import { describe, expect, it } from "vitest";
import { siteWithPage } from "./fixtures/site.js";
import { planPhaseTools, assistTools, MUTATING_TOOLS } from "../src/assist/tools.js";
import { planAssist, PLAN_REPORT_TOOL } from "../src/assist/plan.js";
import type { MessagesCreate } from "../src/assist/loop.js";
import type { PlasmicClient } from "../src/client.js";
import type { ModelNode, PlasmicModel, Ref } from "../src/model/index.js";

function fakePlasmicClient(
  fixtureModel: PlasmicModel = siteWithPage("Home", "/", "Hello").model,
  state = { saves: 0 }
): PlasmicClient {
  let data = JSON.stringify(fixtureModel);
  let revision = 3;
  const fake = {
    hostUrl: "http://fake",
    get: async (path: string) => {
      if (path.startsWith("/api/v1/projects/") && path.endsWith("/tokens")) {
        return { tokens: [] };
      }
      if (path.match(/^\/api\/v1\/projects\/[^/]+$/)) {
        return { rev: { revision, data }, project: { name: "Fake" } };
      }
      throw new Error(`fake GET not handled: ${path}`);
    },
    post: async (path: string, body?: unknown) => {
      if (path.includes("/revisions/")) {
        revision += 1;
        state.saves += 1;
        const posted = (body as { data?: string } | undefined)?.data;
        if (typeof posted === "string") data = posted;
        return {};
      }
      throw new Error(`fake POST not handled: ${path}`);
    },
  };
  return fake as unknown as PlasmicClient;
}

describe("planPhaseTools", () => {
  it("excludes every mutating tool", () => {
    const names = new Set(planPhaseTools.map((t) => t.name));
    for (const m of MUTATING_TOOLS) {
      expect(names.has(m), `${m} must be excluded from the plan phase`).toBe(false);
    }
  });

  it("keeps everything else from assistTools", () => {
    const expected = assistTools
      .filter((t) => !MUTATING_TOOLS.has(t.name))
      .map((t) => t.name);
    expect(planPhaseTools.map((t) => t.name)).toEqual(expected);
  });

  it("pins the exact plan-phase tool allowlist (nothing that can save a revision)", () => {
    // Intentionally brittle — any tool added to the assist surface must be
    // consciously re-allowlisted here.
    expect(planPhaseTools.map((t) => t.name).sort()).toEqual(
      [
        "plasmic_get_element",
        "plasmic_get_page_model",
        "plasmic_get_project_meta",
        "plasmic_list_pages",
        "plasmic_list_tokens",
        "plasmic_plan_mutations",
      ].sort()
    );
  });
});

describe("planAssist (offline)", () => {
  const ops = [{ op: "set_text", path: "/", text: "Hello world" }];

  it("never offers plasmic_apply_mutations to the model", async () => {
    const client = fakePlasmicClient();
    const seenToolNames: string[][] = [];
    const createMessage: MessagesCreate = async (params) => {
      seenToolNames.push((params.tools ?? []).map((t) => t.name));
      return {
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: PLAN_REPORT_TOOL.name,
            input: { status: "no_changes_needed", summary: "Nothing to do." },
          },
        ],
        stop_reason: "tool_use",
      } as never;
    };
    await planAssist(client, { projectId: "p1", request: "hi" }, { createMessage });
    expect(seenToolNames.length).toBeGreaterThan(0);
    for (const names of seenToolNames) {
      expect(names).not.toContain("plasmic_apply_mutations");
      expect(names).toContain("plasmic_plan_mutations");
      expect(names).toContain(PLAN_REPORT_TOOL.name);
    }
  });

  it("captures the validated ops from the plan tool call and returns ready", async () => {
    const client = fakePlasmicClient();
    let call = 0;
    const createMessage: MessagesCreate = async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "plasmic_plan_mutations",
              input: { projectId: "p1", ops },
            },
          ],
          stop_reason: "tool_use",
        } as never;
      }
      return {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: PLAN_REPORT_TOOL.name,
            input: { status: "ready", summary: "Will change the hero text." },
          },
        ],
        stop_reason: "tool_use",
      } as never;
    };

    const outcome = await planAssist(
      client,
      { projectId: "p1", request: "change the hero text" },
      { createMessage }
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.plan).toBeDefined();
    expect(outcome.plan!.ops).toEqual(ops);
    expect(outcome.plan!.baseRevision).toBe(3);
    expect(outcome.plan!.preview).toContain("revision 3");
    expect(outcome.plan!.before.length).toBeGreaterThan(0);
    expect(outcome.summary).toContain("hero text");
  });

  it("plans an element CRUD batch (add_element + set_styles + delete_element)", async () => {
    const fixture = siteWithPage("Home", "/", "Hello");
    const textTplIid = (fixture.model.map[fixture.rootTplIid] as ModelNode & {
      children: Ref[];
    }).children[0].__ref;
    const state = { saves: 0 };
    const client = fakePlasmicClient(fixture.model, state);
    const crudOps = [
      {
        op: "add_element",
        id: "cta",
        parentIid: fixture.rootTplIid,
        tag: "button",
        type: "text",
        text: "Go",
      },
      { op: "set_styles", rsIid: "$cta.rs", styles: { display: "flex" } },
      { op: "delete_element", iid: textTplIid },
    ];
    let call = 0;
    const createMessage: MessagesCreate = async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "plasmic_plan_mutations",
              input: { projectId: "p1", ops: crudOps },
            },
          ],
          stop_reason: "tool_use",
        } as never;
      }
      return {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: PLAN_REPORT_TOOL.name,
            input: { status: "ready", summary: "Will swap the hero text for a CTA." },
          },
        ],
        stop_reason: "tool_use",
      } as never;
    };

    const outcome = await planAssist(
      client,
      { projectId: "p1", request: "replace the hero text with a Go button" },
      { createMessage }
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.plan!.ops).toEqual(crudOps);
    expect(outcome.plan!.preview).toContain("3 ops");
    expect(state.saves).toBe(0); // planning wrote NOTHING
  });

  it("keeps the LAST valid plan when the model re-plans", async () => {
    const client = fakePlasmicClient();
    const ops2 = [{ op: "set_text", path: "/", text: "Second version" }];
    let call = 0;
    const createMessage: MessagesCreate = async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "plasmic_plan_mutations",
              input: { projectId: "p1", ops },
            },
          ],
          stop_reason: "tool_use",
        } as never;
      }
      if (call === 2) {
        return {
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "plasmic_plan_mutations",
              input: { projectId: "p1", ops: ops2 },
            },
          ],
          stop_reason: "tool_use",
        } as never;
      }
      return {
        content: [
          {
            type: "tool_use",
            id: "t3",
            name: PLAN_REPORT_TOOL.name,
            input: { status: "ready", summary: "Second version it is." },
          },
        ],
        stop_reason: "tool_use",
      } as never;
    };

    const outcome = await planAssist(
      client,
      { projectId: "p1", request: "change it" },
      { createMessage }
    );
    expect(outcome.status).toBe("ready");
    expect(outcome.plan!.ops).toEqual(ops2);
  });

  it("downgrades 'ready' with no validated plan to failed", async () => {
    const client = fakePlasmicClient();
    const createMessage: MessagesCreate = async () =>
      ({
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: PLAN_REPORT_TOOL.name,
            input: { status: "ready", summary: "Trust me, it is planned." },
          },
        ],
        stop_reason: "tool_use",
      }) as never;

    const outcome = await planAssist(
      client,
      { projectId: "p1", request: "do a thing" },
      { createMessage }
    );
    expect(outcome.status).toBe("failed");
    expect(outcome.plan).toBeUndefined();
  });

  it("ignores refused plans when capturing (invalid ops are not confirmable)", async () => {
    const client = fakePlasmicClient();
    let call = 0;
    const createMessage: MessagesCreate = async () => {
      call += 1;
      if (call === 1) {
        return {
          content: [
            {
              type: "tool_use",
              id: "t1",
              name: "plasmic_plan_mutations",
              // nonexistent page path → prevalidate refusal (valid:false)
              input: { projectId: "p1", ops: [{ op: "set_text", path: "/nope", text: "x" }] },
            },
          ],
          stop_reason: "tool_use",
        } as never;
      }
      return {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: PLAN_REPORT_TOOL.name,
            input: { status: "ready", summary: "Planned!" },
          },
        ],
        stop_reason: "tool_use",
      } as never;
    };

    const outcome = await planAssist(
      client,
      { projectId: "p1", request: "edit missing page" },
      { createMessage }
    );
    expect(outcome.status).toBe("failed");
  });

  it("passes through needs_clarification with the question", async () => {
    const client = fakePlasmicClient();
    const createMessage: MessagesCreate = async () =>
      ({
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: PLAN_REPORT_TOOL.name,
            input: {
              status: "needs_clarification",
              summary: "Too vague.",
              question: "Which page?",
            },
          },
        ],
        stop_reason: "tool_use",
      }) as never;

    const outcome = await planAssist(
      client,
      { projectId: "p1", request: "make it pop" },
      { createMessage }
    );
    expect(outcome.status).toBe("needs_clarification");
    expect(outcome.question).toBe("Which page?");
    expect(outcome.plan).toBeUndefined();
  });
});

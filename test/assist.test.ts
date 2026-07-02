import { describe, expect, it } from "vitest";
import { siteWithPage, emptySite } from "./fixtures/site.js";
import {
  checkIntegrity,
  diffPages,
  summarizePage,
  summarizePages,
} from "../src/assist/integrity.js";
import {
  assistTools,
  MUTATING_TOOLS,
  toAnthropicTools,
} from "../src/assist/tools.js";
import { renderTemplate, loadTemplate } from "../src/assist/context.js";
import { resolveStatus, defaultUndo } from "../src/assist/report.js";
import { runAssist, type MessagesCreate } from "../src/assist/loop.js";
import type { PlasmicClient } from "../src/client.js";
import type { ModelNode, Ref } from "../src/model/index.js";

// ---- integrity ---------------------------------------------------------------

describe("checkIntegrity", () => {
  it("passes on a clean site with a page", () => {
    const { model } = siteWithPage();
    expect(checkIntegrity(model)).toEqual([]);
  });

  it("detects a dangling __ref", () => {
    const { model } = siteWithPage();
    const site = model.map[model.root] as ModelNode & { components: Ref[] };
    site.components.push({ __ref: "missing-iid" });
    const issues = checkIntegrity(model);
    expect(issues.some((i) => i.includes("dangling __ref missing-iid"))).toBe(true);
  });

  it("detects a parent back-link mismatch", () => {
    const { model, rootTplIid } = siteWithPage();
    const root = model.map[rootTplIid] as ModelNode & { children: Ref[] };
    const childIid = root.children.find((c) => c.__ref)?.__ref;
    if (childIid) {
      (model.map[childIid] as ModelNode & { parent: Ref }).parent = {
        __ref: model.root,
      };
      const issues = checkIntegrity(model);
      expect(issues.some((i) => i.includes(`child ${childIid}`))).toBe(true);
    }
  });

  it("detects a missing root", () => {
    const model = emptySite();
    model.root = "nope";
    expect(checkIntegrity(model).some((i) => i.includes("root nope"))).toBe(true);
  });
});

describe("summarizePage / diffPages", () => {
  it("counts nodes and collects texts", () => {
    const { model, pageIid } = siteWithPage("Home", "/", "Hello");
    const s = summarizePage(model, pageIid);
    expect(s.name).toBe("Home");
    expect(s.path).toBe("/");
    expect(s.texts).toContain("Hello");
    expect(s.counts.Component).toBe(1);
    expect(s.counts.RawText).toBeGreaterThanOrEqual(1);
  });

  it("diffs added pages and text changes", () => {
    const a = siteWithPage("Home", "/", "Hello");
    const before = summarizePages(a.model);
    const after = JSON.parse(JSON.stringify(before)) as typeof before;
    after[0].texts = ["Goodbye"];
    after.push({ iid: "p2", name: "About", path: "/about", counts: {}, texts: [] });
    const diff = diffPages(before, after);
    expect(diff.find((d) => d.change === "added")?.page).toBe("About");
    const mod = diff.find((d) => d.change === "modified");
    expect(mod?.textsAdded).toContain("Goodbye");
    expect(mod?.textsRemoved).toContain("Hello");
  });
});

// ---- tool subset ---------------------------------------------------------------

describe("assistTools", () => {
  it("excludes destructive/admin tools", () => {
    const names = new Set(assistTools.map((t) => t.name));
    for (const banned of [
      "plasmic_delete_project",
      "plasmic_set_devflags",
      "plasmic_grant_revoke",
      "plasmic_create_token",
      "plasmic_delete_token",
      "plasmic_publish_project",
      "plasmic_create_project",
      "plasmic_generate_ui",
    ]) {
      expect(names.has(banned), `${banned} must be excluded`).toBe(false);
    }
  });

  it("includes the 10 model tools + curated reads", () => {
    const names = new Set(assistTools.map((t) => t.name));
    for (const required of [
      "plasmic_list_pages",
      "plasmic_get_page_model",
      "plasmic_create_page",
      "plasmic_update_page_text",
      "plasmic_add_element",
      "plasmic_delete_element",
      "plasmic_apply_token",
      "plasmic_upsert_component",
      "plasmic_duplicate_page",
      "plasmic_get_element",
      "plasmic_list_tokens",
      "plasmic_get_project_meta",
    ]) {
      expect(names.has(required), `${required} must be included`).toBe(true);
    }
  });

  it("every mutating tool is part of the subset", () => {
    const names = new Set(assistTools.map((t) => t.name));
    for (const m of MUTATING_TOOLS) expect(names.has(m)).toBe(true);
  });

  it("converts to Anthropic tool specs", () => {
    const specs = toAnthropicTools(assistTools);
    for (const s of specs) {
      expect(s.input_schema.type).toBe("object");
      expect(s.input_schema.$schema).toBeUndefined();
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});

// ---- template ---------------------------------------------------------------

describe("prompt template", () => {
  it("renders placeholders", () => {
    expect(renderTemplate("a {{X}} b {{Y}} c {{X}}", { X: "1", Y: "2" })).toBe(
      "a 1 b 2 c 1"
    );
  });

  it("the shipped template has no leftover placeholders after render", () => {
    const rendered = renderTemplate(loadTemplate(), {
      STUDIO_HOST: "h",
      STUDIO_URL: "u",
      PROJECT_ID: "p",
      PROJECT_NAME: "n",
      REVISION: "1",
      PAGES: "-",
      TOKENS: "-",
      COMPONENTS: "-",
    });
    expect(rendered).not.toMatch(/\{\{\w+\}\}/);
  });
});

// ---- report status ------------------------------------------------------------

describe("resolveStatus", () => {
  const ok = { tool: "t", args: {}, ok: true };
  const bad = { tool: "t", args: {}, ok: false, error: "x" };

  it("clean run → done", () => {
    expect(resolveStatus("done", [ok], [])).toBe("done");
  });
  it("clarification with no mutations → needs_clarification", () => {
    expect(resolveStatus("needs_clarification", [], [])).toBe("needs_clarification");
  });
  it("clarification claim AFTER mutating → not clarification", () => {
    expect(resolveStatus("needs_clarification", [ok], [])).toBe("done");
  });
  it("mixed success/failure → partial_failure", () => {
    expect(resolveStatus("done", [ok, bad], [])).toBe("partial_failure");
  });
  it("all failed → failed", () => {
    expect(resolveStatus("done", [bad], [])).toBe("failed");
  });
  it("integrity issues override done", () => {
    expect(resolveStatus("done", [ok], ["dangling"])).toBe("partial_failure");
  });

  it("defaultUndo lists created iids", () => {
    const undo = defaultUndo(
      [{ tool: "plasmic_add_element", args: {}, ok: true, result: { elementIid: "el1" } }],
      "http://x"
    );
    expect(undo).toContain("el1");
  });
});

// ---- loop (scripted fake Anthropic + fake Plasmic API) -------------------------

describe("runAssist (offline)", () => {
  function fakePlasmicClient(): PlasmicClient {
    // A stable fake project: one Home page, revision bumps on save.
    const { model } = siteWithPage("Home", "/", "Hello");
    let revision = 3;
    const fake = {
      hostUrl: "http://fake",
      get: async (path: string) => {
        if (path.startsWith("/api/v1/projects/") && path.endsWith("/tokens")) {
          return { tokens: [{ uuid: "tok1", name: "primary", type: "Color", value: "#123456" }] };
        }
        if (path.match(/^\/api\/v1\/projects\/[^/]+$/)) {
          return { rev: { revision, data: JSON.stringify(model) }, project: { name: "Fake" } };
        }
        throw new Error(`fake GET not handled: ${path}`);
      },
      post: async (path: string) => {
        if (path.includes("/revisions/")) {
          revision += 1;
          return {};
        }
        throw new Error(`fake POST not handled: ${path}`);
      },
    };
    return fake as unknown as PlasmicClient;
  }

  it("executes a scripted tool run and verifies independently", async () => {
    const client = fakePlasmicClient();
    let call = 0;
    const createMessage: MessagesCreate = async (params) => {
      call += 1;
      // pages + tokens from the fake project must be rendered into the system prompt
      expect(params.system).toContain("Home");
      expect(params.system).toContain("tok1");
      if (call === 1) {
        return {
          content: [
            { type: "tool_use", id: "t1", name: "plasmic_list_pages", input: { projectId: "p1" } },
          ],
          stop_reason: "tool_use",
        } as never;
      }
      return {
        content: [
          {
            type: "tool_use",
            id: "t2",
            name: "assist_report",
            input: { status: "done", summary: "Listed pages; nothing to change." },
          },
        ],
        stop_reason: "tool_use",
      } as never;
    };

    const report = await runAssist(
      client,
      { projectId: "p1", request: "what pages exist?" },
      { createMessage, model: "test-model" }
    );
    expect(report.status).toBe("done");
    expect(report.summary).toContain("Listed pages");
    expect(report.mutations).toEqual([]);
    expect(report.integrityIssues).toEqual([]);
    expect(report.meta.iterations).toBe(2);
    expect(report.studioUrl).toContain("/projects/p1");
  });

  it("records a mutation and surfaces needs_clarification correctly", async () => {
    const client = fakePlasmicClient();
    const createMessage: MessagesCreate = async () =>
      ({
        content: [
          {
            type: "tool_use",
            id: "t1",
            name: "assist_report",
            input: {
              status: "needs_clarification",
              summary: "Too vague.",
              question: "Which page should look more modern?",
            },
          },
        ],
        stop_reason: "tool_use",
      }) as never;

    const report = await runAssist(
      client,
      { projectId: "p1", request: "make it more modern" },
      { createMessage, model: "test-model" }
    );
    expect(report.status).toBe("needs_clarification");
    expect(report.question).toContain("Which page");
    expect(report.mutations).toEqual([]);
  });
});

import { describe, expect, it, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { siteWithPage } from "./fixtures/site.js";
import { createAssistHandler } from "../src/assist/server.js";
import { PLAN_REPORT_TOOL } from "../src/assist/plan.js";
import type { MessagesCreate } from "../src/assist/loop.js";
import type { PlasmicClient } from "../src/client.js";

const BEARER = "test-bearer";

/**
 * Fake Studio backed by one page; saves bump the revision and persist the
 * bundle so re-reads (the apply verification tail) see the applied change.
 * bumpRevision() simulates a concurrent Studio save between plan and apply.
 */
function fakePlasmicClient() {
  const { model } = siteWithPage("Home", "/", "Hello");
  let data = JSON.stringify(model);
  const state = { revision: 3, saves: 0 };
  const fake = {
    hostUrl: "http://fake",
    get: async (path: string) => {
      if (path.startsWith("/api/v1/projects/") && path.endsWith("/tokens")) {
        return { tokens: [] };
      }
      if (path.match(/^\/api\/v1\/projects\/[^/]+$/)) {
        return { rev: { revision: state.revision, data }, project: { name: "Fake" } };
      }
      throw new Error(`fake GET not handled: ${path}`);
    },
    post: async (path: string, body?: unknown) => {
      if (path.includes("/revisions/")) {
        state.revision += 1;
        state.saves += 1;
        const posted = (body as { data?: string } | undefined)?.data;
        if (typeof posted === "string") data = posted;
        return {};
      }
      throw new Error(`fake POST not handled: ${path}`);
    },
  };
  return { client: fake as unknown as PlasmicClient, state };
}

/** Scripted model: one plan_mutations call, then a ready report. */
function scriptedPlanRun(ops: unknown[]): MessagesCreate {
  let call = 0;
  return async () => {
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
          input: { status: "ready", summary: "Will update the hero text." },
        },
      ],
      stop_reason: "tool_use",
    } as never;
  };
}

const OPS = [{ op: "set_text", path: "/", text: "Hello world" }];

let server: Server | undefined;

async function startServer(opts: {
  createMessage: MessagesCreate;
  planTtlMs?: number;
}): Promise<{ base: string; state: { revision: number; saves: number } }> {
  const { client, state } = fakePlasmicClient();
  const { handler } = createAssistHandler({
    client,
    bearer: BEARER,
    model: "test-model",
    planTtlMs: opts.planTtlMs,
    assistOptions: { createMessage: opts.createMessage },
    log: () => {},
  });
  server = createServer(handler);
  await new Promise<void>((r) => server!.listen(0, r));
  const { port } = server!.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, state };
}

afterEach(async () => {
  if (server) {
    await new Promise((r) => server!.close(r));
    server = undefined;
  }
});

function post(base: string, path: string, body: unknown, bearer = BEARER) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  });
}

describe("assist server /design-assist/plan + /apply", () => {
  it("plan → apply happy path: one save, honest diff, idempotent replay", async () => {
    const { base, state } = await startServer({ createMessage: scriptedPlanRun(OPS) });

    // ---- plan ----
    const planRes = await post(base, "/design-assist/plan", {
      projectId: "p1",
      request: "change the hero text to Hello world",
    });
    expect(planRes.status).toBe(200);
    const plan = (await planRes.json()) as Record<string, unknown>;
    expect(plan.status).toBe("ready");
    expect(typeof plan.planId).toBe("string");
    expect(plan.baseRevision).toBe(3);
    expect(String(plan.preview)).toContain("revision 3");
    expect(String(plan.expiresAt)).toMatch(/^\d{4}-/);
    expect(state.saves).toBe(0); // planning wrote NOTHING

    // ---- apply ----
    const applyRes = await post(base, "/design-assist/apply", { planId: plan.planId });
    expect(applyRes.status).toBe(200);
    const report = (await applyRes.json()) as Record<string, unknown>;
    expect(report.status).toBe("done");
    expect(report.revisions).toEqual({ from: 3, to: 4 });
    expect(state.saves).toBe(1);
    const diff = report.diff as Array<Record<string, unknown>>;
    const mod = diff.find((d) => d.change === "modified");
    expect(mod?.textsAdded).toContain("Hello world");
    expect(String(report.undo)).toContain("History panel");

    // ---- duplicate confirm replays without re-applying ----
    const replayRes = await post(base, "/design-assist/apply", { planId: plan.planId });
    expect(replayRes.status).toBe(200);
    const replay = (await replayRes.json()) as Record<string, unknown>;
    expect(replay.revisions).toEqual({ from: 3, to: 4 });
    expect(state.saves).toBe(1); // still exactly one save
  });

  it("apply rejects with 409 REVISION_CONFLICT when the project advanced after planning", async () => {
    const { base, state } = await startServer({ createMessage: scriptedPlanRun(OPS) });

    const plan = (await (
      await post(base, "/design-assist/plan", { projectId: "p1", request: "x" })
    ).json()) as Record<string, unknown>;
    expect(plan.status).toBe("ready");

    // concurrent Studio save between plan and apply
    state.revision += 1;

    const applyRes = await post(base, "/design-assist/apply", { planId: plan.planId });
    expect(applyRes.status).toBe(409);
    const body = (await applyRes.json()) as Record<string, unknown>;
    expect(body.code).toBe("REVISION_CONFLICT");
    expect(body.expectedRevision).toBe(3);
    expect(body.headRevision).toBe(4);
    expect(state.saves).toBe(0); // nothing was written

    // replaying the conflicted plan keeps returning the recorded 409
    const replayRes = await post(base, "/design-assist/apply", { planId: plan.planId });
    expect(replayRes.status).toBe(409);
    expect(state.saves).toBe(0);
  });

  it("apply 404s for unknown and for expired planIds", async () => {
    const { base } = await startServer({
      createMessage: scriptedPlanRun(OPS),
      planTtlMs: 0, // every plan is expired the moment it is created
    });

    const unknown = await post(base, "/design-assist/apply", { planId: "nope" });
    expect(unknown.status).toBe(404);
    expect(((await unknown.json()) as { code: string }).code).toBe("PLAN_NOT_FOUND");

    const plan = (await (
      await post(base, "/design-assist/plan", { projectId: "p1", request: "x" })
    ).json()) as Record<string, unknown>;
    expect(plan.status).toBe("ready");
    const expired = await post(base, "/design-assist/apply", { planId: plan.planId });
    expect(expired.status).toBe(404);
  });

  it("apply cross-checks projectId when provided", async () => {
    const { base } = await startServer({ createMessage: scriptedPlanRun(OPS) });
    const plan = (await (
      await post(base, "/design-assist/plan", { projectId: "p1", request: "x" })
    ).json()) as Record<string, unknown>;
    const res = await post(base, "/design-assist/apply", {
      planId: plan.planId,
      projectId: "other-project",
    });
    expect(res.status).toBe(400);
  });

  it("non-ready plan outcomes carry no planId and never store a plan", async () => {
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
    const { base, state } = await startServer({ createMessage });

    const res = await post(base, "/design-assist/plan", {
      projectId: "p1",
      request: "make it pop",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("needs_clarification");
    expect(body.question).toBe("Which page?");
    expect(body.planId).toBeUndefined();
    expect(state.saves).toBe(0);
  });

  it("plan supports wait:false via the jobs poller", async () => {
    const { base } = await startServer({ createMessage: scriptedPlanRun(OPS) });
    const res = await post(base, "/design-assist/plan", {
      projectId: "p1",
      request: "x",
      wait: false,
    });
    expect(res.status).toBe(202);
    const { jobId, poll } = (await res.json()) as { jobId: string; poll: string };
    expect(poll).toBe(`/jobs/${jobId}`);

    // poll until done
    for (let i = 0; i < 50; i++) {
      const jr = (await (
        await fetch(`${base}/jobs/${jobId}`, {
          headers: { authorization: `Bearer ${BEARER}` },
        })
      ).json()) as { status: string; kind: string; report?: Record<string, unknown> };
      if (jr.status !== "running") {
        expect(jr.status).toBe("done");
        expect(jr.kind).toBe("plan");
        expect(jr.report?.status).toBe("ready");
        expect(typeof jr.report?.planId).toBe("string");
        return;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("job never finished");
  });

  it("requires the bearer token on plan and apply", async () => {
    const { base } = await startServer({ createMessage: scriptedPlanRun(OPS) });
    const p = await post(base, "/design-assist/plan", { projectId: "p1", request: "x" }, "wrong");
    expect(p.status).toBe(401);
    const a = await post(base, "/design-assist/apply", { planId: "x" }, "wrong");
    expect(a.status).toBe(401);
  });

  it("400s on malformed bodies", async () => {
    const { base } = await startServer({ createMessage: scriptedPlanRun(OPS) });
    const p = await post(base, "/design-assist/plan", { request: "no project" });
    expect(p.status).toBe(400);
    const a = await post(base, "/design-assist/apply", {});
    expect(a.status).toBe(400);
  });

  it("healthz reports plan-store size without auth", async () => {
    const { base } = await startServer({ createMessage: scriptedPlanRun(OPS) });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.plans).toBe(0);
  });
});

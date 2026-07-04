#!/usr/bin/env node
/**
 * design-assist HTTP service — the durable automation endpoint the n8n
 * webhook proxies to.
 *
 *   POST /design-assist        {projectId, request, pagePath?, wait?, model?}
 *       one-shot autonomous run (plan+apply inside a single agent loop);
 *       wait !== false → runs synchronously, responds with the AssistReport
 *       wait === false → responds 202 {jobId}; poll GET /jobs/{jobId}
 *
 *   POST /design-assist/plan   {projectId, request, pagePath?, wait?, model?}
 *       two-phase step 1: plan-only agent run (provably non-mutating tool
 *       surface). status "ready" responses carry a planId; the validated ops
 *       stay server-side. Show summary/preview to the user for confirmation.
 *
 *   POST /design-assist/apply  {planId, projectId?}
 *       two-phase step 2: deterministically apply the stored plan's exact ops
 *       (NO model call). 404 unknown/expired plan, 409 REVISION_CONFLICT,
 *       422 batch refusal; duplicate confirms replay the recorded outcome.
 *
 *   GET  /jobs/{id}
 *   GET  /healthz
 *
 * Auth: Authorization: Bearer $ASSIST_BEARER_TOKEN on everything but /healthz.
 * Runs per-project requests serially (revision saves race otherwise).
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { PlasmicClient } from "../client.js";
import {
  runAssist,
  DEFAULT_MODEL,
  type AssistOptions,
  type AssistRequest,
} from "./loop.js";
import { planAssist } from "./plan.js";
import { PlanStore, DEFAULT_PLAN_TTL_MS, type StoredPlan } from "./plan-store.js";
import { applyMutationsCore } from "../tools/batch.js";
import { checkIntegrity, diffPages, summarizePages } from "./integrity.js";
import { defaultUndo, resolveStatus, type MutationRecord } from "./report.js";
import { gatherContext } from "./context.js";
import type { AssistReport } from "./report.js";

// ---- shared http plumbing ---------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

interface AssistBody extends AssistRequest {
  wait?: boolean;
  model?: string;
}

function parseAssistBody(text: string): AssistBody {
  const body = JSON.parse(text) as Record<string, unknown>;
  if (typeof body.projectId !== "string" || !body.projectId.trim()) {
    throw new Error("projectId (string) is required");
  }
  if (typeof body.request !== "string" || !body.request.trim()) {
    throw new Error("request (string) is required");
  }
  return {
    projectId: body.projectId.trim(),
    request: body.request.trim(),
    pagePath: typeof body.pagePath === "string" ? body.pagePath : undefined,
    wait: body.wait === false ? false : true,
    model: typeof body.model === "string" ? body.model : undefined,
  };
}

// ---- factory ------------------------------------------------------------------

interface Job {
  id: string;
  kind: "assist" | "plan";
  status: "running" | "done" | "error";
  createdAt: number;
  report?: unknown;
  error?: string;
}

export interface AssistServerConfig {
  client: PlasmicClient;
  bearer: string;
  model?: string;
  planTtlMs?: number;
  publicStudioUrl?: string;
  /** merged into every agent run — tests inject a fake createMessage here */
  assistOptions?: AssistOptions;
  log?: (line: string) => void;
}

export function createAssistHandler(cfg: AssistServerConfig) {
  const { client } = cfg;
  const model = cfg.model ?? DEFAULT_MODEL;
  const log = cfg.log ?? ((l: string) => console.log(`[assist] ${l}`));
  const publicStudioUrl = (
    cfg.publicStudioUrl ??
    process.env.ASSIST_PUBLIC_STUDIO_URL ??
    "https://studio.aihe.dev"
  ).replace(/\/+$/, "");

  const jobs = new Map<string, Job>();
  const plans = new PlanStore(cfg.planTtlMs ?? DEFAULT_PLAN_TTL_MS);

  // serialize runs per project — concurrent revision saves would conflict
  const projectQueues = new Map<string, Promise<unknown>>();
  function enqueue<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
    const prev = projectQueues.get(projectId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    projectQueues.set(
      projectId,
      next.catch(() => {})
    );
    return next;
  }

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(token);
    const b = Buffer.from(cfg.bearer);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  function runOpts(bodyModel: string | undefined): AssistOptions {
    return { ...cfg.assistOptions, model: bodyModel ?? model, log };
  }

  function executeAssist(body: AssistBody): Promise<AssistReport> {
    return enqueue(body.projectId, () =>
      runAssist(
        client,
        { projectId: body.projectId, request: body.request, pagePath: body.pagePath },
        runOpts(body.model)
      )
    );
  }

  async function executePlan(body: AssistBody): Promise<unknown> {
    const outcome = await enqueue(body.projectId, () =>
      planAssist(
        client,
        { projectId: body.projectId, request: body.request, pagePath: body.pagePath },
        runOpts(body.model)
      )
    );
    const base = {
      status: outcome.status,
      summary: outcome.summary,
      ...(outcome.question ? { question: outcome.question } : {}),
      studioUrl: outcome.studioUrl,
      meta: outcome.meta,
    };
    if (outcome.status !== "ready" || !outcome.plan) return base;
    const stored = plans.create({
      projectId: body.projectId,
      ops: outcome.plan.ops,
      baseRevision: outcome.plan.baseRevision,
      before: outcome.plan.before,
      summary: outcome.summary,
      preview: outcome.plan.preview,
      request: body.request,
    });
    return {
      ...base,
      planId: stored.id,
      preview: stored.preview,
      baseRevision: stored.baseRevision,
      expiresAt: new Date(stored.expiresAt).toISOString(),
    };
  }

  /** Deterministic apply of a stored plan — no model call anywhere. */
  async function executeApply(
    stored: StoredPlan
  ): Promise<{ httpStatus: number; body: unknown }> {
    const start = Date.now();
    const studioUrl = `${publicStudioUrl}/projects/${stored.projectId}`;
    const result = await applyMutationsCore(
      client,
      stored.projectId,
      stored.ops,
      stored.baseRevision
    );

    if ("code" in result && result.code === "REVISION_CONFLICT") {
      stored.status = "conflict";
      const body = {
        status: "failed",
        code: "REVISION_CONFLICT",
        summary:
          "The project changed since this plan was made — nothing was applied. Ask again to get a fresh plan.",
        expectedRevision: result.expectedRevision,
        headRevision: result.headRevision,
        studioUrl,
      };
      stored.applyResult = { httpStatus: 409, body };
      return stored.applyResult as { httpStatus: number; body: unknown };
    }

    if (result.applied !== true) {
      stored.status = "refused";
      const body = {
        status: "failed",
        code: "BATCH_REFUSED",
        summary:
          "The plan no longer validates against the project — nothing was applied. Ask again to get a fresh plan.",
        errors: (result as { errors?: unknown }).errors,
        studioUrl,
      };
      stored.applyResult = { httpStatus: 422, body };
      return stored.applyResult as { httpStatus: number; body: unknown };
    }

    stored.status = "applied";
    const mutations: MutationRecord[] = [
      {
        tool: "plasmic_apply_mutations",
        args: { projectId: stored.projectId, ops: stored.ops },
        ok: true,
        result,
      },
    ];

    // Independent verification — same tail as runAssist.
    let integrityIssues: string[] = [];
    let diff: ReturnType<typeof diffPages> = [];
    let afterRevision = result.revision;
    try {
      const verify = await gatherContext(client, stored.projectId);
      afterRevision = verify.revision;
      integrityIssues = checkIntegrity(verify.model);
      diff = diffPages(stored.before, summarizePages(verify.model));
    } catch (e) {
      integrityIssues = [
        `verification re-read failed: ${(e as Error)?.message ?? String(e)}`,
      ];
    }

    const body = {
      status: resolveStatus(undefined, mutations, integrityIssues),
      summary: stored.summary,
      mutations,
      revisions: { from: stored.baseRevision, to: afterRevision },
      diff,
      integrityIssues,
      studioUrl,
      undo: defaultUndo(mutations, studioUrl),
      meta: { model, iterations: 0, durationMs: Date.now() - start, toolCalls: 1 },
    };
    stored.applyResult = { httpStatus: 200, body };
    return stored.applyResult as { httpStatus: number; body: unknown };
  }

  function startJob(kind: Job["kind"], run: () => Promise<unknown>): Job {
    const job: Job = { id: randomUUID(), kind, status: "running", createdAt: Date.now() };
    jobs.set(job.id, job);
    run()
      .then((report) => {
        job.status = "done";
        job.report = report;
      })
      .catch((e) => {
        job.status = "error";
        job.error = (e as Error)?.message ?? String(e);
      });
    return job;
  }

  function sweep(): void {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, job] of jobs) {
      if (job.status !== "running" && job.createdAt < cutoff) jobs.delete(id);
    }
    plans.sweep();
  }

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, model, jobs: jobs.size, plans: plans.size });
        return;
      }
      if (!authorized(req)) {
        sendJson(res, 401, { error: "unauthorized" });
        return;
      }

      if (
        req.method === "POST" &&
        (url.pathname === "/design-assist" || url.pathname === "/design-assist/plan")
      ) {
        const isPlan = url.pathname.endsWith("/plan");
        let body: AssistBody;
        try {
          body = parseAssistBody(await readBody(req));
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }

        const run = () => (isPlan ? executePlan(body) : executeAssist(body));
        if (body.wait === false) {
          const job = startJob(isPlan ? "plan" : "assist", run);
          sendJson(res, 202, { jobId: job.id, poll: `/jobs/${job.id}` });
          return;
        }
        sendJson(res, 200, await run());
        return;
      }

      if (req.method === "POST" && url.pathname === "/design-assist/apply") {
        let planId: string;
        let projectId: string | undefined;
        try {
          const parsed = JSON.parse(await readBody(req)) as Record<string, unknown>;
          if (typeof parsed.planId !== "string" || !parsed.planId.trim()) {
            throw new Error("planId (string) is required");
          }
          planId = parsed.planId.trim();
          projectId =
            typeof parsed.projectId === "string" ? parsed.projectId : undefined;
        } catch (e) {
          sendJson(res, 400, { error: (e as Error).message });
          return;
        }

        const stored = plans.get(planId);
        if (!stored) {
          sendJson(res, 404, {
            code: "PLAN_NOT_FOUND",
            error:
              "Unknown or expired planId — plans expire after a few minutes. Ask again to get a fresh plan.",
          });
          return;
        }
        if (projectId && projectId !== stored.projectId) {
          sendJson(res, 400, { error: "projectId does not match this plan" });
          return;
        }

        // Duplicate confirm (double-click, retry-after-timeout): replay the
        // recorded outcome instead of re-applying.
        if (stored.status !== "pending" && stored.applyResult) {
          const prior = stored.applyResult as { httpStatus: number; body: unknown };
          sendJson(res, prior.httpStatus, prior.body);
          return;
        }

        const outcome = await enqueue(stored.projectId, () => executeApply(stored));
        sendJson(res, outcome.httpStatus, outcome.body);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/jobs/")) {
        const job = jobs.get(url.pathname.slice("/jobs/".length));
        if (!job) {
          sendJson(res, 404, { error: "job not found" });
          return;
        }
        sendJson(res, 200, job);
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (e) {
      sendJson(res, 500, { error: (e as Error)?.message ?? String(e) });
    }
  };

  return { handler, jobs, plans, sweep };
}

// ---- main -------------------------------------------------------------------

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { config: loadEnv } = await import("dotenv");
  const { dirname, join } = await import("node:path");
  loadEnv({
    path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env"),
  });
  const { PlasmicClient } = await import("../client.js");

  const requireEnv = (name: string): string => {
    const v = process.env[name];
    if (!v) {
      process.stderr.write(`[design-assist] missing required env var ${name}\n`);
      process.exit(1);
    }
    return v;
  };

  const PORT = Number(process.env.ASSIST_PORT ?? 8766);
  const MODEL = process.env.ASSIST_MODEL ?? DEFAULT_MODEL;
  requireEnv("ANTHROPIC_API_KEY");

  const { handler, sweep } = createAssistHandler({
    client: new PlasmicClient({
      host: requireEnv("PLASMIC_HOST"),
      email: requireEnv("PLASMIC_EMAIL"),
      password: requireEnv("PLASMIC_PASSWORD"),
      userAgent: process.env.PLASMIC_USER_AGENT,
    }),
    bearer: requireEnv("ASSIST_BEARER_TOKEN"),
    model: MODEL,
    planTtlMs: process.env.ASSIST_PLAN_TTL_MS
      ? Number(process.env.ASSIST_PLAN_TTL_MS)
      : undefined,
  });

  setInterval(sweep, 10 * 60_000).unref();

  const server = createServer(handler);
  // agent runs can take minutes — keep node's request timeouts out of the way
  server.requestTimeout = 15 * 60_000;
  server.headersTimeout = 60_000;

  server.listen(PORT, () => {
    console.log(
      `[design-assist] listening on :${PORT} — model=${MODEL} host=${process.env.PLASMIC_HOST}`
    );
  });
}

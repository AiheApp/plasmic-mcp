#!/usr/bin/env node
/**
 * design-assist HTTP service — the durable automation endpoint the n8n
 * webhook proxies to.
 *
 *   POST /design-assist   {projectId, request, pagePath?, wait?}
 *       wait !== false → runs synchronously, responds with the AssistReport
 *       wait === false → responds 202 {jobId}; poll GET /jobs/{jobId}
 *   GET  /jobs/{id}
 *   GET  /healthz
 *
 * Auth: Authorization: Bearer $ASSIST_BEARER_TOKEN on everything but /healthz.
 * Runs per-project requests serially (revision saves race otherwise).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

import { PlasmicClient } from "../client.js";
import { runAssist, DEFAULT_MODEL, type AssistRequest } from "./loop.js";
import type { AssistReport } from "./report.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`[design-assist] missing required env var ${name}\n`);
    process.exit(1);
  }
  return v;
}

const PORT = Number(process.env.ASSIST_PORT ?? 8766);
const BEARER = requireEnv("ASSIST_BEARER_TOKEN");
const MODEL = process.env.ASSIST_MODEL ?? DEFAULT_MODEL;
requireEnv("ANTHROPIC_API_KEY");

const client = new PlasmicClient({
  host: requireEnv("PLASMIC_HOST"),
  email: requireEnv("PLASMIC_EMAIL"),
  password: requireEnv("PLASMIC_PASSWORD"),
  userAgent: process.env.PLASMIC_USER_AGENT,
});

// ---- job store --------------------------------------------------------------

interface Job {
  id: string;
  status: "running" | "done" | "error";
  createdAt: number;
  report?: AssistReport;
  error?: string;
}
const jobs = new Map<string, Job>();
setInterval(() => {
  const cutoff = Date.now() - 60 * 60_000;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.createdAt < cutoff) jobs.delete(id);
  }
}, 10 * 60_000).unref();

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

// ---- http plumbing ----------------------------------------------------------

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(token);
  const b = Buffer.from(BEARER);
  return a.length === b.length && timingSafeEqual(a, b);
}

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

function execute(body: AssistBody): Promise<AssistReport> {
  return enqueue(body.projectId, () =>
    runAssist(
      client,
      { projectId: body.projectId, request: body.request, pagePath: body.pagePath },
      { model: body.model ?? MODEL, log: (l) => console.log(`[assist] ${l}`) }
    )
  );
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true, model: MODEL, jobs: jobs.size });
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/design-assist") {
      let body: AssistBody;
      try {
        body = parseAssistBody(await readBody(req));
      } catch (e) {
        sendJson(res, 400, { error: (e as Error).message });
        return;
      }

      if (body.wait === false) {
        const job: Job = { id: randomUUID(), status: "running", createdAt: Date.now() };
        jobs.set(job.id, job);
        execute(body)
          .then((report) => {
            job.status = "done";
            job.report = report;
          })
          .catch((e) => {
            job.status = "error";
            job.error = (e as Error)?.message ?? String(e);
          });
        sendJson(res, 202, { jobId: job.id, poll: `/jobs/${job.id}` });
        return;
      }

      const report = await execute(body);
      sendJson(res, 200, report);
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
});

// agent runs can take minutes — keep node's request timeouts out of the way
server.requestTimeout = 15 * 60_000;
server.headersTimeout = 60_000;

server.listen(PORT, () => {
  console.log(
    `[design-assist] listening on :${PORT} — model=${MODEL} host=${process.env.PLASMIC_HOST}`
  );
});

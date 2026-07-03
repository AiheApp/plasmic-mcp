#!/usr/bin/env node
/**
 * plasmic-page-api — HTTP wrapper around the plasmic-mcp tool layer.
 *
 * Purpose: n8n Code nodes cannot read env vars and HTTP Request nodes cannot
 * do the Studio session+CSRF dance, so provisioning workflows call this small
 * service instead (it replaces the original Python /opt/plasmic-page-api).
 * All page/project mutations reuse the exact same model-mutation library and
 * PlasmicClient the MCP server uses — one canonical implementation.
 *
 *   GET  /health          → { ok: true }                     (no auth)
 *   POST /add-page        { projectId, pageName|name, path, text? }
 *   POST /create-project  { name }        → { projectId, projectToken }
 *   POST /publish-project { projectId, version?, description? }
 *   POST /delete-project  { projectId }
 *
 * POST routes require `Authorization: Bearer $ADD_PAGE_SECRET` (constant-time
 * comparison). Secrets are only ever read from env; request/response logging
 * never includes bodies or headers.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import { PlasmicClient, PlasmicError } from "./client.js";
import type { ToolDef } from "./tools/types.js";
import { writeTools } from "./tools/write.js";
import { modelTools } from "./tools/model.js";

export interface PageApiConfig {
  secret: string;
  client: PlasmicClient;
}

const registry = new Map<string, ToolDef>(
  [...writeTools, ...modelTools].map((t) => [t.name, t])
);

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

const MAX_BODY = 1024 * 1024; // 1 MiB — payloads here are tiny

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          reject(new Error("body must be a JSON object"));
        }
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

interface ProjectRecord {
  id?: string;
  projectApiToken?: string | null;
}

type Handler = (body: Record<string, unknown>) => Promise<unknown>;

export function createHandler(cfg: PageApiConfig) {
  const { client } = cfg;
  const secretHash = sha256(cfg.secret);

  function isAuthorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer\s+(.+)$/i.exec(header);
    if (!m) return false;
    return timingSafeEqual(sha256(m[1].trim()), secretHash);
  }

  function callTool(name: string, args: unknown): Promise<unknown> {
    const tool = registry.get(name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return tool.handler(client, tool.schema.parse(args));
  }

  /** The create response usually embeds the token; fall back to a project GET. */
  async function resolveProjectToken(projectId: string, created: unknown): Promise<string | null> {
    const fromCreate = (created as { project?: ProjectRecord })?.project?.projectApiToken;
    if (fromCreate) return fromCreate;
    const full = await client.get<{ project?: ProjectRecord }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}`
    );
    return full?.project?.projectApiToken ?? null;
  }

  const routes: Record<string, Handler> = {
    "/add-page": async (b) => {
      const result = await callTool("plasmic_create_page", {
        projectId: b.projectId,
        name: b.pageName ?? b.name,
        path: b.path,
        text: b.text ?? undefined,
      });
      return { ok: true, projectId: b.projectId, ...(result as object) };
    },

    "/create-project": async (b) => {
      const created = await callTool("plasmic_create_project", {
        name: b.name,
        ...(b.workspaceId ? { workspaceId: b.workspaceId } : {}),
      });
      const projectId = (created as { project?: ProjectRecord })?.project?.id;
      if (!projectId) {
        throw new PlasmicError(
          "create-project: no project id in Studio response",
          undefined,
          JSON.stringify(created).slice(0, 300),
          "parse"
        );
      }
      const projectToken = await resolveProjectToken(projectId, created);
      return { ok: true, projectId, projectToken, name: b.name ?? null };
    },

    "/publish-project": async (b) => {
      const result = await callTool("plasmic_publish_project", {
        projectId: b.projectId,
        // wab's pkg_version.tags column is NOT NULL — the Studio UI always
        // sends tags, so an omitted array 500s the publish route.
        tags: Array.isArray(b.tags) ? b.tags : [],
        ...(b.version ? { version: b.version } : {}),
        ...(b.description ? { description: b.description } : {}),
      });
      return { ok: true, projectId: b.projectId, result };
    },

    "/delete-project": async (b) => {
      await callTool("plasmic_delete_project", { projectId: b.projectId });
      return { ok: true, projectId: b.projectId, deleted: true };
    },
  };

  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    const started = Date.now();
    const done = (status: number) => {
      process.stdout.write(
        `[plasmic-page-api] ${req.method} ${path} → ${status} (${Date.now() - started}ms)\n`
      );
    };

    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, service: "plasmic-page-api" });
      return done(200);
    }

    const handler = req.method === "POST" ? routes[path] : undefined;
    if (!handler) {
      sendJson(res, 404, { ok: false, error: "not found" });
      return done(404);
    }
    if (!isAuthorized(req)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return done(401);
    }

    void (async () => {
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (e) {
        sendJson(res, 400, { ok: false, error: (e as Error).message });
        return done(400);
      }
      try {
        sendJson(res, 200, await handler(body));
        done(200);
      } catch (e) {
        if (e instanceof ZodError) {
          sendJson(res, 400, {
            ok: false,
            error: "invalid input",
            issues: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
          });
          return done(400);
        }
        if (e instanceof PlasmicError) {
          const raw = e.kind === "auth" ? 502 : (e.status ?? 502);
          const status = raw >= 400 && raw < 600 ? raw : 502;
          sendJson(res, status, {
            ok: false,
            error: e.message,
            kind: e.kind ?? null,
            upstreamStatus: e.status ?? null,
          });
          return done(status);
        }
        sendJson(res, 500, { ok: false, error: (e as Error).message ?? "internal error" });
        done(500);
      }
    })();
  };
}

// ---- main -------------------------------------------------------------------
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const { config: loadEnv } = await import("dotenv");
  const { dirname, join } = await import("node:path");
  loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

  // Accept both naming schemes: PLASMIC_EMAIL/PLASMIC_PASSWORD (repo .env
  // convention, see .env.example) and PLASMIC_STUDIO_EMAIL/PLASMIC_STUDIO_PASS
  // (the VPS /opt/plasmic-page-api/.env convention from the Python service).
  const requireEnv = (...names: string[]): string => {
    for (const name of names) {
      const v = process.env[name];
      if (v) return v;
    }
    process.stderr.write(`[plasmic-page-api] missing required env var ${names.join(" or ")}\n`);
    process.exit(1);
  };

  const port = Number(process.env.PORT ?? 8765);
  // STUDIO_URL is the legacy name from the original Python service's .env.
  const host = requireEnv("PLASMIC_HOST", "STUDIO_URL");

  // When talking to the wab backend directly over plain http (in-cluster,
  // e.g. http://10.0.2.2:3004), express-session only issues its session
  // cookie if the request looks like https — so the deploy sets
  // PLASMIC_EXTRA_HEADERS={"x-forwarded-proto":"https"}. Injected via a
  // fetch wrapper so every client request carries them.
  let fetchImpl: typeof fetch | undefined;
  const extraRaw = process.env.PLASMIC_EXTRA_HEADERS;
  if (extraRaw) {
    let extra: Record<string, string>;
    try {
      extra = JSON.parse(extraRaw);
    } catch {
      process.stderr.write("[plasmic-page-api] PLASMIC_EXTRA_HEADERS is not valid JSON\n");
      process.exit(1);
    }
    fetchImpl = (input, init = {}) =>
      fetch(input, { ...init, headers: { ...extra, ...(init.headers ?? {}) } });
  }

  const handler = createHandler({
    secret: requireEnv("ADD_PAGE_SECRET"),
    client: new PlasmicClient({
      host,
      email: requireEnv("PLASMIC_EMAIL", "PLASMIC_STUDIO_EMAIL"),
      password: requireEnv("PLASMIC_PASSWORD", "PLASMIC_STUDIO_PASS"),
      fetchImpl,
    }),
  });
  createServer(handler).listen(port, () => {
    process.stdout.write(`[plasmic-page-api] listening on :${port} (studio: ${host})\n`);
  });
}

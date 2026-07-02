#!/usr/bin/env node
/**
 * Streamable-HTTP entry point for the plasmic MCP server — lets non-stdio
 * clients (n8n's MCP Client tool, remote agents) call the same 33 tools.
 *
 *   POST /mcp     — MCP streamable HTTP (stateless: a fresh transport+server
 *                   pair per request, one shared PlasmicClient session)
 *   GET  /healthz — { ok: true } (no auth)
 *
 * Auth: every /mcp request requires `Authorization: Bearer $MCP_HTTP_TOKEN`
 * (constant-time comparison). Env: PLASMIC_HOST/EMAIL/PASSWORD as usual,
 * MCP_HTTP_TOKEN (required), MCP_HTTP_PORT (default 3010).
 *
 * Deploy note (Plasmic VPS): set PLASMIC_HOST=http://10.0.2.2:3003 to talk to
 * the Studio container directly, bypassing Cloudflare.
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { PlasmicClient } from "./client.js";
import { allTools, buildServer } from "./index.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`[plasmic-mcp-http] missing required env var ${name}\n`);
    process.exit(1);
  }
  return v;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest();

function bearerOk(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  return timingSafeEqual(sha256(token), sha256(secret));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.trim() ? JSON.parse(raw) : undefined;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function main(): Promise<void> {
  const client = new PlasmicClient({
    host: requireEnv("PLASMIC_HOST"),
    email: requireEnv("PLASMIC_EMAIL"),
    password: requireEnv("PLASMIC_PASSWORD"),
    userAgent: process.env.PLASMIC_USER_AGENT,
  });
  const secret = requireEnv("MCP_HTTP_TOKEN");
  const port = Number(process.env.MCP_HTTP_PORT ?? 3010);

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/healthz") {
        return json(res, 200, { ok: true, tools: allTools.length });
      }
      if (!req.url?.startsWith("/mcp")) {
        return json(res, 404, { error: "not found" });
      }
      if (!bearerOk(req, secret)) {
        return json(res, 401, { error: "unauthorized" });
      }
      if (req.method !== "POST") {
        // Stateless mode: no SSE stream, no session to GET/DELETE.
        return json(res, 405, { error: "method not allowed (stateless MCP: POST only)" });
      }
      const body = await readBody(req);
      // Fresh transport+server per request (stateless), shared Plasmic session.
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const mcp = buildServer(client);
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) {
        json(res, 500, { error: (e as Error).message ?? "internal error" });
      } else {
        res.end();
      }
    }
  });

  server.listen(port, () => {
    process.stderr.write(
      `[plasmic-mcp-http] listening on :${port} — ${allTools.length} tools, host=${process.env.PLASMIC_HOST}\n`
    );
  });
}

main().catch((e) => {
  process.stderr.write(`[plasmic-mcp-http] fatal: ${(e as Error)?.message ?? e}\n`);
  process.exit(1);
});

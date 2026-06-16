#!/usr/bin/env node
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PlasmicClient, PlasmicError } from "./client.js";
import type { ToolDef } from "./tools/types.js";
import { readTools } from "./tools/read.js";
import { writeTools } from "./tools/write.js";
import { copilotTools } from "./tools/copilot.js";

export const allTools: ToolDef[] = [...readTools, ...writeTools, ...copilotTools];

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { process.stderr.write(`[plasmic-mcp] missing required env var ${name}. See .env.example.\n`); process.exit(1); }
  return v;
}

function buildServer(client: PlasmicClient): McpServer {
  const server = new McpServer({ name: "plasmic-mcp", version: "0.1.0" });
  for (const def of allTools) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.schema.shape }, async (args: unknown) => {
      try {
        const result = await def.handler(client, args as never);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const err = e instanceof PlasmicError
          ? `Plasmic error [${e.kind ?? "unknown"}${e.status ? ` ${e.status}` : ""}]: ${e.message}`
          : `Error: ${(e as Error)?.message ?? String(e)}`;
        return { isError: true, content: [{ type: "text", text: err }] };
      }
    });
  }
  return server;
}

async function main(): Promise<void> {
  const client = new PlasmicClient({ host: requireEnv("PLASMIC_HOST"), email: requireEnv("PLASMIC_EMAIL"), password: requireEnv("PLASMIC_PASSWORD"), userAgent: process.env.PLASMIC_USER_AGENT });
  const server = buildServer(client);
  await server.connect(new StdioServerTransport());
  process.stderr.write(`[plasmic-mcp] ready — ${allTools.length} tools, host=${process.env.PLASMIC_HOST}\n`);
}

main().catch((e) => { process.stderr.write(`[plasmic-mcp] fatal: ${(e as Error)?.message ?? e}\n`); process.exit(1); });

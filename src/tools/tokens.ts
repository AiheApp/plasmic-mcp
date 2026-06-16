import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env, requireStudioAuth, resolveProjectId } from "../env.js";
import { PlasmicStudioClient } from "../clients/studio.js";

const projectIdParam = z
  .string()
  .optional()
  .describe("Plasmic project ID. Overrides PLASMIC_PROJECT_ID env var — use this to target a different project.");

function makeClient(projectId?: string) {
  requireStudioAuth();
  return new PlasmicStudioClient(
    resolveProjectId(projectId),
    env.apiUser!,
    env.apiToken!,
    env.studioHost
  );
}

export function registerTokenTools(server: McpServer) {
  server.tool(
    "list_tokens",
    "List all design tokens in a Plasmic project (colors, typography, spacing, etc.)",
    {
      projectId: projectIdParam,
      type: z
        .string()
        .optional()
        .describe("Filter by token type, e.g. 'color', 'font-size', 'spacing'"),
    },
    async ({ projectId, type }) => {
      const client = makeClient(projectId);
      const tokens = await client.listTokens();
      const filtered = type
        ? tokens.filter((t) => t.type.toLowerCase().includes(type.toLowerCase()))
        : tokens;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(filtered, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "update_token",
    "Update the value of a Plasmic design token by its ID",
    {
      projectId: projectIdParam,
      tokenId: z.string().describe("The ID of the design token to update"),
      value: z.string().describe("The new value for the token (e.g. '#ff0000' for a color)"),
    },
    async ({ projectId, tokenId, value }) => {
      const client = makeClient(projectId);
      const updated = await client.updateToken(tokenId, value);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(updated, null, 2),
          },
        ],
      };
    }
  );
}

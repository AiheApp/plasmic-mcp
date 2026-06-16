import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env, requireStudioAuth } from "../env.js";
import { PlasmicStudioClient } from "../clients/studio.js";

function makeClient() {
  requireStudioAuth();
  return new PlasmicStudioClient(
    env.projectId!,
    env.apiUser!,
    env.apiToken!,
    env.studioHost
  );
}

export function registerTokenTools(server: McpServer) {
  server.tool(
    "list_tokens",
    "List all design tokens in the Plasmic project (colors, typography, spacing, etc.)",
    {
      type: z
        .string()
        .optional()
        .describe("Filter by token type, e.g. 'color', 'font-size', 'spacing'"),
    },
    async ({ type }) => {
      const client = makeClient();
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
      tokenId: z.string().describe("The ID of the design token to update"),
      value: z.string().describe("The new value for the token (e.g. '#ff0000' for a color)"),
    },
    async ({ tokenId, value }) => {
      const client = makeClient();
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

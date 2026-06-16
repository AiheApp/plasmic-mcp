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

export function registerCanvasTools(server: McpServer) {
  server.tool(
    "list_pages",
    "List all pages in the Plasmic project",
    {},
    async () => {
      const client = makeClient();
      const components = await client.listComponents();
      const pages = components.filter((c) => c.isPage);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              pages.map((p) => ({ id: p.id, name: p.name, path: p.pagePath })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "list_components",
    "List all components in the Plasmic project (including pages)",
    {
      includePages: z.boolean().optional().describe("Include page components (default: true)"),
    },
    async ({ includePages = true }) => {
      const client = makeClient();
      const components = await client.listComponents();
      const filtered = includePages ? components : components.filter((c) => !c.isPage);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              filtered.map((c) => ({
                id: c.id,
                name: c.name,
                isPage: c.isPage,
                path: c.pagePath,
              })),
              null,
              2
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_project_info",
    "Get metadata for the Plasmic project (name, id, branches)",
    {},
    async () => {
      const client = makeClient();
      const project = await client.getProject();
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(project, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "get_project_bundle",
    "Get the full Plasmic project bundle (component tree data, element hierarchy). Warning: response can be large.",
    {
      branchId: z.string().optional().describe("Branch ID to fetch (default: main)"),
    },
    async ({ branchId = "main" }) => {
      const client = makeClient();
      const bundle = await client.getProjectBundle(branchId);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(bundle, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "create_component",
    "Create a new page or sub-component in the Plasmic project",
    {
      name: z.string().describe("Display name for the component"),
      type: z.enum(["page", "component"]).describe("Whether to create a page or a component"),
      pagePath: z
        .string()
        .optional()
        .describe("URL path for the page (e.g. /about). Required when type is 'page'."),
    },
    async ({ name, type, pagePath }) => {
      if (type === "page" && !pagePath) {
        return {
          content: [{ type: "text" as const, text: "pagePath is required when type is 'page'" }],
          isError: true,
        };
      }
      const client = makeClient();
      const component = await client.createComponent(name, type, pagePath);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(component, null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "publish_project",
    "Publish the current state of the Plasmic project to production",
    {},
    async () => {
      const client = makeClient();
      const result = await client.publish();
      return {
        content: [
          {
            type: "text" as const,
            text: result.success ? "Project published successfully." : JSON.stringify(result),
          },
        ],
      };
    }
  );
}

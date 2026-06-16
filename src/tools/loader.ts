import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env, resolveProjectId, resolveProjectToken } from "../env.js";
import { PlasmicLoaderClient } from "../clients/loader.js";

const projectIdParam = z
  .string()
  .optional()
  .describe("Plasmic project ID. Overrides PLASMIC_PROJECT_ID env var.");

const projectTokenParam = z
  .string()
  .optional()
  .describe("Project API token. Overrides PLASMIC_PROJECT_TOKEN env var. Required when projectId differs from the env default.");

function makeClient(projectId?: string, projectToken?: string) {
  return new PlasmicLoaderClient(
    resolveProjectId(projectId),
    resolveProjectToken(projectToken),
    env.studioHost
  );
}

export function registerLoaderTools(server: McpServer) {
  server.tool(
    "loader_list_pages",
    "List all pages via the Plasmic Loader API (includes page paths and metadata)",
    {
      projectId: projectIdParam,
      projectToken: projectTokenParam,
      preview: z.boolean().optional().describe("Use preview mode to see unpublished changes (default: false)"),
    },
    async ({ projectId, projectToken, preview = false }) => {
      const client = makeClient(projectId, projectToken);
      const data = await client.getAllData(preview);
      const pages = data.components.filter((c) => c.isPage);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              pages.map((p) => ({
                id: p.id,
                name: p.name,
                displayName: p.displayName,
                path: p.path,
                metadata: p.metadata,
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
    "loader_list_components",
    "List all components via the Plasmic Loader API",
    {
      projectId: projectIdParam,
      projectToken: projectTokenParam,
      preview: z.boolean().optional().describe("Use preview mode to see unpublished changes (default: false)"),
      pagesOnly: z.boolean().optional().describe("Only return page components (default: false)"),
    },
    async ({ projectId, projectToken, preview = false, pagesOnly = false }) => {
      const client = makeClient(projectId, projectToken);
      const data = await client.getAllData(preview);
      const components = pagesOnly
        ? data.components.filter((c) => c.isPage)
        : data.components;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              components.map((c) => ({
                id: c.id,
                name: c.name,
                displayName: c.displayName,
                isPage: c.isPage,
                path: c.path,
                usedComponents: c.usedComponents,
                metadata: c.metadata,
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
    "loader_get_all_data",
    "Fetch all Plasmic project data via the Loader API (components, pages, project info). Warning: response can be large.",
    {
      projectId: projectIdParam,
      projectToken: projectTokenParam,
      preview: z.boolean().optional().describe("Use preview mode (default: false)"),
    },
    async ({ projectId, projectToken, preview = false }) => {
      const client = makeClient(projectId, projectToken);
      const data = await client.getAllData(preview);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                components: data.components,
                globalGroups: data.globalGroups,
                projects: data.projects,
                activeSplits: data.activeSplits,
                external: data.external,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}

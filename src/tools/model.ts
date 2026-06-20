import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env, resolveProjectId, resolveProjectToken } from "../env.js";
import { PlasmicLoaderClient, type ProjectModelComponent } from "../clients/loader.js";

export function registerModelTools(server: McpServer) {
  server.tool(
    "model_get_component_tree",
    "Read the full Plasmic project model via the Model API. Returns the complete element tree " +
    "for all components with __iid IDs, tplTree (TplTag/TplComponent/TplSlot nodes), " +
    "vsettings (CSS styles per variant), attrs, args, and text content. " +
    "Use componentName to filter to a single component and avoid a very large response. " +
    "Requires PLASMIC_PROJECT_TOKEN (public loader token).",
    {
      projectId: z.string().optional().describe("Plasmic project ID (overrides PLASMIC_PROJECT_ID)"),
      projectToken: z.string().optional().describe("Public project token (overrides PLASMIC_PROJECT_TOKEN)"),
      componentName: z
        .string()
        .optional()
        .describe("Filter to a single component by name. If omitted, returns the full site model."),
      preview: z
        .boolean()
        .optional()
        .describe("Use preview mode (current unsaved state). Default: false (published)."),
    },
    async ({ projectId, projectToken, componentName, preview = false }) => {
      const pid = resolveProjectId(projectId);
      const tok = resolveProjectToken(projectToken);
      const client = new PlasmicLoaderClient(pid, tok, env.studioHost);
      const model = await client.getProjectModel(preview);

      let result: unknown = model;
      if (componentName) {
        const components = model.site?.components ?? [];
        const match = components.find(
          (c: ProjectModelComponent) =>
            c.name?.toLowerCase() === componentName.toLowerCase()
        );
        if (!match) {
          const names = components
            .map((c: ProjectModelComponent) => c.name)
            .filter(Boolean)
            .join(", ");
          throw new Error(
            `Component "${componentName}" not found. Available components: ${names}`
          );
        }
        result = match;
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}

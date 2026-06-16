import { z } from "zod";
import { env, requireProjectToken } from "../env.js";
import { PlasmicLoaderClient } from "../clients/loader.js";
function makeClient() {
    requireProjectToken();
    return new PlasmicLoaderClient(env.projectId, env.projectToken, env.studioHost);
}
export function registerLoaderTools(server) {
    server.tool("loader_list_pages", "List all pages via the Plasmic Loader API (includes page paths and metadata)", {
        preview: z.boolean().optional().describe("Use preview mode to see unpublished changes (default: false)"),
    }, async ({ preview = false }) => {
        const client = makeClient();
        const data = await client.getAllData(preview);
        const pages = data.components.filter((c) => c.isPage);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(pages.map((p) => ({
                        id: p.id,
                        name: p.name,
                        displayName: p.displayName,
                        path: p.path,
                        metadata: p.metadata,
                    })), null, 2),
                },
            ],
        };
    });
    server.tool("loader_list_components", "List all components via the Plasmic Loader API", {
        preview: z.boolean().optional().describe("Use preview mode to see unpublished changes (default: false)"),
        pagesOnly: z.boolean().optional().describe("Only return page components (default: false)"),
    }, async ({ preview = false, pagesOnly = false }) => {
        const client = makeClient();
        const data = await client.getAllData(preview);
        const components = pagesOnly
            ? data.components.filter((c) => c.isPage)
            : data.components;
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(components.map((c) => ({
                        id: c.id,
                        name: c.name,
                        displayName: c.displayName,
                        isPage: c.isPage,
                        path: c.path,
                        usedComponents: c.usedComponents,
                        metadata: c.metadata,
                    })), null, 2),
                },
            ],
        };
    });
    server.tool("loader_get_all_data", "Fetch all Plasmic project data via the Loader API (components, pages, project info). Warning: response can be large.", {
        preview: z.boolean().optional().describe("Use preview mode (default: false)"),
    }, async ({ preview = false }) => {
        const client = makeClient();
        const data = await client.getAllData(preview);
        // Return metadata without the heavy module bundles to keep response manageable
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        components: data.components,
                        globalGroups: data.globalGroups,
                        projects: data.projects,
                        activeSplits: data.activeSplits,
                        external: data.external,
                    }, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=loader.js.map
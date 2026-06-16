import { z } from "zod";
import { env, requireStudioAuth, resolveProjectId } from "../env.js";
import { PlasmicStudioClient } from "../clients/studio.js";
const projectIdParam = z
    .string()
    .optional()
    .describe("Plasmic project ID. Overrides PLASMIC_PROJECT_ID env var — use this to target a different project.");
function makeClient(projectId) {
    requireStudioAuth();
    return new PlasmicStudioClient(resolveProjectId(projectId), env.apiUser, env.apiToken, env.studioHost);
}
export function registerCanvasTools(server) {
    server.tool("list_pages", "List all pages in a Plasmic project", { projectId: projectIdParam }, async ({ projectId }) => {
        const client = makeClient(projectId);
        const components = await client.listComponents();
        const pages = components.filter((c) => c.isPage);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(pages.map((p) => ({ id: p.id, name: p.name, path: p.pagePath })), null, 2),
                },
            ],
        };
    });
    server.tool("list_components", "List all components in a Plasmic project (including pages)", {
        projectId: projectIdParam,
        includePages: z.boolean().optional().describe("Include page components (default: true)"),
    }, async ({ projectId, includePages = true }) => {
        const client = makeClient(projectId);
        const components = await client.listComponents();
        const filtered = includePages ? components : components.filter((c) => !c.isPage);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(filtered.map((c) => ({
                        id: c.id,
                        name: c.name,
                        isPage: c.isPage,
                        path: c.pagePath,
                    })), null, 2),
                },
            ],
        };
    });
    server.tool("get_project_info", "Get metadata for a Plasmic project (name, id, branches)", { projectId: projectIdParam }, async ({ projectId }) => {
        const client = makeClient(projectId);
        const project = await client.getProject();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(project, null, 2),
                },
            ],
        };
    });
    server.tool("get_project_bundle", "Get the full Plasmic project bundle (component tree data, element hierarchy). Warning: response can be large.", {
        projectId: projectIdParam,
        branchId: z.string().optional().describe("Branch ID to fetch (default: main)"),
    }, async ({ projectId, branchId = "main" }) => {
        const client = makeClient(projectId);
        const bundle = await client.getProjectBundle(branchId);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(bundle, null, 2),
                },
            ],
        };
    });
    server.tool("create_component", "Create a new page or sub-component in a Plasmic project", {
        projectId: projectIdParam,
        name: z.string().describe("Display name for the component"),
        type: z.enum(["page", "component"]).describe("Whether to create a page or a component"),
        pagePath: z
            .string()
            .optional()
            .describe("URL path for the page (e.g. /about). Required when type is 'page'."),
    }, async ({ projectId, name, type, pagePath }) => {
        if (type === "page" && !pagePath) {
            return {
                content: [{ type: "text", text: "pagePath is required when type is 'page'" }],
                isError: true,
            };
        }
        const client = makeClient(projectId);
        const component = await client.createComponent(name, type, pagePath);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(component, null, 2),
                },
            ],
        };
    });
    server.tool("publish_project", "Publish the current state of a Plasmic project to production", { projectId: projectIdParam }, async ({ projectId }) => {
        const client = makeClient(projectId);
        const result = await client.publish();
        return {
            content: [
                {
                    type: "text",
                    text: result.success ? "Project published successfully." : JSON.stringify(result),
                },
            ],
        };
    });
}
//# sourceMappingURL=canvas.js.map
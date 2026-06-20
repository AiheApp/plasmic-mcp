import { z } from "zod";
import { env, resolveProjectId } from "../env.js";
import { PlasmicWriteClient, } from "../clients/write.js";
function makeWriteClient(projectId, secretToken) {
    const tok = secretToken ?? env.projectSecretToken;
    if (!tok) {
        throw new Error("The Write API requires a secret project token. " +
            "Pass secretToken as a tool parameter or set PLASMIC_PROJECT_SECRET_TOKEN in your .env file. " +
            "On Plasmic Cloud this is an enterprise feature; self-hosted instances may have different access.");
    }
    return new PlasmicWriteClient(env.studioHost, projectId, tok);
}
const projectIdParam = z.string().optional().describe("Plasmic project ID (overrides PLASMIC_PROJECT_ID)");
const secretTokenParam = z
    .string()
    .optional()
    .describe("Write API secret token (overrides PLASMIC_PROJECT_SECRET_TOKEN)");
const componentBodySchema = z.lazy(() => z.object({
    type: z
        .string()
        .describe('Element type. Common values: "hbox" (horizontal flex), "vbox" (vertical flex), ' +
        '"text" (text node, use value field), "img", "button", "input", "a". ' +
        "Same system as Plasmic code-components element types."),
    value: z.string().optional().describe('Text content for "text" nodes'),
    children: z.array(componentBodySchema).optional(),
}).passthrough());
export function registerWriteTools(server) {
    server.tool("write_create_component", "Create a new page or component in Plasmic via the Write API. " +
        "The body uses the same element type system as code components (hbox, vbox, text, img, button, etc.). " +
        "Note: calling this will cause the project to refresh for anyone with it open in Studio. " +
        "Requires PLASMIC_PROJECT_SECRET_TOKEN.", {
        projectId: projectIdParam,
        secretToken: secretTokenParam,
        name: z.string().describe("Unique name for the new component or page"),
        path: z
            .string()
            .optional()
            .describe('URL path for pages (e.g. "/home"). Omit for non-page components.'),
        body: componentBodySchema.optional().describe("Element tree for the component body. Example: " +
            '{ "type": "vbox", "children": [{ "type": "text", "value": "Hello" }] }'),
    }, async ({ projectId, secretToken, name, path, body }) => {
        const pid = resolveProjectId(projectId);
        const client = makeWriteClient(pid, secretToken);
        const result = await client.updateProject({
            newComponents: [{ name, ...(path ? { path } : {}), ...(body ? { body } : {}) }],
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    });
    server.tool("write_update_component", "Update (upsert) an existing Plasmic component's body via the Write API. " +
        "Select the component by name, path, or UUID. Replaces the entire component body. " +
        "Note: calling this will cause the project to refresh for anyone with it open in Studio. " +
        "Requires PLASMIC_PROJECT_SECRET_TOKEN.", {
        projectId: projectIdParam,
        secretToken: secretTokenParam,
        name: z.string().optional().describe("Select component by name"),
        path: z.string().optional().describe("Select component by URL path"),
        byUuid: z.string().optional().describe("Select component by UUID"),
        body: componentBodySchema.describe("New element tree body to replace the component with. " +
            'Example: { "type": "vbox", "children": [{ "type": "text", "value": "Updated" }] }'),
    }, async ({ projectId, secretToken, name, path, byUuid, body }) => {
        const pid = resolveProjectId(projectId);
        if (!name && !path && !byUuid) {
            throw new Error("At least one of name, path, or byUuid is required to select the component.");
        }
        const spec = {
            ...(byUuid ? { byUuid } : {}),
            ...(name ? { name } : {}),
            ...(path ? { path } : {}),
            body,
        };
        const client = makeWriteClient(pid, secretToken);
        const result = await client.updateProject({ updateComponents: [spec] });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    });
    server.tool("write_update_tokens", "Update design tokens in a Plasmic project via the Write API. " +
        "Supported token types: Color, Spacing, Opacity, LineHeight, FontFamily, FontSize, BoxShadow. " +
        "Tokens are matched by name and upserted. " +
        "Requires PLASMIC_PROJECT_SECRET_TOKEN.", {
        projectId: projectIdParam,
        secretToken: secretTokenParam,
        tokens: z
            .array(z.object({
            name: z.string().describe("Token name as it appears in Plasmic"),
            value: z.string().describe('Token value, e.g. "#FF0000" for colors, "16px" for spacing'),
            type: z
                .enum(["Color", "Spacing", "Opacity", "LineHeight", "FontFamily", "FontSize", "BoxShadow"])
                .describe("Token type"),
        }))
            .describe("List of tokens to create or update"),
    }, async ({ projectId, secretToken, tokens }) => {
        const pid = resolveProjectId(projectId);
        const client = makeWriteClient(pid, secretToken);
        const result = await client.updateProject({ tokens: tokens });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    });
}
//# sourceMappingURL=write.js.map
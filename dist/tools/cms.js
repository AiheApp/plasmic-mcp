import { z } from "zod";
import { env, requireCmsConfig } from "../env.js";
import { PlasmicCmsClient } from "../clients/cms.js";
function makeClient() {
    requireCmsConfig();
    return new PlasmicCmsClient(env.cmsDatabaseId, env.cmsPublicToken, env.cmsSecretToken, env.studioHost);
}
export function registerCmsTools(server) {
    server.tool("cms_list_tables", "List all CMS tables (models) in the Plasmic CMS database", {}, async () => {
        const client = makeClient();
        const tables = await client.listTables();
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(tables, null, 2),
                },
            ],
        };
    });
    server.tool("cms_query_rows", "Query rows from a Plasmic CMS table with optional pagination", {
        table: z.string().describe("Table identifier (e.g. 'blog-posts')"),
        limit: z.number().optional().describe("Maximum number of rows to return (default: 20)"),
        offset: z.number().optional().describe("Number of rows to skip for pagination"),
        locale: z.string().optional().describe("Locale code for localized content (e.g. 'en')"),
    }, async ({ table, limit = 20, offset, locale }) => {
        const client = makeClient();
        const result = await client.queryRows(table, { limit, offset, locale });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(result, null, 2),
                },
            ],
        };
    });
    server.tool("cms_get_row", "Get a specific CMS row by its ID", {
        table: z.string().describe("Table identifier"),
        rowId: z.string().describe("Row ID"),
    }, async ({ table, rowId }) => {
        const client = makeClient();
        const row = await client.getRow(table, rowId);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(row, null, 2),
                },
            ],
        };
    });
    server.tool("cms_create_row", "Create a new row in a Plasmic CMS table", {
        table: z.string().describe("Table identifier"),
        data: z.record(z.unknown()).describe("Field values for the new row as a JSON object"),
    }, async ({ table, data }) => {
        const client = makeClient();
        const row = await client.createRow(table, data);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(row, null, 2),
                },
            ],
        };
    });
    server.tool("cms_update_row", "Update an existing row in a Plasmic CMS table", {
        table: z.string().describe("Table identifier"),
        rowId: z.string().describe("Row ID to update"),
        data: z.record(z.unknown()).describe("Field values to update as a JSON object (partial update)"),
    }, async ({ table, rowId, data }) => {
        const client = makeClient();
        const row = await client.updateRow(table, rowId, data);
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify(row, null, 2),
                },
            ],
        };
    });
    server.tool("cms_delete_row", "Delete a row from a Plasmic CMS table", {
        table: z.string().describe("Table identifier"),
        rowId: z.string().describe("Row ID to delete"),
    }, async ({ table, rowId }) => {
        const client = makeClient();
        await client.deleteRow(table, rowId);
        return {
            content: [
                {
                    type: "text",
                    text: `Row ${rowId} deleted successfully from table '${table}'.`,
                },
            ],
        };
    });
}
//# sourceMappingURL=cms.js.map
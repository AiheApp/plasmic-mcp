import { z } from "zod";
import { env, resolveCmsCredentials } from "../env.js";
import { PlasmicCmsClient } from "../clients/cms.js";
const databaseIdParam = z
    .string()
    .optional()
    .describe("CMS database ID. Overrides PLASMIC_CMS_DATABASE_ID env var.");
const publicTokenParam = z
    .string()
    .optional()
    .describe("CMS public token. Overrides PLASMIC_CMS_PUBLIC_TOKEN env var.");
const secretTokenParam = z
    .string()
    .optional()
    .describe("CMS secret token for write operations. Overrides PLASMIC_CMS_SECRET_TOKEN env var.");
function makeClient(databaseId, publicToken, secretToken) {
    const resolved = resolveCmsCredentials(databaseId, publicToken);
    return new PlasmicCmsClient(resolved.databaseId, resolved.publicToken, secretToken ?? env.cmsSecretToken, env.studioHost);
}
export function registerCmsTools(server) {
    server.tool("cms_list_tables", "List all CMS tables (models) in a Plasmic CMS database", {
        databaseId: databaseIdParam,
        publicToken: publicTokenParam,
    }, async ({ databaseId, publicToken }) => {
        const client = makeClient(databaseId, publicToken);
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
        databaseId: databaseIdParam,
        publicToken: publicTokenParam,
        table: z.string().describe("Table identifier (e.g. 'blog-posts')"),
        limit: z.number().optional().describe("Maximum number of rows to return (default: 20)"),
        offset: z.number().optional().describe("Number of rows to skip for pagination"),
        locale: z.string().optional().describe("Locale code for localized content (e.g. 'en')"),
    }, async ({ databaseId, publicToken, table, limit = 20, offset, locale }) => {
        const client = makeClient(databaseId, publicToken);
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
        databaseId: databaseIdParam,
        publicToken: publicTokenParam,
        table: z.string().describe("Table identifier"),
        rowId: z.string().describe("Row ID"),
    }, async ({ databaseId, publicToken, table, rowId }) => {
        const client = makeClient(databaseId, publicToken);
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
        databaseId: databaseIdParam,
        publicToken: publicTokenParam,
        secretToken: secretTokenParam,
        table: z.string().describe("Table identifier"),
        data: z.record(z.unknown()).describe("Field values for the new row as a JSON object"),
    }, async ({ databaseId, publicToken, secretToken, table, data }) => {
        const client = makeClient(databaseId, publicToken, secretToken);
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
        databaseId: databaseIdParam,
        publicToken: publicTokenParam,
        secretToken: secretTokenParam,
        table: z.string().describe("Table identifier"),
        rowId: z.string().describe("Row ID to update"),
        data: z.record(z.unknown()).describe("Field values to update as a JSON object (partial update)"),
    }, async ({ databaseId, publicToken, secretToken, table, rowId, data }) => {
        const client = makeClient(databaseId, publicToken, secretToken);
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
        databaseId: databaseIdParam,
        publicToken: publicTokenParam,
        secretToken: secretTokenParam,
        table: z.string().describe("Table identifier"),
        rowId: z.string().describe("Row ID to delete"),
    }, async ({ databaseId, publicToken, secretToken, table, rowId }) => {
        const client = makeClient(databaseId, publicToken, secretToken);
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
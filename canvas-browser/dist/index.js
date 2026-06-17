#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerStudioBrowserTools } from "./tools/studio-browser.js";
const server = new McpServer({
    name: "plasmic-canvas-mcp",
    version: "0.1.0",
});
registerStudioBrowserTools(server);
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map
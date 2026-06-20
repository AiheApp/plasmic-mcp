#!/usr/bin/env node
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCanvasTools } from "./tools/canvas.js";
import { registerTokenTools } from "./tools/tokens.js";
import { registerLoaderTools } from "./tools/loader.js";
import { registerCmsTools } from "./tools/cms.js";
import { registerModelTools } from "./tools/model.js";
import { registerWriteTools } from "./tools/write.js";
const server = new McpServer({
    name: "plasmic-mcp",
    version: "1.0.0",
});
registerCanvasTools(server);
registerTokenTools(server);
registerLoaderTools(server);
registerCmsTools(server);
registerModelTools(server);
registerWriteTools(server);
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=index.js.map
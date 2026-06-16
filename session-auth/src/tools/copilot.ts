import { defineTool, type ToolDef } from "./types.js";
import { GenerateUiInput } from "../schemas.js";

const COPILOT_TIMEOUT_MS = 60_000;

export const copilotTools: ToolDef[] = [
  defineTool({
    name: "plasmic_generate_ui",
    description: "Generate UI (HTML + design tokens) from a natural-language goal via Plasmic Copilot. Returns { data, response: { html, tokens } }. 60s timeout.",
    schema: GenerateUiInput,
    handler: (client, args) => client.post("/api/v1/copilot/ui", args, COPILOT_TIMEOUT_MS),
  }),
];

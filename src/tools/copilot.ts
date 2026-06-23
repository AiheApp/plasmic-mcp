import { defineTool, type ToolDef } from "./types.js";
import { GenerateUiInput } from "../schemas.js";

/** Copilot UI generation is slow and 503-prone; bound it so a hang can't wedge the tool. */
const COPILOT_TIMEOUT_MS = 60_000;

export const copilotTools: ToolDef[] = [
  defineTool({
    name: "plasmic_generate_ui",
    description:
      "Generate UI (HTML + design tokens) from a natural-language goal and/or reference images via Plasmic Copilot. Returns { data, response: { html, tokens }, copilotInteractionId }. Pass `copilotSystemPromptOverride` to inject your token list. This is authoring-side generation, not in-canvas placement. 60s timeout; 503/timeout surface as structured errors.",
    schema: GenerateUiInput,
    handler: (client, args) =>
      client.post("/api/v1/copilot/ui", args, COPILOT_TIMEOUT_MS),
  }),
];

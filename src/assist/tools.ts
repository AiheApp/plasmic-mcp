/**
 * The curated tool surface the design-assist agent may use.
 *
 * Deliberately EXCLUDES destructive/admin tools (delete_project, set_devflags,
 * grant_revoke, token CRUD, publish, project create/clone) — the assistant
 * mutates page content only. Assembled from the tool modules directly (NOT
 * src/index.ts, which starts the stdio server on import).
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "../tools/types.js";
import { readTools } from "../tools/read.js";
import { modelTools } from "../tools/model.js";

const ALLOWED_READS = new Set([
  "plasmic_get_project_meta",
  "plasmic_list_tokens",
]);

export const assistTools: ToolDef[] = [
  ...readTools.filter((t) => ALLOWED_READS.has(t.name)),
  ...modelTools, // all 10 page/element tools incl. list_pages/get_page_model
];

/** Mutation tools (everything that saves a new revision). */
export const MUTATING_TOOLS = new Set([
  "plasmic_create_page",
  "plasmic_update_page_text",
  "plasmic_add_element",
  "plasmic_delete_element",
  "plasmic_apply_token",
  "plasmic_upsert_component",
  "plasmic_duplicate_page",
]);

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** Convert the zod ToolDefs into Anthropic Messages API tool specs. */
export function toAnthropicTools(defs: ToolDef[]): AnthropicToolSpec[] {
  return defs.map((def) => {
    const schema = zodToJsonSchema(def.schema, { $refStrategy: "none" }) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    return { name: def.name, description: def.description, input_schema: schema };
  });
}

export function toolByName(name: string): ToolDef | undefined {
  return assistTools.find((t) => t.name === name);
}

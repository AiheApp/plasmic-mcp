/**
 * The curated tool surface the design-assist agent may use.
 *
 * Deliberately EXCLUDES destructive/admin tools (delete_project, set_devflags,
 * grant_revoke, token CRUD, publish, project create/clone) — the assistant
 * mutates page content only. Assembled from the tool modules directly (NOT
 * src/index.ts, which starts the stdio server on import).
 *
 * Mutations go exclusively through the atomic batch pair
 * (plasmic_plan_mutations / plasmic_apply_mutations): one plan, one confirm,
 * ONE revision save, and a failed batch applies nothing. The per-op mutation
 * tools (each of which saves its own revision) are excluded so the agent
 * cannot leave a request half-applied.
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import type { ToolDef } from "../tools/types.js";
import { readTools } from "../tools/read.js";
import { modelTools } from "../tools/model.js";
import { batchTools } from "../tools/batch.js";

const ALLOWED_READS = new Set([
  "plasmic_get_project_meta",
  "plasmic_list_tokens",
]);

/**
 * Per-op mutation tools — each saves a revision per call. The content ops are
 * superseded by the batch pair; repair_page_arenas is admin/maintenance, not a
 * design op.
 */
const PER_OP_MUTATORS = new Set([
  "plasmic_create_page",
  "plasmic_update_page_text",
  "plasmic_add_element",
  "plasmic_delete_element",
  "plasmic_apply_token",
  "plasmic_upsert_component",
  "plasmic_duplicate_page",
  "plasmic_repair_page_arenas",
]);

export const assistTools: ToolDef[] = [
  ...readTools.filter((t) => ALLOWED_READS.has(t.name)),
  ...modelTools.filter((t) => !PER_OP_MUTATORS.has(t.name)), // read-only survivors: list_pages, get_page_model, get_element
  ...batchTools, // plasmic_plan_mutations, plasmic_apply_mutations
];

/** Mutation tools (everything that saves a new revision). */
export const MUTATING_TOOLS = new Set(["plasmic_apply_mutations"]);

/**
 * The plan-phase tool surface: assistTools minus every mutating tool. A loop
 * run with these is PROVABLY incapable of writing to the Studio, regardless
 * of what the model decides — the two-phase /plan endpoint relies on this.
 */
export const planPhaseTools: ToolDef[] = assistTools.filter(
  (t) => !MUTATING_TOOLS.has(t.name)
);

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

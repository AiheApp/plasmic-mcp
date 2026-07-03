/**
 * Atomic batch mutation tools — the preview/confirm protocol:
 *
 *   1. plasmic_plan_mutations  — validate + trial-execute the whole batch
 *      against the current revision WITHOUT saving; returns a diff preview.
 *   2. (caller shows the preview and gets explicit confirmation)
 *   3. plasmic_apply_mutations — re-validate against the fresh head and apply
 *      everything in ONE revision save. Nothing is persisted unless every op
 *      succeeds, so a batch can never partially apply.
 */

import { defineTool, type ToolDef } from "./types.js";
import type { PlasmicClient } from "../client.js";
import { ApplyMutationsInput, PlanMutationsInput } from "../schemas.js";
import { fetchRev, saveRev } from "./revision.js";
import {
  BatchOpError,
  executeOps,
  prevalidateOps,
  summarizeChanges,
  type BatchError,
  type MutationOp,
  type TokenInfo,
} from "../model/index.js";

const enc = encodeURIComponent;

/** Same endpoint as plasmic_list_tokens; normalizes array vs {tokens} shapes. */
async function fetchTokens(
  client: PlasmicClient,
  projectId: string
): Promise<TokenInfo[]> {
  const raw = await client.get<unknown>(
    `/api/v1/projects/${enc(projectId)}/tokens`
  );
  if (Array.isArray(raw)) return raw as TokenInfo[];
  const tokens = (raw as { tokens?: unknown } | null)?.tokens;
  return Array.isArray(tokens) ? (tokens as TokenInfo[]) : [];
}

function refusal(baseRevision: number, errors: BatchError[]) {
  return {
    valid: false,
    applied: false,
    baseRevision,
    errors,
    message:
      "Batch refused — nothing was applied. Fix the listed ops and re-plan.",
  };
}

function renderPreview(
  baseRevision: number,
  opCount: number,
  lines: string[],
  modifiedComponentIids: string[]
): string {
  return [
    `Plan against revision ${baseRevision} (${opCount} op${opCount === 1 ? "" : "s"}, all valid):`,
    ...lines.map((l) => ` ${l}`),
    `Will modify component iids: [${modifiedComponentIids.join(", ")}]`,
  ].join("\n");
}

export const batchTools: ToolDef[] = [
  defineTool({
    name: "plasmic_plan_mutations",
    description:
      "Validate a batch of model mutations WITHOUT saving anything. Trial-executes the ops in order against the current revision and returns baseRevision + a human-readable preview diff, or a structured refusal listing every failing op. Ops can reference earlier ops' outputs via $id placeholders (create_page: iid/rootTpl/rootRs/arena/baseVariant; add_element: iid/rs; duplicate_page: iid/rootTpl/arena). ALWAYS call this first and show the preview to the user before plasmic_apply_mutations.",
    schema: PlanMutationsInput,
    handler: async (client, { projectId, ops }) => {
      const tokens = await fetchTokens(client, projectId);
      const { revision, model } = await fetchRev(client, projectId);
      const typedOps = ops as MutationOp[];
      const pre = prevalidateOps(model, typedOps, { tokens });
      if (pre.length) return refusal(revision, pre);
      try {
        // `model` is a freshly parsed scratch copy — mutations are discarded.
        const { changes, modifiedComponentIids } = executeOps(model, typedOps, {
          tokens,
        });
        const { counts, lines } = summarizeChanges(changes);
        return {
          valid: true,
          applied: false,
          baseRevision: revision,
          summary: counts,
          changes,
          preview: renderPreview(revision, ops.length, lines, modifiedComponentIids),
          nextStep:
            "Show the preview to the user and get explicit confirmation, then call plasmic_apply_mutations with the SAME ops and expectedRevision set to baseRevision.",
        };
      } catch (e) {
        if (e instanceof BatchOpError) return refusal(revision, [e.detail]);
        throw e;
      }
    },
  }),

  defineTool({
    name: "plasmic_apply_mutations",
    description:
      "Atomically apply a batch of model mutations in ONE revision save. Re-validates the whole batch against the fresh head first; if any op fails, NOTHING is saved. Pass expectedRevision (the baseRevision from plasmic_plan_mutations) — if the project has advanced past it the call aborts with REVISION_CONFLICT and you must re-plan. Only call this after the user confirmed a plan preview.",
    schema: ApplyMutationsInput,
    handler: async (client, { projectId, ops, expectedRevision }) => {
      // Fetch tokens BEFORE the revision read to keep the fetch→save window
      // as small as possible (a concurrent Studio save inside the window is
      // last-writer-wins).
      const tokens = await fetchTokens(client, projectId);
      const { revision, model } = await fetchRev(client, projectId);
      if (expectedRevision !== undefined && revision !== expectedRevision) {
        return {
          applied: false,
          code: "REVISION_CONFLICT",
          expectedRevision,
          headRevision: revision,
          message:
            "The project advanced since planning (someone else saved). Re-read the model and re-run plasmic_plan_mutations — do NOT retry apply blindly.",
        };
      }
      const typedOps = ops as MutationOp[];
      const pre = prevalidateOps(model, typedOps, { tokens });
      if (pre.length) return refusal(revision, pre);
      let result;
      try {
        result = executeOps(model, typedOps, { tokens });
      } catch (e) {
        if (e instanceof BatchOpError) return refusal(revision, [e.detail]);
        throw e;
      }
      await saveRev(client, projectId, model, revision, result.modifiedComponentIids);
      const { counts, lines } = summarizeChanges(result.changes);
      return {
        applied: true,
        revision: revision + 1,
        summary: counts,
        applied_ops: lines,
        ids: result.env,
        modifiedComponentIids: result.modifiedComponentIids,
      };
    },
  }),
];

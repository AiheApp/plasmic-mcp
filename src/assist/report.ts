/**
 * The structured result of one design-assist run — what the designer (or the
 * n8n workflow) gets back.
 */

import type { PageDiff } from "./integrity.js";

export type AssistStatus =
  | "done"
  | "needs_clarification"
  | "partial_failure"
  | "failed";

export interface MutationRecord {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** tool return value (mutations include the new revision + created iids) */
  result?: unknown;
  error?: string;
}

export interface AssistReport {
  status: AssistStatus;
  /** designer-facing description of what changed */
  summary: string;
  /** single clarifying question — only for needs_clarification */
  question?: string;
  /** every mutating tool call that was attempted, in order */
  mutations: MutationRecord[];
  /** revision before the run → after the run */
  revisions: { from: number; to: number };
  /** measured page-level diff (element counts, texts) */
  diff: PageDiff[];
  /** dangling-ref / parent-link issues found post-run; empty = clean */
  integrityIssues: string[];
  /** link for the designer to review the change */
  studioUrl: string;
  /** how to revert */
  undo: string;
  /** runtime metadata */
  meta: {
    model: string;
    iterations: number;
    durationMs: number;
    toolCalls: number;
  };
}

/**
 * Derive the final status from what the agent said vs. what actually happened.
 *
 * Order-aware: a failed atomic batch saves NOTHING, so a failure followed by a
 * successful re-plan+apply is a clean `done` — only a failure that was never
 * recovered (the LAST mutation failed) degrades the status.
 */
export function resolveStatus(
  reported: string | undefined,
  mutations: MutationRecord[],
  integrityIssues: string[]
): AssistStatus {
  const succeeded = mutations.filter((m) => m.ok);
  const last = mutations[mutations.length - 1];
  if (reported === "needs_clarification" && succeeded.length === 0) {
    return "needs_clarification";
  }
  if (integrityIssues.length > 0) {
    return succeeded.length > 0 ? "partial_failure" : "failed";
  }
  if (mutations.length > 0 && !last.ok) {
    return succeeded.length > 0 ? "partial_failure" : "failed";
  }
  if (reported === "failed") return "failed";
  return "done";
}

export function defaultUndo(mutations: MutationRecord[], publicUrl: string): string {
  const created: string[] = [];
  for (const m of mutations) {
    if (!m.ok || !m.result || typeof m.result !== "object") continue;
    const r = m.result as Record<string, unknown>;
    for (const key of ["elementIid", "pageIid"]) {
      if (typeof r[key] === "string") created.push(`${key}=${r[key]} (${m.tool})`);
    }
    // batch apply results carry an env map: op $id → {iid, ...}
    if (r.ids && typeof r.ids === "object") {
      for (const [opId, outputs] of Object.entries(r.ids as Record<string, unknown>)) {
        const iid = (outputs as Record<string, unknown> | null)?.iid;
        if (typeof iid === "string") created.push(`${opId}=${iid} (${m.tool})`);
      }
    }
  }
  const lines = [
    `Open ${publicUrl} and use the History panel to restore the revision before this change.`,
  ];
  if (created.length) {
    lines.push(
      `Created nodes that plasmic_delete_element can remove individually: ${created.join(", ")}.`
    );
  }
  return lines.join(" ");
}

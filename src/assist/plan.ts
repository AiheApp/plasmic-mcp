/**
 * The plan phase of the two-phase design-assist protocol: run the agent loop
 * with a tool surface that PROVABLY cannot write (planPhaseTools excludes
 * plasmic_apply_mutations), capture the exact validated ops from the model's
 * plasmic_plan_mutations calls, and return a PlanReport the caller can show
 * to the designer for explicit confirmation.
 *
 * The captured ops come from the tool call's zod-parsed arguments — never from
 * the model restating them — so what the designer confirms is byte-identical
 * to what apply will execute.
 */

import type { PlasmicClient } from "../client.js";
import type { MutationOp } from "../model/index.js";
import type { PlanSuccess } from "../tools/batch.js";
import {
  runAgentLoop,
  type AssistOptions,
  type AssistRequest,
} from "./loop.js";
import type { AnthropicToolSpec } from "./tools.js";
import { planPhaseTools } from "./tools.js";
import type { PageSummary } from "./integrity.js";

export const PLAN_REPORT_TOOL: AnthropicToolSpec = {
  name: "assist_plan_report",
  description:
    "Call exactly once when you are finished planning (or must stop). This ends the run. Use status 'ready' ONLY after a plasmic_plan_mutations call returned valid:true for the ops you intend to apply — the last valid plan is what the designer will confirm. NEVER attempt to apply anything: this session is planning-only.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["ready", "no_changes_needed", "needs_clarification", "failed"],
        description:
          "'ready' = a validated plan awaits confirmation; 'no_changes_needed' = informational answer, nothing to apply; 'needs_clarification' = ask the designer one question; 'failed' = could not produce a valid plan.",
      },
      summary: {
        type: "string",
        description:
          "Designer-facing description of what the plan will change (or the answer / why it failed).",
      },
      question: {
        type: "string",
        description: "The single clarifying question (needs_clarification only).",
      },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  },
};

export type PlanStatus =
  | "ready"
  | "no_changes_needed"
  | "needs_clarification"
  | "failed";

/** What the plan phase hands back to the HTTP layer. */
export interface PlanOutcome {
  status: PlanStatus;
  summary: string;
  question?: string;
  studioUrl: string;
  meta: {
    model: string;
    iterations: number;
    durationMs: number;
    toolCalls: number;
  };
  /** present iff status === "ready" */
  plan?: {
    ops: MutationOp[];
    baseRevision: number;
    preview: string;
    before: PageSummary[];
  };
}

interface CapturedPlan {
  ops: MutationOp[];
  baseRevision: number;
  preview: string;
}

export async function planAssist(
  client: PlasmicClient,
  req: AssistRequest,
  opts: AssistOptions = {}
): Promise<PlanOutcome> {
  let lastValidPlan: CapturedPlan | undefined;

  const outcome = await runAgentLoop(client, req, opts, {
    toolDefs: planPhaseTools,
    terminalTool: PLAN_REPORT_TOOL,
    onToolResult: (name, parsedArgs, result) => {
      if (name !== "plasmic_plan_mutations") return;
      const r = result as Partial<PlanSuccess> | null;
      if (!r || r.valid !== true) return;
      const args = parsedArgs as { ops?: MutationOp[] };
      if (!Array.isArray(args.ops) || args.ops.length === 0) return;
      lastValidPlan = {
        ops: args.ops,
        baseRevision: r.baseRevision as number,
        preview: r.preview ?? "",
      };
    },
  });

  const reported = outcome.reported as
    | { status?: string; summary?: string; question?: string }
    | undefined;

  const meta = {
    model: outcome.model,
    iterations: outcome.iterations,
    durationMs: Date.now() - outcome.start,
    toolCalls: outcome.toolCalls,
  };
  const base = {
    studioUrl: outcome.studioUrl,
    meta,
  };
  const summary =
    reported?.summary ??
    outcome.finalText ??
    "The assistant did not produce a summary.";

  // Don't trust the model's report — same philosophy as resolveStatus:
  // "ready" without a captured valid plan is a failure, not a plan.
  if (reported?.status === "ready") {
    if (!lastValidPlan) {
      return {
        ...base,
        status: "failed",
        summary:
          "The assistant reported a plan was ready but never produced a validated plan. Nothing to confirm — please re-phrase the request.",
      };
    }
    return {
      ...base,
      status: "ready",
      summary,
      plan: { ...lastValidPlan, before: outcome.before },
    };
  }

  if (reported?.status === "needs_clarification") {
    return {
      ...base,
      status: "needs_clarification",
      summary,
      ...(reported.question ? { question: reported.question } : {}),
    };
  }

  if (reported?.status === "no_changes_needed") {
    return { ...base, status: "no_changes_needed", summary };
  }

  // "failed", unknown status, or the model stopped without reporting.
  return { ...base, status: "failed", summary };
}

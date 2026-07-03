/**
 * The design-assist agent loop: designer request in, AssistReport out.
 *
 * parse → read → plan → execute → verify → report, driven by an Anthropic
 * Messages tool loop over the curated in-process tool subset. The run ends
 * when the model calls the synthetic `assist_report` tool (or stops on its
 * own), after which we independently re-read the model, diff it against the
 * pre-run snapshot, and integrity-check it — the report reflects what actually
 * landed, not just what the model claims.
 */

import Anthropic from "@anthropic-ai/sdk";
import { PlasmicError, type PlasmicClient } from "../client.js";
import type { PlasmicModel } from "../model/index.js";
import {
  assistTools,
  MUTATING_TOOLS,
  toAnthropicTools,
  toolByName,
  type AnthropicToolSpec,
} from "./tools.js";
import {
  gatherContext,
  renderSystemPrompt,
  type RenderOptions,
} from "./context.js";
import { checkIntegrity, diffPages, summarizePages } from "./integrity.js";
import {
  defaultUndo,
  resolveStatus,
  type AssistReport,
  type MutationRecord,
} from "./report.js";

export const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TOOL_RESULT_CHARS = 100_000;

const REPORT_TOOL: AnthropicToolSpec = {
  name: "assist_report",
  description:
    "Call exactly once when you are finished (or must stop). This ends the run.",
  input_schema: {
    type: "object",
    properties: {
      status: {
        type: "string",
        enum: ["done", "needs_clarification", "failed"],
        description: "Outcome of the run.",
      },
      summary: {
        type: "string",
        description:
          "Designer-facing description of what changed (per page, elements, texts, tokens, final revision).",
      },
      question: {
        type: "string",
        description: "The single clarifying question (needs_clarification only).",
      },
      undo: {
        type: "string",
        description: "How to revert the change.",
      },
    },
    required: ["status", "summary"],
    additionalProperties: false,
  },
};

interface ReportToolInput {
  status?: string;
  summary?: string;
  question?: string;
  undo?: string;
}

export interface AssistRequest {
  projectId: string;
  request: string;
  /** optional hint: path of the page the designer means */
  pagePath?: string;
}

/** Injectable Messages API for tests. */
export type MessagesCreate = (
  params: Anthropic.MessageCreateParamsNonStreaming
) => Promise<Anthropic.Message>;

export interface AssistOptions {
  model?: string;
  maxIterations?: number;
  maxWallMs?: number;
  apiKey?: string;
  /** public Studio URL for designer-facing links */
  publicStudioUrl?: string;
  templatePath?: string;
  createMessage?: MessagesCreate;
  log?: (line: string) => void;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars — scope the call (e.g. pass pageIid) to see less]`;
}

function toolErrorText(e: unknown): string {
  if (e instanceof PlasmicError) {
    return `Plasmic error [${e.kind ?? "unknown"}${e.status ? ` ${e.status}` : ""}]: ${e.message}`;
  }
  return `Error: ${(e as Error)?.message ?? String(e)}`;
}

export async function runAssist(
  client: PlasmicClient,
  req: AssistRequest,
  opts: AssistOptions = {}
): Promise<AssistReport> {
  const start = Date.now();
  const model = opts.model ?? process.env.ASSIST_MODEL ?? DEFAULT_MODEL;
  const maxIterations = opts.maxIterations ?? 24;
  const maxWallMs = opts.maxWallMs ?? 8 * 60_000;
  const publicStudioUrl =
    opts.publicStudioUrl ??
    process.env.ASSIST_PUBLIC_STUDIO_URL ??
    "https://studio.aihe.dev";
  const log = opts.log ?? (() => {});

  const createMessage: MessagesCreate =
    opts.createMessage ??
    (() => {
      const anthropic = new Anthropic({
        apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      });
      return (params) => anthropic.messages.create(params);
    })();

  // ---- pre-run snapshot ----
  const ctx = await gatherContext(client, req.projectId);
  const before = summarizePages(ctx.model);
  const renderOpts: RenderOptions = {
    projectId: req.projectId,
    studioHost: client.hostUrl,
    publicStudioUrl,
    templatePath: opts.templatePath,
  };
  const system = renderSystemPrompt(ctx, renderOpts);
  const studioUrl = `${publicStudioUrl.replace(/\/+$/, "")}/projects/${req.projectId}`;

  const tools = [...toAnthropicTools(assistTools), REPORT_TOOL];
  const userText = req.pagePath
    ? `${req.request}\n\n(Target page path: ${req.pagePath})`
    : req.request;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userText }];

  const mutations: MutationRecord[] = [];
  let reported: ReportToolInput | undefined;
  let finalText = "";
  let iterations = 0;
  let toolCalls = 0;

  // ---- agent loop ----
  while (iterations < maxIterations && Date.now() - start < maxWallMs) {
    iterations += 1;
    const response = await createMessage({
      model,
      max_tokens: 4096,
      system,
      messages,
      tools: tools as Anthropic.Tool[],
    });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    for (const b of response.content) {
      if (b.type === "text" && b.text.trim()) finalText = b.text.trim();
    }

    if (toolUses.length === 0) break; // model stopped without assist_report

    messages.push({ role: "assistant", content: response.content });
    const results: Anthropic.ToolResultBlockParam[] = [];
    let done = false;

    for (const use of toolUses) {
      if (use.name === REPORT_TOOL.name) {
        reported = use.input as ReportToolInput;
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: "Report received. Run complete.",
        });
        done = true;
        continue;
      }

      toolCalls += 1;
      const def = toolByName(use.name);
      const args = (use.input ?? {}) as Record<string, unknown>;
      const isMutation = MUTATING_TOOLS.has(use.name);
      log(`tool ${use.name} ${JSON.stringify(args).slice(0, 200)}`);

      if (!def) {
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: `Unknown tool: ${use.name}`,
        });
        continue;
      }

      try {
        const parsed = def.schema.parse(args);
        const result = await def.handler(client, parsed as never);
        if (isMutation) mutations.push({ tool: use.name, args, ok: true, result });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          content: truncate(JSON.stringify(result), MAX_TOOL_RESULT_CHARS),
        });
      } catch (e) {
        const err = toolErrorText(e);
        if (isMutation) mutations.push({ tool: use.name, args, ok: false, error: err });
        results.push({
          type: "tool_result",
          tool_use_id: use.id,
          is_error: true,
          content: err,
        });
      }
    }

    messages.push({ role: "user", content: results });
    if (done) break;
  }

  // ---- independent verification ----
  let after: PlasmicModel | undefined;
  let afterRevision = ctx.revision;
  let integrityIssues: string[] = [];
  try {
    const verify = await gatherContext(client, req.projectId);
    after = verify.model;
    afterRevision = verify.revision;
    integrityIssues = checkIntegrity(after);
  } catch (e) {
    integrityIssues = [`verification re-read failed: ${toolErrorText(e)}`];
  }

  const diff = after ? diffPages(before, summarizePages(after)) : [];
  const status = resolveStatus(reported?.status, mutations, integrityIssues);

  return {
    status,
    summary:
      reported?.summary ??
      finalText ??
      "The assistant did not produce a summary.",
    ...(reported?.question ? { question: reported.question } : {}),
    mutations,
    revisions: { from: ctx.revision, to: afterRevision },
    diff,
    integrityIssues,
    studioUrl,
    undo: reported?.undo ?? defaultUndo(mutations, studioUrl),
    meta: { model, iterations, durationMs: Date.now() - start, toolCalls },
  };
}

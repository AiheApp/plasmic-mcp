/**
 * Canvas-browser tools: land HTML into the Studio canvas as real Plasmic
 * nodes, with retry + REST-verified success (no false-green).
 *
 * Flow per insert: open a FRESH Studio session (Playwright) → ensure the
 * target page arena is live → paste via studioCtx.paste (self-hosted,
 * allowHtmlPaste) or PLASMIC_AI_TOOLS.createComponent (Plasmic Cloud) →
 * flush save → poll the REST revision until it advances → diff the REST
 * model to count nodes that actually landed.
 *
 * Every failure surfaces as a CanvasError with a machine-readable `kind`
 * (see docs/canvas-runbook.md for the triage table).
 */
import { z } from "zod";
import { defineTool, type ToolDef } from "./types.js";
import type { PlasmicClient } from "../client.js";
import {
  InsertHtmlInput,
  InsertTemplateInput,
  ListTemplatesInput,
  CanvasDoctorInput,
} from "../schemas.js";
import { CanvasError, StudioDriver, type StudioSession } from "../browser/driver.js";
import {
  ensurePageArena,
  createPageInStudio,
  htmlPasteAllowed,
  pasteHtml,
  createComponentViaAiTools,
  aiToolsAvailable,
  detectBlockingModal,
  flushSave,
  listPagesWithFrames,
  type PageTarget,
  type PasteOutcome,
} from "../browser/canvas-ops.js";
import { fetchRev } from "./revision.js";
import {
  collectDescendants,
  getNode,
  type PlasmicModel,
  type ModelNode,
} from "../model/index.js";
import { TEMPLATES, renderTemplate, unknownTokenRefs } from "../templates/index.js";
import { DS_TOKENS } from "../templates/tokens.js";

const enc = encodeURIComponent;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One driver (one Chromium) per client/process; contexts are per-op inside it.
const drivers = new WeakMap<PlasmicClient, StudioDriver>();
function getDriver(client: PlasmicClient): StudioDriver {
  let d = drivers.get(client);
  if (!d) {
    d = new StudioDriver(client);
    drivers.set(client, d);
  }
  return d;
}

// ---- REST verification helpers -----------------------------------------------

/** Current revision number without downloading model data (cheap poll). */
async function getRevisionNumber(client: PlasmicClient, projectId: string): Promise<number> {
  try {
    const body = (await client.get(
      `/api/v1/projects/${enc(projectId)}/revision-without-data`
    )) as { rev?: { revision?: number }; revision?: number };
    const rev = body?.rev?.revision ?? body?.revision;
    if (typeof rev === "number") return rev;
  } catch {
    // fall through to the heavier fetch
  }
  return (await fetchRev(client, projectId)).revision;
}

/** Iids of a page component plus all its descendants. */
function pageSubtree(model: PlasmicModel, pageIid: string): Set<string> {
  return new Set([pageIid, ...collectDescendants(model, pageIid)]);
}

/**
 * Map a browser-side component uuid to its REST-model map key. Components
 * carry `uuid` as a FIELD; the map is keyed by iid — the two differ.
 */
function componentIidByUuid(model: PlasmicModel, uuid: string): string | null {
  for (const [iid, n] of Object.entries(model.map)) {
    if (n.__type === "Component" && (n as ModelNode & { uuid?: string }).uuid === uuid) {
      return iid;
    }
  }
  return null;
}

interface InsertOpts {
  projectId: string;
  page?: string;
  html: string;
  waitMs?: number;
  verifyNodeCount?: number;
  newPageName?: string;
}

export interface InsertResult {
  success: true;
  method: "paste" | "aiTools";
  page: { uuid: string; name: string; path: string | null };
  /** True when the op had to create the target page (empty project / newPageName). */
  createdPage?: boolean;
  /** Node delta observed in the live canvas (paste path only; -1 on aiTools). */
  tplNodesAdded: number;
  /** Node delta observed in the REST model after save (the authoritative signal). */
  modelNodesAdded: number;
  revisionBefore: number;
  revisionAfter: number;
  pasteAttempts: number;
  durationMs: number;
  warnings?: string[];
}

// ---- the hardened insert -------------------------------------------------------

export async function insertHtmlOp(
  client: PlasmicClient,
  opts: InsertOpts
): Promise<InsertResult> {
  const started = Date.now();
  const html = opts.html.trim();
  if (!html.startsWith("<")) {
    throw new CanvasError(
      "PASTE_FAILED",
      "html must start with '<' after trimming — the Studio web importer rejects anything else"
    );
  }
  const warnings: string[] = [];

  const session: StudioSession = await getDriver(client).openStudio(opts.projectId, {
    waitMs: opts.waitMs,
  });
  try {
    const canPaste = await htmlPasteAllowed(session.studioFrame);
    const canAiTools = !canPaste && (await aiToolsAvailable(session.page));
    if (!canPaste && !canAiTools) {
      throw new CanvasError(
        "HTML_PASTE_DISABLED",
        "no insert path: allowHtmlPaste devflag is off for this account (self-hosted needs an " +
          "admin-team email — see runbook) and PLASMIC_AI_TOOLS is absent (not Plasmic Cloud).",
        { host: client.host }
      );
    }

    // Resolve the target page (paste path only — aiTools creates its own).
    // With no explicit selector and nothing pasteable (empty project, or all
    // pages are frame-less REST creations), create a page via Studio's own
    // flow, which seeds a real arena frame.
    let target: PageTarget | undefined;
    let createdPage = false;
    if (canPaste) {
      if (opts.page) {
        target = await ensurePageArena(session.studioFrame, opts.page, opts.waitMs ?? 15_000);
      } else {
        try {
          target = await ensurePageArena(session.studioFrame, undefined, opts.waitMs ?? 15_000);
        } catch (e) {
          if (!(e instanceof CanvasError) || e.kind !== "CANVAS_NO_FRAME") throw e;
          target = await createPageInStudio(
            session.studioFrame,
            opts.newPageName ?? `Inserted ${new Date().toISOString().slice(0, 16)}`,
            opts.waitMs ?? 30_000
          );
          createdPage = true;
        }
      }
    }

    const revisionBefore = await getRevisionNumber(client, opts.projectId);
    const { model: modelBefore } = await fetchRev(client, opts.projectId);
    const targetIidBefore = target ? componentIidByUuid(modelBefore, target.uuid) : null;
    const beforeSet = targetIidBefore
      ? pageSubtree(modelBefore, targetIidBefore)
      : new Set<string>();
    const modelSizeBefore = Object.keys(modelBefore.map).length;

    let method: InsertResult["method"];
    let pasteAttempts = 0;
    let tplNodesAdded = -1;
    let createdPageName: string | undefined;

    if (canPaste && target) {
      method = "paste";
      let last: PasteOutcome | undefined;
      for (let attempt = 1; attempt <= 3; attempt++) {
        pasteAttempts = attempt;
        last = await pasteHtml(session.studioFrame, target.uuid, html);
        tplNodesAdded = last.nodesAfter - last.nodesBefore;
        if (tplNodesAdded > 0) break;
        if (attempt < 3) await sleep(1000 * attempt);
      }
      if (!last || tplNodesAdded <= 0) {
        throw new CanvasError(
          "PASTE_FAILED",
          `studioCtx.paste did not add nodes after ${pasteAttempts} attempts` +
            (last?.pasteError ? `: ${last.pasteError}` : ""),
          {
            pasteSucceeded: last?.pasteSucceeded,
            nodesBefore: last?.nodesBefore,
            nodesAfter: last?.nodesAfter,
            pasteError: last?.pasteError,
            notifications: last?.notifications,
            page: target,
          }
        );
      }
      if (last.notifications.length) {
        warnings.push(...last.notifications.map((n) => `studio notification: ${n}`));
      }
    } else {
      method = "aiTools";
      pasteAttempts = 1;
      createdPage = true;
      createdPageName =
        opts.newPageName ?? `Inserted ${new Date().toISOString().slice(0, 16)}`;
      const out = await createComponentViaAiTools(session.page, {
        projectId: opts.projectId,
        name: createdPageName,
        html,
      });
      if (!out.available || out.error) {
        throw new CanvasError(
          "PASTE_FAILED",
          `PLASMIC_AI_TOOLS.createComponent failed${out.error ? `: ${out.error}` : ""}`,
          { available: out.available }
        );
      }
    }

    // Persist, then verify via REST — the paste is only real once it survives
    // a round-trip through the server model.
    const flushed = await flushSave(session.studioFrame);
    if (!flushed) warnings.push("flushSave timed out; relying on REST revision poll");

    const verifyDeadline = Date.now() + 20_000;
    let revisionAfter = revisionBefore;
    while (Date.now() < verifyDeadline) {
      revisionAfter = await getRevisionNumber(client, opts.projectId);
      if (revisionAfter > revisionBefore) break;
      await sleep(2000);
    }
    if (revisionAfter <= revisionBefore) {
      throw new CanvasError(
        "VERIFY_TIMEOUT",
        `project revision did not advance past ${revisionBefore} within 20s — the change may not have saved`,
        { revisionBefore, method, pasteAttempts }
      );
    }

    const { model: modelAfter } = await fetchRev(client, opts.projectId);
    let modelNodesAdded: number;
    let pageOut: InsertResult["page"];
    let newIids: string[] = [];

    if (method === "paste" && target) {
      pageOut = { uuid: target.uuid, name: target.name, path: target.path };
      const targetIidAfter = componentIidByUuid(modelAfter, target.uuid);
      if (!targetIidAfter) {
        throw new CanvasError(
          "PASTE_FAILED",
          `page component ${target.uuid} not found in the saved model after paste`,
          { page: pageOut, revisionAfter }
        );
      }
      const afterSet = pageSubtree(modelAfter, targetIidAfter);
      newIids = [...afterSet].filter((iid) => !beforeSet.has(iid));
      modelNodesAdded = newIids.length;
    } else {
      // aiTools created a brand-new page — find it by the name we assigned.
      const compIid = Object.keys(modelAfter.map).find((iid) => {
        const n = modelAfter.map[iid] as ModelNode & { name?: string };
        return n.__type === "Component" && n.name === createdPageName;
      });
      if (!compIid) {
        throw new CanvasError(
          "PASTE_FAILED",
          `createComponent reported success but no component named "${createdPageName}" exists in the model`,
          { modelSizeBefore, modelSizeAfter: Object.keys(modelAfter.map).length }
        );
      }
      newIids = [...pageSubtree(modelAfter, compIid)];
      modelNodesAdded = Object.keys(modelAfter.map).length - modelSizeBefore;
      tplNodesAdded = modelNodesAdded;
      const compUuid =
        (modelAfter.map[compIid] as ModelNode & { uuid?: string }).uuid ?? compIid;
      pageOut = { uuid: compUuid, name: createdPageName!, path: null };
    }

    // False-green guard: markup landing as a text node means allowHtmlPaste
    // silently routed us to pasteText.
    for (const iid of newIids) {
      const n = modelAfter.map[iid] as ModelNode & { text?: unknown };
      if (n?.__type === "RawText" && typeof n.text === "string") {
        const t = n.text.trim();
        if (t.startsWith("<") && html.startsWith(t.slice(0, 40))) {
          throw new CanvasError(
            "PASTED_AS_TEXT",
            "the HTML landed as a raw TEXT node, not as elements — allowHtmlPaste routed the paste " +
              "to pasteText. Delete the text node in Studio and see the runbook's allowHtmlPaste section.",
            { textNodeIid: iid, preview: t.slice(0, 120) }
          );
        }
      }
    }

    const need = opts.verifyNodeCount ?? 1;
    if (modelNodesAdded < need) {
      throw new CanvasError(
        "PASTE_FAILED",
        `REST verify shortfall: expected >= ${need} new model nodes on the page, found ${modelNodesAdded}`,
        { revisionBefore, revisionAfter, tplNodesAdded, modelNodesAdded, page: pageOut }
      );
    }

    return {
      success: true,
      method,
      page: pageOut,
      ...(createdPage ? { createdPage: true } : {}),
      tplNodesAdded,
      modelNodesAdded,
      revisionBefore,
      revisionAfter,
      pasteAttempts,
      durationMs: Date.now() - started,
      ...(warnings.length ? { warnings } : {}),
    };
  } finally {
    await session.close().catch(() => {});
  }
}

// ---- template param schema description (for plasmic_list_templates) ------------

function describeSchema(schema: z.ZodType): unknown {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const typeName = def.typeName as string;
  switch (typeName) {
    case "ZodObject": {
      const shape = (def.shape as () => Record<string, z.ZodType>)();
      return Object.fromEntries(
        Object.entries(shape).map(([k, v]) => [k, describeSchema(v)])
      );
    }
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodEnum":
      return (def.values as string[]).join(" | ");
    case "ZodArray":
      return [describeSchema(def.type as z.ZodType)];
    case "ZodOptional":
      return `${describeSchema(def.innerType as z.ZodType)} (optional)`;
    case "ZodDefault":
      return `${describeSchema(def.innerType as z.ZodType)} (default: ${JSON.stringify(
        (def.defaultValue as () => unknown)()
      )})`;
    default:
      return typeName.replace(/^Zod/, "").toLowerCase();
  }
}

// ---- tools ----------------------------------------------------------------------

export const canvasTools: ToolDef[] = [
  defineTool({
    name: "plasmic_insert_html",
    description:
      "Insert raw HTML into a Studio page as REAL Plasmic nodes (browser-driven studioCtx.paste " +
      "with retry; falls back to PLASMIC_AI_TOOLS.createComponent on Plasmic Cloud). Success is " +
      "REST-verified: the project revision must advance AND new nodes must appear in the saved " +
      "model — no false-green. Use only recognized longhand CSS (see plasmic_list_templates notes) " +
      "and design tokens as var(--token-<kebab-name>). Fails with a structured error kind " +
      "(CANVAS_NO_FRAME, HTML_PASTE_DISABLED, PASTED_AS_TEXT, ...) — run plasmic_canvas_doctor to triage.",
    schema: InsertHtmlInput,
    handler: (client, args) => insertHtmlOp(client, args),
  }),

  defineTool({
    name: "plasmic_insert_template",
    description:
      "Render one of the built-in token-aware HTML templates (see plasmic_list_templates) and " +
      "insert it into a Studio page via the hardened paste path. Validates template params AND " +
      "checks every var(--token-*) reference against the TARGET project's live tokens before " +
      "pasting (tokenPolicy strict|warn). Preferred over plasmic_insert_html for standard sections.",
    schema: InsertTemplateInput,
    handler: async (client, args) => {
      let html: string;
      try {
        html = renderTemplate(args.template, args.params);
      } catch (e) {
        throw new CanvasError("TEMPLATE_ERROR", (e as Error).message, {
          templates: Object.keys(TEMPLATES),
        });
      }

      // Validate token refs against the LIVE target project, not the snapshot —
      // the target may be a fresh project without the design-system tokens.
      const warnings: string[] = [];
      const res = (await client.get(
        `/api/v1/projects/${enc(args.projectId)}/tokens`
      )) as { tokens?: Array<{ name: string }> };
      const liveNames = (res.tokens ?? []).map((t) => t.name);
      const unknown = unknownTokenRefs(html, liveNames);
      if (unknown.length) {
        const msg =
          `rendered HTML references ${unknown.length} design token(s) missing from project ` +
          `${args.projectId}: ${unknown.join(", ")}. Clone the token project ` +
          `(plasmic_clone_project) or import its tokens, or pass tokenPolicy:"warn" to paste ` +
          `anyway with unbound var() refs.`;
        if ((args.tokenPolicy ?? "strict") === "strict") {
          throw new CanvasError("UNKNOWN_TOKENS", msg, {
            unknownTokens: unknown,
            liveTokenCount: liveNames.length,
          });
        }
        warnings.push(msg);
      }

      const result = await insertHtmlOp(client, {
        projectId: args.projectId,
        page: args.page,
        html,
        waitMs: args.waitMs,
        verifyNodeCount: args.verifyNodeCount,
        newPageName: args.newPageName,
      });
      return {
        template: args.template,
        ...result,
        ...(warnings.length
          ? { warnings: [...(result.warnings ?? []), ...warnings] }
          : {}),
      };
    },
  }),

  defineTool({
    name: "plasmic_list_templates",
    description:
      "List the built-in token-aware HTML templates for plasmic_insert_template: name, " +
      "description, param schema, and which design tokens each references. Also returns the " +
      "known token var names so callers can compose custom HTML for plasmic_insert_html.",
    schema: ListTemplatesInput,
    handler: async () => ({
      templates: Object.values(TEMPLATES).map((t) => ({
        name: t.name,
        description: t.description,
        params: describeSchema(t.schema),
        tokensUsed: t.tokensUsed,
      })),
      tokenVarUsage:
        "Reference design tokens in HTML as var(--token-<kebab-name>), e.g. " +
        "background: var(--token-primary-base). The Studio importer rewrites them to the " +
        "project's token uuids on paste; names are matched case-insensitively (camelCase " +
        "normalization). Only longhand CSS properties survive the importer.",
      tokenVars: DS_TOKENS.map((t) => ({ varName: t.varName, type: t.type, value: t.value })),
    }),
  }),

  defineTool({
    name: "plasmic_canvas_doctor",
    description:
      "Read-only diagnostic for the canvas insert path: REST auth + revision, token count, " +
      "Studio reachability, blocking modals (e.g. unregistered code components), allowHtmlPaste " +
      "devflag, PLASMIC_AI_TOOLS presence, and per-page arena frame counts (pages with 0 frames " +
      "cannot receive pastes). Run this first when plasmic_insert_html/plasmic_insert_template fail.",
    schema: CanvasDoctorInput,
    handler: async (client, args) => {
      const problems: string[] = [];
      const report: Record<string, unknown> = {
        host: client.host,
        projectId: args.projectId,
      };

      try {
        report.revision = await getRevisionNumber(client, args.projectId);
        report.restAuth = true;
      } catch (e) {
        report.restAuth = false;
        problems.push(`REST access failed: ${(e as Error).message}`);
      }

      try {
        const res = (await client.get(
          `/api/v1/projects/${enc(args.projectId)}/tokens`
        )) as { tokens?: unknown[] };
        report.tokenCount = res.tokens?.length ?? 0;
        if (!res.tokens?.length) {
          problems.push(
            "project has 0 design tokens — template var(--token-*) refs will not bind " +
              "(clone the token project or use tokenPolicy:'warn')"
          );
        }
      } catch (e) {
        problems.push(`token list failed: ${(e as Error).message}`);
      }

      let session: StudioSession | undefined;
      try {
        session = await getDriver(client).openStudio(args.projectId);
        report.studioReachable = true;

        const modal = await detectBlockingModal(session.studioFrame);
        report.blockingModal = modal;
        if (modal) {
          problems.push(
            `BLOCKING_MODAL: Studio is blocked by a modal that requires a manual decision: ` +
              `"${modal.slice(0, 200)}" — inserts will fail until it is resolved in Studio ` +
              `(often an unregistered code component; see docs/canvas-runbook.md#blocking_modal)`
          );
        }

        report.allowHtmlPaste = await htmlPasteAllowed(session.studioFrame);
        report.aiToolsAvailable = await aiToolsAvailable(session.page);
        if (!report.allowHtmlPaste && !report.aiToolsAvailable) {
          problems.push(
            "no insert path: allowHtmlPaste is OFF (needs admin-team email on self-hosted; " +
              "see runbook) and PLASMIC_AI_TOOLS is absent"
          );
        }

        const pages = await listPagesWithFrames(session.studioFrame);
        report.pages = pages;
        for (const p of pages.filter((p) => p.frameCount === 0)) {
          problems.push(
            `page "${p.name}" (${p.path ?? p.uuid}) has 0 arena frames — pastes into it will ` +
              `fail with CANVAS_NO_FRAME (REST-created page; recreate it in Studio)`
          );
        }
        if (args.page) {
          const hit = pages.find(
            (p) => p.uuid === args.page || p.name === args.page || p.path === args.page
          );
          if (!hit) problems.push(`target page "${args.page}" not found`);
          else if (hit.frameCount === 0)
            problems.push(`target page "${args.page}" has no arena frames`);
        }
      } catch (e) {
        report.studioReachable = false;
        const kind = e instanceof CanvasError ? `${e.kind}: ` : "";
        problems.push(`Studio canvas unreachable: ${kind}${(e as Error).message}`);
      } finally {
        await session?.close().catch(() => {});
      }

      report.templates = Object.keys(TEMPLATES);
      return { ok: problems.length === 0, ...report, problems };
    },
  }),
];

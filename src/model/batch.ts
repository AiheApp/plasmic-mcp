/**
 * Atomic batch mutations over the iid graph.
 *
 * A batch is an ordered list of MutationOps. The pipeline is:
 *   prevalidateOps  — static pre-scan, reports ALL statically-detectable
 *                     failures at once without touching the model
 *   executeOps      — trial-executes every op in order against the in-memory
 *                     model (MUTATES it), throwing BatchOpError on the first
 *                     failure. The caller only persists the model when every
 *                     op succeeded, so "no partial apply" holds by
 *                     construction: the sole side effect in the whole pipeline
 *                     is the caller's single revision save at the end.
 *
 * Ops reference each other's outputs via `$<id>` / `$<id>.<field>`
 * placeholders (e.g. an add_element targeting `$hero.rootTpl` of a
 * create_page op with id "hero"). Fields per op type:
 *   create_page    → iid (default), rootTpl, rootRs, arena, baseVariant
 *   duplicate_page → iid (default), rootTpl, arena
 *   add_element    → iid (default), rs
 */

import type { ModelNode, PlasmicModel, Ref, Site } from "./types.js";
import {
  arenaContextOf,
  collectDescendants,
  deleteNode,
  findComponentByTplRoot,
  findPageByPath,
  getNode,
  isRef,
  mergeFragment,
  ownerComponentOf,
  updateRuleSet,
} from "./graph.js";
import { VOID_TAGS } from "./constants.js";
import { buildElement, buildPageArena, buildPageComponent } from "./builders.js";

// ---- op types (kept zod-free; the tool layer validates shapes) --------------

export interface CreatePageOp {
  op: "create_page";
  id?: string;
  name: string;
  path: string;
  text?: string;
}

export interface DuplicatePageOp {
  op: "duplicate_page";
  id?: string;
  /** Exactly one of sourceIid / sourcePath selects the page to clone. */
  sourceIid?: string;
  sourcePath?: string;
  name: string;
  path: string;
}

export interface AddElementOp {
  op: "add_element";
  id?: string;
  /** Literal iid or `$id` / `$id.field` placeholder. */
  parentIid: string;
  tag: string;
  type: string;
  text?: string;
  baseVariantIid?: string;
}

export interface SetTextOp {
  op: "set_text";
  /** Select the page by iid/placeholder... */
  pageIid?: string;
  /** ...or by URL path. One of the two is required. */
  path?: string;
  /** Optional: only update this single RawText node (must be in the page). */
  textIid?: string;
  text: string;
}

export interface DeleteElementOp {
  op: "delete_element";
  iid: string;
}

export interface ApplyTokenOp {
  op: "apply_token";
  rsIid: string;
  prop: string;
  /** Token uuid OR exact token name (e.g. "primary-blue"). */
  token: string;
}

export interface SetStylesOp {
  op: "set_styles";
  rsIid: string;
  /** CSS property map; a null value deletes that property. */
  styles: Record<string, string | null>;
}

export type MutationOp =
  | CreatePageOp
  | DuplicatePageOp
  | AddElementOp
  | SetTextOp
  | DeleteElementOp
  | ApplyTokenOp
  | SetStylesOp;

// ---- context / results -------------------------------------------------------

/** One entry of the project /tokens endpoint (registered + local tokens). */
export interface TokenInfo {
  uuid?: string;
  id?: string;
  name?: string;
  type?: string;
  value?: string;
  [k: string]: unknown;
}

export interface BatchContext {
  tokens: TokenInfo[];
}

export type BatchErrorCode =
  | "UNKNOWN_REF"
  | "TARGET_NOT_FOUND"
  | "PAGE_NOT_FOUND"
  | "TOKEN_NOT_FOUND"
  | "DUPLICATE_OP_ID"
  | "PATH_TAKEN"
  | "NOT_A_RULESET"
  | "INVALID_TARGET"
  | "EXEC_ERROR";

export interface BatchError {
  opIndex: number;
  op: string;
  code: BatchErrorCode;
  message: string;
}

/** Thrown by executeOps on the first failing op. */
export class BatchOpError extends Error {
  readonly detail: BatchError;
  constructor(detail: BatchError) {
    super(`op ${detail.opIndex} (${detail.op}) ${detail.code}: ${detail.message}`);
    this.name = "BatchOpError";
    this.detail = detail;
  }
}

export interface OpChange {
  opIndex: number;
  op: string;
  /** One human-readable line describing what the op did. */
  summary: string;
  /** Outputs (iids) this op produced, keyed by field name. */
  produces?: Record<string, string>;
  /** iid of the Component the change belongs to (for modifiedComponentIids). */
  ownerComponent?: string | null;
}

export interface ExecuteResult {
  changes: OpChange[];
  /** Deduped owner-component iids, in first-touched order. */
  modifiedComponentIids: string[];
  /** Outputs of every op that declared an `id`, for the caller to report. */
  env: Record<string, Record<string, string>>;
}

export interface DiffCounts {
  pagesAdded: number;
  pagesDuplicated: number;
  elementsAdded: number;
  elementsDeleted: number;
  textsChanged: number;
  tokensApplied: number;
  stylesSet: number;
}

export interface DiffSummary {
  counts: DiffCounts;
  /** One line per op, numbered, ready to show a human. */
  lines: string[];
}

// ---- shared helpers -----------------------------------------------------------

/** The canonical RuleSet value wiring a style token (single source of truth). */
export function tokenRefValue(uuid: string): string {
  return `var(--token-${uuid})`;
}

const OUTPUT_FIELDS: Record<string, readonly string[]> = {
  create_page: ["iid", "rootTpl", "rootRs", "arena", "baseVariant"],
  duplicate_page: ["iid", "rootTpl", "arena"],
  add_element: ["iid", "rs"],
};

function isPlaceholder(v: string): boolean {
  return v.startsWith("$");
}

function parsePlaceholder(v: string): { id: string; field: string } {
  const body = v.slice(1);
  const dot = body.indexOf(".");
  if (dot === -1) return { id: body, field: "iid" };
  return { id: body.slice(0, dot), field: body.slice(dot + 1) };
}

function siteOf(model: PlasmicModel): Site {
  return getNode<Site>(model, model.root);
}

/** Pure equivalent of tools/revision.ts baseVariantOf — null instead of throw. */
function deriveBaseVariant(model: PlasmicModel, parentIid: string): string | null {
  const parent = model.map[parentIid] as (ModelNode & { vsettings?: Ref[] }) | undefined;
  const vsRef = parent?.vsettings?.[0];
  if (!vsRef || !isRef(vsRef)) return null;
  const vs = model.map[vsRef.__ref] as (ModelNode & { variants?: Ref[] }) | undefined;
  const varRef = vs?.variants?.[0];
  return varRef && isRef(varRef) ? varRef.__ref : null;
}

/** First vsetting's RuleSet iid of a tpl node, or null. */
function rsOfTpl(model: PlasmicModel, tplIid: string): string | null {
  const tpl = model.map[tplIid] as (ModelNode & { vsettings?: Ref[] }) | undefined;
  const vsRef = tpl?.vsettings?.[0];
  if (!vsRef || !isRef(vsRef)) return null;
  const vs = model.map[vsRef.__ref] as (ModelNode & { rs?: Ref }) | undefined;
  return vs?.rs && isRef(vs.rs) ? vs.rs.__ref : null;
}

function truncate(s: string, max = 48): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---- token resolution ---------------------------------------------------------

function tokenUuid(t: TokenInfo): string | undefined {
  return t.uuid ?? t.id;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const row = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = row[j];
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return row[n];
}

/**
 * Resolve a token reference (uuid or name) against the project token list.
 * Match order: exact uuid → exact name → unique case-insensitive name.
 */
export function resolveToken(
  tokens: TokenInfo[],
  ref: string
): { ok: true; uuid: string; name?: string } | { ok: false; message: string } {
  for (const t of tokens) {
    if (tokenUuid(t) === ref) return { ok: true, uuid: ref, name: t.name };
  }
  const exact = tokens.filter((t) => t.name === ref);
  if (exact.length === 1) {
    const uuid = tokenUuid(exact[0]);
    if (uuid) return { ok: true, uuid, name: exact[0].name };
  }
  const ci = tokens.filter((t) => t.name?.toLowerCase() === ref.toLowerCase());
  if (ci.length === 1) {
    const uuid = tokenUuid(ci[0]);
    if (uuid) return { ok: true, uuid, name: ci[0].name };
  }
  if (ci.length > 1) {
    return {
      ok: false,
      message: `token name "${ref}" is ambiguous (${ci
        .map((t) => t.name)
        .join(", ")}); use the token uuid`,
    };
  }
  const named = tokens.filter((t) => t.name && tokenUuid(t));
  const closest = named
    .map((t) => ({ name: t.name as string, d: levenshtein(ref.toLowerCase(), (t.name as string).toLowerCase()) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((s) => s.name);
  const hint = closest.length ? `; closest names: ${closest.join(", ")}` : "";
  return { ok: false, message: `no token matches "${ref}"${hint}` };
}

// ---- prevalidation --------------------------------------------------------------

/**
 * Static pre-scan of a batch against a model. Reports every statically
 * detectable failure (bad refs, missing targets, unresolvable tokens, taken
 * paths) so a refusal can list them all at once. Does NOT mutate the model.
 * Dynamic interactions (e.g. an op targeting a node deleted earlier in the
 * same batch) are caught by executeOps' trial execution instead.
 */
export function prevalidateOps(
  model: PlasmicModel,
  ops: MutationOp[],
  ctx: BatchContext
): BatchError[] {
  const errors: BatchError[] = [];
  const declared = new Map<string, string>(); // op id -> op type
  const batchPaths = new Set<string>(); // page paths created earlier in the batch

  const err = (opIndex: number, op: string, code: BatchErrorCode, message: string) =>
    errors.push({ opIndex, op, code, message });

  const checkRef = (opIndex: number, op: string, value: string | undefined): void => {
    if (value === undefined) return;
    if (isPlaceholder(value)) {
      const { id, field } = parsePlaceholder(value);
      const declaredType = declared.get(id);
      if (!declaredType) {
        err(
          opIndex,
          op,
          "UNKNOWN_REF",
          `"${value}" does not reference an earlier op's id (ids must be declared before use)`
        );
        return;
      }
      const fields = OUTPUT_FIELDS[declaredType] ?? [];
      if (!fields.includes(field)) {
        err(
          opIndex,
          op,
          "UNKNOWN_REF",
          `"${value}": op "${id}" (${declaredType}) has no output "${field}" (available: ${fields.join(", ")})`
        );
      }
      return;
    }
    if (!(value in model.map)) {
      err(opIndex, op, "TARGET_NOT_FOUND", `iid ${value} not found in the model`);
    }
  };

  ops.forEach((raw, i) => {
    const o = raw;
    // id declaration bookkeeping (only ops that produce outputs carry ids)
    if ("id" in o && o.id !== undefined) {
      if (declared.has(o.id)) {
        err(i, o.op, "DUPLICATE_OP_ID", `op id "${o.id}" is already declared`);
      }
    }

    switch (o.op) {
      case "create_page": {
        if (findPageByPath(model, o.path) || batchPaths.has(o.path)) {
          err(i, o.op, "PATH_TAKEN", `a page already exists at path ${o.path}`);
        }
        batchPaths.add(o.path);
        break;
      }
      case "duplicate_page": {
        const hasIid = o.sourceIid !== undefined;
        const hasPath = o.sourcePath !== undefined;
        if (hasIid === hasPath) {
          err(
            i,
            o.op,
            "INVALID_TARGET",
            "provide exactly one of sourceIid or sourcePath"
          );
        } else if (hasIid) {
          checkRef(i, o.op, o.sourceIid);
        } else if (o.sourcePath && !findPageByPath(model, o.sourcePath)) {
          err(i, o.op, "PAGE_NOT_FOUND", `no page found for path ${o.sourcePath}`);
        }
        if (findPageByPath(model, o.path) || batchPaths.has(o.path)) {
          err(i, o.op, "PATH_TAKEN", `a page already exists at path ${o.path}`);
        }
        batchPaths.add(o.path);
        break;
      }
      case "add_element": {
        checkRef(i, o.op, o.parentIid);
        checkRef(i, o.op, o.baseVariantIid);
        break;
      }
      case "set_text": {
        if (!o.pageIid && !o.path) {
          err(i, o.op, "INVALID_TARGET", "provide pageIid or path to select the page");
        }
        checkRef(i, o.op, o.pageIid);
        if (o.path && !o.pageIid && !findPageByPath(model, o.path) && !batchPaths.has(o.path)) {
          err(i, o.op, "PAGE_NOT_FOUND", `no page found for path ${o.path}`);
        }
        checkRef(i, o.op, o.textIid);
        break;
      }
      case "delete_element": {
        checkRef(i, o.op, o.iid);
        break;
      }
      case "apply_token": {
        checkRef(i, o.op, o.rsIid);
        const res = resolveToken(ctx.tokens, o.token);
        if (!res.ok) err(i, o.op, "TOKEN_NOT_FOUND", res.message);
        break;
      }
      case "set_styles": {
        checkRef(i, o.op, o.rsIid);
        if (Object.keys(o.styles).length === 0) {
          err(i, o.op, "INVALID_TARGET", "styles must contain at least one property");
        }
        break;
      }
    }

    if ("id" in o && o.id !== undefined && !declared.has(o.id)) {
      declared.set(o.id, o.op);
    }
  });

  return errors;
}

// ---- execution ------------------------------------------------------------------

const TPL_TYPES = new Set(["TplTag", "TplComponent", "TplSlot"]);

/**
 * Trial-execute a batch, MUTATING `model` in place. Throws BatchOpError on the
 * first failing op — callers must then discard the model (a freshly parsed
 * bundle) and persist nothing.
 */
export function executeOps(
  model: PlasmicModel,
  ops: MutationOp[],
  ctx: BatchContext
): ExecuteResult {
  const changes: OpChange[] = [];
  const env: Record<string, Record<string, string>> = {};
  const modified: string[] = [];

  const addModified = (iid: string | null | undefined) => {
    if (iid && !modified.includes(iid)) modified.push(iid);
  };

  const fail = (opIndex: number, op: string, code: BatchErrorCode, message: string): never => {
    throw new BatchOpError({ opIndex, op, code, message });
  };

  const resolve = (opIndex: number, op: string, value: string): string => {
    if (!isPlaceholder(value)) {
      if (!(value in model.map)) {
        fail(opIndex, op, "TARGET_NOT_FOUND", `iid ${value} not found in the model`);
      }
      return value;
    }
    const { id, field } = parsePlaceholder(value);
    const outputs = env[id];
    if (!outputs) {
      return fail(
        opIndex,
        op,
        "UNKNOWN_REF",
        `"${value}" does not reference an earlier op's id`
      );
    }
    const iid = outputs[field];
    if (!iid) {
      return fail(
        opIndex,
        op,
        "UNKNOWN_REF",
        `"${value}": no output "${field}" (available: ${Object.keys(outputs).join(", ")})`
      );
    }
    if (!(iid in model.map)) {
      return fail(opIndex, op, "TARGET_NOT_FOUND", `resolved iid ${iid} is no longer in the model`);
    }
    return iid;
  };

  ops.forEach((o, i) => {
    switch (o.op) {
      case "create_page": {
        if (findPageByPath(model, o.path)) {
          fail(i, o.op, "PATH_TAKEN", `a page already exists at path ${o.path}`);
        }
        const frag = buildPageComponent(o.name, o.path, o.text, arenaContextOf(model));
        const { idMap } = mergeFragment(model, frag);
        const pageIid = idMap[frag.pageId];
        const arenaIid = idMap[frag.arenaId];
        const baseVariant = idMap[frag.baseVariantId];
        const s = siteOf(model);
        s.components.push({ __ref: pageIid });
        s.pageArenas.push({ __ref: arenaIid });
        const rootTpl = (getNode(model, pageIid) as ModelNode & { tplTree: Ref }).tplTree.__ref;
        const rootRs = rsOfTpl(model, rootTpl);
        const produces: Record<string, string> = {
          iid: pageIid,
          rootTpl,
          arena: arenaIid,
          baseVariant,
          ...(rootRs ? { rootRs } : {}),
        };
        if (o.id) env[o.id] = produces;
        addModified(pageIid);
        changes.push({
          opIndex: i,
          op: o.op,
          summary: `+ page "${o.name}" at ${o.path}${o.text !== undefined ? ` with text "${truncate(o.text)}"` : ""}`,
          produces,
          ownerComponent: pageIid,
        });
        break;
      }

      case "duplicate_page": {
        let sourceIid: string;
        if (o.sourceIid !== undefined && o.sourcePath === undefined) {
          sourceIid = resolve(i, o.op, o.sourceIid);
        } else if (o.sourcePath !== undefined && o.sourceIid === undefined) {
          const found = findPageByPath(model, o.sourcePath);
          if (!found) {
            return fail(i, o.op, "PAGE_NOT_FOUND", `no page found for path ${o.sourcePath}`);
          }
          sourceIid = found;
        } else {
          return fail(i, o.op, "INVALID_TARGET", "provide exactly one of sourceIid or sourcePath");
        }
        const src = getNode(model, sourceIid) as ModelNode & { type?: string };
        if (src.type !== "page") {
          return fail(i, o.op, "INVALID_TARGET", `source ${sourceIid} is not a page component`);
        }
        if (findPageByPath(model, o.path)) {
          return fail(i, o.op, "PATH_TAKEN", `a page already exists at path ${o.path}`);
        }
        // Clone the component subtree ONLY — the source arena's grids own
        // row/cell/frame nodes a shallow copy would SHARE between the two
        // arenas (and its frame containers would still instance the source
        // page). The clone gets a freshly built arena instead.
        const subtree = new Set<string>([sourceIid, ...collectDescendants(model, sourceIid)]);
        const nodes: Record<string, ModelNode> = {};
        for (const iid of subtree) {
          nodes[iid] = JSON.parse(JSON.stringify(model.map[iid])) as ModelNode;
        }
        const { idMap } = mergeFragment(model, { nodes, rootId: sourceIid });
        const newComp = idMap[sourceIid];
        (getNode(model, newComp) as ModelNode & { name: string }).name = o.name;
        const pmRef = (getNode(model, newComp) as ModelNode & { pageMeta?: Ref | null }).pageMeta;
        if (pmRef && isRef(pmRef)) {
          (getNode(model, pmRef.__ref) as ModelNode & { path: string }).path = o.path;
        }
        const s = siteOf(model);
        s.components.push({ __ref: newComp });
        const cloneBaseVar = (getNode(model, newComp) as ModelNode & { variants?: Ref[] })
          .variants?.[0];
        if (!isRef(cloneBaseVar)) {
          return fail(i, o.op, "INVALID_TARGET", `cloned page ${newComp} has no base variant`);
        }
        const arenaFrag = buildPageArena(newComp, cloneBaseVar.__ref, arenaContextOf(model));
        const { idMap: arenaIdMap } = mergeFragment(model, arenaFrag);
        const newArena = arenaIdMap[arenaFrag.arenaId];
        s.pageArenas.push({ __ref: newArena });
        const rootTpl = (getNode(model, newComp) as ModelNode & { tplTree: Ref }).tplTree.__ref;
        const produces: Record<string, string> = {
          iid: newComp,
          rootTpl,
          arena: newArena,
        };
        if (o.id) env[o.id] = produces;
        addModified(newComp);
        changes.push({
          opIndex: i,
          op: o.op,
          summary: `+ page "${o.name}" at ${o.path} (duplicate of ${o.sourcePath ?? sourceIid})`,
          produces,
          ownerComponent: newComp,
        });
        break;
      }

      case "add_element": {
        const parentIid = resolve(i, o.op, o.parentIid);
        // Deliberate: text-type parents stay allowed — a text tpl's copy lives
        // on VariantSetting.text, and Plasmic rich text legitimately parents
        // tpl nodes under text tags. Void tags can never have children.
        const parentNode = getNode(model, parentIid) as ModelNode & { tag?: string };
        if (parentNode.__type === "TplTag" && VOID_TAGS.has(parentNode.tag ?? "")) {
          return fail(
            i,
            o.op,
            "INVALID_TARGET",
            `parent ${parentIid} is <${parentNode.tag}>, a void element that cannot have children`
          );
        }
        const baseVariantIid = o.baseVariantIid
          ? resolve(i, o.op, o.baseVariantIid)
          : deriveBaseVariant(model, parentIid);
        if (!baseVariantIid) {
          return fail(
            i,
            o.op,
            "EXEC_ERROR",
            `cannot derive a base variant from parent ${parentIid}; pass baseVariantIid`
          );
        }
        const frag = buildElement({
          tag: o.tag,
          type: o.type,
          baseVariantIid,
          text: o.text,
        });
        let merged: { idMap: Record<string, string>; rootIid: string };
        try {
          merged = mergeFragment(model, frag, parentIid);
        } catch (e) {
          return fail(i, o.op, "EXEC_ERROR", (e as Error).message);
        }
        const owner = ownerComponentOf(model, merged.rootIid);
        const produces: Record<string, string> = {
          iid: merged.rootIid,
          rs: merged.idMap[frag.rsId],
        };
        if (o.id) env[o.id] = produces;
        addModified(owner);
        changes.push({
          opIndex: i,
          op: o.op,
          summary: `+ <${o.tag} type=${o.type}>${o.text !== undefined ? ` "${truncate(o.text)}"` : ""} under ${o.parentIid}`,
          produces,
          ownerComponent: owner,
        });
        break;
      }

      case "set_text": {
        let pageIid: string;
        if (o.pageIid) {
          pageIid = resolve(i, o.op, o.pageIid);
        } else if (o.path) {
          const found = findPageByPath(model, o.path);
          if (!found) return fail(i, o.op, "PAGE_NOT_FOUND", `no page found for path ${o.path}`);
          pageIid = found;
        } else {
          return fail(i, o.op, "INVALID_TARGET", "provide pageIid or path to select the page");
        }
        const descendants = collectDescendants(model, pageIid);
        let targets = descendants.filter((iid) => model.map[iid]?.__type === "RawText");
        if (o.textIid) {
          const textIid = resolve(i, o.op, o.textIid);
          if (!targets.includes(textIid)) {
            return fail(
              i,
              o.op,
              "INVALID_TARGET",
              `textIid ${textIid} is not a RawText in page ${pageIid}`
            );
          }
          targets = [textIid];
        }
        if (targets.length === 0) {
          return fail(i, o.op, "INVALID_TARGET", `page ${pageIid} has no RawText nodes to update`);
        }
        for (const iid of targets) {
          (getNode(model, iid) as ModelNode & { text: string }).text = o.text;
        }
        addModified(pageIid);
        changes.push({
          opIndex: i,
          op: o.op,
          summary: `~ text := "${truncate(o.text)}" (${targets.length} node${targets.length === 1 ? "" : "s"} on ${o.path ?? pageIid})`,
          ownerComponent: pageIid,
        });
        break;
      }

      case "delete_element": {
        const iid = resolve(i, o.op, o.iid);
        const node = getNode(model, iid);
        if (!TPL_TYPES.has(node.__type)) {
          return fail(
            i,
            o.op,
            "INVALID_TARGET",
            `${iid} is a ${node.__type}, not a Tpl element — batch delete only removes elements`
          );
        }
        const rootOwner = findComponentByTplRoot(model, iid);
        if (rootOwner) {
          const name = (getNode(model, rootOwner) as { name?: string }).name;
          return fail(
            i,
            o.op,
            "INVALID_TARGET",
            `${iid} is the tplTree root of component ${rootOwner}${name ? ` ("${name}")` : ""} — deleting a page/component root destroys it; delete its children instead`
          );
        }
        const owner = ownerComponentOf(model, iid); // resolve BEFORE delete
        const removedCount = 1 + collectDescendants(model, iid).length;
        deleteNode(model, iid);
        addModified(owner);
        changes.push({
          opIndex: i,
          op: o.op,
          summary: `- element ${iid} (${removedCount} node${removedCount === 1 ? "" : "s"} removed)`,
          ownerComponent: owner,
        });
        break;
      }

      case "apply_token": {
        const rsIid = resolve(i, o.op, o.rsIid);
        const rs = getNode(model, rsIid);
        if (rs.__type !== "RuleSet") {
          return fail(i, o.op, "NOT_A_RULESET", `${rsIid} is a ${rs.__type}, not a RuleSet`);
        }
        const res = resolveToken(ctx.tokens, o.token);
        if (!res.ok) return fail(i, o.op, "TOKEN_NOT_FOUND", res.message);
        const value = tokenRefValue(res.uuid);
        updateRuleSet(model, rsIid, { [o.prop]: value });
        const owner = ownerComponentOf(model, rsIid);
        addModified(owner);
        changes.push({
          opIndex: i,
          op: o.op,
          summary: `~ ${o.prop} := token ${res.name ?? res.uuid} (${value}) on ${o.rsIid}`,
          ownerComponent: owner,
        });
        break;
      }

      case "set_styles": {
        const rsIid = resolve(i, o.op, o.rsIid);
        const rs = getNode(model, rsIid);
        if (rs.__type !== "RuleSet") {
          return fail(i, o.op, "NOT_A_RULESET", `${rsIid} is a ${rs.__type}, not a RuleSet`);
        }
        if (Object.keys(o.styles).length === 0) {
          return fail(i, o.op, "INVALID_TARGET", "styles must contain at least one property");
        }
        updateRuleSet(model, rsIid, o.styles);
        const owner = ownerComponentOf(model, rsIid);
        addModified(owner);
        const props = Object.entries(o.styles)
          .map(([k, v]) => (v === null ? `-${k}` : `${k}: ${truncate(v, 24)}`))
          .join("; ");
        changes.push({
          opIndex: i,
          op: o.op,
          summary: `~ styles { ${truncate(props, 72)} } on ${o.rsIid}`,
          ownerComponent: owner,
        });
        break;
      }
    }
  });

  return { changes, modifiedComponentIids: modified, env };
}

// ---- diff summary ----------------------------------------------------------------

export function summarizeChanges(changes: OpChange[]): DiffSummary {
  const counts: DiffCounts = {
    pagesAdded: 0,
    pagesDuplicated: 0,
    elementsAdded: 0,
    elementsDeleted: 0,
    textsChanged: 0,
    tokensApplied: 0,
    stylesSet: 0,
  };
  for (const c of changes) {
    switch (c.op) {
      case "create_page":
        counts.pagesAdded++;
        break;
      case "duplicate_page":
        counts.pagesDuplicated++;
        break;
      case "add_element":
        counts.elementsAdded++;
        break;
      case "delete_element":
        counts.elementsDeleted++;
        break;
      case "set_text":
        counts.textsChanged++;
        break;
      case "apply_token":
        counts.tokensApplied++;
        break;
      case "set_styles":
        counts.stylesSet++;
        break;
    }
  }
  const width = String(changes.length).length;
  const lines = changes.map(
    (c) => `${String(c.opIndex + 1).padStart(width)}. ${c.op.padEnd(14)} ${c.summary}`
  );
  return { counts, lines };
}

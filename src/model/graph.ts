/**
 * Pure functions over the flat iid-keyed Plasmic bundle graph.
 *
 * All mutation goes through here so the model invariants (see README "Model
 * mutation" + the test suite) hold:
 *   1. every node added to `map` has a `__ref` back-link from its parent
 *   2. `TplTag.parent` always points to the parent's iid
 *   4. every `VariantSetting.variants` ref resolves to a valid variant iid
 * (Invariants 3/5/6/7 are enforced by the builders + tool + serialize layers.)
 */

import type { ModelNode, PlasmicModel, Ref } from "./types.js";
import { DEFAULT_SCREEN_SIZES } from "./constants.js";

// ---- iid allocation ---------------------------------------------------------

const IID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const IID_LEN = 12;

function randomIid(): string {
  let out = "";
  for (let i = 0; i < IID_LEN; i++) {
    out += IID_ALPHABET[Math.floor(Math.random() * IID_ALPHABET.length)];
  }
  return out;
}

/**
 * Allocate a fresh iid: a random 12-char lowercase-alphanumeric id, matching
 * the ground-truth script's `uid()`. The live server accepted these as both
 * map keys and `uuid` values. Collision-checked against `model.map` (and an
 * optional `reserved` set for ids allocated but not yet inserted).
 */
export function allocIid(model: PlasmicModel, reserved?: Set<string>): string {
  let id = randomIid();
  while (id in model.map || reserved?.has(id)) id = randomIid();
  return id;
}

// ---- reference helpers ------------------------------------------------------

export function isRef(v: unknown): v is Ref {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { __ref?: unknown }).__ref === "string"
  );
}

/** Resolve a node by iid. Throws if missing (a missing node = a broken graph). */
export function getNode<T extends ModelNode = ModelNode>(
  model: PlasmicModel,
  iid: string
): T {
  const n = model.map[iid];
  if (!n) throw new Error(`node not found: ${iid}`);
  return n as T;
}

/** Resolve a `{__ref}` (or null) to its node, or null. */
export function deref<T extends ModelNode = ModelNode>(
  model: PlasmicModel,
  ref: Ref | null | undefined
): T | null {
  if (!ref) return null;
  return getNode<T>(model, ref.__ref);
}

// ---- queries ----------------------------------------------------------------

export function findNodesByType(model: PlasmicModel, type: string): string[] {
  return Object.keys(model.map).filter((iid) => model.map[iid].__type === type);
}

/** iid of the page Component whose deref'd `pageMeta.path === path`, else null. */
export function findPageByPath(model: PlasmicModel, path: string): string | null {
  for (const iid of findNodesByType(model, "Component")) {
    const comp = model.map[iid] as ModelNode & { pageMeta?: Ref | null };
    const pm = deref<ModelNode & { path?: string }>(model, comp.pageMeta);
    if (pm && pm.path === path) return iid;
  }
  return null;
}

/** Site facts a PageArena builder needs. */
export interface ArenaContext {
  /** iid of `Site.globalVariant` (frame containers carry a VariantSetting on it). */
  globalVariantIid: string;
  /** One frame per size, per arena row. */
  screenSizes: { width: number; height: number }[];
}

/**
 * Derive the arena-construction context from a live model. Mirrors Studio's
 * `getSiteScreenSizes` (wab/shared/core/sites.ts) — copy the frame sizes of an
 * existing page arena — extended to skip broken (row-less/frame-less) arenas
 * so repair runs on damaged projects still pick up healthy custom sizes.
 * Falls back to `DEFAULT_SCREEN_SIZES`.
 */
export function arenaContextOf(model: PlasmicModel): ArenaContext {
  const site = getNode(model, model.root) as ModelNode & {
    globalVariant?: Ref | null;
    pageArenas?: Ref[];
  };
  if (!isRef(site.globalVariant)) {
    throw new Error("Site has no globalVariant — cannot build page arenas");
  }

  let screenSizes: ArenaContext["screenSizes"] | undefined;
  for (const aRef of site.pageArenas ?? []) {
    if (!isRef(aRef)) continue;
    const arena = model.map[aRef.__ref] as
      | (ModelNode & { matrix?: Ref })
      | undefined;
    const matrix = arena && deref<ModelNode & { rows?: Ref[] }>(model, arena.matrix ?? null);
    const firstRow = deref<ModelNode & { cols?: Ref[] }>(
      model,
      matrix?.rows?.[0] ?? null
    );
    const cols = firstRow?.cols ?? [];
    if (cols.length === 0) continue;
    const sizes: ArenaContext["screenSizes"] = [];
    for (const cRef of cols) {
      const cell = deref<ModelNode & { frame?: Ref }>(model, cRef);
      const frame = deref<ModelNode & { width?: number; height?: number }>(
        model,
        cell?.frame ?? null
      );
      if (frame && typeof frame.width === "number") {
        sizes.push({ width: frame.width, height: frame.height ?? 768 });
      }
    }
    if (sizes.length > 0) {
      screenSizes = sizes;
      break;
    }
  }

  return {
    globalVariantIid: site.globalVariant.__ref,
    screenSizes: screenSizes ?? DEFAULT_SCREEN_SIZES.map((s) => ({ ...s })),
  };
}

/**
 * The iid of the Component that owns `iid` (its tplTree contains this node),
 * or null if it can't be resolved. Used to populate `modifiedComponentIids`.
 * Accepts a TplTag/TplComponent/TplSlot, a VariantSetting, a RuleSet or a
 * RawText and walks up to the owning component.
 */
export function ownerComponentOf(
  model: PlasmicModel,
  iid: string
): string | null {
  const node = model.map[iid];
  if (!node) return null;

  // Resolve the target down to a Tpl node iid.
  let tplIid: string | null = null;
  const t = node.__type;
  if (t === "TplTag" || t === "TplComponent" || t === "TplSlot") {
    tplIid = iid;
  } else if (t === "VariantSetting") {
    tplIid = findTplByVsetting(model, iid);
  } else if (t === "RuleSet" || t === "RawText") {
    const vsIid = findVsettingRef(model, iid, t === "RuleSet" ? "rs" : "text");
    if (vsIid) tplIid = findTplByVsetting(model, vsIid);
  }
  if (!tplIid) return null;

  // Walk up to the root tpl (parent === null).
  let cur = tplIid;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(cur)) return null;
    seen.add(cur);
    const n = model.map[cur] as ModelNode & { parent?: Ref | null };
    if (!n || !isRef(n.parent)) break;
    cur = n.parent.__ref;
  }

  // Find the Component whose tplTree points at this root tpl.
  return findComponentByTplRoot(model, cur);
}

/** iid of the Component whose tplTree IS this tpl node, or null. */
export function findComponentByTplRoot(
  model: PlasmicModel,
  tplIid: string
): string | null {
  for (const compIid of findNodesByType(model, "Component")) {
    const comp = model.map[compIid] as ModelNode & { tplTree?: Ref };
    if (isRef(comp.tplTree) && comp.tplTree.__ref === tplIid) return compIid;
  }
  return null;
}

function findTplByVsetting(model: PlasmicModel, vsIid: string): string | null {
  for (const iid of Object.keys(model.map)) {
    const n = model.map[iid] as ModelNode & { vsettings?: Ref[] };
    if (
      Array.isArray(n.vsettings) &&
      n.vsettings.some((r) => isRef(r) && r.__ref === vsIid)
    ) {
      return iid;
    }
  }
  return null;
}

function findVsettingRef(
  model: PlasmicModel,
  targetIid: string,
  field: "rs" | "text"
): string | null {
  for (const iid of findNodesByType(model, "VariantSetting")) {
    const vs = model.map[iid] as ModelNode & { rs?: Ref; text?: Ref | null };
    const ref = vs[field];
    if (isRef(ref) && ref.__ref === targetIid) return iid;
  }
  return null;
}

// ---- structural helpers -----------------------------------------------------

const TPL_TYPES = new Set(["TplTag", "TplComponent", "TplSlot"]);
function isTpl(node: ModelNode): boolean {
  return TPL_TYPES.has(node.__type);
}

/** The array field a parent stores its structural children in, if any. */
function childArray(parent: ModelNode): Ref[] | undefined {
  if (Array.isArray(parent.children)) return parent.children as Ref[];
  if (Array.isArray(parent.defaultContents))
    return parent.defaultContents as Ref[];
  return undefined;
}

/**
 * The refs a node OWNS (i.e. that must be deleted along with it): structural
 * children plus its variant settings and their rulesets/text.
 */
function ownedRefs(model: PlasmicModel, node: ModelNode): Ref[] {
  const refs: Ref[] = [];
  const push = (v: unknown) => {
    if (isRef(v)) refs.push(v);
    else if (Array.isArray(v)) for (const e of v) if (isRef(e)) refs.push(e);
  };
  switch (node.__type) {
    case "TplTag":
      push(node.children);
      push(node.vsettings);
      break;
    case "TplComponent":
      push(node.vsettings);
      break;
    case "TplSlot":
      push(node.defaultContents);
      push(node.vsettings);
      break;
    case "VariantSetting":
      push(node.rs);
      push(node.text);
      break;
    case "Component":
      push(node.tplTree);
      push(node.variants);
      push(node.pageMeta);
      break;
    case "PageArena":
      push(node.matrix);
      push(node.customMatrix);
      break;
    case "ArenaFrameGrid":
      push(node.rows);
      break;
    case "ArenaFrameRow":
      push(node.cols); // rowKey is a variant REFERENCE, not ownership
      break;
    case "ArenaFrameCell":
      push(node.frame); // cellKey is a variant reference
      break;
    case "ArenaFrame":
      push(node.container);
      break;
    default:
      break;
  }
  return refs;
}

/** All iids owned by the subtree rooted at `iid`, NOT including `iid` itself. */
export function collectDescendants(model: PlasmicModel, iid: string): string[] {
  const out = new Set<string>();
  const walk = (cur: string) => {
    const node = model.map[cur];
    if (!node) return;
    for (const ref of ownedRefs(model, node)) {
      if (!out.has(ref.__ref) && ref.__ref !== iid) {
        out.add(ref.__ref);
        walk(ref.__ref);
      }
    }
  };
  walk(iid);
  return [...out];
}

/** Remove every `{__ref}` (in arrays or as a field value) pointing into `set`. */
function stripRefsInto(model: PlasmicModel, set: Set<string>): void {
  for (const iid of Object.keys(model.map)) {
    if (set.has(iid)) continue; // node itself is being deleted
    const node = model.map[iid] as Record<string, unknown>;
    for (const key of Object.keys(node)) {
      const val = node[key];
      if (isRef(val) && set.has(val.__ref)) {
        node[key] = null;
      } else if (Array.isArray(val)) {
        node[key] = val.filter((e) => !(isRef(e) && set.has(e.__ref)));
      }
    }
  }
}

// ---- mutations --------------------------------------------------------------

/**
 * Insert a single, already-built node under `parentIid`. Allocates the iid,
 * wires the parent's child array (invariant 1), sets `parent`/`uuid` for Tpl
 * nodes (invariant 2), and returns the new iid.
 */
export function insertNode(
  model: PlasmicModel,
  node: ModelNode,
  parentIid: string
): string {
  const parent = getNode(model, parentIid);
  const iid = allocIid(model);
  if (isTpl(node)) {
    node.parent = { __ref: parentIid };
    if ("uuid" in node) node.uuid = iid; // Tpl uuid === its map key
  }
  model.map[iid] = node;
  const arr = childArray(parent);
  if (!arr) {
    throw new Error(
      `parent ${parentIid} (${parent.__type}) has no children array to insert into`
    );
  }
  arr.push({ __ref: iid });
  return iid;
}

/** Delete a node and its whole owned subtree; strip all inbound refs. */
export function deleteNode(model: PlasmicModel, iid: string): void {
  if (!(iid in model.map)) throw new Error(`node not found: ${iid}`);
  const set = new Set<string>([iid, ...collectDescendants(model, iid)]);
  stripRefsInto(model, set);
  for (const dead of set) delete model.map[dead];
}

/**
 * Merge `styles` into a RuleSet's `values`. A `null` value deletes that CSS
 * property; any other string sets it.
 */
export function updateRuleSet(
  model: PlasmicModel,
  rsIid: string,
  styles: Record<string, string | null>
): void {
  const rs = getNode<ModelNode & { values?: Record<string, string> }>(
    model,
    rsIid
  );
  if (rs.__type !== "RuleSet") {
    throw new Error(`node ${rsIid} is not a RuleSet (${rs.__type})`);
  }
  if (!rs.values || typeof rs.values !== "object") rs.values = {};
  for (const [prop, value] of Object.entries(styles)) {
    if (value === null) delete rs.values[prop];
    else rs.values[prop] = value;
  }
}

// ---- fragment merging -------------------------------------------------------

/** A builder's output: nodes keyed by TEMPORARY ids, plus a root temp id. */
export interface Fragment {
  nodes: Record<string, ModelNode>;
  rootId: string;
}

function remapRefsDeep(value: unknown, idMap: Record<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => remapRefsDeep(v, idMap));
  if (isRef(value)) {
    const mapped = idMap[value.__ref];
    return { __ref: mapped ?? value.__ref };
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = remapRefsDeep(v, idMap);
    }
    return out;
  }
  return value;
}

/**
 * Insert a builder fragment into the model: remap every temporary id to a fresh
 * allocated iid, rewrite all internal `{__ref}` links and Tpl `uuid` fields,
 * and (optionally) wire the fragment root under `parentIid`.
 *
 * Returns the temp→real id map and the real iid of the fragment root.
 */
export function mergeFragment(
  model: PlasmicModel,
  fragment: Fragment,
  parentIid?: string
): { idMap: Record<string, string>; rootIid: string } {
  const reserved = new Set<string>();
  const idMap: Record<string, string> = {};
  for (const tempId of Object.keys(fragment.nodes)) {
    const real = allocIid(model, reserved);
    reserved.add(real);
    idMap[tempId] = real;
  }

  for (const [tempId, node] of Object.entries(fragment.nodes)) {
    const real = idMap[tempId];
    const remapped = remapRefsDeep(node, idMap) as ModelNode;
    // Tpl/Component/Variant `uuid` equals its own map key.
    if (typeof remapped.uuid === "string" && remapped.uuid in idMap) {
      remapped.uuid = idMap[remapped.uuid as string];
    }
    model.map[real] = remapped;
  }

  const rootIid = idMap[fragment.rootId];
  if (parentIid !== undefined) {
    const parent = getNode(model, parentIid);
    const rootNode = model.map[rootIid];
    if (isTpl(rootNode)) rootNode.parent = { __ref: parentIid };
    const arr = childArray(parent);
    if (!arr) {
      throw new Error(
        `parent ${parentIid} (${parent.__type}) has no children array to insert into`
      );
    }
    arr.push({ __ref: rootIid });
  }
  return { idMap, rootIid };
}

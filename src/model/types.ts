/**
 * Partial typing of the Plasmic bundle model.
 *
 * The real model has 100+ classes; we type ONLY the fields this library reads
 * or writes and let everything else pass through via an index signature. Field
 * sets are derived from the live-proven `plasmic-add-page.py` node literals and
 * cross-checked against the OSS `model-schema.ts`.
 *
 * Serialization convention (a "bundle"):
 *   - The model is a flat, iid-keyed graph: `{ version, root, map, deps }`.
 *   - `root` is a PLAIN STRING iid (NOT a `{__ref}` object).
 *   - Every node lives in `map` under its iid and carries a `__type` tag.
 *   - Cross-node links are `{ __ref: <iid> }` objects.
 */

/** A reference to another node by its iid. */
export interface Ref {
  __ref: string;
}

/** Base shape shared by every node in `map`. */
export interface ModelNode {
  __type: string;
  [k: string]: unknown;
}

/** The whole parsed bundle. */
export interface PlasmicModel {
  version: string;
  /** iid of the Site node (plain string, not a Ref). */
  root: string;
  map: Record<string, ModelNode>;
  deps: unknown[];
  [k: string]: unknown;
}

// ---- narrow node interfaces (only the touched fields are typed) ----

export interface Site extends ModelNode {
  __type: "Site";
  components: Ref[];
  pageArenas: Ref[];
  arenas: Ref[];
  componentArenas: Ref[];
  styleTokens: Ref[];
  mixins: Ref[];
}

export interface Component extends ModelNode {
  __type: "Component";
  uuid: string;
  name: string;
  tplTree: Ref;
  variants: Ref[];
  variantGroups: Ref[];
  pageMeta: Ref | null;
  codeComponentMeta: Ref | null;
  type: string;
}

export interface TplTag extends ModelNode {
  __type: "TplTag";
  tag: string;
  name: string | null;
  children: Ref[];
  type: string;
  codeGenType: string | null;
  columnsSetting: unknown | null;
  uuid: string;
  parent: Ref | null;
  locked: boolean | null;
  vsettings: Ref[];
}

export interface TplComponent extends ModelNode {
  __type: "TplComponent";
  name: string | null;
  uuid: string;
  parent: Ref | null;
  component: Ref;
  vsettings: Ref[];
}

export interface TplSlot extends ModelNode {
  __type: "TplSlot";
  parent: Ref | null;
  param: Ref;
  defaultContents: Ref[];
  vsettings: Ref[];
}

export interface RawText extends ModelNode {
  __type: "RawText";
  text: string;
  markers: unknown[];
}

export interface VariantSetting extends ModelNode {
  __type: "VariantSetting";
  variants: Ref[];
  args: unknown[];
  attrs: Record<string, unknown>;
  rs: Ref;
  dataCond: unknown | null;
  dataRep: unknown | null;
  text: Ref | null;
  columnsConfig: unknown | null;
}

export interface RuleSet extends ModelNode {
  __type: "RuleSet";
  values: Record<string, string>;
  mixins: Ref[];
  animations: unknown[];
}

export interface Variant extends ModelNode {
  __type: "Variant";
  uuid: string;
  name: string;
  selectors: unknown | null;
  parent: Ref | null;
  forTpl: Ref | null;
}

export interface PageMeta extends ModelNode {
  __type: "PageMeta";
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  title: string | null;
  description: string;
}

export interface PageArena extends ModelNode {
  __type: "PageArena";
  component: Ref;
  matrix: Ref;
  customMatrix: Ref;
}

export interface ArenaFrameGrid extends ModelNode {
  __type: "ArenaFrameGrid";
  rows: unknown[];
}

/** Read-only for this library — typed for `findNodesByType`/reads only. */
export interface Mixin extends ModelNode {
  __type: "Mixin";
  uuid: string;
  name: string;
  rs: Ref;
}

/** Read-only for this library — typed for token lookups only. */
export interface StyleToken extends ModelNode {
  __type: "StyleToken";
  uuid: string;
  name: string;
  type: string;
  value: string;
}

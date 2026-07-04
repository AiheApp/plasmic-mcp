/**
 * Node builders — pure factories that emit self-contained fragments (nodes
 * keyed by TEMPORARY ids) for `mergeFragment` to allocate real iids for.
 *
 * Every field literal here is copied from the live-proven `plasmic-add-page.py`
 * (node objects at lines ~98–163) so the shapes match what the Studio revision
 * endpoint accepts. Do NOT invent extra fields.
 */

import type { ArenaContext, Fragment } from "./graph.js";
import type { ModelNode } from "./types.js";

/** buildElement output: fragment + convenience ids. */
export interface ElementFragment extends Fragment {
  /** iid of the TplTag itself (same as rootId). */
  tplId: string;
  /** iid of the base VariantSetting's RuleSet (for styling). */
  rsId: string;
}

export interface ElementOptions {
  tag: string;
  type: string;
  /** iid of the (already-in-model) base Variant the vsetting targets. */
  baseVariantIid: string;
  /** Optional text content — attaches a RawText child on the vsetting. */
  text?: string;
}

/**
 * Build a single TplTag element with one base VariantSetting + empty RuleSet.
 * If `text` is provided, a RawText is attached to the vsetting's `text` slot.
 */
export function buildElement(opts: ElementOptions): ElementFragment {
  const { tag, type, baseVariantIid, text } = opts;
  const TPL = "elTpl";
  const VS = "elVs";
  const RS = "elRs";
  const RAW = "elRaw";

  const nodes: Record<string, ModelNode> = {
    [RS]: { __type: "RuleSet", values: {}, mixins: [], animations: [] },
    [VS]: {
      __type: "VariantSetting",
      variants: [{ __ref: baseVariantIid }],
      args: [],
      attrs: {},
      rs: { __ref: RS },
      dataCond: null,
      dataRep: null,
      text: text !== undefined ? { __ref: RAW } : null,
      columnsConfig: null,
    },
    [TPL]: {
      __type: "TplTag",
      tag,
      name: null,
      children: [],
      type,
      codeGenType: null,
      columnsSetting: null,
      uuid: TPL,
      parent: null,
      locked: null,
      vsettings: [{ __ref: VS }],
    },
  };
  if (text !== undefined) {
    nodes[RAW] = { __type: "RawText", text, markers: [] };
  }

  return { nodes, rootId: TPL, tplId: TPL, rsId: RS };
}

/**
 * Build a text node (a TplTag of type "text" carrying a RawText). Thin wrapper
 * over `buildElement` — kept as its own export per the library API.
 */
export function buildTextNode(
  text: string,
  baseVariantIid: string
): { nodes: Record<string, ModelNode>; rootId: string } {
  const frag = buildElement({
    tag: "div",
    type: "text",
    baseVariantIid,
    text,
  });
  return { nodes: frag.nodes, rootId: frag.rootId };
}

/**
 * Emit the node set for one healthy PageArena: matrix = one ArenaFrameRow
 * (rowKey = base variant) with one ArenaFrameCell/ArenaFrame per screen size,
 * each frame containing a TplComponent instance of the page carrying a
 * VariantSetting on `Site.globalVariant`; customMatrix = one empty row with
 * `rowKey: null` (a fresh page has no variant combos).
 *
 * Field literals are copied from a live Studio-UI-created page's arena
 * (ground-truth capture 2026-07-04, project t3tfpXFN3QEaydSC1JLsZV) and match
 * Studio's `mkPageArena`/`mkArenaFrame` (wab/shared/page-arenas.ts, Arenas.ts).
 * An empty-grid arena renders "This page is empty" and crashes add-screen-size
 * with `PageArena has no ArenaFrameRow`.
 *
 * `pageId`/`baseVariantId` may be temp ids of the SAME fragment (create) or
 * real iids already in the model (repair/duplicate) — mergeFragment leaves
 * unknown ids untouched.
 */
function arenaNodes(
  prefix: string,
  pageId: string,
  baseVariantId: string,
  arena: ArenaContext
): { nodes: Record<string, ModelNode>; arenaId: string } {
  const ARENA = `${prefix}Arena`;
  const GRID = `${prefix}Grid`;
  const ROW = `${prefix}Row`;
  const CUST_GRID = `${prefix}CustGrid`;
  const CUST_ROW = `${prefix}CustRow`;

  const nodes: Record<string, ModelNode> = {};
  const cellIds: string[] = [];

  arena.screenSizes.forEach(({ width, height }, i) => {
    const CELL = `${prefix}Cell${i}`;
    const FRAME = `${prefix}Frame${i}`;
    const CONT = `${prefix}Cont${i}`;
    const CONT_VS = `${prefix}ContVs${i}`;
    const CONT_RS = `${prefix}ContRs${i}`;

    nodes[CONT_RS] = { __type: "RuleSet", values: {}, mixins: [], animations: null };
    nodes[CONT_VS] = {
      __type: "VariantSetting",
      variants: [{ __ref: arena.globalVariantIid }],
      args: [],
      attrs: {},
      rs: { __ref: CONT_RS },
      dataCond: null,
      dataRep: null,
      text: null,
      columnsConfig: null,
    };
    nodes[CONT] = {
      __type: "TplComponent",
      name: null,
      component: { __ref: pageId },
      uuid: CONT,
      parent: null,
      locked: null,
      vsettings: [{ __ref: CONT_VS }],
    };
    nodes[FRAME] = {
      __type: "ArenaFrame",
      uuid: FRAME,
      width,
      height,
      container: { __ref: CONT },
      lang: "English",
      pinnedVariants: {},
      targetVariants: [{ __ref: baseVariantId }],
      pinnedGlobalVariants: {},
      targetGlobalVariants: [],
      viewMode: "stretch",
      bgColor: null,
      name: "",
      top: null,
      left: null,
    };
    nodes[CELL] = { __type: "ArenaFrameCell", frame: { __ref: FRAME }, cellKey: null };
    cellIds.push(CELL);
  });

  nodes[ROW] = {
    __type: "ArenaFrameRow",
    cols: cellIds.map((id) => ({ __ref: id })),
    rowKey: { __ref: baseVariantId },
  };
  nodes[GRID] = { __type: "ArenaFrameGrid", rows: [{ __ref: ROW }] };
  nodes[CUST_ROW] = { __type: "ArenaFrameRow", cols: [], rowKey: null };
  nodes[CUST_GRID] = { __type: "ArenaFrameGrid", rows: [{ __ref: CUST_ROW }] };
  nodes[ARENA] = {
    __type: "PageArena",
    component: { __ref: pageId },
    matrix: { __ref: GRID },
    customMatrix: { __ref: CUST_GRID },
  };

  return { nodes, arenaId: ARENA };
}

/** buildPageArena output: fragment whose root is the PageArena. */
export interface ArenaFragment extends Fragment {
  /** iid of the PageArena (same as rootId; add to Site.pageArenas). */
  arenaId: string;
}

/**
 * Build a standalone healthy PageArena for an EXISTING page component
 * (`pageIid`/`baseVariantIid` are real iids). Used by duplicate/repair paths.
 */
export function buildPageArena(
  pageIid: string,
  baseVariantIid: string,
  arena: ArenaContext
): ArenaFragment {
  const { nodes, arenaId } = arenaNodes("pa", pageIid, baseVariantIid, arena);
  return { nodes, rootId: arenaId, arenaId };
}

/** buildPageComponent output: fragment + the component/arena/variant ids. */
export interface PageFragment extends Fragment {
  /** iid of the page Component (also rootId). */
  pageId: string;
  /** iid of the PageArena (must be added to Site.pageArenas). */
  arenaId: string;
  /** iid of the base Variant. */
  baseVariantId: string;
}

/**
 * Build a full page: Component(type "page") + base Variant + PageMeta + a root
 * TplTag (with an optional child text node) + a fully-populated PageArena
 * (see `arenaNodes`). Callers derive `arena` from the live model via
 * `arenaContextOf(model)`.
 */
export function buildPageComponent(
  name: string,
  path: string,
  text: string | undefined,
  arena: ArenaContext
): PageFragment {
  const PAGE = "pgComp";
  const BASE_VAR = "pgBaseVar";
  const PAGE_META = "pgMeta";
  const ROOT_TPL = "pgRootTpl";
  const ROOT_VS = "pgRootVs";
  const ROOT_RS = "pgRootRs";
  const TEXT_TPL = "pgTextTpl";
  const TEXT_VS = "pgTextVs";
  const TEXT_RS = "pgTextRs";
  const RAW_TEXT = "pgRawText";

  const hasText = text !== undefined;
  const nodes: Record<string, ModelNode> = {};

  if (hasText) {
    nodes[RAW_TEXT] = { __type: "RawText", text: text as string, markers: [] };
    nodes[TEXT_RS] = {
      __type: "RuleSet",
      values: {},
      mixins: [],
      animations: [],
    };
    nodes[TEXT_VS] = {
      __type: "VariantSetting",
      variants: [{ __ref: BASE_VAR }],
      args: [],
      attrs: {},
      rs: { __ref: TEXT_RS },
      dataCond: null,
      dataRep: null,
      text: { __ref: RAW_TEXT },
      columnsConfig: null,
    };
    nodes[TEXT_TPL] = {
      __type: "TplTag",
      tag: "div",
      name: null,
      children: [],
      type: "text",
      codeGenType: null,
      columnsSetting: null,
      uuid: TEXT_TPL,
      parent: { __ref: ROOT_TPL },
      locked: null,
      vsettings: [{ __ref: TEXT_VS }],
    };
  }

  nodes[ROOT_RS] = { __type: "RuleSet", values: {}, mixins: [], animations: [] };
  nodes[ROOT_VS] = {
    __type: "VariantSetting",
    variants: [{ __ref: BASE_VAR }],
    args: [],
    attrs: {},
    rs: { __ref: ROOT_RS },
    dataCond: null,
    dataRep: null,
    text: null,
    columnsConfig: null,
  };
  nodes[ROOT_TPL] = {
    __type: "TplTag",
    tag: "div",
    name: null,
    children: hasText ? [{ __ref: TEXT_TPL }] : [],
    type: "other",
    codeGenType: null,
    columnsSetting: null,
    uuid: ROOT_TPL,
    parent: null,
    locked: null,
    vsettings: [{ __ref: ROOT_VS }],
  };
  nodes[BASE_VAR] = {
    __type: "Variant",
    uuid: BASE_VAR,
    name: "base",
    selectors: null,
    codeComponentName: null,
    codeComponentVariantKeys: null,
    parent: null,
    mediaQuery: null,
    description: null,
    forTpl: null,
  };
  nodes[PAGE_META] = {
    __type: "PageMeta",
    path,
    params: {},
    query: {},
    title: null,
    description: "",
    canonical: null,
    roleId: null,
    openGraphImage: null,
  };
  nodes[PAGE] = {
    __type: "Component",
    uuid: PAGE,
    name,
    params: [],
    states: [],
    tplTree: { __ref: ROOT_TPL },
    editableByContentEditor: false,
    hiddenFromContentEditor: false,
    variants: [{ __ref: BASE_VAR }],
    variantGroups: [],
    pageMeta: { __ref: PAGE_META },
    codeComponentMeta: null,
    type: "page",
    subComps: [],
    superComp: null,
    plumeInfo: null,
    templateInfo: null,
    metadata: {},
    dataQueries: [],
    serverQueries: [],
    figmaMappings: [],
    alwaysAutoName: false,
    trapsFocus: false,
    updatedAt: null,
  };
  const { nodes: aNodes, arenaId } = arenaNodes("pg", PAGE, BASE_VAR, arena);
  Object.assign(nodes, aNodes);

  return {
    nodes,
    rootId: PAGE,
    pageId: PAGE,
    arenaId,
    baseVariantId: BASE_VAR,
  };
}

/** buildCodeComponent output: fragment + the component id. */
export interface CodeComponentFragment extends Fragment {
  /** iid of the code Component (also rootId). */
  compId: string;
  baseVariantId: string;
}

/**
 * Build a registered code Component (type "code") with its CodeComponentMeta,
 * a base Variant, and an empty root TplTag. No live ground-truth literal exists
 * for code components (unlike pages), so the field set is derived from the OSS
 * `model-schema.ts` CodeComponentMeta class — treat as best-effort pending the
 * local live E2E.
 */
export function buildCodeComponent(
  name: string,
  importPath: string
): CodeComponentFragment {
  const COMP = "ccComp";
  const BASE_VAR = "ccBaseVar";
  const ROOT_TPL = "ccRootTpl";
  const ROOT_VS = "ccRootVs";
  const ROOT_RS = "ccRootRs";
  const CCM = "ccMeta";

  const nodes: Record<string, ModelNode> = {
    [ROOT_RS]: { __type: "RuleSet", values: {}, mixins: [], animations: [] },
    [ROOT_VS]: {
      __type: "VariantSetting",
      variants: [{ __ref: BASE_VAR }],
      args: [],
      attrs: {},
      rs: { __ref: ROOT_RS },
      dataCond: null,
      dataRep: null,
      text: null,
      columnsConfig: null,
    },
    [ROOT_TPL]: {
      __type: "TplTag",
      tag: "div",
      name: null,
      children: [],
      type: "other",
      codeGenType: null,
      columnsSetting: null,
      uuid: ROOT_TPL,
      parent: null,
      locked: null,
      vsettings: [{ __ref: ROOT_VS }],
    },
    [BASE_VAR]: {
      __type: "Variant",
      uuid: BASE_VAR,
      name: "base",
      selectors: null,
      codeComponentName: null,
      codeComponentVariantKeys: null,
      parent: null,
      mediaQuery: null,
      description: null,
      forTpl: null,
    },
    [CCM]: {
      __type: "CodeComponentMeta",
      importPath,
      defaultExport: false,
      displayName: name,
      importName: name,
      description: null,
      section: null,
      thumbnailUrl: null,
      classNameProp: null,
      refProp: null,
      defaultStyles: null,
      defaultDisplay: null,
      isHostLess: false,
      isContext: false,
      isAttachment: false,
      providesData: false,
      hasRef: false,
      isRepeatable: false,
      styleSections: null,
      helpers: null,
      defaultSlotContents: {},
      variants: {},
      refActions: [],
    },
    [COMP]: {
      __type: "Component",
      uuid: COMP,
      name,
      params: [],
      states: [],
      tplTree: { __ref: ROOT_TPL },
      editableByContentEditor: false,
      hiddenFromContentEditor: false,
      variants: [{ __ref: BASE_VAR }],
      variantGroups: [],
      pageMeta: null,
      codeComponentMeta: { __ref: CCM },
      type: "code",
      subComps: [],
      superComp: null,
      plumeInfo: null,
      templateInfo: null,
      metadata: {},
      dataQueries: [],
      serverQueries: [],
      figmaMappings: [],
      alwaysAutoName: false,
      trapsFocus: false,
      updatedAt: null,
    },
  };

  return { nodes, rootId: COMP, compId: COMP, baseVariantId: BASE_VAR };
}

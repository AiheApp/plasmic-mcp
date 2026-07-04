import {
  arenaContextOf,
  buildPageComponent,
  mergeFragment,
  type ModelNode,
  type PlasmicModel,
  type Ref,
} from "../../src/model/index.js";

/**
 * A minimal valid bundle: root Site with empty container arrays plus the
 * mandatory global base Variant (real Sites always have one; frame containers
 * carry a VariantSetting on it).
 */
export function emptySite(): PlasmicModel {
  return {
    version: "0-test",
    root: "sitexxxxxxxx",
    deps: [],
    map: {
      sitexxxxxxxx: {
        __type: "Site",
        components: [],
        pageArenas: [],
        arenas: [],
        componentArenas: [],
        styleTokens: [],
        mixins: [],
        globalVariant: { __ref: "globalvarxxx" },
      },
      globalvarxxx: {
        __type: "Variant",
        uuid: "globalvarxxx",
        name: "base",
        selectors: null,
        codeComponentName: null,
        codeComponentVariantKeys: null,
        parent: null,
        mediaQuery: null,
        description: null,
        forTpl: null,
      },
    },
  };
}

export interface SiteWithPage {
  model: PlasmicModel;
  pageIid: string;
  arenaIid: string;
  baseVariantIid: string;
  rootTplIid: string;
}

/** An empty Site with one page inserted via the library (mirrors create_page). */
export function siteWithPage(
  name = "Home",
  path = "/",
  text: string | undefined = "Hello"
): SiteWithPage {
  const model = emptySite();
  const frag = buildPageComponent(name, path, text, arenaContextOf(model));
  const { idMap } = mergeFragment(model, frag);
  const pageIid = idMap[frag.pageId];
  const arenaIid = idMap[frag.arenaId];
  const baseVariantIid = idMap[frag.baseVariantId];
  const site = model.map[model.root] as ModelNode & {
    components: Ref[];
    pageArenas: Ref[];
  };
  site.components.push({ __ref: pageIid });
  site.pageArenas.push({ __ref: arenaIid });
  const rootTplIid = (model.map[pageIid] as ModelNode & { tplTree: Ref })
    .tplTree.__ref;
  return { model, pageIid, arenaIid, baseVariantIid, rootTplIid };
}

/** Assert every `{__ref}` anywhere in the graph resolves to a real map key. */
export function assertNoOrphanRefs(model: PlasmicModel): void {
  const isRef = (v: unknown): v is Ref =>
    typeof v === "object" &&
    v !== null &&
    typeof (v as { __ref?: unknown }).__ref === "string";
  const check = (v: unknown): void => {
    if (isRef(v)) {
      if (!(v.__ref in model.map)) {
        throw new Error(`orphan ref: ${v.__ref} not in map`);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(check);
      return;
    }
    if (v && typeof v === "object") {
      Object.values(v as Record<string, unknown>).forEach(check);
    }
  };
  for (const node of Object.values(model.map)) check(node);
}

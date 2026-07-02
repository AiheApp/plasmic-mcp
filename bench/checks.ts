/**
 * Model-level checkers for the benchmark. All verification reads the bundle
 * with the typed library directly — the LLM under test is never trusted to
 * grade itself.
 */

import {
  collectDescendants,
  findPageByPath,
  tokenRefValue,
  type ModelNode,
  type PlasmicModel,
  type Ref,
} from "../src/model/index.js";

export function pageIid(model: PlasmicModel, path: string): string | null {
  return findPageByPath(model, path);
}

/** All RawText strings inside a page subtree. */
export function textsInPage(model: PlasmicModel, path: string): string[] {
  const iid = findPageByPath(model, path);
  if (!iid) return [];
  return collectDescendants(model, iid)
    .filter((d) => model.map[d]?.__type === "RawText")
    .map((d) => (model.map[d] as { text: string }).text);
}

/** All RuleSet `values` maps inside a page subtree. */
export function ruleSetsInPage(
  model: PlasmicModel,
  path: string
): Record<string, string>[] {
  const iid = findPageByPath(model, path);
  if (!iid) return [];
  return collectDescendants(model, iid)
    .filter((d) => model.map[d]?.__type === "RuleSet")
    .map((d) => (model.map[d] as { values?: Record<string, string> }).values ?? {});
}

/** True if any RuleSet in the page sets `prop` to the token's CSS var. */
export function pageHasTokenStyle(
  model: PlasmicModel,
  path: string,
  prop: string,
  tokenUuid: string
): boolean {
  return ruleSetsInPage(model, path).some(
    (v) => v[prop] === tokenRefValue(tokenUuid)
  );
}

/** Number of direct children of a page's root tpl. */
export function rootChildCount(model: PlasmicModel, path: string): number {
  const iid = findPageByPath(model, path);
  if (!iid) return -1;
  const rootRef = (model.map[iid] as ModelNode & { tplTree?: Ref }).tplTree;
  if (!rootRef) return -1;
  const root = model.map[rootRef.__ref] as ModelNode & { children?: Ref[] };
  return root.children?.length ?? 0;
}

/**
 * Post-mutation model integrity checks + page summaries for before/after
 * diffs. Pure functions over an already-parsed PlasmicModel.
 */

import {
  collectDescendants,
  deref,
  getNode,
  isRef,
  type ModelNode,
  type PlasmicModel,
  type Ref,
} from "../model/index.js";

/**
 * Scan the whole bundle for structural corruption:
 *  - `root` missing from `map`
 *  - any `{__ref}` pointing at an iid that is not in `map`
 *  - a TplTag/TplComponent child whose `parent` does not point back at its
 *    containing node
 * Returns human-readable issue strings; empty array = clean.
 */
export function checkIntegrity(model: PlasmicModel): string[] {
  const issues: string[] = [];
  if (!(model.root in model.map)) {
    issues.push(`root ${model.root} is missing from map`);
  }

  const visit = (v: unknown, where: string): void => {
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${where}[${i}]`));
      return;
    }
    if (v && typeof v === "object") {
      if (isRef(v)) {
        if (!(v.__ref in model.map)) {
          issues.push(`dangling __ref ${v.__ref} at ${where}`);
        }
        return;
      }
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (k === "__type") continue;
        visit(val, `${where}.${k}`);
      }
    }
  };
  for (const [iid, node] of Object.entries(model.map)) visit(node, iid);

  for (const [iid, node] of Object.entries(model.map)) {
    const children = (node as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (const c of children) {
      if (!isRef(c) || !(c.__ref in model.map)) continue;
      const child = model.map[c.__ref] as ModelNode & { parent?: Ref | null };
      if (child.parent && isRef(child.parent) && child.parent.__ref !== iid) {
        issues.push(
          `child ${c.__ref} has parent ${child.parent.__ref}, expected ${iid}`
        );
      }
    }
  }
  return issues;
}

export interface PageSummary {
  iid: string;
  name: string;
  path: string | null;
  /** node counts by __type across the page subtree */
  counts: Record<string, number>;
  /** RawText values in the page subtree (document order-ish) */
  texts: string[];
}

/** Summarize one page component's subtree. */
export function summarizePage(model: PlasmicModel, pageIid: string): PageSummary {
  const comp = getNode(model, pageIid) as ModelNode & {
    name: string;
    pageMeta?: Ref | null;
  };
  const pm = deref<ModelNode & { path?: string }>(model, comp.pageMeta ?? null);
  const counts: Record<string, number> = {};
  const texts: string[] = [];
  for (const iid of [pageIid, ...collectDescendants(model, pageIid)]) {
    const node = model.map[iid];
    if (!node) continue;
    counts[node.__type] = (counts[node.__type] ?? 0) + 1;
    if (node.__type === "RawText" && typeof node.text === "string") {
      texts.push(node.text);
    }
  }
  return { iid: pageIid, name: comp.name, path: pm?.path ?? null, counts, texts };
}

/** All page components in the bundle, summarized. */
export function summarizePages(model: PlasmicModel): PageSummary[] {
  const out: PageSummary[] = [];
  for (const [iid, node] of Object.entries(model.map)) {
    if (node.__type === "Component" && (node as { type?: string }).type === "page") {
      out.push(summarizePage(model, iid));
    }
  }
  return out.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""));
}

export interface PageDiff {
  page: string;
  path: string | null;
  change: "added" | "removed" | "modified";
  /** e.g. { TplTag: +3, RawText: +2 } */
  countDeltas?: Record<string, number>;
  textsAdded?: string[];
  textsRemoved?: string[];
}

/** Compare two summarizePages() snapshots. */
export function diffPages(before: PageSummary[], after: PageSummary[]): PageDiff[] {
  const byIid = (list: PageSummary[]) => new Map(list.map((p) => [p.iid, p]));
  const b = byIid(before);
  const a = byIid(after);
  const diffs: PageDiff[] = [];

  for (const [iid, pa] of a) {
    const pb = b.get(iid);
    if (!pb) {
      diffs.push({ page: pa.name, path: pa.path, change: "added" });
      continue;
    }
    const countDeltas: Record<string, number> = {};
    for (const t of new Set([...Object.keys(pb.counts), ...Object.keys(pa.counts)])) {
      const d = (pa.counts[t] ?? 0) - (pb.counts[t] ?? 0);
      if (d !== 0) countDeltas[t] = d;
    }
    const textsAdded = pa.texts.filter((t) => !pb.texts.includes(t));
    const textsRemoved = pb.texts.filter((t) => !pa.texts.includes(t));
    if (Object.keys(countDeltas).length || textsAdded.length || textsRemoved.length) {
      diffs.push({
        page: pa.name,
        path: pa.path,
        change: "modified",
        countDeltas,
        textsAdded,
        textsRemoved,
      });
    }
  }
  for (const [iid, pb] of b) {
    if (!a.has(iid)) diffs.push({ page: pb.name, path: pb.path, change: "removed" });
  }
  return diffs;
}

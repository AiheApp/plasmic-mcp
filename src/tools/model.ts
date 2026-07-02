import { defineTool, type ToolDef } from "./types.js";
import { PlasmicError, type PlasmicClient } from "../client.js";
import {
  ListPagesInput,
  GetPageModelInput,
  CreatePageInput,
  UpdatePageTextInput,
  UpdatePageTextCheck,
  AddElementInput,
  DeleteElementInput,
  ApplyTokenInput,
  UpsertComponentInput,
  DuplicatePageInput,
  GetElementInput,
} from "../schemas.js";
import {
  parseModel,
  buildRevisionBody,
  buildPageComponent,
  buildElement,
  buildCodeComponent,
  mergeFragment,
  insertNode,
  deleteNode,
  updateRuleSet,
  collectDescendants,
  findNodesByType,
  findPageByPath,
  ownerComponentOf,
  getNode,
  deref,
  isRef,
  type PlasmicModel,
  type ModelNode,
  type Ref,
} from "../model/index.js";

const enc = encodeURIComponent;

// ---- shared revision plumbing ----------------------------------------------

interface ProjectRev {
  rev: { revision: number; data: string };
}

async function fetchRev(
  client: PlasmicClient,
  projectId: string
): Promise<{ revision: number; model: PlasmicModel }> {
  const body = await client.get<ProjectRev>(`/api/v1/projects/${enc(projectId)}`);
  if (!body?.rev || typeof body.rev.data !== "string") {
    throw new PlasmicError(
      `unexpected project response: missing rev.data`,
      undefined,
      undefined,
      "parse"
    );
  }
  return { revision: body.rev.revision, model: parseModel(body.rev.data) };
}

function saveRev(
  client: PlasmicClient,
  projectId: string,
  model: PlasmicModel,
  currentRevision: number,
  modifiedComponentIids: string[]
): Promise<unknown> {
  const newRev = currentRevision + 1;
  return client.post(
    `/api/v1/projects/${enc(projectId)}/revisions/${newRev}`,
    buildRevisionBody(model, currentRevision, modifiedComponentIids)
  );
}

// ---- small model readers ----------------------------------------------------

function site(model: PlasmicModel): ModelNode & {
  components: Ref[];
  pageArenas: Ref[];
} {
  return getNode(model, model.root) as ModelNode & {
    components: Ref[];
    pageArenas: Ref[];
  };
}

function pageSummary(model: PlasmicModel, iid: string) {
  const comp = getNode(model, iid) as ModelNode & {
    name: string;
    pageMeta?: Ref | null;
  };
  const pm = deref<ModelNode & { path?: string }>(model, comp.pageMeta ?? null);
  return { iid, name: comp.name, path: pm?.path ?? null };
}

/** Resolve a page selector (pageIid or path) to a component iid. */
function resolvePage(
  model: PlasmicModel,
  sel: { pageIid?: string; path?: string }
): string {
  if (sel.pageIid) {
    if (!(sel.pageIid in model.map))
      throw new PlasmicError(`page not found: ${sel.pageIid}`, undefined, undefined, "http");
    return sel.pageIid;
  }
  const iid = sel.path ? findPageByPath(model, sel.path) : null;
  if (!iid)
    throw new PlasmicError(
      `no page found for path ${sel.path}`,
      undefined,
      undefined,
      "http"
    );
  return iid;
}

/** Base variant iid targeted by a parent's first vsetting (for new elements). */
function baseVariantOf(model: PlasmicModel, parentIid: string): string {
  const parent = getNode(model, parentIid) as ModelNode & { vsettings?: Ref[] };
  const vsRef = parent.vsettings?.[0];
  const vs = deref<ModelNode & { variants?: Ref[] }>(model, vsRef ?? null);
  const varRef = vs?.variants?.[0];
  if (!varRef || !isRef(varRef))
    throw new PlasmicError(
      `cannot derive a base variant from parent ${parentIid}; pass baseVariantIid`,
      undefined,
      undefined,
      "http"
    );
  return varRef.__ref;
}

export const modelTools: ToolDef[] = [
  defineTool({
    name: "plasmic_list_pages",
    description:
      "List page components in a project (name, path, iid) at the current revision.",
    schema: ListPagesInput,
    handler: async (client, { projectId }) => {
      const { revision, model } = await fetchRev(client, projectId);
      const pages = findNodesByType(model, "Component")
        .filter((iid) => (getNode(model, iid) as { type?: string }).type === "page")
        .map((iid) => pageSummary(model, iid));
      return { revision, count: pages.length, pages };
    },
  }),

  defineTool({
    name: "plasmic_get_page_model",
    description:
      "Get the full iid graph at the current revision. Pass pageIid to scope the result to a single page's subtree (component + descendants).",
    schema: GetPageModelInput,
    handler: async (client, { projectId, pageIid }) => {
      const { revision, model } = await fetchRev(client, projectId);
      if (!pageIid) return { revision, model };
      if (!(pageIid in model.map))
        throw new PlasmicError(`node not found: ${pageIid}`, undefined, undefined, "http");
      const iids = [pageIid, ...collectDescendants(model, pageIid)];
      const map: Record<string, ModelNode> = {};
      for (const iid of iids) map[iid] = model.map[iid];
      return { revision, root: pageIid, map };
    },
  }),

  defineTool({
    name: "plasmic_create_page",
    description:
      "Create a new page component (name + path, optional text). Wires it into Site.components and Site.pageArenas and saves a new revision.",
    schema: CreatePageInput,
    handler: async (client, { projectId, name, path, text }) => {
      const { revision, model } = await fetchRev(client, projectId);
      const frag = buildPageComponent(name, path, text);
      const { idMap } = mergeFragment(model, frag);
      const pageIid = idMap[frag.pageId];
      const arenaIid = idMap[frag.arenaId];
      const s = site(model);
      s.components.push({ __ref: pageIid });
      s.pageArenas.push({ __ref: arenaIid });
      await saveRev(client, projectId, model, revision, [pageIid]);
      return { pageIid, arenaIid, name, path, revision: revision + 1 };
    },
  }),

  defineTool({
    name: "plasmic_update_page_text",
    description:
      "Update RawText content in a page. Select the page by pageIid or path; replaces all RawText nodes in the page (or just textIid if given).",
    schema: UpdatePageTextInput,
    handler: async (client, args) => {
      UpdatePageTextCheck.parse(args);
      const { projectId, text, textIid } = args;
      const { revision, model } = await fetchRev(client, projectId);
      const pageIid = resolvePage(model, args);
      const descendants = collectDescendants(model, pageIid);
      let targets = descendants.filter(
        (iid) => getNode(model, iid).__type === "RawText"
      );
      if (textIid) {
        if (!targets.includes(textIid))
          throw new PlasmicError(
            `textIid ${textIid} is not a RawText in page ${pageIid}`,
            undefined,
            undefined,
            "http"
          );
        targets = [textIid];
      }
      for (const iid of targets) {
        (getNode(model, iid) as ModelNode & { text: string }).text = text;
      }
      await saveRev(client, projectId, model, revision, [pageIid]);
      return { pageIid, updated: targets.length, revision: revision + 1 };
    },
  }),

  defineTool({
    name: "plasmic_add_element",
    description:
      "Insert a new TplTag (div/span/text/image/…) under a parent element iid. baseVariantIid is derived from the parent if omitted.",
    schema: AddElementInput,
    handler: async (client, { projectId, parentIid, tag, type, baseVariantIid, text }) => {
      const { revision, model } = await fetchRev(client, projectId);
      if (!(parentIid in model.map))
        throw new PlasmicError(`parent not found: ${parentIid}`, undefined, undefined, "http");
      const baseVar = baseVariantIid ?? baseVariantOf(model, parentIid);
      const frag = buildElement({ tag, type, baseVariantIid: baseVar, text });
      const { rootIid } = mergeFragment(model, frag, parentIid);
      const owner = ownerComponentOf(model, rootIid);
      await saveRev(client, projectId, model, revision, owner ? [owner] : []);
      return { elementIid: rootIid, parentIid, owner, revision: revision + 1 };
    },
  }),

  defineTool({
    name: "plasmic_delete_element",
    description:
      "Remove a TplTag (and all its descendants + variant settings) by iid; strips the parent's reference. Saves a new revision.",
    schema: DeleteElementInput,
    handler: async (client, { projectId, iid }) => {
      const { revision, model } = await fetchRev(client, projectId);
      if (!(iid in model.map))
        throw new PlasmicError(`element not found: ${iid}`, undefined, undefined, "http");
      const owner = ownerComponentOf(model, iid); // resolve BEFORE delete
      const removed = [iid, ...collectDescendants(model, iid)];
      deleteNode(model, iid);
      await saveRev(client, projectId, model, revision, owner ? [owner] : []);
      return { deleted: iid, removedCount: removed.length, owner, revision: revision + 1 };
    },
  }),

  defineTool({
    name: "plasmic_apply_token",
    description:
      "Set a CSS property on a RuleSet to reference a design token. The token is wired as a CSS var (var(--token-<uuid>)).",
    schema: ApplyTokenInput,
    handler: async (client, { projectId, rsIid, prop, tokenId }) => {
      const { revision, model } = await fetchRev(client, projectId);
      if (!(rsIid in model.map))
        throw new PlasmicError(`ruleset not found: ${rsIid}`, undefined, undefined, "http");
      // Q3: no conclusive token-ref literal in the ground-truth script; using
      // the CSS var form. Flagged in the task .done for live E2E re-check.
      const value = `var(--token-${tokenId})`;
      updateRuleSet(model, rsIid, { [prop]: value });
      const owner = ownerComponentOf(model, rsIid);
      await saveRev(client, projectId, model, revision, owner ? [owner] : []);
      return { rsIid, prop, value, owner, revision: revision + 1 };
    },
  }),

  defineTool({
    name: "plasmic_upsert_component",
    description:
      "Create or update a registered code component's metadata (name + importPath). Pass componentIid to update an existing one; omit to create. NOTE: code-component creation shape is best-effort pending live verification.",
    schema: UpsertComponentInput,
    handler: async (client, { projectId, name, importPath, componentIid, props }) => {
      const { revision, model } = await fetchRev(client, projectId);
      let compIid: string;
      if (componentIid) {
        if (!(componentIid in model.map))
          throw new PlasmicError(`component not found: ${componentIid}`, undefined, undefined, "http");
        const comp = getNode(model, componentIid) as ModelNode & {
          name: string;
          codeComponentMeta?: Ref | null;
          metadata?: Record<string, string>;
        };
        comp.name = name;
        const ccm = deref<ModelNode & { importPath?: string; importName?: string }>(
          model,
          comp.codeComponentMeta ?? null
        );
        if (ccm) {
          ccm.importPath = importPath;
          ccm.importName = name;
        }
        if (props) {
          comp.metadata = comp.metadata ?? {};
          for (const [k, v] of Object.entries(props)) comp.metadata[k] = String(v);
        }
        compIid = componentIid;
      } else {
        const frag = buildCodeComponent(name, importPath);
        const { idMap } = mergeFragment(model, frag);
        compIid = idMap[frag.compId];
        site(model).components.push({ __ref: compIid });
        if (props) {
          const comp = getNode(model, compIid) as ModelNode & {
            metadata: Record<string, string>;
          };
          for (const [k, v] of Object.entries(props)) comp.metadata[k] = String(v);
        }
      }
      await saveRev(client, projectId, model, revision, [compIid]);
      return { componentIid: compIid, name, importPath, revision: revision + 1 };
    },
  }),

  defineTool({
    name: "plasmic_duplicate_page",
    description:
      "Clone an existing page component (and its PageArena) under a new name + path. Saves a new revision.",
    schema: DuplicatePageInput,
    handler: async (client, { projectId, sourceIid, name, path }) => {
      const { revision, model } = await fetchRev(client, projectId);
      const src = getNode(model, sourceIid) as ModelNode & {
        type?: string;
        pageMeta?: Ref | null;
      };
      if (src.type !== "page")
        throw new PlasmicError(
          `source ${sourceIid} is not a page component`,
          undefined,
          undefined,
          "http"
        );
      // Locate the source PageArena + its two grids.
      const arenaIid = findNodesByType(model, "PageArena").find((iid) => {
        const a = getNode(model, iid) as ModelNode & { component?: Ref };
        return isRef(a.component) && a.component.__ref === sourceIid;
      });
      // Gather the subtree: component + descendants (+ arena + grids).
      const subtree = new Set<string>([sourceIid, ...collectDescendants(model, sourceIid)]);
      if (arenaIid) {
        subtree.add(arenaIid);
        const arena = getNode(model, arenaIid) as ModelNode & {
          matrix?: Ref;
          customMatrix?: Ref;
        };
        if (isRef(arena.matrix)) subtree.add(arena.matrix.__ref);
        if (isRef(arena.customMatrix)) subtree.add(arena.customMatrix.__ref);
      }
      // Build a fragment keyed by the CURRENT iids (as temp ids) with clones.
      const nodes: Record<string, ModelNode> = {};
      for (const iid of subtree) {
        nodes[iid] = JSON.parse(JSON.stringify(model.map[iid])) as ModelNode;
      }
      const { idMap } = mergeFragment(model, { nodes, rootId: sourceIid });
      const newComp = idMap[sourceIid];
      // Apply the new name + path to the clone.
      (getNode(model, newComp) as ModelNode & { name: string }).name = name;
      const clonedPm = deref<ModelNode & { path?: string }>(
        model,
        (getNode(model, newComp) as { pageMeta?: Ref | null }).pageMeta ?? null
      );
      if (clonedPm) clonedPm.path = path;
      // Wire into the Site.
      const s = site(model);
      s.components.push({ __ref: newComp });
      const newArena = arenaIid ? idMap[arenaIid] : undefined;
      if (newArena) s.pageArenas.push({ __ref: newArena });
      await saveRev(client, projectId, model, revision, [newComp]);
      return { sourceIid, pageIid: newComp, arenaIid: newArena ?? null, name, path, revision: revision + 1 };
    },
  }),

  defineTool({
    name: "plasmic_get_element",
    description:
      "Read one element by iid: its tag/type, base-variant styles (RuleSet values), text content, and child iids.",
    schema: GetElementInput,
    handler: async (client, { projectId, iid }) => {
      const { revision, model } = await fetchRev(client, projectId);
      if (!(iid in model.map))
        throw new PlasmicError(`element not found: ${iid}`, undefined, undefined, "http");
      const node = getNode(model, iid) as ModelNode & {
        tag?: string;
        type?: string;
        children?: Ref[];
        vsettings?: Ref[];
      };
      const vs = deref<ModelNode & { rs?: Ref; text?: Ref | null }>(
        model,
        node.vsettings?.[0] ?? null
      );
      const rs = deref<ModelNode & { values?: Record<string, string> }>(
        model,
        vs?.rs ?? null
      );
      const rawText = deref<ModelNode & { text?: string }>(model, vs?.text ?? null);
      return {
        revision,
        iid,
        __type: node.__type,
        tag: node.tag ?? null,
        type: node.type ?? null,
        rsIid: vs?.rs && isRef(vs.rs) ? vs.rs.__ref : null,
        styles: rs?.values ?? {},
        text: rawText?.text ?? null,
        children: (node.children ?? [])
          .filter(isRef)
          .map((r) => r.__ref),
      };
    },
  }),
];

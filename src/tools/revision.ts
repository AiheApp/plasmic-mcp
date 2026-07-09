import { PlasmicError, type PlasmicClient } from "../client.js";
import {
  parseModel,
  buildRevisionBody,
  findPageByPath,
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

export async function fetchRev(
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

// The server 412s (SchemaMismatchError) unless the save body's modelSchemaHash
// matches the RUNNING server's — and that hash changes on model-schema-touching
// Studio upgrades (classes-metas.ts is regenerated at image build). Resolution
// order: PLASMIC_MODEL_SCHEMA_HASH env override → the server's own value from
// GET /api/v1/app-config (self-hosted fork exposes it; cached per client) →
// the legacy hardcoded constant (pre-patch servers).
const schemaHashCache = new WeakMap<PlasmicClient, number>();

export async function resolveModelSchemaHash(
  client: PlasmicClient
): Promise<number | undefined> {
  const envHash = process.env.PLASMIC_MODEL_SCHEMA_HASH;
  if (envHash && Number.isFinite(Number(envHash))) return Number(envHash);
  if (schemaHashCache.has(client)) return schemaHashCache.get(client);
  try {
    const cfg = (await client.get(`/api/v1/app-config`)) as {
      modelSchemaHash?: unknown;
    };
    if (typeof cfg?.modelSchemaHash === "number") {
      schemaHashCache.set(client, cfg.modelSchemaHash);
      return cfg.modelSchemaHash;
    }
  } catch {
    // fall through to the legacy constant
  }
  return undefined;
}

export async function saveRev(
  client: PlasmicClient,
  projectId: string,
  model: PlasmicModel,
  currentRevision: number,
  modifiedComponentIids: string[]
): Promise<unknown> {
  const newRev = currentRevision + 1;
  const hash = await resolveModelSchemaHash(client);
  return client.post(
    `/api/v1/projects/${enc(projectId)}/revisions/${newRev}`,
    buildRevisionBody(model, currentRevision, modifiedComponentIids, hash)
  );
}

// ---- small model readers ----------------------------------------------------

export function site(model: PlasmicModel): ModelNode & {
  components: Ref[];
  pageArenas: Ref[];
} {
  return getNode(model, model.root) as ModelNode & {
    components: Ref[];
    pageArenas: Ref[];
  };
}

/** Resolve a page selector (pageIid or path) to a component iid. */
export function resolvePage(
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
export function baseVariantOf(model: PlasmicModel, parentIid: string): string {
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

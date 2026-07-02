/**
 * Bundle (de)serialization + the revision-save request body.
 *
 * The Studio `GET /api/v1/projects/{id}` response carries the model as a JSON
 * STRING under `rev.data`; the save endpoint expects the same string back under
 * `data`, alongside the schema/version constants.
 */

import {
  HOSTLESS_DATA_VERSION,
  MODEL_SCHEMA_HASH,
  MODEL_VERSION,
} from "./constants.js";
import type { PlasmicModel } from "./types.js";

export function parseModel(data: string): PlasmicModel {
  const parsed = JSON.parse(data) as PlasmicModel;
  if (
    !parsed ||
    typeof parsed !== "object" ||
    typeof parsed.root !== "string" ||
    typeof parsed.map !== "object"
  ) {
    throw new Error("invalid model bundle: expected { root: string, map }");
  }
  return parsed;
}

export function serializeModel(model: PlasmicModel): string {
  return JSON.stringify(model);
}

export interface RevisionBody {
  modelSchemaHash: number;
  data: string;
  modelVersion: number;
  hostlessDataVersion: number;
  incremental: boolean;
  toDeleteIids: string[];
  revisionNum: number;
  modifiedComponentIids: string[];
  branchId: null;
}

/**
 * Build the revision-save POST body. `revisionNum` is always
 * `currentRevision + 1` (invariant 7).
 */
export function buildRevisionBody(
  model: PlasmicModel,
  currentRevision: number,
  modifiedComponentIids: string[]
): RevisionBody {
  return {
    modelSchemaHash: MODEL_SCHEMA_HASH,
    data: serializeModel(model),
    modelVersion: MODEL_VERSION,
    hostlessDataVersion: HOSTLESS_DATA_VERSION,
    incremental: false,
    toDeleteIids: [],
    revisionNum: currentRevision + 1,
    modifiedComponentIids,
    branchId: null,
  };
}

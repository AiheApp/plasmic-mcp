/**
 * Bundle-save constants — the exact values the live Studio revision endpoint
 * accepts, taken verbatim from the proven `plasmic-add-page.py` (SCHEMA_HASH is
 * "from Studio bundle module 8798").
 */

/** modelSchemaHash the server validates the incoming bundle against. */
export const MODEL_SCHEMA_HASH = -516264365;

/** modelVersion carried by the revision save body. */
export const MODEL_VERSION = 21;

/** hostlessDataVersion carried by the revision save body. */
export const HOSTLESS_DATA_VERSION = 1;

/** Name of the mandatory base variant every Component must have. */
export const BASE_VARIANT_NAME = "base";

/** __type tag constants (avoid stringly-typed drift at call sites). */
export const TYPE = {
  Site: "Site",
  Component: "Component",
  TplTag: "TplTag",
  TplComponent: "TplComponent",
  TplSlot: "TplSlot",
  RawText: "RawText",
  VariantSetting: "VariantSetting",
  RuleSet: "RuleSet",
  Variant: "Variant",
  PageMeta: "PageMeta",
  PageArena: "PageArena",
  ArenaFrameGrid: "ArenaFrameGrid",
  Mixin: "Mixin",
  StyleToken: "StyleToken",
} as const;

/** Allowed TplTag.type values (from model-schema.ts). */
export const TPL_TAG_TYPES = [
  "text",
  "image",
  "column",
  "columns",
  "other",
] as const;
export type TplTagType = (typeof TPL_TAG_TYPES)[number];

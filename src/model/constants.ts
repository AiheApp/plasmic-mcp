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

/**
 * Screen sizes for new PageArena frames when the project has no healthy page
 * arena to copy from — Studio's desktop-first defaults
 * (`defaultResponsiveSettings.screenSizes` in wab/shared/responsiveness.ts).
 */
export const DEFAULT_SCREEN_SIZES: readonly { width: number; height: number }[] =
  [
    { width: 1366, height: 768 },
    { width: 414, height: 736 },
  ];

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
  ArenaFrameRow: "ArenaFrameRow",
  ArenaFrameCell: "ArenaFrameCell",
  ArenaFrame: "ArenaFrame",
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

/** HTML void elements — can never have children (add_element refuses them as parents). */
export const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

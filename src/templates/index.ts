/**
 * Token-aware HTML templates for Studio canvas insertion.
 *
 * Constraints (from the Studio web importer, platform/wab web-importer/):
 * - Only `recognizedStylesKeys` survive: use `background` for color fills,
 *   padding/margin/border LONGHANDS only, flex layout with row-gap/column-gap
 *   (no `gap`, no CSS grid), border-*-radius corner longhands.
 * - Design tokens are referenced as `var(--token-<kebab-name>)`; the importer
 *   rewrites them to `var(--token-<uuid>)` bound to the project's tokens
 *   (matched via toVarName on both sides).
 * - The pasted string must start with "<" after trim.
 */
import { z } from "zod";
import { TOKEN_VARS } from "./tokens.js";
import { tokenMatchKey } from "./token-names.js";

// ---- helpers ----------------------------------------------------------------

/** Escape user-provided text for safe embedding in HTML content/attributes. */
export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Token var reference; throws at render time if the token is unknown. */
export function tv(varName: string): string {
  if (!TOKEN_VARS.has(varName)) {
    throw new Error(
      `unknown design token var "${varName}" — run npm run gen:tokens or pick from tokens.ts`
    );
  }
  return `var(--token-${varName})`;
}

const TOKEN_REF_RE = /var\(--token-([^)]+)\)/g;

/** All --token- refs in an HTML string (raw, un-normalized). */
export function findTokenRefs(html: string): string[] {
  return [...html.matchAll(TOKEN_REF_RE)].map((m) => m[1]);
}

/**
 * Token refs that will NOT resolve against a token-name list (normalized the
 * same way Studio matches them). Used to fail fast before pasting.
 */
export function unknownTokenRefs(html: string, tokenNames: Iterable<string>): string[] {
  const known = new Set([...tokenNames].map(tokenMatchKey));
  return [...new Set(findTokenRefs(html))].filter((ref) => !known.has(tokenMatchKey(ref)));
}

// ---- template registry --------------------------------------------------------

export interface TemplateDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Token varNames this template references (introspectable + unit-tested). */
  tokensUsed: string[];
  render(params: z.infer<S>): string;
}

function defineTemplate<S extends z.ZodType>(def: TemplateDef<S>): TemplateDef {
  return def as unknown as TemplateDef;
}

const cornerRadius = (px: number) =>
  `border-top-left-radius: ${px}px; border-top-right-radius: ${px}px; border-bottom-left-radius: ${px}px; border-bottom-right-radius: ${px}px`;

const pad = (v: number, h: number) =>
  `padding-top: ${v}px; padding-bottom: ${v}px; padding-left: ${h}px; padding-right: ${h}px`;

const noMargin = "margin-top: 0px; margin-bottom: 0px; margin-left: 0px; margin-right: 0px";

const noBorder =
  "border-top-style: none; border-right-style: none; border-bottom-style: none; border-left-style: none";

// ---- hero ---------------------------------------------------------------------

const HeroParams = z
  .object({
    title: z.string().min(1),
    subtitle: z.string().optional(),
    ctaText: z.string().optional(),
  })
  .strict();

const hero = defineTemplate({
  name: "hero",
  description:
    "Full-width hero section: primary background, centered display title, optional subtitle and CTA button.",
  schema: HeroParams,
  tokensUsed: [
    "primary-base",
    "primary-light-3",
    "white",
    "primary-font",
    "font-size-7-xl",
    "line-height-7-xl",
    "font-size-xl",
    "line-height-xl",
    "font-size-lg",
  ],
  render: (p) => `
<section style="display: flex; flex-direction: column; align-items: center; row-gap: 24px; ${pad(96, 32)}; background: ${tv("primary-base")};">
  <h1 style="${noMargin}; color: ${tv("white")}; font-family: ${tv("primary-font")}; font-size: ${tv("font-size-7-xl")}; line-height: ${tv("line-height-7-xl")}; font-weight: 700; text-align: center;">${esc(p.title)}</h1>
  ${p.subtitle ? `<p style="${noMargin}; max-width: 640px; color: ${tv("primary-light-3")}; font-size: ${tv("font-size-xl")}; line-height: ${tv("line-height-xl")}; text-align: center;">${esc(p.subtitle)}</p>` : ""}
  ${p.ctaText ? `<button style="${noBorder}; ${cornerRadius(8)}; ${pad(12, 28)}; background: ${tv("white")}; color: ${tv("primary-base")}; font-size: ${tv("font-size-lg")}; font-weight: 600; cursor: pointer;">${esc(p.ctaText)}</button>` : ""}
</section>`,
});

// ---- cardGrid -------------------------------------------------------------------

const CardGridParams = z
  .object({
    heading: z.string().optional(),
    columns: z.number().int().min(2).max(4).default(3),
    cards: z
      .array(z.object({ title: z.string().min(1), body: z.string().min(1) }).strict())
      .min(1),
  })
  .strict();

const CARD_BASIS: Record<number, string> = { 2: "44%", 3: "29%", 4: "21%" };

const cardGrid = defineTemplate({
  name: "cardGrid",
  description:
    "Responsive card grid (flex-wrap): optional section heading, N cards with title + body. columns controls target cards per row (2-4).",
  schema: CardGridParams,
  tokensUsed: [
    "white",
    "grey-light-6",
    "text-base",
    "text-light-2",
    "primary-font",
    "font-size-3-xl",
    "line-height-3-xl",
    "font-size-xl",
    "line-height-xl",
    "font-size-md",
    "line-height-md",
  ],
  render: (p) => {
    const basis = CARD_BASIS[p.columns] ?? CARD_BASIS[3];
    const cards = p.cards
      .map(
        (c) => `
    <div style="display: flex; flex-direction: column; row-gap: 8px; flex-grow: 1; flex-shrink: 1; flex-basis: ${basis}; min-width: 220px; ${pad(24, 24)}; background: ${tv("white")}; border-top-style: solid; border-right-style: solid; border-bottom-style: solid; border-left-style: solid; border-top-width: 1px; border-right-width: 1px; border-bottom-width: 1px; border-left-width: 1px; border-top-color: ${tv("grey-light-6")}; border-right-color: ${tv("grey-light-6")}; border-bottom-color: ${tv("grey-light-6")}; border-left-color: ${tv("grey-light-6")}; ${cornerRadius(12)}; box-shadow: 0px 1px 4px rgba(16, 24, 40, 0.06);">
      <h3 style="${noMargin}; color: ${tv("text-base")}; font-size: ${tv("font-size-xl")}; line-height: ${tv("line-height-xl")}; font-weight: 600;">${esc(c.title)}</h3>
      <p style="${noMargin}; color: ${tv("text-light-2")}; font-size: ${tv("font-size-md")}; line-height: ${tv("line-height-md")};">${esc(c.body)}</p>
    </div>`
      )
      .join("");
    return `
<section style="display: flex; flex-direction: column; row-gap: 32px; ${pad(64, 32)};">
  ${p.heading ? `<h2 style="${noMargin}; color: ${tv("text-base")}; font-family: ${tv("primary-font")}; font-size: ${tv("font-size-3-xl")}; line-height: ${tv("line-height-3-xl")}; font-weight: 700;">${esc(p.heading)}</h2>` : ""}
  <div style="display: flex; flex-wrap: wrap; row-gap: 24px; column-gap: 24px;">${cards}
  </div>
</section>`;
  },
});

// ---- formSection -----------------------------------------------------------------

const FormSectionParams = z
  .object({
    title: z.string().optional(),
    fields: z
      .array(
        z
          .object({
            label: z.string().min(1),
            type: z.enum(["text", "email", "password", "number", "tel"]).default("text"),
            placeholder: z.string().optional(),
          })
          .strict()
      )
      .min(1),
    submitText: z.string().default("Submit"),
  })
  .strict();

const formSection = defineTemplate({
  name: "formSection",
  description:
    "Vertical form: optional title, labeled inputs (text/email/password/number/tel), submit button.",
  schema: FormSectionParams,
  tokensUsed: [
    "white",
    "grey-light-4",
    "text-base",
    "text-light-1",
    "primary-base",
    "primary-font",
    "font-size-2-xl",
    "line-height-2-xl",
    "font-size-sm",
    "line-height-sm",
    "font-size-md",
    "font-size-lg",
  ],
  render: (p) => {
    const fields = p.fields
      .map(
        (f) => `
    <div style="display: flex; flex-direction: column; row-gap: 6px;">
      <span style="color: ${tv("text-light-1")}; font-size: ${tv("font-size-sm")}; line-height: ${tv("line-height-sm")}; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;">${esc(f.label)}</span>
      <input type="${f.type}"${f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : ""} style="${pad(10, 12)}; ${cornerRadius(8)}; border-top-style: solid; border-right-style: solid; border-bottom-style: solid; border-left-style: solid; border-top-width: 1px; border-right-width: 1px; border-bottom-width: 1px; border-left-width: 1px; border-top-color: ${tv("grey-light-4")}; border-right-color: ${tv("grey-light-4")}; border-bottom-color: ${tv("grey-light-4")}; border-left-color: ${tv("grey-light-4")}; background: ${tv("white")}; color: ${tv("text-base")}; font-size: ${tv("font-size-md")};" />
    </div>`
      )
      .join("");
    return `
<section style="display: flex; flex-direction: column; row-gap: 20px; max-width: 480px; ${pad(40, 32)};">
  ${p.title ? `<h2 style="${noMargin}; color: ${tv("text-base")}; font-family: ${tv("primary-font")}; font-size: ${tv("font-size-2-xl")}; line-height: ${tv("line-height-2-xl")}; font-weight: 700;">${esc(p.title)}</h2>` : ""}${fields}
  <button style="${noBorder}; ${cornerRadius(8)}; ${pad(12, 24)}; background: ${tv("primary-base")}; color: ${tv("white")}; font-size: ${tv("font-size-lg")}; font-weight: 600; cursor: pointer;">${esc(p.submitText)}</button>
</section>`;
  },
});

// ---- twoColumnLayout ---------------------------------------------------------------

const TwoColumnParams = z
  .object({
    /** Raw HTML for each column — NOT escaped; token refs are validated. */
    leftHtml: z.string().min(1),
    rightHtml: z.string().min(1),
    ratio: z.enum(["1:1", "1:2", "2:1"]).default("1:1"),
  })
  .strict();

const RATIO_BASIS: Record<string, [string, string]> = {
  "1:1": ["46%", "46%"],
  "1:2": ["30%", "62%"],
  "2:1": ["62%", "30%"],
};

const twoColumnLayout = defineTemplate({
  name: "twoColumnLayout",
  description:
    "Two side-by-side columns (wraps on narrow frames). leftHtml/rightHtml are RAW HTML fragments — compose with other templates' output or hand-written markup.",
  schema: TwoColumnParams,
  tokensUsed: [],
  render: (p) => {
    const [l, r] = RATIO_BASIS[p.ratio] ?? RATIO_BASIS["1:1"];
    return `
<section style="display: flex; flex-wrap: wrap; row-gap: 32px; column-gap: 32px; align-items: flex-start; ${pad(48, 32)};">
  <div style="display: flex; flex-direction: column; row-gap: 16px; flex-grow: 1; flex-shrink: 1; flex-basis: ${l}; min-width: 240px;">${p.leftHtml}</div>
  <div style="display: flex; flex-direction: column; row-gap: 16px; flex-grow: 1; flex-shrink: 1; flex-basis: ${r}; min-width: 240px;">${p.rightHtml}</div>
</section>`;
  },
});

// ---- emptyState ---------------------------------------------------------------------

const EmptyStateParams = z
  .object({
    icon: z.string().optional(),
    title: z.string().min(1),
    description: z.string().min(1),
  })
  .strict();

const emptyState = defineTemplate({
  name: "emptyState",
  description:
    "Centered empty-state block: optional icon glyph/emoji in a muted circle, title, description.",
  schema: EmptyStateParams,
  tokensUsed: [
    "grey-light-6",
    "text-base",
    "text-light-2",
    "font-size-2-xl",
    "font-size-xl",
    "line-height-xl",
    "font-size-md",
    "line-height-md",
  ],
  render: (p) => `
<section style="display: flex; flex-direction: column; align-items: center; row-gap: 12px; ${pad(64, 32)};">
  ${p.icon ? `<div style="display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; ${cornerRadius(32)}; background: ${tv("grey-light-6")}; font-size: ${tv("font-size-2-xl")};">${esc(p.icon)}</div>` : ""}
  <h3 style="${noMargin}; color: ${tv("text-base")}; font-size: ${tv("font-size-xl")}; line-height: ${tv("line-height-xl")}; font-weight: 600; text-align: center;">${esc(p.title)}</h3>
  <p style="${noMargin}; max-width: 420px; color: ${tv("text-light-2")}; font-size: ${tv("font-size-md")}; line-height: ${tv("line-height-md")}; text-align: center;">${esc(p.description)}</p>
</section>`,
});

// ---- registry -----------------------------------------------------------------------

export const TEMPLATES: Record<string, TemplateDef> = Object.fromEntries(
  [hero, cardGrid, formSection, twoColumnLayout, emptyState].map((t) => [t.name, t])
);

/** Validate params against the template's schema and render its HTML. */
export function renderTemplate(name: string, params: unknown): string {
  const def = TEMPLATES[name];
  if (!def) {
    throw new Error(
      `unknown template "${name}" — available: ${Object.keys(TEMPLATES).join(", ")}`
    );
  }
  const parsed = def.schema.safeParse(params);
  if (!parsed.success) {
    throw new Error(`invalid params for "${name}": ${parsed.error.message}`);
  }
  return def.render(parsed.data).trim();
}

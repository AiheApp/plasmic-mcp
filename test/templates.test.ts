import { describe, expect, it } from "vitest";
import {
  TEMPLATES,
  renderTemplate,
  findTokenRefs,
  unknownTokenRefs,
  esc,
} from "../src/templates/index.js";
import { DS_TOKENS, TOKEN_VARS } from "../src/templates/tokens.js";
import { tokenMatchKey, toKebabVarName } from "../src/templates/token-names.js";

const SAMPLE_PARAMS: Record<string, unknown> = {
  hero: { title: "T <b>x</b>", subtitle: "S & sub", ctaText: "Go" },
  cardGrid: {
    heading: "H",
    columns: 3,
    cards: [
      { title: "A", body: "a" },
      { title: "B", body: "b" },
    ],
  },
  formSection: {
    title: "Contact",
    fields: [
      { label: "Email", type: "email", placeholder: "you@example.com" },
      { label: "Name" },
    ],
  },
  twoColumnLayout: { leftHtml: "<p>L</p>", rightHtml: "<p>R</p>", ratio: "2:1" },
  emptyState: { icon: "📭", title: "Nothing here", description: "Add something." },
};

describe("template library", () => {
  it("ships at least 5 templates, all with sample params", () => {
    expect(Object.keys(TEMPLATES).length).toBeGreaterThanOrEqual(5);
    for (const name of Object.keys(TEMPLATES)) {
      expect(SAMPLE_PARAMS, `missing sample params for ${name}`).toHaveProperty(name);
    }
  });

  for (const [name, def] of Object.entries(TEMPLATES)) {
    describe(name, () => {
      it("renders HTML that the web importer will accept (starts with '<')", () => {
        const html = renderTemplate(name, SAMPLE_PARAMS[name]);
        expect(html.startsWith("<")).toBe(true);
        expect(html.length).toBeGreaterThan(50);
      });

      it("references only tokens present in the generated allowlist", () => {
        const html = renderTemplate(name, SAMPLE_PARAMS[name]);
        expect(unknownTokenRefs(html, DS_TOKENS.map((t) => t.name))).toEqual([]);
      });

      it("declares its token usage accurately (tokensUsed ⊆ refs and vice versa)", () => {
        const html = renderTemplate(name, SAMPLE_PARAMS[name]);
        const refs = new Set(findTokenRefs(html));
        for (const t of def.tokensUsed) {
          // Optional params in sample are all set, so every declared token should appear.
          expect(refs, `${name} declares unused token ${t}`).toContain(t);
        }
        for (const r of refs) {
          expect(def.tokensUsed, `${name} uses undeclared token ${r}`).toContain(r);
        }
      });

      it("rejects invalid params", () => {
        expect(() => renderTemplate(name, { nope: true })).toThrow(/invalid params/);
      });

      it("uses only importer-recognized longhand CSS properties", () => {
        const html = renderTemplate(name, SAMPLE_PARAMS[name]);
        // Shorthands the Studio web importer silently drops.
        for (const banned of [
          /style="[^"]*(?<![a-z-])padding:/,
          /style="[^"]*(?<![a-z-])margin:/,
          /style="[^"]*(?<![a-z-])border:/,
          /style="[^"]*(?<![a-z-])border-radius:/,
          /style="[^"]*(?<![a-z-])gap:/,
          /style="[^"]*background-color:/,
          /display:\s*grid/,
        ]) {
          expect(html).not.toMatch(banned);
        }
      });
    });
  }

  it("escapes user-provided strings", () => {
    const html = renderTemplate("hero", { title: `<script>alert("x")</script>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("unknown template names throw with the available list", () => {
    expect(() => renderTemplate("nope", {})).toThrow(/available: /);
  });
});

describe("token name normalization", () => {
  it("matches Studio's camelCase normalization for kebab and spaced names", () => {
    expect(tokenMatchKey("primary-base")).toBe(tokenMatchKey("Primary Base"));
    expect(tokenMatchKey("font-size-7-xl")).toBe(tokenMatchKey("Font Size 7xl"));
  });

  it("generated varNames are unique", () => {
    expect(TOKEN_VARS.size).toBe(DS_TOKENS.length);
  });

  it("kebab conversion splits digit boundaries like lodash words", () => {
    expect(toKebabVarName("Font Size 7xl")).toBe("font-size-7-xl");
    expect(toKebabVarName("Primary Light 3")).toBe("primary-light-3");
  });
});

describe("unknownTokenRefs", () => {
  it("flags refs missing from the live token list", () => {
    const html = `<div style="color: var(--token-not-a-token);"></div>`;
    expect(unknownTokenRefs(html, ["Primary Base"])).toEqual(["not-a-token"]);
  });

  it("accepts refs that normalize to a live token name", () => {
    const html = `<div style="color: var(--token-primary-base);"></div>`;
    expect(unknownTokenRefs(html, ["Primary Base"])).toEqual([]);
  });
});

describe("esc", () => {
  it("escapes all HTML-significant characters", () => {
    expect(esc(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
  });
});

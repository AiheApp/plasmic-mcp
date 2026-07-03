/**
 * The benchmark instruction set — 10 varied designer requests with
 * machine-checkable expectations. Cases 9 and 10 MUST be refused (or answered
 * with a clarifying question) without mutating anything.
 *
 * Every case runs against a fresh throwaway project seeded with:
 *   - page "Home" at /home with two text elements:
 *       "Hello from Aihe" (the hero) and "Old banner"
 *   - color tokens: primary-blue (#4169e1), text-light-1 (#1f1f1f)
 * Case 8 additionally seeds page "Pricing" at /pricing with text "Prices".
 */

import type { PlasmicModel } from "../src/model/index.js";
import {
  pageHasTokenStyle,
  pageIid,
  rootChildCount,
  textsInPage,
} from "./checks.js";

export interface ResultLine {
  status: "applied" | "refused" | "clarification";
  revision: number | null;
}

export interface VerifyArgs {
  model: PlasmicModel;
  revision: number;
  seedRevision: number;
  result: ResultLine | null;
  /** token name -> uuid, as seeded */
  tokens: Record<string, string>;
}

export interface BenchCase {
  id: string;
  instruction: string;
  /** Case 8 needs an extra seeded page. */
  extraSeedPage?: { name: string; path: string; text: string };
  /** true = the case must mutate; false = it must NOT mutate. */
  expectMutation: boolean;
  /** Returns a list of failure descriptions (empty = pass). */
  verify: (args: VerifyArgs) => string[];
}

const fail = (cond: boolean, msg: string): string[] => (cond ? [] : [msg]);

export const CASES: BenchCase[] = [
  {
    id: "create-page",
    instruction:
      "Create a page called Pricing at /pricing with the heading 'Simple pricing'",
    expectMutation: true,
    verify: ({ model }) => [
      ...fail(pageIid(model, "/pricing") !== null, "no page at /pricing"),
      ...fail(
        textsInPage(model, "/pricing").includes("Simple pricing"),
        "heading 'Simple pricing' not found on /pricing"
      ),
    ],
  },
  {
    id: "change-hero-text",
    instruction:
      "Change the hero text 'Hello from Aihe' on the Home page to 'Welcome to Aihe'",
    expectMutation: true,
    verify: ({ model }) => {
      const texts = textsInPage(model, "/home");
      return [
        ...fail(texts.includes("Welcome to Aihe"), "new hero text missing"),
        ...fail(!texts.includes("Hello from Aihe"), "old hero text still present"),
        ...fail(
          texts.includes("Old banner"),
          "unrelated 'Old banner' text was clobbered"
        ),
      ];
    },
  },
  {
    id: "add-two-blocks",
    instruction:
      "Add two text blocks that say 'Fast' and 'Secure' to the Home page",
    expectMutation: true,
    verify: ({ model, revision, seedRevision }) => {
      const texts = textsInPage(model, "/home");
      return [
        ...fail(texts.includes("Fast"), "'Fast' block missing"),
        ...fail(texts.includes("Secure"), "'Secure' block missing"),
        ...fail(texts.includes("Hello from Aihe"), "existing hero text lost"),
        ...fail(rootChildCount(model, "/home") === 4, "expected 4 root children"),
        ...fail(
          revision === seedRevision + 1,
          `expected one atomic revision (${seedRevision}→${seedRevision + 1}), got ${revision}`
        ),
      ];
    },
  },
  {
    id: "token-color",
    instruction:
      "Make the hero text on the Home page use our primary-blue color token",
    expectMutation: true,
    verify: ({ model, tokens }) => [
      ...fail(
        pageHasTokenStyle(model, "/home", "color", tokens["primary-blue"]),
        "no RuleSet on /home sets color to the primary-blue token var"
      ),
    ],
  },
  {
    id: "delete-banner",
    instruction: "Remove the 'Old banner' text from the Home page",
    expectMutation: true,
    verify: ({ model }) => {
      const texts = textsInPage(model, "/home");
      return [
        ...fail(!texts.includes("Old banner"), "'Old banner' still present"),
        ...fail(texts.includes("Hello from Aihe"), "hero text was also removed"),
      ];
    },
  },
  {
    id: "duplicate-home",
    instruction: "Duplicate the Home page as 'Home V2' at /home-v2",
    expectMutation: true,
    verify: ({ model }) => {
      const copyTexts = textsInPage(model, "/home-v2");
      return [
        ...fail(pageIid(model, "/home-v2") !== null, "no page at /home-v2"),
        ...fail(copyTexts.includes("Hello from Aihe"), "copy is missing hero text"),
        ...fail(
          textsInPage(model, "/home").includes("Hello from Aihe"),
          "original page was damaged"
        ),
      ];
    },
  },
  {
    id: "about-atomic",
    instruction:
      "Create an About page at /about with the text 'About us' and color that text with the text-light-1 token",
    expectMutation: true,
    verify: ({ model, revision, seedRevision, tokens }) => [
      ...fail(pageIid(model, "/about") !== null, "no page at /about"),
      ...fail(
        textsInPage(model, "/about").includes("About us"),
        "'About us' text missing"
      ),
      ...fail(
        pageHasTokenStyle(model, "/about", "color", tokens["text-light-1"]),
        "text-light-1 token var not applied on /about"
      ),
      ...fail(
        revision === seedRevision + 1,
        `expected one atomic revision (${seedRevision}→${seedRevision + 1}), got ${revision}`
      ),
    ],
  },
  {
    id: "pricing-two-edits",
    instruction:
      "On the Pricing page change the heading to 'Pricing' and add a subtitle that says 'Fair and simple'",
    extraSeedPage: { name: "Pricing", path: "/pricing", text: "Prices" },
    expectMutation: true,
    verify: ({ model, revision, seedRevision }) => {
      const texts = textsInPage(model, "/pricing");
      return [
        ...fail(texts.includes("Pricing"), "heading not changed to 'Pricing'"),
        ...fail(texts.includes("Fair and simple"), "subtitle missing"),
        ...fail(!texts.includes("Prices"), "old heading 'Prices' still present"),
        ...fail(
          revision === seedRevision + 1,
          `expected one atomic revision (${seedRevision}→${seedRevision + 1}), got ${revision}`
        ),
      ];
    },
  },
  {
    id: "refuse-ambiguous",
    instruction: "Make the site feel more modern",
    expectMutation: false,
    verify: ({ result, revision, seedRevision }) => [
      ...fail(
        result?.status === "refused" || result?.status === "clarification",
        `expected refused/clarification, got ${result?.status ?? "no RESULT line"}`
      ),
      ...fail(revision === seedRevision, "model was mutated on an ambiguous request"),
    ],
  },
  {
    id: "refuse-unsupported",
    instruction: "Add a login form wired to Supabase auth",
    expectMutation: false,
    verify: ({ result, revision, seedRevision }) => [
      ...fail(
        result?.status === "refused",
        `expected refused, got ${result?.status ?? "no RESULT line"}`
      ),
      ...fail(revision === seedRevision, "model was mutated on an unsupported request"),
    ],
  },
];

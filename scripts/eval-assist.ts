/**
 * Live eval harness for the design-assist workflow (ClickUp 86ey4ferx).
 *
 * Creates a throwaway project, seeds a Home page, runs 5 varied
 * natural-language requests + 1 ambiguity probe through the agent loop, and
 * asserts each result against a fresh model read. Deletes the project at the
 * end (pass --keep to skip deletion for manual Studio inspection).
 *
 *   PLASMIC_HOST=… PLASMIC_EMAIL=… PLASMIC_PASSWORD=… ANTHROPIC_API_KEY=… \
 *     npx tsx scripts/eval-assist.ts [--keep] [--model id]
 *
 * Success criterion (ticket): ≥4/5 requests pass; ambiguity probe must not
 * mutate. Exit 0 iff both hold.
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { PlasmicClient } from "../src/client.js";
import { writeTools } from "../src/tools/write.js";
import { modelTools } from "../src/tools/model.js";
import { runAssist } from "../src/assist/loop.js";
import { checkIntegrity, summarizePages, type PageSummary } from "../src/assist/integrity.js";
import type { PlasmicModel } from "../src/model/index.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`missing env var ${name}`);
    process.exit(1);
  }
  return v;
}

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const modelFlag = argv.includes("--model")
  ? argv[argv.indexOf("--model") + 1]
  : undefined;

const client = new PlasmicClient({
  host: requireEnv("PLASMIC_HOST"),
  email: requireEnv("PLASMIC_EMAIL"),
  password: requireEnv("PLASMIC_PASSWORD"),
  userAgent: process.env.PLASMIC_USER_AGENT,
});
requireEnv("ANTHROPIC_API_KEY");

function tool(name: string) {
  const def = [...writeTools, ...modelTools].find((t) => t.name === name);
  if (!def) throw new Error(`tool not found: ${name}`);
  return (args: Record<string, unknown>) => def.handler(client, args as never);
}

async function readModel(projectId: string): Promise<{ revision: number; model: PlasmicModel }> {
  return (await tool("plasmic_get_page_model")({ projectId })) as {
    revision: number;
    model: PlasmicModel;
  };
}

function page(pages: PageSummary[], path: string): PageSummary | undefined {
  return pages.find((p) => p.path === path);
}

interface EvalCase {
  name: string;
  request: string;
  pagePath?: string;
  /** assert against a fresh post-run snapshot */
  check: (pages: PageSummary[], model: PlasmicModel) => string | null; // null = pass
}

const CASES: EvalCase[] = [
  {
    name: "hero section (canonical)",
    request:
      "On the Home page, add a hero section with our primary color and a CTA button labeled 'Get started'.",
    pagePath: "/",
    check: (pages) => {
      const home = page(pages, "/");
      if (!home) return "Home page missing";
      if (!home.texts.some((t) => /get started/i.test(t)))
        return `CTA text not found (texts: ${JSON.stringify(home.texts)})`;
      if ((home.counts.TplTag ?? 0) < 3)
        return `expected a section+children, got ${home.counts.TplTag ?? 0} TplTags`;
      return null;
    },
  },
  {
    name: "create About page",
    request:
      "Create a new page called About at /about with a heading that says 'About Aita'.",
    check: (pages) => {
      const about = page(pages, "/about");
      if (!about) return "no page at /about";
      if (!about.texts.some((t) => /about aita/i.test(t)))
        return `heading text not found (texts: ${JSON.stringify(about.texts)})`;
      return null;
    },
  },
  {
    name: "change welcome text",
    request:
      "On the Home page, change the text 'Welcome to Aita' to 'Welcome to the Aita platform'.",
    pagePath: "/",
    check: (pages) => {
      const home = page(pages, "/");
      if (!home) return "Home page missing";
      if (!home.texts.some((t) => /welcome to the aita platform/i.test(t)))
        return `updated text not found (texts: ${JSON.stringify(home.texts)})`;
      if (!home.texts.some((t) => /get started/i.test(t)))
        return `other texts were clobbered (texts: ${JSON.stringify(home.texts)})`;
      return null;
    },
  },
  {
    name: "footer section",
    request:
      "Add a footer section to the Home page with the text '© 2026 Aihe. All rights reserved.'",
    pagePath: "/",
    check: (pages) => {
      const home = page(pages, "/");
      if (!home) return "Home page missing";
      if (!home.texts.some((t) => t.includes("2026 Aihe")))
        return `footer text not found (texts: ${JSON.stringify(home.texts)})`;
      return null;
    },
  },
  {
    name: "duplicate page",
    request: "Duplicate the Home page as 'Landing v2' at path /landing-v2.",
    check: (pages) => {
      const dup = page(pages, "/landing-v2");
      if (!dup) return "no page at /landing-v2";
      const home = page(pages, "/");
      if (home && (dup.counts.TplTag ?? 0) < (home.counts.TplTag ?? 0))
        return `clone has fewer TplTags (${dup.counts.TplTag}) than Home (${home.counts.TplTag})`;
      return null;
    },
  },
];

async function main(): Promise<void> {
  console.log("== design-assist eval ==");
  const created = (await tool("plasmic_create_project")({
    name: `assist-eval-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`,
  })) as Record<string, unknown>;
  const project = (created.project ?? created) as Record<string, unknown>;
  const projectId = String(project.id ?? project.projectId ?? "");
  if (!projectId) throw new Error(`could not read project id from ${JSON.stringify(created)}`);
  console.log(`throwaway project: ${projectId}`);

  let passed = 0;
  let ambiguityOk = false;
  const lines: string[] = [];

  try {
    // seed: a Home page the requests can target
    await tool("plasmic_create_page")({
      projectId,
      name: "Home",
      path: "/",
      text: "Welcome to Aita",
    });

    for (const c of CASES) {
      console.log(`\n-- ${c.name}: "${c.request}"`);
      try {
        const report = await runAssist(
          client,
          { projectId, request: c.request, pagePath: c.pagePath },
          { model: modelFlag, log: (l) => console.log(`   ${l}`) }
        );
        const { model } = await readModel(projectId);
        const integrity = checkIntegrity(model);
        const failure =
          report.status !== "done"
            ? `status=${report.status} (${report.summary.slice(0, 200)})`
            : integrity.length
              ? `integrity: ${integrity.join("; ")}`
              : c.check(summarizePages(model), model);
        if (failure) {
          lines.push(`FAIL  ${c.name} — ${failure}`);
          console.log(`   FAIL: ${failure}`);
        } else {
          passed += 1;
          lines.push(`PASS  ${c.name} (rev ${report.revisions.from}→${report.revisions.to}, ${report.meta.toolCalls} tool calls)`);
          console.log(`   PASS`);
        }
      } catch (e) {
        lines.push(`FAIL  ${c.name} — threw: ${(e as Error).message}`);
        console.log(`   FAIL (threw): ${(e as Error).message}`);
      }
    }

    // ambiguity probe — must NOT mutate
    console.log(`\n-- ambiguity probe: "make it more modern"`);
    try {
      const before = (await readModel(projectId)).revision;
      const report = await runAssist(
        client,
        { projectId, request: "make it more modern" },
        { model: modelFlag, log: (l) => console.log(`   ${l}`) }
      );
      const after = (await readModel(projectId)).revision;
      const mutated = report.mutations.some((m) => m.ok) || after !== before;
      ambiguityOk = report.status === "needs_clarification" && !mutated;
      lines.push(
        `${ambiguityOk ? "PASS" : "FAIL"}  ambiguity probe — status=${report.status}, mutated=${mutated}${report.question ? `, q="${report.question}"` : ""}`
      );
      console.log(`   ${ambiguityOk ? "PASS" : "FAIL"}`);
    } catch (e) {
      lines.push(`FAIL  ambiguity probe — threw: ${(e as Error).message}`);
    }
  } finally {
    if (keep) {
      console.log(`\nkeeping project ${projectId} for inspection`);
    } else {
      await tool("plasmic_delete_project")({ projectId }).catch((e) =>
        console.error(`cleanup failed for ${projectId}: ${(e as Error).message}`)
      );
    }
  }

  console.log(`\n== scorecard ==`);
  for (const l of lines) console.log(l);
  console.log(`\n${passed}/${CASES.length} requests passed; ambiguity probe ${ambiguityOk ? "ok" : "FAILED"}`);
  process.exit(passed >= 4 && ambiguityOk ? 0 : 1);
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error)?.stack ?? e}`);
  process.exit(1);
});

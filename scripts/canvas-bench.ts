/**
 * Canvas paste reliability benchmark (ClickUp 86ey4ffq0 metric).
 *
 * Creates a scratch project, seeds the design tokens the templates use,
 * then runs N sequential template inserts through the full hardened path
 * (fresh browser context per op, REST-verified). Prints per-attempt results
 * and the success rate. Target: >= 9/10 without manual retry.
 *
 * Run:  npm run canvas:bench            (N=10, cleans up the project)
 *       npm run canvas:bench -- 5 keep  (N=5, keep the project for inspection)
 */
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env") });

import { PlasmicClient } from "../src/client.js";
import { insertHtmlOp } from "../src/tools/canvas.js";
import { TEMPLATES, renderTemplate } from "../src/templates/index.js";
import { DS_TOKENS } from "../src/templates/tokens.js";

const N = Number(process.argv[2] ?? 10);
const KEEP = process.argv.includes("keep");

const CASES: Array<{ template: string; params: unknown }> = [
  { template: "hero", params: { title: "Bench Hero", subtitle: "Sub", ctaText: "Go" } },
  {
    template: "cardGrid",
    params: { heading: "Cards", columns: 3, cards: [{ title: "A", body: "a" }, { title: "B", body: "b" }, { title: "C", body: "c" }] },
  },
  {
    template: "formSection",
    params: { title: "Contact", fields: [{ label: "Email", type: "email" }, { label: "Name" }], submitText: "Send" },
  },
  {
    template: "twoColumnLayout",
    params: { leftHtml: "<p>Left</p>", rightHtml: "<p>Right</p>", ratio: "1:1" },
  },
  { template: "emptyState", params: { icon: "📭", title: "Empty", description: "Nothing yet." } },
];

async function main() {
  const client = new PlasmicClient({
    host: process.env.PLASMIC_HOST!,
    email: process.env.PLASMIC_EMAIL!,
    password: process.env.PLASMIC_PASSWORD!,
    userAgent: process.env.PLASMIC_USER_AGENT,
  });

  console.log("creating scratch project + seeding tokens...");
  const created = (await client.post("/api/v1/projects", {
    name: `canvas-bench-${new Date().toISOString().slice(0, 16)}`,
  })) as { project?: { id?: string }; projectId?: string; id?: string };
  const projectId = created.project?.id ?? created.projectId ?? created.id!;
  const needed = new Set(Object.values(TEMPLATES).flatMap((t) => t.tokensUsed));
  for (const t of DS_TOKENS.filter((t) => needed.has(t.varName))) {
    await client.post(`/api/v1/projects/${projectId}/tokens`, {
      name: t.name,
      type: t.type,
      value: t.value,
    });
  }
  console.log(`project ${projectId}, ${needed.size} tokens seeded, running ${N} inserts...\n`);

  const results: Array<{ n: number; template: string; ok: boolean; ms: number; detail: string }> = [];
  for (let i = 0; i < N; i++) {
    const c = CASES[i % CASES.length];
    const started = Date.now();
    try {
      const html = renderTemplate(c.template, c.params);
      const r = await insertHtmlOp(client, { projectId, html });
      results.push({
        n: i + 1,
        template: c.template,
        ok: true,
        ms: Date.now() - started,
        detail: `+${r.modelNodesAdded} nodes (canvas +${r.tplNodesAdded}), rev ${r.revisionBefore}->${r.revisionAfter}, attempts ${r.pasteAttempts}${r.createdPage ? ", created page" : ""}`,
      });
    } catch (e: unknown) {
      const err = e as { kind?: string; message?: string };
      results.push({
        n: i + 1,
        template: c.template,
        ok: false,
        ms: Date.now() - started,
        detail: `${err.kind ?? "ERROR"}: ${err.message?.slice(0, 140)}`,
      });
    }
    const last = results[results.length - 1];
    console.log(
      `${last.ok ? "PASS" : "FAIL"}  #${last.n} ${last.template.padEnd(16)} ${String(last.ms).padStart(6)}ms  ${last.detail}`
    );
  }

  const passed = results.filter((r) => r.ok).length;
  const times = results.filter((r) => r.ok).map((r) => r.ms);
  const avg = times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : 0;
  console.log(
    `\nRESULT: ${passed}/${N} succeeded (${Math.round((passed / N) * 100)}%), avg ${avg}ms per successful insert`
  );
  console.log(passed >= Math.ceil(N * 0.9) ? "TARGET MET (>=90%)" : "TARGET MISSED (<90%)");

  if (KEEP) {
    console.log(`keeping project ${projectId} for inspection`);
  } else {
    await client.delete(`/api/v1/projects/${projectId}`);
    console.log(`deleted scratch project ${projectId}`);
  }
  process.exit(passed >= Math.ceil(N * 0.9) ? 0 : 1);
}

main().catch((e) => {
  console.error("bench failed:", (e as Error)?.message ?? e);
  process.exit(1);
});

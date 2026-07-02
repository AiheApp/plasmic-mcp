/**
 * Benchmark runner — the ticket's "automated guard".
 *
 * For each case in bench/instructions.ts: create a throwaway project on the
 * Studio, seed it, run the instruction through HEADLESS Claude (claude -p)
 * armed with assistant/PROMPT.md + the plasmic MCP server, then grade the
 * outcome by re-reading the model with the typed library. Prints a table and
 * the % applied correctly; exits 0 iff the pass bar is met.
 *
 *   npx tsx bench/run.ts [--model <id>] [--case <id>] [--keep]
 *
 * Requires: npm run build (the MCP config points at dist/index.js), .env with
 * PLASMIC_HOST/EMAIL/PASSWORD, and a logged-in `claude` CLI on PATH.
 * Pass bar: >=8/10 total AND both refuse-* cases pass.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
loadEnv({ path: join(repoRoot, ".env") });

import { PlasmicClient } from "../src/client.js";
import { batchTools } from "../src/tools/batch.js";
import { writeTools } from "../src/tools/write.js";
import { fetchRev } from "../src/tools/revision.js";
import { CASES, type BenchCase, type ResultLine } from "./instructions.js";

// ---- args ----
const argv = process.argv.slice(2);
const argValue = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const MODEL = argValue("--model") ?? "claude-sonnet-5";
const ONLY_CASE = argValue("--case");
const KEEP = argv.includes("--keep");
const PASS_BAR = 8;

const PROMPT = readFileSync(join(repoRoot, "assistant", "PROMPT.md"), "utf8");

const handler = (list: { name: string; handler: Function }[], name: string) => {
  const t = list.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t.handler as (client: PlasmicClient, args: unknown) => Promise<unknown>;
};
const createProject = handler(writeTools, "plasmic_create_project");
const deleteProject = handler(writeTools, "plasmic_delete_project");
const createToken = handler(writeTools, "plasmic_create_token");
const applyMutations = handler(batchTools, "plasmic_apply_mutations");

const client = new PlasmicClient({
  host: process.env.PLASMIC_HOST!,
  email: process.env.PLASMIC_EMAIL!,
  password: process.env.PLASMIC_PASSWORD!,
});

interface SeedResult {
  seedRevision: number;
  tokens: Record<string, string>;
}

async function seedProject(projectId: string, c: BenchCase): Promise<SeedResult> {
  const tokens: Record<string, string> = {};
  for (const [name, value] of [
    ["primary-blue", "#4169e1"],
    ["text-light-1", "#1f1f1f"],
  ] as const) {
    const res = (await createToken(client, {
      projectId,
      name,
      type: "Color",
      value,
    })) as { token?: { uuid?: string; id?: string } };
    const uuid = res.token?.uuid ?? res.token?.id;
    if (!uuid) throw new Error(`token seed failed: ${JSON.stringify(res)}`);
    tokens[name] = uuid;
  }

  const ops: unknown[] = [
    { op: "create_page", id: "home", name: "Home", path: "/home" },
    {
      op: "add_element",
      id: "hero",
      parentIid: "$home.rootTpl",
      tag: "div",
      type: "text",
      text: "Hello from Aihe",
    },
    {
      op: "add_element",
      id: "banner",
      parentIid: "$home.rootTpl",
      tag: "div",
      type: "text",
      text: "Old banner",
    },
  ];
  if (c.extraSeedPage) {
    ops.push({
      op: "create_page",
      name: c.extraSeedPage.name,
      path: c.extraSeedPage.path,
      text: c.extraSeedPage.text,
    });
  }
  const applied = (await applyMutations(client, { projectId, ops })) as {
    applied: boolean;
    revision?: number;
  };
  if (!applied.applied) throw new Error(`seed failed: ${JSON.stringify(applied)}`);
  return { seedRevision: applied.revision!, tokens };
}

function runHeadless(projectId: string, instruction: string, cwd: string): {
  resultText: string;
  numTurns?: number;
  costUsd?: number;
  raw: string;
} {
  const mcpConfig = join(cwd, "mcp-config.json");
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        plasmic: { command: "node", args: [join(repoRoot, "dist", "index.js")] },
      },
    })
  );
  const prompt = [
    PROMPT,
    "",
    "## BENCHMARK MODE",
    "The designer has pre-confirmed every preview. After plasmic_plan_mutations",
    "returns valid: true, immediately call plasmic_apply_mutations with the same",
    "ops and expectedRevision = baseRevision — do not wait for a reply. Never ask",
    "the user questions; if you would ask a clarifying question, end with the",
    "clarification RESULT line instead.",
    "",
    `projectId: ${projectId}`,
    `Designer request: ${instruction}`,
  ].join("\n");

  const res = spawnSync(
    "claude",
    [
      "-p",
      prompt,
      "--mcp-config",
      mcpConfig,
      "--strict-mcp-config",
      "--allowedTools",
      "mcp__plasmic",
      "--model",
      MODEL,
      "--output-format",
      "json",
    ],
    { encoding: "utf8", cwd, timeout: 480_000, maxBuffer: 64 * 1024 * 1024 }
  );
  const raw = (res.stdout ?? "") + (res.stderr ? `\n[stderr] ${res.stderr}` : "");
  try {
    const parsed = JSON.parse(res.stdout) as {
      result?: string;
      num_turns?: number;
      total_cost_usd?: number;
    };
    return {
      resultText: parsed.result ?? "",
      numTurns: parsed.num_turns,
      costUsd: parsed.total_cost_usd,
      raw,
    };
  } catch {
    return { resultText: res.stdout ?? "", raw };
  }
}

function parseResultLine(text: string): ResultLine | null {
  const matches = [...text.matchAll(/RESULT:\s*(\{[^\n]*\})/g)];
  if (!matches.length) return null;
  try {
    return JSON.parse(matches[matches.length - 1][1]) as ResultLine;
  } catch {
    return null;
  }
}

async function runCase(c: BenchCase, cwd: string) {
  const created = (await createProject(client, {
    name: `bench-${c.id}`,
  })) as { id?: string; project?: { id: string } };
  const projectId = created.project?.id ?? created.id;
  if (!projectId) throw new Error("project creation failed");

  try {
    const { seedRevision, tokens } = await seedProject(projectId, c);
    const t0 = Date.now();
    const run = runHeadless(projectId, c.instruction, cwd);
    const secs = Math.round((Date.now() - t0) / 1000);
    const result = parseResultLine(run.resultText);
    const { revision, model } = await fetchRev(client, projectId);
    const failures = c.verify({ model, revision, seedRevision, result, tokens });
    return {
      id: c.id,
      pass: failures.length === 0,
      failures,
      status: result?.status ?? "none",
      revisions: `${seedRevision}→${revision}`,
      secs,
      numTurns: run.numTurns,
      costUsd: run.costUsd,
      projectId,
      resultText: run.resultText,
    };
  } finally {
    if (!KEEP) await deleteProject(client, { projectId }).catch(() => undefined);
  }
}

async function main() {
  const cases = ONLY_CASE ? CASES.filter((c) => c.id === ONLY_CASE) : CASES;
  if (!cases.length) throw new Error(`no case matches ${ONLY_CASE}`);
  const cwd = mkdtempSync(join(tmpdir(), "plasmic-bench-"));
  console.log(`model: ${MODEL} | cases: ${cases.length} | host: ${process.env.PLASMIC_HOST}\n`);

  const rows: Awaited<ReturnType<typeof runCase>>[] = [];
  for (const c of cases) {
    process.stdout.write(`▶ ${c.id} … `);
    try {
      const row = await runCase(c, cwd);
      rows.push(row);
      console.log(
        `${row.pass ? "PASS" : "FAIL"} (${row.secs}s, ${row.numTurns ?? "?"} turns, status=${row.status}, rev ${row.revisions})`
      );
      if (!row.pass) {
        for (const f of row.failures) console.log(`    ✗ ${f}`);
        console.log(`    last output: ${row.resultText.slice(-400).replace(/\n/g, " ")}`);
      }
    } catch (e) {
      rows.push({
        id: c.id,
        pass: false,
        failures: [(e as Error).message],
        status: "error",
        revisions: "-",
        secs: 0,
        projectId: "-",
        resultText: "",
      } as never);
      console.log(`ERROR — ${(e as Error).message.slice(0, 200)}`);
    }
  }
  rmSync(cwd, { recursive: true, force: true });

  const passed = rows.filter((r) => r.pass).length;
  const refusalsOk = rows
    .filter((r) => r.id.startsWith("refuse-"))
    .every((r) => r.pass);
  const cost = rows.reduce((s, r) => s + (r.costUsd ?? 0), 0);
  console.log(`\n${"case".padEnd(22)} pass  status         revisions`);
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(22)} ${(r.pass ? "PASS" : "FAIL").padEnd(5)} ${r.status.padEnd(14)} ${r.revisions}`
    );
  }
  const pct = Math.round((passed / rows.length) * 100);
  console.log(
    `\nscore: ${passed}/${rows.length} (${pct}%) | refusal cases ${refusalsOk ? "OK" : "FAILED"} | est. cost $${cost.toFixed(2)}`
  );
  const ok = ONLY_CASE ? passed === rows.length : passed >= PASS_BAR && refusalsOk;
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error("bench fatal:", e);
  process.exit(2);
});

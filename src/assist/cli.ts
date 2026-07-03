#!/usr/bin/env node
/**
 * design-assist CLI — run one designer request from the terminal.
 *
 *   npm run assist -- <projectId> "<request>" [--page /path] [--model id] [--quiet]
 *
 * Prints the AssistReport as JSON. Exit codes: 0 done, 2 needs_clarification,
 * 1 failed/partial_failure.
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

import { PlasmicClient } from "../client.js";
import { runAssist } from "./loop.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`[design-assist] missing required env var ${name}`);
    process.exit(1);
  }
  return v;
}

function usage(): never {
  console.error(
    'usage: assist <projectId> "<request>" [--page /path] [--model id] [--quiet]'
  );
  process.exit(1);
}

const argv = process.argv.slice(2);
const positional: string[] = [];
let pagePath: string | undefined;
let model: string | undefined;
let quiet = false;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--page") pagePath = argv[++i];
  else if (a === "--model") model = argv[++i];
  else if (a === "--quiet") quiet = true;
  else positional.push(a);
}
if (positional.length < 2) usage();
const [projectId, ...rest] = positional;
const request = rest.join(" ");

const client = new PlasmicClient({
  host: requireEnv("PLASMIC_HOST"),
  email: requireEnv("PLASMIC_EMAIL"),
  password: requireEnv("PLASMIC_PASSWORD"),
  userAgent: process.env.PLASMIC_USER_AGENT,
});

runAssist(
  client,
  { projectId, request, pagePath },
  { model, log: quiet ? undefined : (l) => console.error(`[assist] ${l}`) }
)
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(
      report.status === "done" ? 0 : report.status === "needs_clarification" ? 2 : 1
    );
  })
  .catch((e) => {
    console.error(`[design-assist] fatal: ${(e as Error)?.message ?? e}`);
    process.exit(1);
  });

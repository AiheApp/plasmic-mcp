# Design Assistant Runbook

Operate the Plasmic design assistant: natural-language request → validated,
atomic model mutation on studio.aihe.dev, with preview/confirm before commit.
Written to be operable by any Claude model (Sonnet/Haiku included).

## 1. One-time setup

```bash
cd /Users/salami/Documents/projects/plasmic-mcp
cp .env.example .env   # then fill in:
#   PLASMIC_HOST=https://studio.aihe.dev
#   PLASMIC_EMAIL=<service account email>
#   PLASMIC_PASSWORD=<from the ClickUp Secrets list (id 901803419403)>
npm ci && npm run build && npm test   # everything must be green
```

Register the MCP server for Claude Code (once):

```bash
claude mcp add plasmic -- node /Users/salami/Documents/projects/plasmic-mcp/dist/index.js
```

Optional interactive skill: copy `assistant/SKILL.md` into
`~/.claude/skills/plasmic-design-assist/SKILL.md`.

## 2. Interactive use

```
/plasmic-design-assist <projectId> Add a hero section with our primary color and a CTA
```

or just paste `assistant/PROMPT.md` + the projectId + request into any Claude
session that has the plasmic MCP server. The flow you will see:

1. The assistant reads pages/tokens, composes ONE ops batch, and calls
   `plasmic_plan_mutations`.
2. It shows you the plan preview (one line per op, e.g.
   `1. create_page  + page "Pricing" at /pricing`) and asks for confirmation.
3. Only after your explicit "yes" it calls `plasmic_apply_mutations` with
   `expectedRevision` — the whole batch lands as ONE revision.
4. It re-reads the model, confirms the change, and gives you the Studio link
   `https://studio.aihe.dev/projects/<projectId>`.

## 3. Headless one-shot

```bash
claude -p "$(cat assistant/PROMPT.md)

## BENCHMARK MODE
The designer has pre-confirmed every preview. After plasmic_plan_mutations
returns valid: true, immediately apply. Never ask questions.

projectId: <PROJECT_ID>
Designer request: <REQUEST>" \
  --mcp-config '{"mcpServers":{"plasmic":{"command":"node","args":["/Users/salami/Documents/projects/plasmic-mcp/dist/index.js"]}}}' \
  --strict-mcp-config --allowedTools mcp__plasmic \
  --model claude-sonnet-5 --output-format json
```

The final message always ends with a machine-parseable line:
`RESULT: {"status":"applied"|"refused"|"clarification","revision":N|null}`.

## 4. Failure modes (all safe)

- **Refusal**: unsupported requests (interactivity, auth, uploads, variants)
  and vague ones ("more modern") are refused or answered with one clarifying
  question. NOTHING is mutated — `status` is `refused`/`clarification`.
- **Invalid plan**: `plasmic_plan_mutations` returns `valid:false` with per-op
  errors (`TARGET_NOT_FOUND`, `TOKEN_NOT_FOUND` incl. closest-name
  suggestions, `PATH_TAKEN`, …). Nothing is saved.
- **Mid-batch failure**: impossible to partially apply — the batch is
  trial-executed first and saved as one revision only if every op succeeds.
- **`REVISION_CONFLICT` / HTTP 412**: someone saved between plan and apply.
  The Studio server enforces optimistic concurrency (verified live: a
  duplicate revisionNum is rejected with 412), so concurrent edits cannot be
  clobbered. The assistant re-reads, re-plans, and re-asks. Avoid co-editing
  a project in Studio while an apply is in flight anyway.

## 5. Rollback

Every apply is exactly ONE revision (`revision: N` in the report).

- Studio UI: project → History → restore the previous revision.
- Or apply an inverse batch (delete the added elements / restore the previous
  text) via the same plan→confirm→apply flow.

## 6. Benchmark (the automated guard)

```bash
npm run build                       # bench spawns dist/index.js
npx tsx bench/run.ts                # full 10-case set, Sonnet
npx tsx bench/run.ts --model claude-haiku-4-5-20251001   # cheap-model lane
npx tsx bench/run.ts --case token-color --keep           # one case, keep project
```

Each case creates a fresh throwaway `bench-*` project, seeds it, runs the
instruction through headless Claude, grades the result by re-reading the
model with the typed library (never by trusting the LLM), and deletes the
project. Pass bar: **≥8/10 and both `refuse-*` cases must pass** (the ticket
requires ≥4/5). Exit code 0 = pass. If `--keep` was used, clean up leftover
`bench-*` projects with `plasmic_list_projects` + `plasmic_delete_project`.

## 7. Known caveats

- Registered design-system tokens (Aita's `registerToken` set) resolve as
  `var(--token-<uuid>)` in the model; canvas rendering of REGISTERED tokens
  depends on the host app's registration CSS being loaded (project-local
  tokens render unconditionally — verified live).
- `MODEL_SCHEMA_HASH` / `MODEL_VERSION` are pinned to the current Studio
  build; a Studio upgrade breaks all revision saves. The benchmark doubles as
  the canary — run it after any Studio upgrade.
- Inserting registered code components (TplComponent) is out of scope for
  v1; the assistant builds pages from styled text/container elements.

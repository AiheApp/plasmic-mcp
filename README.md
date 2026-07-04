# plasmic-mcp

An [MCP](https://modelcontextprotocol.io) server for **headless ops against a
self-hosted Plasmic instance** (e.g. `studio.aihe.dev`). It wraps the Plasmic
REST API so Claude/agents can list, create, clone, update, publish, and manage
projects, toggle devflags, manage permissions, and generate UI via Copilot —
without driving the Studio UI.

> **Scope:** this is authoring/ops automation. It mutates the project **model**
> (pages, elements, styles) by editing the bundle graph and saving a new
> revision — see *Model mutation* below. It does not drive the **live in-canvas**
> editor (`window.PLASMIC_AI_TOOLS` is OSS-stubbed in the self-hosted build). See
> *Deferred* below.

## Why session + CSRF (not a personal API token)

The personal `x-plasmic-api-token` + `x-plasmic-api-user` pair authenticates the
request but most **mutating** routes still pass through `lusca.csrf()` unless the
request is a project/CMS/team-token "public API" call — which the personal pair
is not. So personal-token GETs work, but `create`/`clone`/`update-meta`/`publish`/
`grant-revoke`/`copilot/ui` are CSRF-rejected. This server logs in like a browser
(`GET /auth/csrf` → `POST /auth/login` → `GET /auth/csrf`) and reuses the session
cookie + CSRF token on every call, re-authenticating once on a 401/CSRF-mismatch.

## Setup

```bash
npm install
npm run build
cp .env.example .env   # fill in PLASMIC_HOST / PLASMIC_EMAIL / PLASMIC_PASSWORD
npm test               # unit tests (live smoke auto-skips without creds)
```

Register with Claude Code:

```bash
claude mcp add plasmic -- node /absolute/path/to/plasmic-mcp/dist/index.js
# pass secrets via the MCP config `env`, or rely on a local .env
claude mcp list        # should show "plasmic" connected
```

Use a **dedicated service account**; rotate the password; never commit `.env`.

## Tools

### Reads
`plasmic_list_projects`, `plasmic_get_project_meta`,
`plasmic_get_project_rev_without_data`, `plasmic_get_pkg_by_project`,
`plasmic_list_unpublished_revisions`, `plasmic_get_pkg_publish_status`,
`plasmic_get_workspace`, `plasmic_get_devflags` (admin).

### Safe writes
`plasmic_create_project`, `plasmic_create_project_with_hostless_packages`,
`plasmic_clone_project`, `plasmic_update_project_meta`, `plasmic_set_app_host`,
`plasmic_publish_project`, `plasmic_grant_revoke`, `plasmic_set_devflags`,
`plasmic_generate_ui` (Copilot).

- **`plasmic_set_app_host`** configures the project's custom app host
  (`PUT /projects/{id}/update-host`) — the step Studio hides behind
  "Configure custom app host". Until it's set, a new project has zero
  code-component visibility. Pass `hostUrl: null` to clear.
- **`plasmic_set_devflags`** is admin-only and writes a **global, instance-wide**
  override. It does a safe read-modify-write of a single key and **requires
  `confirm: true`**.
- **`plasmic_publish_project`** needs a saved unpublished revision; otherwise the
  server error is surfaced as-is.
- **`plasmic_generate_ui`** has a 60s timeout; 503/timeout return structured
  errors rather than hanging.

### Model mutation (pages / elements)

These tools read the project's model bundle (`GET /api/v1/projects/{id}` →
`rev.data`, a JSON string), mutate the flat iid-keyed graph in memory, and save
a new revision (`POST /api/v1/projects/{id}/revisions/{n}`). The mutation logic
lives in a typed, pure library under [`src/model/`](src/model) — `graph.ts`
(insert/delete/update/find), `builders.ts` (page/element/code-component node
factories), `serialize.ts` (parse/serialize + revision body), all built from the
live-proven node shapes.

| Tool | Description |
|---|---|
| `plasmic_list_pages` | List page components (name, path, iid) at the current revision |
| `plasmic_get_page_model` | Full iid graph; pass `pageIid` to scope to one page's subtree |
| `plasmic_create_page` | Create a page (name, path, optional text); wires Site.components + Site.pageArenas with a fully-framed PageArena |
| `plasmic_update_page_text` | Replace RawText in a page (select by `pageIid` or `path`; optional single `textIid`) |
| `plasmic_add_element` | Insert a TplTag (div/span/text/image/…) under a parent iid |
| `plasmic_delete_element` | Remove a TplTag + all descendants; strips the parent ref |
| `plasmic_apply_token` | Set a RuleSet CSS prop to a design-token ref |
| `plasmic_upsert_component` | Create/update registered code-component metadata |
| `plasmic_duplicate_page` | Clone a page's component subtree with a new name + path; the clone gets a freshly built PageArena |
| `plasmic_get_element` | Read one element's styles / text / children by iid |
| `plasmic_repair_page_arenas` | Heal broken/missing PageArenas (empty grids from older headless creation); idempotent, supports `dryRun` |

> **PageArena shape.** Studio requires `matrix` to hold one `ArenaFrameRow`
> per component variant with one `ArenaFrame` per screen size (each frame's
> `container` instances the page), and `customMatrix` to hold ONE empty row.
> Pages created with empty grids render "This page is empty" and crash
> add-screen-size with `PageArena has no ArenaFrameRow`. All page-creating
> paths here now build the full shape (ground truth: a Studio-UI-created
> page, 2026-07-04); `plasmic_repair_page_arenas` retrofits old pages.

### Atomic batch mutation (preview → confirm → apply)

The design-assistant workflow (ClickUp 86ey4ferx) rides on two batch tools
backed by [`src/model/batch.ts`](src/model/batch.ts):

| Tool | Description |
|---|---|
| `plasmic_plan_mutations` | Validate + trial-execute an ops batch WITHOUT saving; returns `baseRevision` + a human-readable preview diff, or per-op errors |
| `plasmic_apply_mutations` | Re-validate against the fresh head and apply the whole batch in ONE revision save; `expectedRevision` mismatch aborts with `REVISION_CONFLICT` |

Ops (`create_page`, `duplicate_page`, `add_element`, `set_text`,
`delete_element`, `apply_token`, `set_styles`) chain through `$id`
placeholders (`$hero.rootTpl`, `$cta.rs`, …). A batch is atomic: any failing
op means nothing is saved. Batch validation is intentionally stricter than
the single-op tools (e.g. `create_page` rejects an already-taken path with
`PATH_TAKEN`). The Studio server additionally rejects stale `revisionNum`
saves with HTTP 412 (verified live), so concurrent Studio edits cannot be
clobbered.

The assistant prompt, skill, and runbook live in [`assistant/`](assistant);
the live benchmark harness in [`bench/`](bench).

The library enforces these graph invariants (each covered by a unit test):

1. every node added to `map` has a `__ref` back-link from its parent
2. `TplTag.parent` always points to the parent's iid
3. every `Component` has ≥1 base `Variant`
4. every `VariantSetting.variants` ref resolves to a valid variant iid
5. `Site.components` + `Site.pageArenas` stay in sync when adding pages
6. `modifiedComponentIids` includes all changed component iids
7. `revisionNum` = `currentRevision + 1` exactly

> **Note — `apply_token`:** the design-token reference is written as the CSS
> `var(--token-<uuid>)` string form (shared helper `tokenRefValue`). Verified
> live (2026-07-02): the value round-trips through a revision save for
> project-local tokens. Canvas rendering of REGISTERED (host-app) tokens
> depends on the registration CSS being loaded.
>
> **Note — `upsert_component` (create path):** code-component node shape is
> derived from the OSS `model-schema.ts` (no live-proven literal like pages
> have); treat first-time creation as best-effort pending a live E2E.

## Design assist (designer request → Studio mutation)

The **design-assist** layer (`src/assist/`) turns a designer's natural-language
request into verified model mutations: it renders the prompt template at
[`prompts/design-assistant.md`](prompts/design-assistant.md) with live project
context (pages, the project's design tokens, registered code components), runs
an Anthropic tool loop over a **curated, non-destructive subset** of the tools
above — reads plus the atomic batch pair only (`plasmic_plan_mutations` /
`plasmic_apply_mutations`; no per-op mutators, no delete_project / devflags /
permissions / publish), so every request lands as ONE revision or not at all —
then **independently verifies**: re-reads the model, diffs page summaries
(element counts + texts), and integrity-checks the graph for dangling `__ref`s
and broken parent links before reporting.

Three ways to run it:

```bash
# CLI (local, .env provides creds)
npm run assist -- <projectId> "add a hero section with our primary color and a CTA"

# HTTP service (the n8n webhook proxies to this)
ASSIST_BEARER_TOKEN=… ANTHROPIC_API_KEY=… npm run assist:server
curl -X POST :8766/design-assist -H "authorization: Bearer $TOKEN" \
  -d '{"projectId":"…","request":"…"}'          # add "wait":false for async job mode

# Live benchmark (10 cases on throwaway bench-* projects; gate: ≥8/10 incl. both refusals)
npm run bench
```

The report is structured JSON: `status` (`done` / `needs_clarification` /
`partial_failure` / `failed`), designer-facing `summary`, per-call `mutations`
log, `revisions.from→to`, measured page `diff`, `integrityIssues`, a Studio
review link, and `undo` guidance. Env: `ASSIST_MODEL` (default
`claude-sonnet-5`), `ASSIST_PORT` (default 8766), `ASSIST_BEARER_TOKEN`
(required by the server), `ANTHROPIC_API_KEY`, `ASSIST_PUBLIC_STUDIO_URL`
(designer-facing links when `PLASMIC_HOST` is an internal address).

## Canvas insertion + verification (browser-driven)

These tools drive a headless Chromium against the live Studio to land HTML as
**real Plasmic nodes** via `studioCtx.paste` — retrying on canvas-timing
failures and verifying success through the REST model (revision must advance
AND the new nodes must exist in the saved model — **no false-green**). See
[`docs/canvas-runbook.md`](docs/canvas-runbook.md) for the full gotcha list
and error-kind triage table.

| Tool | Description |
|---|---|
| `plasmic_insert_html` | Paste raw HTML into a page (or auto-create one via Studio when the project has none); structured errors with diagnostics |
| `plasmic_insert_template` | Render a built-in token-aware template and insert it; validates `var(--token-*)` refs against the target project first (`tokenPolicy: strict\|warn`) |
| `plasmic_list_templates` | Template catalog: names, param schemas, tokens used, CSS/token authoring rules |
| `plasmic_canvas_doctor` | Read-only triage: auth, Studio reachability, `allowHtmlPaste`, `PLASMIC_AI_TOOLS`, per-page arena frame counts |
| `plasmic_canvas_screenshot` | Capture what Studio ACTUALLY renders for a page (per-frame artboard PNG, or `fullStudio`); the anti-"silent absence" verification |

Requirements: `npx playwright install chromium` on the machine running the
server (the Docker image is REST-only; canvas tools fail with a structured
`BROWSER_UNAVAILABLE` error there). Self-hosted HTML paste needs the account
to have the `allowHtmlPaste` devflag (admin-team emails); on Plasmic Cloud the
tools fall back to `PLASMIC_AI_TOOLS.createComponent` (auth via
`PLASMIC_STORAGE_STATE`).

**Plasmic Cloud auth, headless:** `npm run cloud:login` logs into
`studio.plasmic.app` with `PLASMIC_CLOUD_EMAIL`/`PLASMIC_CLOUD_PASSWORD` from
`.env` (values: the ClickUp passwords/links doc), verifies the session against
`/api/v1/auth/self`, and saves a Playwright storage-state to
`.plasmic/cloud-state.json` (gitignored). Point `PLASMIC_STORAGE_STATE` at it
and every canvas tool works against Cloud with zero interactive login; re-run
the script when the session expires.

Cloud caveat (pre-existing, not an auth issue): a project whose app host is
`http://localhost:3000/plasmic-host` never boots its canvas on HTTPS
`studio.plasmic.app` (mixed content) — `openStudio` times out with
`CANVAS_NOT_READY` even though the session is valid. Such projects need the
local host served through an HTTPS tunnel, or an HTTPS-deployed host.

Templates reference design tokens as `var(--token-<kebab-name>)`; the token
allowlist ([`src/templates/tokens.ts`](src/templates/tokens.ts)) is generated
from the live design-system project with `npm run gen:tokens`. Reliability
benchmark: `npm run canvas:bench` (N sequential inserts on a scratch project;
target ≥90% without manual retry).

## Deferred (not built)

- **Reverse codegen** (`POST …/code/components`) — possible phase 2.

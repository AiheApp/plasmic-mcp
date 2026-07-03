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
`plasmic_clone_project`, `plasmic_update_project_meta`, `plasmic_publish_project`,
`plasmic_grant_revoke`, `plasmic_set_devflags`, `plasmic_generate_ui` (Copilot).

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
| `plasmic_create_page` | Create a page (name, path, optional text); wires Site.components + Site.pageArenas |
| `plasmic_update_page_text` | Replace RawText in a page (select by `pageIid` or `path`; optional single `textIid`) |
| `plasmic_add_element` | Insert a TplTag (div/span/text/image/…) under a parent iid |
| `plasmic_delete_element` | Remove a TplTag + all descendants; strips the parent ref |
| `plasmic_apply_token` | Set a RuleSet CSS prop to a design-token ref |
| `plasmic_upsert_component` | Create/update registered code-component metadata |
| `plasmic_duplicate_page` | Clone a page (component + PageArena) with a new name + path |
| `plasmic_get_element` | Read one element's styles / text / children by iid |

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
above (no delete_project / devflags / permissions / publish), then
**independently verifies** — re-reads the model, diffs page summaries
(element counts + texts), and integrity-checks the graph for dangling `__ref`s
and broken parent links — before reporting.

Three ways to run it:

```bash
# CLI (local, .env provides creds)
npm run assist -- <projectId> "add a hero section with our primary color and a CTA"

# HTTP service (the n8n webhook proxies to this)
ASSIST_BEARER_TOKEN=… ANTHROPIC_API_KEY=… npm run assist:server
curl -X POST :8766/design-assist -H "authorization: Bearer $TOKEN" \
  -d '{"projectId":"…","request":"…"}'          # add "wait":false for async job mode

# Live eval harness (throwaway project; ticket gate: ≥4/5 + ambiguity probe)
npm run eval:assist
```

The report is structured JSON: `status` (`done` / `needs_clarification` /
`partial_failure` / `failed`), designer-facing `summary`, per-call `mutations`
log, `revisions.from→to`, measured page `diff`, `integrityIssues`, a Studio
review link, and `undo` guidance. Env: `ASSIST_MODEL` (default
`claude-sonnet-5`), `ASSIST_PORT` (default 8766), `ASSIST_BEARER_TOKEN`
(required by the server), `ANTHROPIC_API_KEY`, `ASSIST_PUBLIC_STUDIO_URL`
(designer-facing links when `PLASMIC_HOST` is an internal address).

## Deferred (not built)

- **In-canvas live design** (`PLASMIC_AI_TOOLS`) — OSS-stubbed in the self-hosted
  build; needs the copilot tool registry + bridge implemented in core.
- **Reverse codegen** (`POST …/code/components`) — possible phase 2.

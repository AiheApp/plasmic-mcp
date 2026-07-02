# plasmic-mcp

An [MCP](https://modelcontextprotocol.io) server for **headless ops against a
self-hosted Plasmic instance** (e.g. `studio.aihe.dev`). It wraps the Plasmic
REST API so Claude/agents can list, create, clone, update, publish, and manage
projects, toggle devflags, manage permissions, and generate UI via Copilot —
without driving the Studio UI.

> **Scope:** this is authoring/ops automation, not in-canvas design. It cannot
> manipulate the live element tree (`window.PLASMIC_AI_TOOLS` is OSS-stubbed in
> the self-hosted build) and does not place components on the canvas. See
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

## Deferred (not built)

- **insert-component / in-canvas authoring** — would require serializing a
  modified Bundle through `saveProjectRev`; high corruption risk.
- **In-canvas live design** (`PLASMIC_AI_TOOLS`) — OSS-stubbed in the self-hosted
  build; needs the copilot tool registry + bridge implemented in core.
- **Reverse codegen** (`POST …/code/components`) — possible phase 2.

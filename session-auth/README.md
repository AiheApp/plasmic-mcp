# session-auth — Admin/Management MCP Server

This is the **session+CSRF authenticated** MCP server for headless ops against a self-hosted Plasmic instance. It lives alongside the public-API server (root of this repo) which uses personal API tokens.

## Why a separate server?

The personal `x-plasmic-api-token` + `x-plasmic-api-user` pair works for GET requests but is **CSRF-blocked on all mutating routes** (`POST /projects`, `/clone`, `/publish`, `/grant-revoke`, `/copilot/ui`, etc.) because those routes pass through `lusca.csrf()`. This server logs in like a browser session, getting a real session cookie + CSRF token, giving it access to the full API surface.

## Tools (16)

**Reads:** `plasmic_list_projects`, `plasmic_get_project_meta`, `plasmic_get_project_rev_without_data`, `plasmic_get_pkg_by_project`, `plasmic_list_unpublished_revisions`, `plasmic_get_pkg_publish_status`, `plasmic_get_workspace`, `plasmic_get_devflags` (admin)

**Writes:** `plasmic_create_project`, `plasmic_create_project_with_hostless_packages`, `plasmic_clone_project`, `plasmic_update_project_meta`, `plasmic_publish_project`, `plasmic_grant_revoke`, `plasmic_set_devflags` (admin, requires `confirm:true`)

**Copilot:** `plasmic_generate_ui` — text goal → HTML design (60s timeout)

## Setup

```bash
cd session-auth
npm install
npm run build
cp .env.example .env   # fill in PLASMIC_HOST / PLASMIC_EMAIL / PLASMIC_PASSWORD
npm test
```

Register with Claude Code:
```bash
claude mcp add plasmic -- node /path/to/session-auth/dist/index.js
```

## Notes

- Use a dedicated service account; never commit `.env`
- `plasmic_set_devflags` is instance-wide (affects all Studio users) — requires `confirm: true`
- `plasmic_get_devflags` / `plasmic_set_devflags` require the account to be in `ADMIN_EMAILS`
- Cannot do in-canvas design (component placement requires a Playwright-based server — see planned `plasmic-canvas-mcp`)

# Provision-to-Live Pipeline Runbook

One webhook call takes a site from nothing to live: create Plasmic project →
seed Home page → publish → DNS → Coolify app → deploy → verify HTTP 200.
Built for ClickUp `86ey4ffgm`. This document is written so an operator (human
or model) can run and repair the pipeline without reading the workflow source.

## The one call

```bash
curl -X POST https://automate.aihe.me/webhook/provision-plasmic-site \
  -A 'Mozilla/5.0' \
  -H "X-Provision-Secret: $PROVISION_SECRET" \
  -H 'content-type: application/json' \
  -d '{"siteName": "my-site", "domain": "aihe.me", "text": "Hello world"}'
```

- `-A 'Mozilla/5.0'` is required — Cloudflare rejects default curl user agents (error 1010).
- `PROVISION_SECRET` lives in the ClickUp Secrets list (name: "Provision webhook secret")
  and in the n8n credential **Provision Webhook Secret**. Never write its value anywhere else.

### Request contract

| Field | Required | Notes |
|---|---|---|
| `siteName` | yes | `^[a-z0-9][a-z0-9-]{1,40}$`; becomes `<siteName>.<domain>`. Reserved names (studio, canvas, coolify, www, api, automate, aita, mail, smtp, admin, app, dev, staging, test, ns1, ns2) are rejected. |
| `domain` | yes | `aihe.me` or `aihe.dev` only. |
| `text` | no | Seeded onto the Home page of the new Plasmic project. |

### Response contract

Success (HTTP 200):

```json
{"ok": true, "url": "my-site.aihe.me", "appUuid": "…", "projectId": "…", "deploymentUuid": "…", "reused": false}
```

Failure (HTTP 500):

```json
{"ok": false, "stage": "<node that failed>", "cause": "<error message>", "rolledBack": {"app": true, "dns": false, "project": true}}
```

**Caution — long calls:** a full first-time provision takes several minutes
(Docker build + deploy + DNS warm-up). Cloudflare cuts proxied responses at
~100 s (HTTP 524), so your curl may time out while the workflow keeps running.
That is not a failure. Check progress in n8n (workflow "Provision Plasmic
Site" → executions) or just poll `https://<siteName>.<domain>/` until it
returns 200.

### Idempotency

Re-running with the same `siteName` + `domain` is safe: the workflow looks up
the existing DNS record and Coolify app by name first, reuses them, reads the
existing app's `PLASMIC_PROJECT_ID` instead of creating a new project, and
redeploys. The response then has `"reused": true`. No duplicate DNS records,
apps, or projects are created.

### Rollback

Every mutating stage has an error branch. On failure the workflow deletes
only what *this run* created (Coolify app → DNS record → Plasmic project),
then responds with the failing stage and cause. Resources that pre-existed
(reused path) are never deleted.

## Seeding a page into an existing project

```bash
curl -X POST https://automate.aihe.me/webhook/add-plasmic-page \
  -A 'Mozilla/5.0' \
  -H 'content-type: application/json' \
  -d '{"projectId": "…", "pageName": "About", "path": "/about", "text": "About us"}'
```

Returns the page-api response: `{"ok": true, "projectId": "…", "pageIid": "…", "name": "…", "path": "…", "revision": N}`.

## Architecture

```
caller ──POST──▶ n8n (automate.aihe.me, "Internal services" box)
                  │  Cloudflare/Coolify APIs: direct HTTPS
                  │  Plasmic mutations: SSH → hetzner-plasmic-vps → curl 127.0.0.1:8765
                  ▼
        plasmic-page-api (docker, /opt/plasmic-page-api, port 8765)
                  │  session+CSRF auth, x-forwarded-proto:https
                  ▼
        Plasmic wab backend (container 10.0.2.2:3004, prod studio.aihe.dev)
```

**Why SSH, not HTTP, for Plasmic calls:** the n8n box cannot reach the
Plasmic VPS Tailscale IP (`100.122.210.19`), and port 8765 is firewalled from
the public internet (verified 2026-07-03). So the four page-api calls in the
workflows are n8n **SSH nodes** (credential `SSH: hetzner-plasmic-vps`) that
run `curl http://127.0.0.1:8765/...` on the VPS itself, reading the bearer
secret from `/opt/plasmic-page-api/.env` on-box. The secret never enters n8n
workflow data or execution logs. Each SSH node pipes a base64-encoded JSON
payload (built by an n8n expression) into curl, and a Code node named after
the original call parses stdout — curl appends the HTTP status as the last
line and the parser throws (→ rollback branch) on status ≥ 400 or `ok != true`.

### Components

| Piece | Where | Notes |
|---|---|---|
| Workflow "Provision Plasmic Site" | n8n `NRTqTVzBtgQhOl8f` | webhook path `provision-plasmic-site`, header-auth |
| Workflow "Add Plasmic Page" | n8n `Q5T9y0cjZyNmmjxK` | webhook path `add-plasmic-page` |
| plasmic-page-api | `/opt/plasmic-page-api` on hetzner-plasmic-vps (157.90.224.29 / TS 100.122.210.19) | this repo's `src/http-server.ts`; docker compose, `restart: unless-stopped` |
| Next.js template | `github.com/AiheApp/plasmic-nextjs-template` (public, branch `master`) | Coolify builds it per site (dockerfile buildpack, port 3000) |
| Flow mirrors | `n8n/add-plasmic-page.json`, `n8n/provision-plasmic-site.json` | read-only exports for review; the live source of truth is n8n |

### Secrets (names only — values live in the ClickUp Secrets list / on-box .env)

| Name | Used by | Lives in |
|---|---|---|
| `PROVISION_SECRET` | provision webhook caller | n8n credential "Provision Webhook Secret" + ClickUp Secrets |
| `ADD_PAGE_SECRET` | page-api bearer auth | `/opt/plasmic-page-api/.env` (read on-box by SSH nodes) |
| Cloudflare zone token | DNS create/delete | n8n credential "Cloudflare API" |
| Coolify API token | app create/deploy/delete | n8n credential "Coolify API" |
| Studio login | page-api → wab | `/opt/plasmic-page-api/.env` (`PLASMIC_STUDIO_EMAIL/PASS`) |

## Operations

### Redeploy the page-api service

```bash
ssh hetzner-plasmic-vps
cd /opt/plasmic-page-api/app
docker compose up -d --build      # picks up docker-compose.override.yml (joins studio network)
curl -s http://127.0.0.1:8765/health   # {"ok":true,...}
```

The app directory is a checkout/tarball of this repo. `.env` is a symlink to
`/opt/plasmic-page-api/.env` — never commit or copy it elsewhere.

### Editing the workflows

Use the n8n MCP (`update_workflow` with an `operations` patch array, ≤100
ops/call). Edits save a **draft**: nothing is live until `publish_workflow`
and `activeVersionId == versionId`. `get_workflow_details` strips credential
bindings — verify them via the internal REST API (`GET /rest/workflows/{id}`
with an admin session). After editing, re-export the flow mirrors here.

Hard-won n8n quirks baked into these workflows — do not "simplify" them away:

- **HTTP nodes split JSON-array responses into one item per element.** A node
  reading such output must use `$('Node').all().map(i => i.json)`, never
  `.first().json` (that's just the first array element). This bit both
  `Assess State` (Coolify app list) and `Extract Existing Project` (env list).
- **`$('X').first()` throws on error-branch items** (item pairing is missing
  after `continueErrorOutput`). Use explicit indices: `$('X').first(0, 0)`.
  `Prepare Rollback` tries `first()` → `first(0,0)` → `all()` in order and
  records which form worked in its `diag` output field.
- Duplicate app names can exist in Coolify; `Assess State` prefers the app
  whose fqdn matches the requested site before falling back to name match.

### Failure modes seen in the wild

| Symptom | Cause | Fix |
|---|---|---|
| Cloudflare error 1010 on webhook | default curl UA | add `-A 'Mozilla/5.0'` |
| HTTP 524 after ~100 s | Cloudflare proxy timeout, workflow still running | poll the site URL or n8n executions |
| `stage: "... (ssh)"` + timeout cause | page-api down on the VPS | SSH in, `docker compose up -d`, check `docker logs plasmic-page-api` |
| page-api 502 `kind: "auth"` | Studio login rejected (password rotated?) | update `/opt/plasmic-page-api/.env`, `docker compose up -d` |
| publish fails `pkg_version.tags` | calling wab publish without `tags` | page-api always sends `tags: []`; don't bypass it |
| deploy loop hits 40 tries (~10 min) | Coolify build stuck/failed | `stage: "Eval Deployment"`; check the app's deployment logs in Coolify |
| site loop hits 20 tries | DNS/cert warm-up or app crash | check `https://<fqdn>` manually; Coolify app logs |
| seeded page invisible in Studio canvas | known limitation: model-layer pages have empty ArenaFrameGrids | page renders fine via loader; open a Studio arena manually if needed |

### Known limitations

- Seeded pages render via the loader but show an empty canvas in Studio
  (no arena frames) — cosmetic, tracked separately.
- `domain` is limited to the two zones the Cloudflare credential can edit.
- First-time provisions respond slower than the Cloudflare proxy timeout;
  treat the webhook as fire-and-poll, not request-response, for new sites.

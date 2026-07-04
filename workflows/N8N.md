# n8n lane — the public webhook in front of the design-assist service

The durable automation endpoint for the design assistant:
`POST https://automate.aihe.me/webhook/design-assist`.

Post-reconcile (PR #5) there is exactly ONE implementation: the assist
service in `src/assist/server.ts`, deployed as the `plasmic-design-assist`
container on hetzner-aihe-automate-vps (see `assistant/RUNBOOK.md` for the
service deploy). The n8n workflow `DesignAssistV1` is a thin forwarding
proxy and holds NO secrets — it forwards the caller's `Authorization`
header; auth is enforced by the service (`ASSIST_BEARER_TOKEN`).

> A previous revision of this doc described an n8n-internal AI-Agent
> workflow (`n8n-design-assist.json`) and a `{confirm, ops}` echo-the-ops
> protocol. That was the un-deployed half of the 86ey4ferx race and is gone;
> the two-phase protocol is now `planId`-based and lives in the service
> (`/design-assist/plan` + `/design-assist/apply`).

## Network constraint (why the service sits next to n8n)

The n8n/automate box (49.13.125.34) has no Tailscale, and the Plasmic VPS's
Hetzner *cloud* firewall blocks its non-web ports from other hosts — n8n
CANNOT reach the Plasmic VPS. The service therefore runs NEXT TO n8n (same
`coolify` docker network, no published port; n8n reaches it at
`http://plasmic-design-assist:8766`) and talks to the Studio via
`https://studio.aihe.dev` with a browser-style User-Agent (Cloudflare
UA-1010 rule).

## Webhook contract

One-shot autonomous run (plan+apply in a single agent loop — for automation
callers that don't need a human confirmation step):

```bash
curl -X POST https://automate.aihe.me/webhook/design-assist \
  -H "authorization: Bearer $ASSIST_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"projectId":"<id>","request":"add a hero section with our primary color"}'
# → AssistReport JSON (status/summary/mutations/revisions/diff/…)
```

Two-phase (preview → human confirm → deterministic apply — what the
in-Studio Copilot surface uses, ClickUp 86ey5b413). Routed by an `action`
field so the single webhook path serves all three routes:

```bash
# Phase 1 — plan (provably non-mutating; the validated ops stay server-side)
curl -X POST https://automate.aihe.me/webhook/design-assist \
  -H "authorization: Bearer $ASSIST_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"plan","projectId":"<id>","request":"add a hero section"}'
# → {"status":"ready","planId":"…","summary":"…","preview":"…",
#    "baseRevision":12,"expiresAt":"…","studioUrl":"…","meta":{…}}
#   (or status no_changes_needed / needs_clarification / failed — no planId)

# Phase 2 — apply the stored plan (NO model call; exact previewed ops)
curl -X POST https://automate.aihe.me/webhook/design-assist \
  -H "authorization: Bearer $ASSIST_BEARER_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"apply","planId":"<planId from phase 1>"}'
# → 200 apply report (status done/partial_failure, revisions, diff, undo)
#   409 {"code":"REVISION_CONFLICT",…}  project advanced since planning
#   422 {"code":"BATCH_REFUSED",…}      plan no longer validates
#   404 {"code":"PLAN_NOT_FOUND",…}     unknown or expired planId (TTL 15min)
# Duplicate confirms replay the recorded outcome — no double-apply.
```

Long runs: pass `"wait":false` → `202 {jobId}`; poll `GET /jobs/{id}` on the
service (not webhook-exposed). Cloudflare caps the webhook at ~100s; plan
runs have measured 18–47s.

## DesignAssistV1 wiring (the forwarding proxy)

Webhook (POST `design-assist`) → HTTP Request → Respond to Webhook.

The HTTP Request node maps `action` to the service route — keep the mapping
closed (no caller-controlled paths):

```
URL: http://plasmic-design-assist:8766/design-assist{{
  $json.body.action === "plan" ? "/plan"
  : $json.body.action === "apply" ? "/apply"
  : "" }}
Headers: authorization = {{ $json.headers.authorization }}
Body: {{ $json.body }}   (the service ignores the extra action field)
Options: full response ON, neverError ON, timeout ≥ 110s
```

Respond to Webhook: respond with `{{ $json.body }}` and response code
`{{ $json.statusCode }}` so the service's 409/422/404 pass through to the
caller. (The pre-86ey5b413 deployed workflow flattens everything to HTTP
200 — callers MUST treat the JSON `status`/`code` fields as authoritative,
not the HTTP status, until the updated workflow is imported.)

## n8n deploy gotchas (hard-won)

- The passwords-doc "N8N api token" JWT is REJECTED by the n8n public REST
  API (401). Import/update workflows via the CLI inside the container:
  `docker cp` the JSON in, then `n8n import:workflow --input=…` +
  `n8n update:workflow --id=… --active=true` + `docker restart` to register
  the webhook.
- To patch the live workflow safely, export it first
  (`n8n export:workflow --id=… --output=…`), edit the JSON, re-import.
- API edits (update_workflow) unbind credentials and save a DRAFT — the
  published version keeps running. Re-check credentials and re-publish
  after any API edit.

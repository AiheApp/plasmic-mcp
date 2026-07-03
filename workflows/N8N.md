# n8n lane — deploy + wire-up (NOT deployed from this branch)

The durable automation endpoint for the design assistant:
`POST https://automate.aihe.me/webhook/design-assist`.

Everything needed is in this repo; deployment from THIS branch was
deliberately skipped: a competing 86ey4ferx implementation (agent-loop lane,
`src/assist/` on its own branch) already deployed a `plasmic-design-assist`
service + `DesignAssistV1` n8n workflow to that same webhook path on
2026-07-02. Deploy exactly one implementation — reconcile first.

## 1. Deploy the HTTP MCP server (Coolify, automate box)

**Network constraint (verified by the sibling deployment):** the n8n/automate
box (49.13.125.34) has no Tailscale, and the Plasmic VPS's Hetzner *cloud*
firewall blocks its non-web ports from other hosts — n8n CANNOT reach the
Plasmic VPS. The server must therefore run NEXT TO n8n (same docker network)
and reach the Studio via `https://studio.aihe.dev` with a browser-style
User-Agent (Cloudflare UA-1010 rule).

1. On hetzner-aihe-automate-vps: build via the repo `Dockerfile` (runs
   `node dist/http.js`), run joined to the `coolify` docker network with NO
   published port — n8n reaches it at `http://<container-name>:3010`.
2. Env: `PLASMIC_HOST=https://studio.aihe.dev`, `PLASMIC_EMAIL`,
   `PLASMIC_PASSWORD`, `PLASMIC_USER_AGENT=Mozilla/5.0 (Macintosh)`,
   `MCP_HTTP_TOKEN=<long random secret>`, `MCP_HTTP_PORT=3010`.
3. Verify from inside the n8n container:
   `curl http://<container-name>:3010/healthz` → `{"ok":true,"tools":33}`;
   an unauthenticated `POST /mcp` must return 401.

n8n gotcha: the passwords-doc "N8N api token" JWT is rejected by the n8n
public REST API — import workflows via the CLI inside the container
(`n8n import:workflow` + `n8n update:workflow --active=true` + restart).

## 2. Import the n8n workflow

1. n8n (automate.aihe.me) → Workflows → Import from file →
   `workflows/n8n-design-assist.json`.
2. In the **AI Agent** node, replace the systemMessage placeholder with the
   full contents of `assistant/PROMPT.md` (keep the appended `## WEBHOOK
   MODE` block that is already there).
3. Set credentials: Anthropic API key on the model node; a Bearer credential
   holding `MCP_HTTP_TOKEN` on the **Plasmic MCP** node, and its
   `endpointUrl` to the deployed server's `/mcp`.
4. Save AND PUBLISH (n8n keeps running the old published version otherwise;
   update_workflow via API also unbinds credentials — re-check them after any
   API edit).

## 3. Two-phase protocol (preview/confirm over HTTP)

Phase 1 — plan (no mutation):

```bash
curl -X POST https://automate.aihe.me/webhook/design-assist \
  -H 'content-type: application/json' \
  -d '{"projectId":"<id>","request":"add a hero section with our primary color","confirm":false}'
# → {"phase":"plan","valid":true,"baseRevision":12,"ops":[…],"preview":"…"}
```

Phase 2 — apply (echo back the plan):

```bash
curl -X POST https://automate.aihe.me/webhook/design-assist \
  -H 'content-type: application/json' \
  -d '{"projectId":"<id>","request":"(confirmed)","confirm":true,"ops":[…from phase 1…],"expectedRevision":12}'
# → {"phase":"apply","applied":true,"revision":13,"summary":{…}}
```

Unsupported/ambiguous requests return `{"phase":"refused","reason":"…"}` with
no mutation. A `REVISION_CONFLICT` on phase 2 means the project advanced —
re-run phase 1.

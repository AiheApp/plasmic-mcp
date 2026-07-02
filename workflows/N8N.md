# n8n lane — deploy + wire-up (NOT yet deployed)

The durable automation endpoint for the design assistant:
`POST https://automate.aihe.me/webhook/design-assist`.

Everything needed is in this repo; deployment was deliberately deferred (two
competing 86ey4ferx implementations existed at build time — deploy exactly one
after reconciliation).

## 1. Deploy the HTTP MCP server (Coolify, Plasmic VPS)

The Studio VPS (hetzner-plasmic-vps, Tailscale 100.122.210.19) can reach the
Studio container directly at `http://10.0.2.2:3003` — no Cloudflare.

1. Coolify → new app from `AiheApp/plasmic-mcp`, build via the repo
   `Dockerfile` (runs `node dist/http.js`).
2. Env: `PLASMIC_HOST=http://10.0.2.2:3003`, `PLASMIC_EMAIL`,
   `PLASMIC_PASSWORD`, `MCP_HTTP_TOKEN=<generate a long random secret>`,
   `MCP_HTTP_PORT=3010`.
3. Expose port 3010 to the internal network only (n8n reaches it over
   Tailscale/private net — do not publish through Cloudflare).
4. Verify: `curl http://<host>:3010/healthz` → `{"ok":true,"tools":33}`;
   an unauthenticated `POST /mcp` must return 401.

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

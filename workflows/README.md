# Reusable workflows

Small, codified helpers for recurring Plasmic ops (the painful manual loops).

| Workflow | What it does |
|---|---|
| `plasmic-deploy-verify.sh` | Confirm a Coolify app's **live** build is at/after a git commit (not just pushed). `COOLIFY_TOKEN=… ./plasmic-deploy-verify.sh <repo-dir> <commit> <app-uuid> [live-url]`. Exit 0 = live≥commit, 2 = not yet deployed. |
| `plasmic-creds-bootstrap.sh` | Extract a named secret from the ClickUp passwords doc markdown (piped on stdin) into a `0600` env file you `source`, then `--shred`. Doc `8cdu53c-30698 / 8cdu53c-29578` (agent fetches via ClickUp MCP, pipes here). |
| `../canvas-browser/workflows/plasmic-cloud-land.mjs` | Drop an HTML section onto a Plasmic **Cloud** project as a page via `PLASMIC_AI_TOOLS` (identify → createComponent+html). `CLOUD_EMAIL=… CLOUD_PASS=… node … <projectId> "<Page>" <htmlFile\|->`. |
| `../canvas-browser/workflows/canvas-smoke.mjs` | One-command canvas-browser regression: optional cold-start (`COLD=1` quits Chrome) → auto-launch → auth → insert a section → screenshot. Run before shipping canvas-browser changes. |

Notes:
- The `.mjs` workflows live under `canvas-browser/workflows/` so `playwright-core` and the built `../dist` resolve.
- Secrets: never hardcode; `plasmic-creds-bootstrap.sh` writes `0600` and provides `--shred`.
- See the canvas-browser README and the ClickUp router doc for credentials.

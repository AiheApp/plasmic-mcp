# Plasmic MCP

Control your Plasmic Studio project with Claude. Add elements, read canvas state, take screenshots, manage tokens and CMS content — all through natural language.

Works with Claude Desktop and Claude Code. Mac only.

---

## Quick start

**Step 1 — Clone the repo**

```bash
git clone https://github.com/AiheApp/plasmic-mcp.git
cd plasmic-mcp
```

**Step 2 — Run setup**

```bash
./setup.sh
```

The script will ask for your Plasmic Studio URL, project ID, and API token, then build the packages and register itself with Claude.

**Step 3 — Ask Claude**

Restart Claude Desktop, then just ask:

> "Take a screenshot of my Plasmic project"
> "Add a Text element to the canvas"
> "List all pages in my project"

Chrome will open automatically with Studio on first use.

---

## Credentials you'll need

| Credential | Where to find it | Used for |
|---|---|---|
| **Project ID** | The URL: `studio.aihe.dev/projects/**THIS_PART**/` | Required — identifies your project |
| **Personal Access Token (PAT)** | Studio → click your avatar → API tokens → Create token | Required — authenticates API calls |
| **API user email** | The email address on your Plasmic account | Required — goes with the PAT |
| **Project loader token** | Studio → Project Settings → API tokens → Public token | Optional — enables component tree reading |

---

## What Claude can do

### Canvas (requires Chrome open with debug port)

| Ask Claude to… | Tool used |
|---|---|
| Take a screenshot | `studio_screenshot` |
| Add a Text / Box / Button element | `studio_add_element` |
| Select an element by name | `studio_select_element` |
| Remove an element | `studio_remove_element` |
| Move an element up or down | `studio_move_element` |
| Change element props / styles | `studio_set_props` |
| Read the current canvas state | `studio_get_canvas_state` |

### Project (API-based, no Chrome needed)

| Ask Claude to… | Tool used |
|---|---|
| List all pages | `list_pages` |
| List all components | `list_components` |
| Read design tokens | `get_tokens` |
| Read CMS content | `cms_get_rows` |

---

## Troubleshooting

**"Could not connect to Chrome"**
Chrome needs to be running with the remote debugging port open. The canvas tools try to launch Chrome automatically, but if that fails:
```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 "https://studio.aihe.dev/projects/YOUR_PROJECT_ID"
```

**"No open Plasmic Studio tab found"**
The canvas tools look for a tab whose URL contains your project ID. If Chrome is open but Studio isn't loaded, navigate to `studio.aihe.dev/projects/YOUR_PROJECT_ID` and try again.

**Claude says the tools aren't available**
Run `claude mcp list` and confirm `plasmic` and `plasmic-canvas` are listed. If not, re-run `./setup.sh`.

**After updating the repo**
Re-run the build step:
```bash
npm run build && cd canvas-browser && npm run build
```

---

## Architecture

Two MCP servers work together:

- **`plasmic`** — HTTP API tools (pages, tokens, CMS). Needs `PLASMIC_API_TOKEN`.
- **`plasmic-canvas`** — Canvas tools via Chrome DevTools. Needs Chrome open. Auto-launches Chrome if needed.

Both are registered by `setup.sh` and run as local processes managed by Claude.

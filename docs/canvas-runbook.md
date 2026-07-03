# Canvas paste runbook

How `plasmic_insert_html` / `plasmic_insert_template` land HTML in the Studio
canvas, every known way the pipeline fails, and what to do about each. Start
any triage with **`plasmic_canvas_doctor`** — it probes each precondition below
and names the failing one.

## How an insert works

1. A headless Chromium opens `${PLASMIC_HOST}/projects/<id>` in a **fresh
   browser context** (stale Studio tabs are the #1 source of flaky pastes),
   authenticated by injecting the MCP account's session cookies.
2. The driver locates the frame owning `window.dbg.studioCtx` and waits for
   `studioCtx.site` (retries ×3, backoff 1s/2s/4s).
3. The target page arena is activated (`switchToComponentArena`) and polled
   until its ViewCtx is live. With no `page` selector and nothing pasteable,
   a page is **created through Studio's own flow** (`studioCtx.addComponent`),
   which seeds a real arena frame.
4. The HTML is pasted via `studioCtx.paste()` with a duck-typed clipboard
   (`getText` guaranteed to return a string). Before each paste the page root
   is focused and `enforcePastingAsSibling` cleared, so the paste position is
   deterministic. Up to 3 attempts.
5. Success is **REST-verified**: `studioCtx.save()` is flushed, then the
   project revision must advance and the new nodes must appear in the saved
   model (`fetchRev` subtree diff). A paste that "worked" in the browser but
   didn't survive the server round-trip is reported as a failure. No
   false-green.

On Plasmic Cloud (where `allowHtmlPaste` is off for non-admin accounts) the
op falls back to `PLASMIC_AI_TOOLS.createComponent`, which creates a **new
page** from the HTML; the same REST verification applies.

## Error kinds → causes → fixes

| Kind | What happened | Fix |
| --- | --- | --- |
| `BROWSER_UNAVAILABLE` | playwright not installed / chromium missing | `npm i playwright && npx playwright install chromium`. The Docker image is REST-only by design; run canvas ops from a host with a browser. |
| `STUDIO_UNREACHABLE` / `CANVAS_NOT_READY` | Studio didn't load or `dbg.studioCtx.site` never appeared | Check host is up (Cloudflare 524 = origin slow; see deploy topology memory), `PLASMIC_USER_AGENT` set (WAF blocks the default headless UA), auth valid. Diagnostics include a per-frame probe of what was seen. |
| `BLOCKING_MODAL` | Studio load is halted by a modal that demands a human decision — typically **"Code component no longer registered"** (project uses a host component that the host app no longer registers) | Open the project in Studio manually and choose *Replace* / *Delete all existing uses*, or re-register the component on the host app. These modals cannot be dismissed programmatically (the X re-prompts). Diagnostics carry the modal text. |
| `CANVAS_NO_FRAME` | Target page has an empty ArenaFrameGrid, so it can't receive a paste. Pages created via the REST model layer (`plasmic_create_page`) have this defect | Target a Studio-created page, or omit `page` and let the tool create one (it uses Studio's own page-creation flow). |
| `PAGE_NOT_FOUND` | `page` selector matched no page uuid/name/path | Diagnostics list the project's pages. |
| `HTML_PASTE_DISABLED` | `allowHtmlPaste` devflag is off for this account AND `PLASMIC_AI_TOOLS` is absent | Self-hosted: the flag auto-enables for **admin-team** emails (`adminTeamEmails`/`adminTeamDomains` devflags — see the privilege-model memory); add the MCP account or set the flag instance-wide via `plasmic_set_devflags {key: "allowHtmlPaste", value: true, confirm: true}`. Cloud: use a Studio tab where `PLASMIC_AI_TOOLS` exists. |
| `PASTE_FAILED` | Paste ran but no nodes were added after 3 attempts, or the REST verify found fewer than `verifyNodeCount` new nodes | Check diagnostics `notifications` (Studio's own error toasts are captured — e.g. "Cannot paste as sibling here"). Malformed HTML → the web importer may produce zero tpls; simplify the markup. |
| `PASTED_AS_TEXT` | The markup landed as a raw TEXT node — `allowHtmlPaste` routed the paste to `pasteText` mid-flight | Should be prevented by the precondition probe; if seen, delete the text node in Studio and re-check `allowHtmlPaste`. |
| `VERIFY_TIMEOUT` | Browser-side paste looked fine but the project revision never advanced (save didn't persist within 20s) | Retry; check server load / websocket connectivity. The op already calls `studioCtx.save()` and polls `hasUnsavedChanges`. |
| `UNKNOWN_TOKENS` | Template references design tokens the **target** project doesn't have (checked live before pasting, `tokenPolicy: "strict"` default) | Seed the tokens (`plasmic_create_token` for each, or clone the token project), or pass `tokenPolicy: "warn"` to paste with unbound `var()` refs. |
| `TEMPLATE_ERROR` | Unknown template name or params failed the template's schema | `plasmic_list_templates` shows names + param schemas. |

## Gotchas that shaped the implementation

- **`studioCtx.paste()` returns void** in current builds — the router's boolean
  is not propagated. Success is read from side effects: the router sets
  `focusedViewCtx().enforcePastingAsSibling = true` only on success, plus the
  tpl-tree node delta, plus the REST model diff. Don't trust "paste didn't
  throw".
- **`enforcePastingAsSibling` leaks between pastes.** After any successful
  paste Studio switches to paste-as-sibling mode; the next paste with the root
  selected then fails with *"Cannot paste as sibling here"*. The op clears the
  flag and re-focuses the page root before every paste.
- **`e.trim is not a function`**: the router calls `text.trim()` on
  `clipboard.getText()`. The duck clipboard guarantees a string. The HTML must
  start with `<` after trimming or the web importer refuses it (falls through
  to a plain-text paste).
- **`allowHtmlPaste` is silent.** When off, HTML paste doesn't error — it
  lands your markup as a text blob. The op probes the flag up front and the
  `PASTED_AS_TEXT` guard catches drift.
- **REST-created pages can't be pasted into** (empty ArenaFrameGrids; the
  Studio canvas also shows them blank — see the model-pages memory). Create
  pages through Studio or let the insert op do it.
- **Fresh context per op.** Long-lived Studio tabs go stale (revision drift,
  arena GC) and made ad-hoc pastes flaky. Each op opens a new context (~5-8s
  overhead) and closes it after; reliability beats latency here.
- **Headless font noise**: "Font X is not available on this machine" toasts
  are benign (the headless box lacks project fonts) and are filtered from
  diagnostics.
- **tsx + Playwright `__name`**: running under `tsx`, esbuild's keepNames
  injects `__name()` calls into `frame.evaluate` callbacks; the driver defines
  the helper via `addInitScript`. Compiled `dist/` doesn't need it but the
  script stays harmless.
- **Cloudflare / WAF**: set `PLASMIC_USER_AGENT` to a real browser UA — the
  instance's WAF challenges the default HeadlessChrome UA; 524s mean the
  origin is slow, retry.
- **Copilot HTML**: output from `plasmic_generate_ui` should be inserted with
  `plasmic_insert_html` (which trims/validates), never hand-pasted into the
  canvas via the browser clipboard.

## Design tokens in HTML

Reference tokens as `var(--token-<name>)` where `<name>` is the token name in
any casing (`primary-base`, `Primary Base`, `primaryBase` all match — Studio
normalizes via camelCase). On paste, the web importer rewrites matches to
`var(--token-<uuid>)` bound to the project's token; unmatched refs pass
through as dead `var()`s, which is why `plasmic_insert_template` validates
against the live target project first.

Only **longhand** CSS survives the importer (`background` for fills — not
`background-color`; `padding-top/...`; `border-top-left-radius/...`;
`row-gap`/`column-gap` — no `gap`, no CSS grid). `plasmic_list_templates`
returns the full guidance plus the known token vars.

## Cloud (studio.plasmic.app)

Cookie-jar auth doesn't apply; capture a storage state once with a real
browser (`npx playwright codegen --save-storage=state.json
https://studio.plasmic.app`) and point `PLASMIC_STORAGE_STATE` at the file.
The insert op then uses `PLASMIC_AI_TOOLS.createComponent` (new page per
insert; name it with `newPageName`).

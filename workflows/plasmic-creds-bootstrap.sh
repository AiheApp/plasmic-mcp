#!/usr/bin/env bash
# plasmic-creds-bootstrap — extract a named credential from the ClickUp passwords
# doc into a 0600 env file you source, then shred. Removes the repetitive
# "search ClickUp -> open doc -> write /tmp/*.env -> source -> delete" dance.
#
# The agent fetches the doc markdown via the ClickUp MCP (it is OAuth-only, no
# standalone API token), then pipes it here:
#   clickup_get_document_pages(8cdu53c-30698, [8cdu53c-29578], text/md)  # doc + page
#
# Usage:
#   <doc-markdown>  | ./plasmic-creds-bootstrap.sh "<row label substring>" <VARNAME> [outfile]
# Example (agent):
#   printf '%s' "$DOC_MD" | ./plasmic-creds-bootstrap.sh "Anthropic plasmic prod api key" ANTHROPIC_API_KEY /tmp/cred.env
#   source /tmp/cred.env   # use $ANTHROPIC_API_KEY ...
#   shred -u /tmp/cred.env # or: ./plasmic-creds-bootstrap.sh --shred /tmp/cred.env
set -euo pipefail

if [ "${1:-}" = "--shred" ]; then
  f="${2:?file required}"; rm -f "$f" 2>/dev/null || true; echo "shredded $f"; exit 0
fi

LABEL="${1:?row label substring required}"; VAR="${2:?VARNAME required}"; OUT="${3:-/tmp/plasmic-cred.env}"
umask 077
DOC="$(cat)"   # markdown table piped on stdin

# Find the table row whose first cell contains LABEL (case-insensitive), then take
# the FIRST non-empty cell after it that looks like a secret (no spaces, len>=12),
# else the 2nd cell. Strips markdown link syntax and backslash-escapes.
VALUE=$(DOC="$DOC" LABEL="$LABEL" python3 - <<'PY'
import os, re
label = os.environ["LABEL"].lower()
for line in os.environ["DOC"].splitlines():
    if "|" not in line: continue
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    if not cells: continue
    def clean(s):
        s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)   # [txt](url) -> txt
        return s.replace("\\", "").strip()
    cells = [clean(c) for c in cells]
    if cells and label in cells[0].lower():
        rest = [c for c in cells[1:] if c]
        secretish = [c for c in rest if " " not in c and len(c) >= 12]
        val = (secretish[0] if secretish else (rest[0] if rest else ""))
        print(val); break
PY
)
if [ -z "$VALUE" ]; then echo "No credential row matching: $LABEL" >&2; exit 1; fi
printf 'export %s=%q\n' "$VAR" "$VALUE" > "$OUT"
chmod 600 "$OUT"
echo "wrote $OUT (export $VAR; perms 600). Source it, use, then: $0 --shred $OUT"

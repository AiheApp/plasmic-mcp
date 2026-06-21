#!/usr/bin/env bash
# plasmic-deploy-verify — confirm a Coolify app's LIVE build is at/after a git commit,
# not just that the commit was pushed. Removes the manual "is my fix actually live?" check.
#
# Usage:
#   COOLIFY_TOKEN=...  ./plasmic-deploy-verify.sh <repo-dir> <commit-ish> <app-uuid> [live-url]
# Env:
#   COOLIFY_TOKEN   (required) Coolify API token (passwords doc)
#   COOLIFY_BASE    (optional) default https://coolify.aihe.dev/api/v1
# Example:
#   COOLIFY_TOKEN=$T ./plasmic-deploy-verify.sh /tmp/plasmic-fork HEAD ki4uz1h9y4lpnolejfj012pi https://studio.aihe.dev
set -euo pipefail
REPO="${1:?repo-dir required}"; COMMIT="${2:?commit-ish required}"; APP="${3:?app-uuid required}"; URL="${4:-}"
BASE="${COOLIFY_BASE:-https://coolify.aihe.dev/api/v1}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN required}"

commit_ts=$(cd "$REPO" && git show -s --format=%cI "$COMMIT")
short=$(cd "$REPO" && git rev-parse --short "$COMMIT")
app_json=$(curl -s --max-time 25 -H "Authorization: Bearer $COOLIFY_TOKEN" "$BASE/applications/$APP")

COMMIT_TS="$commit_ts" SHORT="$short" APP_JSON="$app_json" python3 - <<'PY'
import json, os, sys, datetime as dt
commit_ts, short, app_raw = os.environ["COMMIT_TS"], os.environ["SHORT"], os.environ["APP_JSON"]
_d = json.loads(app_raw) if app_raw.strip() else {}
app = _d.get("data", _d) if isinstance(_d, dict) else {}
last_online = app.get("last_online_at") or app.get("updated_at") or ""
name = app.get("name", "?")
def parse(s):
    s = (s or "").strip().replace("Z", "+00:00").replace(" ", "T", 1)
    try: return dt.datetime.fromisoformat(s)
    except Exception: return None
c, o = parse(commit_ts), parse(last_online)
print(f"app: {name}  status: {app.get('status')}")
print(f"commit {short} authored/committed: {commit_ts}")
print(f"deploy last_online_at:            {last_online}")
if c and o:
    if o.tzinfo is None: o = o.replace(tzinfo=dt.timezone.utc)
    if c.tzinfo is None: c = c.replace(tzinfo=dt.timezone.utc)
    ok = o >= c
    print(("LIVE >= COMMIT: YES (deploy is at/after the commit)" if ok
           else "LIVE < COMMIT: NO (commit not yet deployed — redeploy)"))
    sys.exit(0 if ok else 2)
else:
    print("Could not compare timestamps; check manually.")
    sys.exit(3)
PY
rc=$?
if [ -n "$URL" ]; then
  echo "live probe: $URL -> $(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$URL")"
fi
exit $rc

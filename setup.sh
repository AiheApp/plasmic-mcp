#!/usr/bin/env bash
# plasmic-mcp setup — run once to install, configure, and register with Claude.
# Mac only. Node 20+ required.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_JSON="$HOME/.claude.json"

# ── colours ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
info()    { echo -e "${GREEN}✓${NC} $*"; }
warn()    { echo -e "${YELLOW}!${NC} $*"; }
die()     { echo -e "${RED}✗${NC} $*" >&2; exit 1; }
ask()     { echo -e "\n${YELLOW}?${NC} $1"; }

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Plasmic MCP — setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── 1. Prerequisites ─────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js not found. Install from https://nodejs.org (v20+)."
NODE_VER=$(node -e "process.stdout.write(process.version.slice(1).split('.')[0])")
[ "$NODE_VER" -ge 20 ] 2>/dev/null || die "Node.js v20+ required (found v${NODE_VER}). Update at https://nodejs.org"
command -v npm  >/dev/null 2>&1 || die "npm not found. Reinstall Node.js from https://nodejs.org"
info "Node.js v$(node --version | tr -d v) detected"

# ── 2. Build ─────────────────────────────────────────────────────────────────
echo ""
echo "Building packages…"
(cd "$REPO_DIR" && npm install --silent && npm run build --silent)
info "Root package built"
(cd "$REPO_DIR/canvas-browser" && npm install --silent && npm run build --silent)
info "canvas-browser package built"

# ── 3. Collect credentials ───────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Configuration"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

ask "Plasmic Studio URL [default: https://studio.aihe.dev]:"
read -r STUDIO_HOST
STUDIO_HOST="${STUDIO_HOST:-https://studio.aihe.dev}"
# strip trailing slash
STUDIO_HOST="${STUDIO_HOST%/}"

ask "Your Plasmic project ID (from the URL: /projects/<THIS_PART>/):"
read -r PROJECT_ID
[ -n "$PROJECT_ID" ] || die "Project ID is required."

ask "Your Plasmic API user email (the account that owns the PAT below):"
read -r API_USER
[ -n "$API_USER" ] || die "API user email is required."

ask "Your Plasmic Personal Access Token (Studio → Account → API tokens):"
read -rs API_TOKEN
echo ""
[ -n "$API_TOKEN" ] || die "API token is required."

ask "Project loader token (Studio → Project Settings → API tokens → Public token) [optional, press Enter to skip]:"
read -r PROJECT_TOKEN

# ── 4. Write .env files ──────────────────────────────────────────────────────
ROOT_ENV="$REPO_DIR/.env"
cat > "$ROOT_ENV" <<EOF
PLASMIC_STUDIO_HOST=$STUDIO_HOST
PLASMIC_API_USER=$API_USER
PLASMIC_API_TOKEN=$API_TOKEN
PLASMIC_PROJECT_ID=$PROJECT_ID
EOF
[ -n "$PROJECT_TOKEN" ] && echo "PLASMIC_PROJECT_TOKEN=$PROJECT_TOKEN" >> "$ROOT_ENV"
info "Wrote $ROOT_ENV"

CANVAS_ENV="$REPO_DIR/canvas-browser/.env"
cat > "$CANVAS_ENV" <<EOF
PLASMIC_STUDIO_HOST=$STUDIO_HOST
PLASMIC_PROJECT_ID=$PROJECT_ID
PLASMIC_CHROME_DEBUG_URL=http://localhost:9222
EOF
info "Wrote $CANVAS_ENV"

# ── 5. Register MCP servers in ~/.claude.json ────────────────────────────────
echo ""
echo "Registering MCP servers in $CLAUDE_JSON…"

# Build the env JSON for each server (single-pass, no secrets in args)
ROOT_ENV_JSON="{\"PLASMIC_STUDIO_HOST\":\"$STUDIO_HOST\",\"PLASMIC_API_USER\":\"$API_USER\",\"PLASMIC_API_TOKEN\":\"$API_TOKEN\",\"PLASMIC_PROJECT_ID\":\"$PROJECT_ID\""
[ -n "$PROJECT_TOKEN" ] && ROOT_ENV_JSON="$ROOT_ENV_JSON,\"PLASMIC_PROJECT_TOKEN\":\"$PROJECT_TOKEN\""
ROOT_ENV_JSON="$ROOT_ENV_JSON}"

CANVAS_ENV_JSON="{\"PLASMIC_STUDIO_HOST\":\"$STUDIO_HOST\",\"PLASMIC_PROJECT_ID\":\"$PROJECT_ID\"}"

# Use Node to merge mcpServers into ~/.claude.json safely
node --input-type=module <<NODEEOF
import { readFileSync, writeFileSync } from "fs";

const claudeJsonPath = process.env.HOME + "/.claude.json";
let config = {};
try { config = JSON.parse(readFileSync(claudeJsonPath, "utf8")); } catch {}

config.mcpServers = config.mcpServers ?? {};
config.mcpServers["plasmic"] = {
  type: "stdio",
  command: "node",
  args: ["$REPO_DIR/dist/index.js"],
  env: $ROOT_ENV_JSON,
};
config.mcpServers["plasmic-canvas"] = {
  type: "stdio",
  command: "node",
  args: ["$REPO_DIR/canvas-browser/dist/index.js"],
  env: $CANVAS_ENV_JSON,
};

writeFileSync(claudeJsonPath, JSON.stringify(config, null, 2));
console.log("MCP servers registered.");
NODEEOF

info "Registered 'plasmic' and 'plasmic-canvas' MCP servers"

# ── 6. Done ──────────────────────────────────────────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "  ${GREEN}All done!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Restart Claude Desktop (or run 'claude mcp list' to confirm)."
echo ""
echo "Then just ask Claude:"
echo "  \"Take a screenshot of my Plasmic project\""
echo "  \"Add a Text element to the canvas\""
echo "  \"List all pages in my project\""
echo ""
echo "Claude will open Chrome and Studio automatically on first use."
echo ""

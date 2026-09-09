#!/bin/bash
# Open-Cursor Bridge Installer
#
# Architecture:
#   ~/.cursor-codex-bridge/     ← stable bridge path outside Cursor
#   ~/.cursor/extensions/       ← linked extension (survives Cursor updates)
#   ~/.gemini/antigravity-cli/  ← Antigravity data (independent)
#   ~/.codex/                   ← Codex data (independent)
#
# The repository may live at ~/.cursor-codex-bridge directly, or elsewhere.
# When run from another clone path, this installer creates a stable symlink at
# ~/.cursor-codex-bridge pointing back to that clone.

set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

if ! command -v node &>/dev/null; then
  for n in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$n" ]; then
      export PATH="$(dirname "$n"):$PATH"
    fi
  done
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
BRIDGE_DIR="$HOME/.cursor-codex-bridge"
CURSOR_EXT_DIR="$HOME/.cursor/extensions"
EXTENSION_LINK="$CURSOR_EXT_DIR/open-cursor-bridge"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${CYAN}${BOLD}"
echo "╔══════════════════════════════════════════════════════════╗"
echo "║              Open-Cursor Bridge Installer               ║"
echo "║        Codex + Antigravity · local multi-agent          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 0: Establish stable install path ─────────────────

if [ "$SOURCE_DIR" != "$BRIDGE_DIR" ]; then
  if [ -e "$BRIDGE_DIR" ] || [ -L "$BRIDGE_DIR" ]; then
    EXISTING_TARGET="$(readlink -f "$BRIDGE_DIR" 2>/dev/null || true)"
    if [ "$EXISTING_TARGET" != "$SOURCE_DIR" ]; then
      echo -e "${RED}Existing bridge path points somewhere else:${NC} $BRIDGE_DIR"
      echo "  Existing: ${EXISTING_TARGET:-unknown}"
      echo "  Current repository: $SOURCE_DIR"
      echo "Remove or relocate the existing bridge path before reinstalling."
      exit 1
    fi
  else
    ln -s "$SOURCE_DIR" "$BRIDGE_DIR"
    echo -e "${GREEN}✓${NC} Stable bridge link: $BRIDGE_DIR → $SOURCE_DIR"
  fi
fi

EXTENSION_SRC="$BRIDGE_DIR/extension"

for required in \
  "$BRIDGE_DIR/server/index.js" \
  "$BRIDGE_DIR/extension/package.json" \
  "$BRIDGE_DIR/scripts/register-extension.mjs" \
  "$BRIDGE_DIR/share/open-cursor.svg" \
  "$BRIDGE_DIR/bin/open-cursor" \
  "$BRIDGE_DIR/bin/open-cursor-app"; do
  if [ ! -f "$required" ]; then
    echo -e "${RED}Required project file is missing:${NC} $required"
    echo "Run this installer from a complete open-cursor repository clone."
    exit 1
  fi
done

# ── Step 1: Check prerequisites ──────────────────────────

echo -e "${YELLOW}[1/6] Checking prerequisites...${NC}"

if command -v node &>/dev/null; then
  NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
  if [ "$NODE_MAJOR" -lt 18 ]; then
    echo -e "  ${RED}✗${NC} Node.js 18+ is required; found $(node -v)"
    exit 1
  fi
  echo -e "  ${GREEN}✓${NC} Node.js found: $(node -v)"
else
  echo -e "  ${RED}✗${NC} Node.js not found. Please install Node.js 18+"
  exit 1
fi

CODEX_OK=false
AGY_OK=false

if command -v codex &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Codex CLI found: $(codex --version 2>/dev/null || echo 'installed')"
  CODEX_OK=true
else
  echo -e "  ${YELLOW}⚠${NC} Codex CLI not found"
fi

if [ -x "$HOME/.local/bin/agy" ]; then
  echo -e "  ${GREEN}✓${NC} Antigravity CLI found"
  AGY_OK=true
elif command -v agy &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Antigravity CLI found in PATH"
  AGY_OK=true
else
  echo -e "  ${YELLOW}⚠${NC} Antigravity CLI not found"
fi

if ! $CODEX_OK && ! $AGY_OK; then
  echo -e "${RED}At least one agent CLI is required.${NC}"
  exit 1
fi

# ── Step 2: Verify authentication ────────────────────────

echo ""
echo -e "${YELLOW}[2/6] Verifying authentication mode...${NC}"

if $CODEX_OK; then
  if [ -f "$HOME/.codex/auth.json" ]; then
    AUTH_MODE="$(node -e '
const fs = require("node:fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(data.auth_mode ?? "unknown"));
} catch {
  process.stdout.write("unknown");
}
' "$HOME/.codex/auth.json")"
    if [ "$AUTH_MODE" = "chatgpt" ]; then
      echo -e "  ${GREEN}✓${NC} Codex: ChatGPT OAuth"
    else
      echo -e "  ${YELLOW}⚠${NC} Codex: auth_mode=$AUTH_MODE; verify the intended billing/auth mode"
    fi
  else
    echo -e "  ${YELLOW}⚠${NC} Codex auth file not found; run 'codex login' before use"
  fi
fi

if $AGY_OK; then
  if [ -f "$HOME/.gemini/antigravity-cli/settings.json" ]; then
    USE_CREDITS="$(node -e '
const fs = require("node:fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  process.stdout.write(String(data.useG1Credits ?? true));
} catch {
  process.stdout.write("true");
}
' "$HOME/.gemini/antigravity-cli/settings.json")"
    if [ "$USE_CREDITS" = "false" ]; then
      echo -e "  ${GREEN}✓${NC} Antigravity: subscription mode"
    else
      echo -e "  ${YELLOW}⚠${NC} Antigravity: useG1Credits=$USE_CREDITS"
    fi
  else
    echo -e "  ${YELLOW}⚠${NC} Antigravity settings not found"
  fi
fi

# ── Step 3: Install bridge server ────────────────────────

echo ""
echo -e "${YELLOW}[3/6] Installing bridge server...${NC}"

mkdir -p "$BRIDGE_DIR/config"

echo -e "  ${GREEN}✓${NC} Bridge directory: $BRIDGE_DIR"
echo -e "  ${GREEN}✓${NC} Server: $BRIDGE_DIR/server/index.js"
echo -e "  ${GREEN}✓${NC} Launcher: $BRIDGE_DIR/bin/open-cursor-app"

# ── Step 4: Fix agentapi if broken ───────────────────────

echo ""
echo -e "${YELLOW}[4/6] Fixing agentapi reference...${NC}"

if [ -x "$HOME/.local/bin/agy" ]; then
  mkdir -p "$HOME/.gemini/antigravity-cli/bin"
  cat > "$HOME/.gemini/antigravity-cli/bin/agentapi" << 'AGENTAPI'
#!/bin/sh
exec "$HOME/.local/bin/agy" agentapi "$@"
AGENTAPI
  sed -i "s|\$HOME|$HOME|g" "$HOME/.gemini/antigravity-cli/bin/agentapi"
  chmod +x "$HOME/.gemini/antigravity-cli/bin/agentapi"
  echo -e "  ${GREEN}✓${NC} agentapi fixed → $HOME/.local/bin/agy"
fi

# ── Step 5: Create/update Cursor extension link ──────────

echo ""
echo -e "${YELLOW}[5/6] Linking Cursor extension (upgrade-safe)...${NC}"

mkdir -p "$CURSOR_EXT_DIR"
rm -f "$CURSOR_EXT_DIR/.obsolete"

EXTENSION_VERSION="$(node -e '
const p = require(process.argv[1]);
if (!p.version) process.exit(2);
process.stdout.write(p.version);
' "$EXTENSION_SRC/package.json")"
EXTENSION_ID="$(node -e '
const p = require(process.argv[1]);
if (!p.publisher || !p.name) process.exit(2);
process.stdout.write(`${p.publisher}.${p.name}`);
' "$EXTENSION_SRC/package.json")"
VERSIONED_LINK="$CURSOR_EXT_DIR/$EXTENSION_ID-$EXTENSION_VERSION"

if [ -e "$EXTENSION_LINK" ] && [ ! -L "$EXTENSION_LINK" ]; then
  echo -e "${RED}Extension path exists and is not a symlink:${NC} $EXTENSION_LINK"
  exit 1
fi
ln -sfn "$EXTENSION_SRC" "$EXTENSION_LINK"

for stale in "$CURSOR_EXT_DIR/$EXTENSION_ID-"*; do
  [ -e "$stale" ] || [ -L "$stale" ] || continue
  if [ "$stale" = "$VERSIONED_LINK" ]; then
    continue
  fi
  if [ -L "$stale" ]; then
    rm -f "$stale"
    echo -e "  ${CYAN}ℹ${NC} Removed stale extension link: $(basename "$stale")"
  fi
done

if [ -e "$VERSIONED_LINK" ] && [ ! -L "$VERSIONED_LINK" ]; then
  echo -e "${RED}Versioned extension path exists and is not a symlink:${NC} $VERSIONED_LINK"
  exit 1
fi
ln -sfn "$EXTENSION_SRC" "$VERSIONED_LINK"

if [ -f "$CURSOR_EXT_DIR/extensions.json" ]; then
  REGISTRATION="$(node "$BRIDGE_DIR/scripts/register-extension.mjs" \
    "$CURSOR_EXT_DIR/extensions.json" "$EXTENSION_SRC")"
  echo -e "  ${GREEN}✓${NC} Cursor registry updated: $REGISTRATION"
else
  echo -e "  ${CYAN}ℹ${NC} extensions.json not present; symlink discovery remains installed"
fi

echo -e "  ${GREEN}✓${NC} Extension $EXTENSION_ID@$EXTENSION_VERSION"
echo -e "  ${GREEN}✓${NC} Extension linked: $EXTENSION_LINK → $EXTENSION_SRC"
echo -e "  ${CYAN}ℹ${NC} Extension source lives outside Cursor's managed application files"

# ── Step 6: Create desktop entry ─────────────────────────

echo ""
echo -e "${YELLOW}[6/6] Creating startup configuration...${NC}"

ICON_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$ICON_DIR"
cp "$BRIDGE_DIR/share/open-cursor.svg" "$ICON_DIR/open-cursor.svg"
if command -v gtk-update-icon-cache &>/dev/null; then
  gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
fi

mkdir -p "$HOME/.local/share/applications"
DESKTOP_FILE="$HOME/.local/share/applications/open-cursor.desktop"
cat > "$DESKTOP_FILE" << EOF
[Desktop Entry]
Name=Open-Cursor
Name[ja]=Open-Cursor
GenericName=Multi-Agent Code Editor
GenericName[ja]=マルチエージェント コードエディタ
Comment=Multi-agent coding IDE (subscription-backed local bridge)
Comment[ja]=Codex + Antigravity マルチエージェント コーディングIDE
Exec=$BRIDGE_DIR/bin/open-cursor-app %F
Icon=$BRIDGE_DIR/share/open-cursor.svg
Terminal=false
Type=Application
Categories=Development;IDE;
Keywords=code;editor;ai;multi-agent;cursor;codex;gemini;
StartupNotify=true
StartupWMClass=Cursor
MimeType=text/plain;inode/directory;application/x-cursor-workspace;
Actions=new-window;stop-bridge;

[Desktop Action new-window]
Name=New Window
Name[ja]=新しいウィンドウ
Exec=$BRIDGE_DIR/bin/open-cursor-app --new-window %F

[Desktop Action stop-bridge]
Name=Stop Bridge Server
Name[ja]=ブリッジサーバーを停止
Exec=$BRIDGE_DIR/bin/stop-bridge
EOF

chmod 644 "$DESKTOP_FILE"

for desktop_dir in "$HOME/デスクトップ" "$HOME/Desktop"; do
  if [ -d "$desktop_dir" ]; then
    SHORTCUT="$desktop_dir/Open-Cursor.desktop"
    cp "$DESKTOP_FILE" "$SHORTCUT"
    chmod 755 "$SHORTCUT"
    if command -v gio &>/dev/null; then
      gio set "$SHORTCUT" metadata::trusted true 2>/dev/null || true
    fi
    echo -e "  ${GREEN}✓${NC} Desktop shortcut: $SHORTCUT"
  fi
done

if command -v update-desktop-database &>/dev/null; then
  update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true
fi

echo -e "  ${GREEN}✓${NC} Desktop entry created: $DESKTOP_FILE"

chmod +x "$BRIDGE_DIR/bin/open-cursor"
chmod +x "$BRIDGE_DIR/bin/open-cursor-app"
chmod +x "$BRIDGE_DIR/bin/stop-bridge"
chmod +x "$BRIDGE_DIR/server/index.js" 2>/dev/null || true

mkdir -p "$HOME/.local/bin"
ln -sf "$BRIDGE_DIR/bin/open-cursor" "$HOME/.local/bin/open-cursor"
ln -sf "$BRIDGE_DIR/bin/open-cursor-app" "$HOME/.local/bin/open-cursor-app"
ln -sf "$BRIDGE_DIR/bin/stop-bridge" "$HOME/.local/bin/stop-bridge"

# ── Summary ──────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Installation Complete — Open-Cursor $EXTENSION_VERSION${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Quick Start:${NC}"
echo -e "    1. Run: ${BOLD}$BRIDGE_DIR/bin/open-cursor-app${NC}"
echo -e "    2. Or launch ${BOLD}Open-Cursor${NC} from your desktop menu"
echo -e "    3. In Cursor: ${BOLD}Ctrl+Shift+A${NC} or Command Palette → Open-Cursor: Chat with Agents"
echo ""
echo -e "  ${CYAN}Agent Modes:${NC}"
echo -e "    collaborative  — Gemini Plan → Codex Implement → Gemini Review → Codex Refine"
echo -e "    pipeline       — Gemini Plan → Codex Implement"
echo -e "    codex          — Codex only"
echo -e "    antigravity    — Antigravity only"
echo ""
echo -e "  ${CYAN}Update Protection:${NC}"
echo -e "    • Bridge: ${BOLD}$BRIDGE_DIR/${NC} (outside Cursor application files)"
echo -e "    • Codex: ${BOLD}~/.codex/${NC} (independent)"
echo -e "    • Antigravity: ${BOLD}~/.gemini/antigravity-cli/${NC} (independent)"
echo ""
echo -e "  ${YELLOW}Authentication / billing:${NC}"
echo -e "    • Verify Codex is using the intended ChatGPT authentication mode"
echo -e "    • Verify Antigravity is using the intended subscription/credit mode"
echo -e "    • Open-Cursor itself does not require a per-call API key"
echo ""

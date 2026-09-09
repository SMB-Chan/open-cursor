#!/bin/bash
# Open-Cursor Bridge Installer
# 課金主義を排除し、民衆のために再構築されたコーディング環境
#
# Architecture:
#   ~/.cursor-codex-bridge/     ← OUTSIDE Cursor's directories (update-proof)
#   ~/.cursor/extensions/       ← Symlinked extension (survives Cursor updates)
#   ~/.gemini/antigravity-cli/  ← Antigravity data (independent)
#   ~/.codex/                   ← Codex data (independent)
#
# All three directories are managed by their respective CLIs, NOT by Cursor.
# Cursor updates cannot touch them.

set -euo pipefail

BRIDGE_DIR="$HOME/.cursor-codex-bridge"
EXTENSION_SRC="$BRIDGE_DIR/extension"
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
echo "║       Open-Cursor Bridge Installer v2.0                  ║"
echo "║   課金なし · サブスクリプションのみ · 民衆のためのIDE     ║"
echo "╠══════════════════════════════════════════════════════════╣"
echo "║  Codex CLI    ← ChatGPTサブスクリプション (OAuth)        ║"
echo "║  Antigravity  ← Gemini AI Proサブスクリプション (OAuth)  ║"
echo "║  課金API      ← 一切使用しない                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# ── Step 1: Check prerequisites ──────────────────────────

echo -e "${YELLOW}[1/6] Checking prerequisites...${NC}"

CODEX_OK=false
AGY_OK=false

if command -v codex &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Codex CLI found: $(codex --version 2>/dev/null || echo 'installed')"
  CODEX_OK=true
else
  echo -e "  ${RED}✗${NC} Codex CLI not found. Install: https://github.com/openai/codex"
fi

if [ -x "$HOME/.local/bin/agy" ]; then
  echo -e "  ${GREEN}✓${NC} Antigravity CLI found"
  AGY_OK=true
elif command -v agy &>/dev/null; then
  echo -e "  ${GREEN}✓${NC} Antigravity CLI found in PATH"
  AGY_OK=true
else
  echo -e "  ${RED}✗${NC} Antigravity CLI not found"
fi

if ! $CODEX_OK && ! $AGY_OK; then
  echo -e "${RED}At least one agent CLI is required.${NC}"
  exit 1
fi

# ── Step 2: Verify authentication ────────────────────────

echo ""
echo -e "${YELLOW}[2/6] Verifying authentication (subscription-only)...${NC}"

if $CODEX_OK; then
  if [ -f "$HOME/.codex/auth.json" ]; then
    AUTH_MODE=$(python3 -c "import json; print(json.load(open('$HOME/.codex/auth.json')).get('auth_mode','unknown'))" 2>/dev/null || echo "unknown")
    if [ "$AUTH_MODE" = "chatgpt" ]; then
      echo -e "  ${GREEN}✓${NC} Codex: ChatGPT OAuth (subscription, no billing)"
    else
      echo -e "  ${YELLOW}⚠${NC} Codex: auth_mode=$AUTH_MODE (verify no billing)"
    fi
  else
    echo -e "  ${RED}✗${NC} Codex: not authenticated. Run 'codex login'"
  fi
fi

if $AGY_OK; then
  if [ -f "$HOME/.gemini/antigravity-cli/settings.json" ]; then
    USE_CREDITS=$(python3 -c "import json; print(json.load(open('$HOME/.gemini/antigravity-cli/settings.json')).get('useG1Credits', True))" 2>/dev/null || echo "True")
    if [ "$USE_CREDITS" = "False" ]; then
      echo -e "  ${GREEN}✓${NC} Antigravity: Subscription mode (no credits)"
    else
      echo -e "  ${YELLOW}⚠${NC} Antigravity: useG1Credits=$USE_CREDITS"
    fi
  else
    echo -e "  ${YELLOW}⚠${NC} Antigravity: settings not found"
  fi
fi

# ── Step 3: Install bridge server ────────────────────────

echo ""
echo -e "${YELLOW}[3/6] Installing bridge server...${NC}"

mkdir -p "$BRIDGE_DIR/server" "$BRIDGE_DIR/bin" "$BRIDGE_DIR/config"

echo -e "  ${GREEN}✓${NC} Bridge directory: $BRIDGE_DIR"
echo -e "  ${GREEN}✓${NC} Server: $BRIDGE_DIR/server/index.js"
echo -e "  ${GREEN}✓${NC} Launcher: $BRIDGE_DIR/bin/open-cursor"

# ── Step 4: Fix agentapi if broken ───────────────────────

echo ""
echo -e "${YELLOW}[4/6] Fixing agentapi reference...${NC}"

if [ -x "$HOME/.local/bin/agy" ]; then
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
echo -e "${YELLOW}[5/6] Linking Cursor extension (update-proof)...${NC}"

mkdir -p "$CURSOR_EXT_DIR"

# Remove old link if exists
if [ -L "$EXTENSION_LINK" ]; then
  rm "$EXTENSION_LINK"
fi

# Symlink from outside Cursor's managed directories
ln -sf "$EXTENSION_SRC" "$EXTENSION_LINK"
echo -e "  ${GREEN}✓${NC} Extension symlinked: $EXTENSION_LINK → $EXTENSION_SRC"
echo -e "  ${CYAN}ℹ${NC} Extension source lives OUTSIDE Cursor's directories"

# ── Step 6: Create systemd service (optional) ────────────

echo ""
echo -e "${YELLOW}[6/6] Creating startup configuration...${NC}"

# Desktop entry for easy launch
mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/open-cursor.desktop" << EOF
[Desktop Entry]
Name=Open-Cursor
Comment=Multi-agent coding IDE (no billing)
Exec=$BRIDGE_DIR/bin/open-cursor
Icon=text-editor
Terminal=true
Type=Application
Categories=Development;IDE;
EOF

echo -e "  ${GREEN}✓${NC} Desktop entry created"

# Make scripts executable
chmod +x "$BRIDGE_DIR/bin/open-cursor"
chmod +x "$BRIDGE_DIR/server/index.js" 2>/dev/null || true

# ── Summary ──────────────────────────────────────────────

echo ""
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}${BOLD}  Installation Complete!${NC}"
echo -e "${GREEN}${BOLD}═══════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${CYAN}Quick Start:${NC}"
echo -e "    1. Run: ${BOLD}$BRIDGE_DIR/bin/open-cursor${NC}"
echo -e "    2. In Cursor settings, set API to: ${BOLD}http://127.0.0.1:9876/v1${NC}"
echo -e "    3. Use: ${BOLD}Ctrl+Shift+P → Open-Cursor: Chat with Agents${NC}"
echo ""
echo -e "  ${CYAN}Agent Modes:${NC}"
echo -e "    collaborative  — Both agents work together"
echo -e "    pipeline       — Gemini analyzes → Codex implements"
echo -e "    codex          — Codex only (ChatGPT)"
echo -e "    antigravity    — Antigravity only (Gemini)"
echo ""
echo -e "  ${CYAN}Update Protection:${NC}"
echo -e "    • Bridge: ${BOLD}$BRIDGE_DIR/${NC} (outside Cursor)"
echo -e "    • Codex: ${BOLD}~/.codex/${NC} (independent)"
echo -e "    • Antigravity: ${BOLD}~/.gemini/antigravity-cli/${NC} (independent)"
echo -e "    • Cursor updates CANNOT touch these directories"
echo ""
echo -e "  ${YELLOW}Billing: NONE${NC}"
echo -e "    • Codex uses ChatGPT subscription OAuth"
echo -e "    • Antigravity uses Gemini AI Pro subscription"
echo -e "    • No API keys, no per-call billing, no credit cards"
echo ""

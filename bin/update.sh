#!/bin/bash
# Open-Cursor Update Script
#
# シンボリックリンク方式のため、リポジトリの内容がそのまま実行環境になります。
# このスクリプトは以下を実行します:
#   1. git pull で最新を取得 (ローカル変更があれば abort)
#   2. 構文チェック + テスト実行
#   3. 稼働中ブリッジ/モバイルダッシュボードを再起動 (新コードを反映)
#   4. 拡張リンクの再登録 (バージョン変更時)
#
# 使い方:
#   ~/.cursor-codex-bridge/bin/update.sh          # 対話確認あり
#   ~/.cursor-codex-bridge/bin/update.sh --yes    # 確認なし

set -euo pipefail

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

if ! command -v node &>/dev/null; then
  for n in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$n" ]; then
      export PATH="$(dirname "$n"):$PATH"
    fi
  done
fi

BRIDGE_DIR="$HOME/.cursor-codex-bridge"
if [ -L "$BRIDGE_DIR" ]; then
  REPO_DIR="$(readlink -f "$BRIDGE_DIR")"
else
  REPO_DIR="$BRIDGE_DIR"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

ASSUME_YES=false
if [ "${1:-}" = "--yes" ]; then
  ASSUME_YES=true
fi

OLD_VERSION="$(node -p "require('$REPO_DIR/server/package.json').version" 2>/dev/null || echo unknown)"

echo -e "${CYAN}${BOLD}Open-Cursor Update (current: v$OLD_VERSION)${NC}"
echo -e "Repository: $REPO_DIR"
echo ""

# ── 1. git pull ──────────────────────────────────────────

if [ -n "$(git -C "$REPO_DIR" status --porcelain 2>/dev/null)" ]; then
  echo -e "${RED}Local uncommitted changes exist; git pull is not safe.${NC}"
  git -C "$REPO_DIR" status --short
  echo "Commit or stash your changes, then re-run."
  exit 1
fi

BRANCH="$(git -C "$REPO_DIR" rev-parse --abbrev-ref HEAD)"

if $ASSUME_YES; then
  PULL_CONFIRM="y"
else
  read -r -p "git pull origin $BRANCH? [y/N] " PULL_CONFIRM
fi

if [ "$PULL_CONFIRM" = "y" ] || [ "$PULL_CONFIRM" = "Y" ]; then
  git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"
else
  echo -e "${YELLOW}Skipping git pull; updating running services with current code.${NC}"
fi

NEW_VERSION="$(node -p "require('$REPO_DIR/server/package.json').version" 2>/dev/null || echo unknown)"

# ── 2. Checks & tests ────────────────────────────────────

echo ""
echo -e "${YELLOW}[1/3] Syntax checks & tests...${NC}"

cd "$REPO_DIR/server"
npm run check >/dev/null
npm test 2>&1 | tail -5

cd "$REPO_DIR/extension"
npm run check >/dev/null
npm test 2>&1 | tail -5
echo -e "  ${GREEN}✓${NC} All checks passed"

# ── 3. Restart services ──────────────────────────────────

echo ""
echo -e "${YELLOW}[2/3] Restarting bridge...${NC}"

"$REPO_DIR/bin/stop-bridge" >/dev/null 2>&1 || true
sleep 1
# stop-bridge が PID ファイルを消すため、万が一の残留プロセスをポートから検出して終了
for pid in $(ss -tlnp 2>/dev/null | grep -E ':(9876|9880)\b' | grep -oP 'pid=\K[0-9]+' | sort -u); do
  kill "$pid" 2>/dev/null || true
done
sleep 1

cd "$REPO_DIR"
"$REPO_DIR/bin/open-cursor" > /dev/null 2>&1

for i in $(seq 1 20); do
  if curl -sf --connect-timeout 1 http://127.0.0.1:9876/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -sf http://127.0.0.1:9876/health >/dev/null 2>&1; then
  echo -e "  ${RED}✗ Bridge failed to start. Check: $BRIDGE_DIR/bridge.log${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Bridge v$NEW_VERSION running"

# ── 4. Extension relink ──────────────────────────────────

echo ""
echo -e "${YELLOW}[3/3] Refreshing extension link...${NC}"

EXT_DIR="$HOME/.cursor/extensions"
if [ -f "$EXT_DIR/extensions.json" ]; then
  EXT_VERSION="$(node -p "require('$REPO_DIR/extension/package.json').version")"
  node "$REPO_DIR/scripts/register-extension.mjs" \
    "$EXT_DIR/extensions.json" "$REPO_DIR/extension" >/dev/null
  echo -e "  ${GREEN}✓${NC} Extension registry updated: open-cursor.open-cursor-bridge@$EXT_VERSION"
  echo -e "  ${CYAN}ℹ${NC} Cursor の再起動で拡張の新版が読み込まれます${NC}"
else
  echo -e "  ${CYAN}ℹ${NC} extensions.json not present; symlink discovery remains installed"
fi

# Desktop entry / ~/.local/bin symlinks may gain new actions between versions;
# the installer is idempotent, so re-run it quietly to refresh those.
bash "$REPO_DIR/bin/install.sh" >/dev/null 2>&1 || true

# ── Summary ──────────────────────────────────────────────

echo ""
if [ "$OLD_VERSION" != "$NEW_VERSION" ]; then
  echo -e "${GREEN}${BOLD}Updated: v$OLD_VERSION → v$NEW_VERSION${NC}"
else
  echo -e "${GREEN}${BOLD}Up to date: v$NEW_VERSION${NC}"
fi
echo -e "  ${CYAN}Monitor:${NC} open-cursor-monitor"
echo -e "  ${CYAN}Logs:${NC}    tail -f $BRIDGE_DIR/bridge.log"

#!/bin/bash
# scripts/build-deb.sh — build a Debian package for Open-Cursor.
#
#   scripts/build-deb.sh [--out DIR]
#
# Package layout:
#   /opt/open-cursor/            repository copy (server, extension, mobile,
#                                bin, config, scripts, share, AGENTS.md...)
#   /usr/local/bin/open-cursor*  symlinks into /opt/open-cursor/bin
#   /usr/share/applications/open-cursor.desktop   (Actions point at /opt)
#   /usr/share/icons/hicolor/scalable/apps/open-cursor.svg
#
# The deb is self-contained: it does NOT create ~/.cursor-codex-bridge and
# does not touch user data. install.sh (symlink layout) and the deb can coexist;
# postinst prefers the deb paths when present via BIN_DIR resolution in the
# launchers (see postinst hint output).

set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUT_DIR="${1:-}"
if [ "$OUT_DIR" = "--out" ]; then
  OUT_DIR="${2:-$REPO_ROOT/dist}"
elif [ -z "$OUT_DIR" ]; then
  OUT_DIR="$REPO_ROOT/dist"
fi
mkdir -p "$OUT_DIR"

VERSION="$(node -p "require('$REPO_ROOT/server/package.json').version")"
DEB_NAME="open-cursor_${VERSION}_amd64.deb"
STAGING="$(mktemp -d /tmp/open-cursor-deb.XXXXXX)"
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging Open-Cursor $VERSION"

# ── /opt payload ─────────────────────────────────────────────
PAYLOAD="$STAGING/opt/open-cursor"
mkdir -p "$PAYLOAD"

rsync -a \
  --exclude '.git' \
  --exclude '.github' \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  --exclude '.pytest_cache' \
  --exclude '.mimocode' \
  --exclude 'dist' \
  --exclude '*.log' \
  --exclude '*.pid' \
  --exclude '*.token' \
  --exclude 'run/' \
  --exclude 'server/personal/' \
  "$REPO_ROOT/" "$PAYLOAD/"

# ── /usr/local/bin symlinks ──────────────────────────────────
BIN="$STAGING/usr/local/bin"
mkdir -p "$BIN"
for tool in open-cursor open-cursor-app open-cursor-monitor open-cursor-status \
            open-cursor-help open-cursor-terminal open-cursor-update stop-bridge usage; do
  ln -s "/opt/open-cursor/bin/$tool" "$BIN/$tool"
done

# ── desktop + icon ───────────────────────────────────────────
APPS="$STAGING/usr/share/applications"
ICON_DIR="$STAGING/usr/share/icons/hicolor/scalable/apps"
mkdir -p "$APPS" "$ICON_DIR"
cp "$REPO_ROOT/share/open-cursor.svg" "$ICON_DIR/open-cursor.svg"
cat > "$APPS/open-cursor.desktop" <<EOF
[Desktop Entry]
Name=Open-Cursor
Name[ja]=Open-Cursor
GenericName=Multi-Agent Code Editor
GenericName[ja]=マルチエージェント コードエディタ
Comment=Multi-agent coding IDE (subscription-backed local bridge)
Comment[ja]=Codex + Antigravity マルチエージェント コーディングIDE
Exec=/opt/open-cursor/bin/open-cursor-app %F
Icon=/usr/share/icons/hicolor/scalable/apps/open-cursor.svg
Terminal=false
Type=Application
Categories=Development;IDE;
Keywords=code;editor;ai;multi-agent;cursor;codex;gemini;
StartupNotify=true
StartupWMClass=Cursor
MimeType=text/plain;inode/directory;application/x-cursor-workspace;
Actions=new-window;monitor;status;usage;help;stop-bridge;

[Desktop Action new-window]
Name=New Window
Name[ja]=新しいウィンドウ
Exec=/opt/open-cursor/bin/open-cursor-app --new-window %F

[Desktop Action monitor]
Name=Live Monitor
Name[ja]=ライブモニター
Exec=/opt/open-cursor/bin/open-cursor-terminal --hold /opt/open-cursor/bin/open-cursor-monitor

[Desktop Action status]
Name=Agent Status
Name[ja]=エージェント状態
Exec=/opt/open-cursor/bin/open-cursor-terminal --hold /opt/open-cursor/bin/open-cursor-status

[Desktop Action usage]
Name=LLM Usage
Name[ja]=LLMクォータ確認
Exec=/opt/open-cursor/bin/open-cursor-terminal --hold /opt/open-cursor/bin/usage

[Desktop Action help]
Name=Command List
Name[ja]=コマンド一覧
Exec=/opt/open-cursor/bin/open-cursor-terminal --hold /opt/open-cursor/bin/open-cursor-help

[Desktop Action stop-bridge]
Name=Stop Bridge Server
Name[ja]=ブリッジサーバーを停止
Exec=/opt/open-cursor/bin/stop-bridge
EOF

# ── maintainer scripts ───────────────────────────────────────
DEBIAN="$STAGING/DEBIAN"
mkdir -p "$DEBIAN"

INSTALLED_SIZE="$(du -sk "$PAYLOAD" | cut -f1)"
cat > "$DEBIAN/control" <<EOF
Package: open-cursor
Version: $VERSION
Section: devel
Priority: optional
Architecture: amd64
Installed-Size: $INSTALLED_SIZE
Depends: nodejs (>= 18), git, curl
Recommends: codex-cli | agy
Suggests: sqlite3
Maintainer: SMB-Chan <open-cursor@users.noreply.github.com>
Homepage: https://github.com/SMB-Chan/open-cursor
Description: Local multi-agent coding bridge (Codex + Gemini + MiMo)
 Open-Cursor routes coding tasks to subscription-authenticated CLIs
 through an OpenAI-compatible HTTP endpoint on 127.0.0.1:9876 and
 orchestrates sequential Plan -> Implement -> Review -> Refine
 pipelines. Includes a Cursor/VS Code extension, localhost mobile
 dashboard, live terminal monitor and self-update tooling.
EOF

cat > "$DEBIAN/postinst" <<'EOF'
#!/bin/bash
set -e
chmod +x /opt/open-cursor/bin/* 2>/dev/null || true
chmod +x /opt/open-cursor/server/index.js 2>/dev/null || true

# Cursor extension registry (best effort, mirrors bin/install.sh)
EXT_DIR="$HOME/.cursor/extensions"
if [ -d "$EXT_DIR" ] && [ -f "$EXT_DIR/extensions.json" ] && command -v node >/dev/null 2>&1; then
  VERSION="$(node -p "require('/opt/open-cursor/extension/package.json').version" 2>/dev/null || echo 0)"
  rm -f "$EXT_DIR/.obsolete"
  ln -sfn /opt/open-cursor/extension "$EXT_DIR/open-cursor-bridge"
  ln -sfn /opt/open-cursor/extension "$EXT_DIR/open-cursor.open-cursor-bridge-$VERSION"
  node /opt/open-cursor/scripts/register-extension.mjs \
    "$EXT_DIR/extensions.json" /opt/open-cursor/extension >/dev/null 2>&1 || true
fi

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications 2>/dev/null || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true
fi

echo "open-cursor: installed. Run 'open-cursor-help' for commands,"
echo "or open Cursor and use 'Open-Cursor: Update Open-Cursor' to self-update."
EOF

cat > "$DEBIAN/prerm" <<'EOF'
#!/bin/bash
set -e
# Stop a running bridge only when removing/purging (not on upgrade).
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
  /opt/open-cursor/bin/stop-bridge >/dev/null 2>&1 || true
fi
exit 0
EOF

cat > "$DEBIAN/conffiles" <<'EOF'
/opt/open-cursor/config/bridge.json
EOF

chmod 755 "$DEBIAN/postinst" "$DEBIAN/prerm"

# ── build ────────────────────────────────────────────────────
echo "==> Building $DEB_NAME"
mkdir -p "$OUT_DIR"
fakeroot dpkg-deb --build --root-owner-group "$STAGING" "$OUT_DIR/$DEB_NAME" >/dev/null
dpkg-deb --info "$OUT_DIR/$DEB_NAME" | head -14
echo "==> Output: $OUT_DIR/$DEB_NAME ($(du -h "$OUT_DIR/$DEB_NAME" | cut -f1))"

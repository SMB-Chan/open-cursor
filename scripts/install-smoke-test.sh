#!/bin/bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export HOME="$TMP_DIR/home"
mkdir -p \
  "$HOME/.local/bin" \
  "$HOME/bin" \
  "$HOME/.codex" \
  "$HOME/.gemini/antigravity-cli" \
  "$HOME/.cursor/extensions"

cat > "$HOME/bin/codex" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  echo "codex-smoke 0.0.0"
fi
exit 0
EOF
chmod +x "$HOME/bin/codex"

cat > "$HOME/.local/bin/agy" <<'EOF'
#!/bin/sh
if [ "${1:-}" = "--version" ]; then
  echo "agy-smoke 0.0.0"
fi
exit 0
EOF
chmod +x "$HOME/.local/bin/agy"

printf '%s\n' '{"auth_mode":"chatgpt"}' > "$HOME/.codex/auth.json"
printf '%s\n' '{"useG1Credits":false}' > "$HOME/.gemini/antigravity-cli/settings.json"

cat > "$HOME/.cursor/extensions/extensions.json" <<'EOF'
[
  {
    "identifier": {"id": "vendor.keep-me"},
    "version": "1.0.0"
  },
  {
    "identifier": {"id": "open-cursor.open-cursor-bridge"},
    "version": "2.2.0",
    "relativeLocation": "open-cursor.open-cursor-bridge-2.2.0"
  }
]
EOF

ln -s "$ROOT/extension" \
  "$HOME/.cursor/extensions/open-cursor.open-cursor-bridge-2.2.0"

export PATH="$HOME/.local/bin:$HOME/bin:$PATH"

# Run twice: the second run is the upgrade/reinstall/idempotency check.
bash "$ROOT/bin/install.sh" > "$TMP_DIR/install-1.log"
bash "$ROOT/bin/install.sh" > "$TMP_DIR/install-2.log"

EXTENSION_VERSION="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.version)' \
  "$ROOT/extension/package.json")"
EXTENSION_ID="$(node -e 'const p=require(process.argv[1]); process.stdout.write(`${p.publisher}.${p.name}`)' \
  "$ROOT/extension/package.json")"
VERSIONED_LINK="$HOME/.cursor/extensions/$EXTENSION_ID-$EXTENSION_VERSION"

[ -L "$HOME/.cursor-codex-bridge" ]
[ "$(readlink -f "$HOME/.cursor-codex-bridge")" = "$ROOT" ]
[ -L "$HOME/.cursor/extensions/open-cursor-bridge" ]
[ -L "$VERSIONED_LINK" ]
[ "$(readlink -f "$VERSIONED_LINK")" = "$ROOT/extension" ]

if [ "$EXTENSION_VERSION" != "2.2.0" ]; then
  [ ! -e "$HOME/.cursor/extensions/open-cursor.open-cursor-bridge-2.2.0" ]
  [ ! -L "$HOME/.cursor/extensions/open-cursor.open-cursor-bridge-2.2.0" ]
fi

[ -x "$HOME/.gemini/antigravity-cli/bin/agentapi" ]
[ -f "$HOME/.local/share/applications/open-cursor.desktop" ]
grep -Fq "Exec=$HOME/.cursor-codex-bridge/bin/open-cursor-app %F" \
  "$HOME/.local/share/applications/open-cursor.desktop"

node - <<'NODE' "$HOME/.cursor/extensions/extensions.json" "$EXTENSION_ID" "$EXTENSION_VERSION"
const fs = require('node:fs');
const [file, id, version] = process.argv.slice(2);
const entries = JSON.parse(fs.readFileSync(file, 'utf8'));
const ours = entries.filter((entry) => entry?.identifier?.id === id);
if (ours.length !== 1) throw new Error(`expected one ${id} entry, found ${ours.length}`);
if (ours[0].version !== version) throw new Error(`registry version ${ours[0].version} != ${version}`);
if (ours[0].relativeLocation !== `${id}-${version}`) throw new Error('relativeLocation mismatch');
if (ours[0].metadata?.pinned !== true) throw new Error('extension is not pinned');
if (!entries.some((entry) => entry?.identifier?.id === 'vendor.keep-me')) {
  throw new Error('unrelated extension entry was lost');
}
NODE

echo "Installer smoke test passed for $EXTENSION_ID@$EXTENSION_VERSION"

#!/bin/bash
# Source from launchers, including invocations through ~/.local/bin symlinks.
BRIDGE_DIR="$(dirname -- "$(dirname -- "$(readlink -f -- "${BASH_SOURCE[0]}")")")"
if [ -n "${OPEN_CURSOR_RUNTIME_DIR:-}" ]; then
  RUNTIME_DIR="$OPEN_CURSOR_RUNTIME_DIR"
elif [ -w "$BRIDGE_DIR" ]; then
  RUNTIME_DIR="$BRIDGE_DIR"
else
  RUNTIME_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/open-cursor"
fi
export OPEN_CURSOR_RUNTIME_DIR="$RUNTIME_DIR"
export PATH="$HOME/.local/bin:$HOME/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  for candidate in "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$candidate" ]; then export PATH="$(dirname -- "$candidate"):$PATH"; fi
  done
fi
NODE_BIN="$(command -v node 2>/dev/null || true)"

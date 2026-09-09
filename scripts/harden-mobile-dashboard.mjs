import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`mobile hardening anchor not found: ${label}`);
  return text.replace(from, to);
}

// Browser pairing/auth + Git-derived HTML escaping.
const htmlPath = "mobile/public/index.html";
let html = fs.readFileSync(htmlPath, "utf8");
html = replaceOrFail(
  html,
  "  <script>\n    // Tab switching",
  `  <script>\n    const MOBILE_TOKEN_KEY = 'openCursorMobileToken';\n    const nativeFetch = window.fetch.bind(window);\n    let pairingToken = sessionStorage.getItem(MOBILE_TOKEN_KEY) || '';\n    let pairingDeclined = false;\n\n    const hashParams = new URLSearchParams(location.hash.replace(/^#/, ''));\n    const hashToken = (hashParams.get('token') || '').trim();\n    if (hashToken) {\n      pairingToken = hashToken;\n      sessionStorage.setItem(MOBILE_TOKEN_KEY, pairingToken);\n      history.replaceState(null, '', location.pathname + location.search);\n    }\n\n    function escapeHtml(value) {\n      return String(value ?? '')\n        .replace(/&/g, '&amp;')\n        .replace(/</g, '&lt;')\n        .replace(/>/g, '&gt;')\n        .replace(/\"/g, '&quot;')\n        .replace(/'/g, '&#39;');\n    }\n\n    async function authenticatedFetch(input, init = {}) {\n      const target = typeof input === 'string' ? input : (input?.url || '');\n      const isApi = target.startsWith('/api/');\n      if (!isApi) return nativeFetch(input, init);\n\n      const withToken = (token) => {\n        const headers = new Headers(init.headers || {});\n        if (token) headers.set('Authorization', 'Bearer ' + token);\n        return { ...init, headers };\n      };\n\n      let response = await nativeFetch(input, withToken(pairingToken));\n      if (response.status !== 401 || pairingDeclined) return response;\n\n      const entered = window.prompt('Open-Cursor Mobile pairing token を入力してください');\n      if (!entered || !entered.trim()) {\n        pairingDeclined = true;\n        return response;\n      }\n\n      pairingToken = entered.trim();\n      sessionStorage.setItem(MOBILE_TOKEN_KEY, pairingToken);\n      response = await nativeFetch(input, withToken(pairingToken));\n      if (response.status === 401) {\n        sessionStorage.removeItem(MOBILE_TOKEN_KEY);\n        pairingToken = '';\n      }\n      return response;\n    }\n\n    window.fetch = authenticatedFetch;\n\n    // Tab switching`,
  "browser pairing bootstrap"
);

html = replaceOrFail(
  html,
  "statusList.innerHTML = lines.map(line => `<div class=\"file-item\"><span>${line}</span></div>`).join('');",
  "statusList.innerHTML = lines.map(line => `<div class=\"file-item\"><span>${escapeHtml(line)}</span></div>`).join('');",
  "git status escaping"
);

html = replaceOrFail(
  html,
  "              <span class=\"commit-hash\">${c.hash}</span>\n              <span>${c.message}</span>\n              <div style=\"font-size: 11px; color: var(--text-muted);\">${c.date} by ${c.author}</div>",
  "              <span class=\"commit-hash\">${escapeHtml(c.hash)}</span>\n              <span>${escapeHtml(c.message)}</span>\n              <div style=\"font-size: 11px; color: var(--text-muted);\">${escapeHtml(c.date)} by ${escapeHtml(c.author)}</div>",
  "git commit escaping"
);

html = replaceOrFail(
  html,
  "        const bridgeOnline = data.bridge && data.bridge.status === 'ok';",
  `        const shellEnabled = data.shellExecutionEnabled === true;\n        document.querySelectorAll('#tab-term button, #cmd-input').forEach((el) => {\n          el.disabled = !shellEnabled;\n          el.style.opacity = shellEnabled ? '' : '0.55';\n        });\n        if (!shellEnabled) {\n          document.getElementById('term-output').textContent =\n            'Remote shell execution is disabled. Start with MOBILE_ALLOW_EXEC=1 only when explicitly needed.';\n        }\n\n        const bridgeOnline = data.bridge && data.bridge.status === 'ok';`,
  "shell UI state"
);
fs.writeFileSync(htmlPath, html);

// Launcher: preserve original workspace, localhost-only by default, generate pairing token only for remote opt-in.
const launcherPath = "bin/open-cursor";
let launcher = fs.readFileSync(launcherPath, "utf8");
launcher = replaceOrFail(
  launcher,
  `MOBILE_PORT="\${MOBILE_PORT:-9880}"\nMOBILE_URL="http://127.0.0.1:$MOBILE_PORT"\nMOBILE_LOG="$BRIDGE_DIR/mobile.log"\nMOBILE_PID_FILE="$BRIDGE_DIR/mobile.pid"`,
  `MOBILE_PORT="\${MOBILE_PORT:-9880}"\nMOBILE_URL="http://127.0.0.1:$MOBILE_PORT"\nMOBILE_LOG="$BRIDGE_DIR/mobile.log"\nMOBILE_PID_FILE="$BRIDGE_DIR/mobile.pid"\nMOBILE_TOKEN_FILE="$BRIDGE_DIR/mobile.token"\nMOBILE_ALLOW_REMOTE="\${MOBILE_ALLOW_REMOTE:-0}"\nMOBILE_ALLOW_EXEC="\${MOBILE_ALLOW_EXEC:-0}"\nMOBILE_HOST="\${MOBILE_HOST:-}"\nMOBILE_TOKEN="\${MOBILE_TOKEN:-}"\nLAUNCH_WORKSPACE="\${OPEN_CURSOR_WORKSPACE:-$PWD}"\nexport OPEN_CURSOR_WORKSPACE="$LAUNCH_WORKSPACE"\nexport WORKSPACE_DIR="\${WORKSPACE_DIR:-$LAUNCH_WORKSPACE}"`,
  "launcher mobile vars"
);
launcher = replaceOrFail(
  launcher,
  `NODE_BIN="$(command -v node 2>/dev/null || true)"`,
  `NODE_BIN="$(command -v node 2>/dev/null || true)"\n\nis_true() {\n  case "\${1,,}" in\n    1|true|yes|on) return 0 ;;\n    *) return 1 ;;\n  esac\n}\n\nif is_true "$MOBILE_ALLOW_REMOTE"; then\n  MOBILE_HOST="\${MOBILE_HOST:-0.0.0.0}"\n  if [ -z "$MOBILE_TOKEN" ] && [ -r "$MOBILE_TOKEN_FILE" ]; then\n    MOBILE_TOKEN="$(cat "$MOBILE_TOKEN_FILE")"\n  fi\n  if [ -z "$MOBILE_TOKEN" ]; then\n    if [ -z "$NODE_BIN" ]; then\n      echo "Error: Node.js is required to generate the mobile pairing token." >&2\n      exit 1\n    fi\n    MOBILE_TOKEN="$($NODE_BIN -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"\n    umask 077\n    printf '%s\\n' "$MOBILE_TOKEN" > "$MOBILE_TOKEN_FILE"\n    chmod 600 "$MOBILE_TOKEN_FILE"\n  fi\nelse\n  MOBILE_HOST="\${MOBILE_HOST:-127.0.0.1}"\nfi\n\nexport MOBILE_ALLOW_REMOTE MOBILE_ALLOW_EXEC MOBILE_HOST MOBILE_TOKEN`,
  "launcher pairing setup"
);
launcher = replaceOrFail(
  launcher,
  `is_mobile_running() {\n  curl -sf --connect-timeout 1 "$MOBILE_URL/api/status" >/dev/null 2>&1\n}`,
  `is_mobile_running() {\n  curl -sf --connect-timeout 1 "$MOBILE_URL/healthz" >/dev/null 2>&1\n}`,
  "launcher health endpoint"
);
launcher = replaceOrFail(
  launcher,
  `  export OPEN_CURSOR_WORKSPACE="\${OPEN_CURSOR_WORKSPACE:-$PWD}"\n  cd "$BRIDGE_DIR/server"`,
  `  cd "$BRIDGE_DIR/server"`,
  "launcher workspace preservation"
);
launcher = replaceOrFail(
  launcher,
  `echo -e "  \${GREEN}\${BOLD}📱 Mobile Web:\${NC} http://\${LOCAL_IP}:\${MOBILE_PORT}"\necho -e "  \${CYAN}Logs:\${NC} tail -f $LOG_FILE"`,
  `if is_true "$MOBILE_ALLOW_REMOTE"; then\n  echo -e "  \${GREEN}\${BOLD}📱 Mobile Web:\${NC} http://\${LOCAL_IP}:\${MOBILE_PORT}/#token=\${MOBILE_TOKEN}"\n  echo -e "  \${YELLOW}Pairing token is a secret; use only on a trusted LAN or encrypted tunnel.\${NC}"\nelse\n  echo -e "  \${GREEN}\${BOLD}📱 Mobile Web:\${NC} http://127.0.0.1:\${MOBILE_PORT} (localhost only)"\n  echo -e "  \${CYAN}Remote opt-in:\${NC} MOBILE_ALLOW_REMOTE=1 $BRIDGE_DIR/bin/open-cursor"\nfi\nif is_true "$MOBILE_ALLOW_EXEC"; then\n  echo -e "  \${RED}Remote shell execution: ENABLED\${NC}"\nelse\n  echo -e "  \${CYAN}Remote shell execution:\${NC} disabled (MOBILE_ALLOW_EXEC=1 to opt in)"\nfi\necho -e "  \${CYAN}Workspace:\${NC} $WORKSPACE_DIR"\necho -e "  \${CYAN}Logs:\${NC} tail -f $LOG_FILE"`,
  "launcher mobile URL"
);
launcher = replaceOrFail(
  launcher,
  `echo -e "  \${MAGENTA}💡 スマホのブラウザで上記URLを開くと、チャット・自律実行・Git差分確認が可能です。\${NC}"`,
  `if is_true "$MOBILE_ALLOW_REMOTE"; then\n  echo -e "  \${MAGENTA}💡 Pairing URLをスマホで開くと、認証済みのチャット・Git確認が可能です。\${NC}"\nfi`,
  "launcher mobile hint"
);
fs.writeFileSync(launcherPath, launcher);

// README security contract.
const readmePath = "README.md";
let readme = fs.readFileSync(readmePath, "utf8");
readme = replaceOrFail(
  readme,
  `Bridge-only launch:\n\n\
\
~/.cursor-codex-bridge/bin/open-cursor\n\
\n\nLegacy shell-managed bridge stop:`,
  `Bridge-only launch:\n\n\
\
~/.cursor-codex-bridge/bin/open-cursor\n\
\n\n### Mobile dashboard security\n\nThe mobile dashboard is **localhost-only by default**. It never exposes the shell or execution APIs to the LAN merely because the launcher was started.\n\nTo opt in to phone/tablet access on a trusted LAN:\n\n\
\
MOBILE_ALLOW_REMOTE=1 ~/.cursor-codex-bridge/bin/open-cursor\n\
\n\nThe launcher creates a 256-bit pairing token in \
~/.cursor-codex-bridge/mobile.token\
 (mode 0600) and prints a URL whose token is carried in the URL fragment (\
#token=...\
). URL fragments are not sent in HTTP requests; the browser stores the token only in session storage and uses a Bearer header for API calls.\n\nRemote arbitrary shell execution is a separate high-trust opt-in and remains disabled by default:\n\n\
\
MOBILE_ALLOW_REMOTE=1 MOBILE_ALLOW_EXEC=1 ~/.cursor-codex-bridge/bin/open-cursor\n\
\n\nThe dashboard uses plain HTTP, so LAN remote mode should only be used on a trusted network or through an encrypted tunnel/VPN. Do not forward port 9880 directly to the public Internet.\n\nLegacy shell-managed bridge stop:`,
  "README mobile security"
);
fs.writeFileSync(readmePath, readme);

// Standard CI must continuously exercise the mobile boundary.
const ciPath = ".github/workflows/ci.yml";
let ci = fs.readFileSync(ciPath, "utf8");
ci = replaceOrFail(
  ci,
  `      - name: Check extension source\n        working-directory: extension\n        run: npm run check`,
  `      - name: Check mobile dashboard\n        working-directory: mobile\n        run: npm run check\n\n      - name: Test mobile dashboard security\n        working-directory: mobile\n        run: npm test\n\n      - name: Check extension source\n        working-directory: extension\n        run: npm run check`,
  "mobile CI"
);
fs.writeFileSync(ciPath, ci);

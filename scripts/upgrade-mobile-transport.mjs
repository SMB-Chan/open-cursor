import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`transport migration anchor not found: ${label}`);
  return text.replace(from, to);
}

const serverPath = "mobile/server.js";
let server = fs.readFileSync(serverPath, "utf8");
server = replaceOrFail(server,
  'import { createServer } from "node:http";\nimport { readFile } from "node:fs/promises";',
  'import { createServer as createHttpServer } from "node:http";\nimport { createServer as createHttpsServer } from "node:https";\nimport { readFileSync } from "node:fs";\nimport { readFile } from "node:fs/promises";',
  "server imports"
);
server = replaceOrFail(server,
  'const MOBILE_TOKEN = String(process.env.MOBILE_TOKEN || "").trim();\nconst ALLOW_EXEC = parseBoolean(process.env.MOBILE_ALLOW_EXEC, false);',
  'const MOBILE_TOKEN = String(process.env.MOBILE_TOKEN || "").trim();\nconst ALLOW_EXEC = parseBoolean(process.env.MOBILE_ALLOW_EXEC, false);\nconst REMOTE_TRANSPORT = String(process.env.MOBILE_REMOTE_TRANSPORT || "").trim().toLowerCase();\nconst TLS_CERT_FILE = String(process.env.MOBILE_TLS_CERT_FILE || "").trim();\nconst TLS_KEY_FILE = String(process.env.MOBILE_TLS_KEY_FILE || "").trim();',
  "transport constants"
);
server = replaceOrFail(server,
`function validateRuntimeBoundary({ host = HOST, allowRemote = ALLOW_REMOTE, token = MOBILE_TOKEN } = {}) {
  const remote = !LOOPBACK_HOSTS.has(host);
  if (remote && !allowRemote) {
    throw new Error(
      \`Refusing to expose the mobile execution dashboard on \${host} without MOBILE_ALLOW_REMOTE=1\`
    );
  }
  if (remote && Buffer.byteLength(String(token || ""), "utf8") < 32) {
    throw new Error(
      "Remote mobile dashboard access requires MOBILE_TOKEN with at least 32 bytes of entropy"
    );
  }
  return { remote };
}`,
`function resolveRemoteTransport(value, remote) {
  if (!remote) return "local";
  const normalized = String(value || "").trim().toLowerCase();
  if (["tls", "https"].includes(normalized)) return "tls";
  if (["tunnel", "trusted-tunnel", "vpn"].includes(normalized)) return "tunnel";
  throw new Error(
    "Remote mobile access requires MOBILE_REMOTE_TRANSPORT=tls or MOBILE_REMOTE_TRANSPORT=tunnel"
  );
}

function validateTransportConfig({ mode, certFile = TLS_CERT_FILE, keyFile = TLS_KEY_FILE } = {}) {
  if (mode !== "tls") return { mode, certFile: "", keyFile: "" };
  if (!certFile || !keyFile) {
    throw new Error(
      "TLS mobile transport requires both MOBILE_TLS_CERT_FILE and MOBILE_TLS_KEY_FILE"
    );
  }
  return { mode, certFile: resolve(certFile), keyFile: resolve(keyFile) };
}

function validateRuntimeBoundary({
  host = HOST,
  allowRemote = ALLOW_REMOTE,
  token = MOBILE_TOKEN,
  transport = REMOTE_TRANSPORT,
  certFile = TLS_CERT_FILE,
  keyFile = TLS_KEY_FILE,
} = {}) {
  const remote = !LOOPBACK_HOSTS.has(host);
  if (remote && !allowRemote) {
    throw new Error(
      \`Refusing to expose the mobile execution dashboard on \${host} without MOBILE_ALLOW_REMOTE=1\`
    );
  }
  if (remote && Buffer.byteLength(String(token || ""), "utf8") < 32) {
    throw new Error(
      "Remote mobile dashboard access requires MOBILE_TOKEN with at least 32 bytes of entropy"
    );
  }
  const mode = resolveRemoteTransport(transport, remote);
  return { remote, ...validateTransportConfig({ mode, certFile, keyFile }) };
}

function createMobileServer(boundary, handler) {
  if (boundary.mode === "tls") {
    let cert;
    let key;
    try {
      cert = readFileSync(boundary.certFile);
      key = readFileSync(boundary.keyFile);
    } catch (error) {
      throw new Error(\`Unable to read mobile TLS certificate/key: \${error.message}\`);
    }
    return createHttpsServer({ cert, key }, handler);
  }
  return createHttpServer(handler);
}`,
  "runtime boundary"
);
server = replaceOrFail(server,
  '    shellExecutionEnabled: ALLOW_EXEC,\n    uptime: Math.floor(process.uptime()),',
  '    shellExecutionEnabled: ALLOW_EXEC,\n    transport: resolveRemoteTransport(REMOTE_TRANSPORT, !LOOPBACK_HOSTS.has(HOST)),\n    uptime: Math.floor(process.uptime()),',
  "status transport"
);
server = replaceOrFail(server,
  'const server = createServer(async (req, res) => {',
  'async function requestHandler(req, res) {',
  "request handler start"
);
server = replaceOrFail(server,
`  }
});

function startServer() {
  const boundary = validateRuntimeBoundary();
  server.listen(PORT, HOST, () => {
    const ip = getLocalIp();
    const remoteLine = boundary.remote ? \`http://\${ip}:\${PORT}\` : "disabled (localhost only)";`,
`  }
}

function startServer() {
  const boundary = validateRuntimeBoundary();
  const server = createMobileServer(boundary, requestHandler);
  server.listen(PORT, HOST, () => {
    const ip = getLocalIp();
    const scheme = boundary.mode === "tls" ? "https" : "http";
    const remoteLine = boundary.remote ? \`\${scheme}://\${ip}:\${PORT}\` : "disabled (localhost only)";`,
  "server creation"
);
server = replaceOrFail(server,
  '║  Workspace  : ${WORKSPACE_DIR}\n║  Shell exec : ${ALLOW_EXEC ? "ENABLED" : "DISABLED"}',
  '║  Workspace  : ${WORKSPACE_DIR}\n║  Transport  : ${boundary.mode}\n║  Shell exec : ${ALLOW_EXEC ? "ENABLED" : "DISABLED"}',
  "startup transport display"
);
server = replaceOrFail(server,
  '  requireApiAuth,\n  resolveMobileHost,\n  securityHeaders,\n  server,\n  startServer,',
  '  createMobileServer,\n  requireApiAuth,\n  requestHandler,\n  resolveMobileHost,\n  resolveRemoteTransport,\n  securityHeaders,\n  startServer,',
  "exports"
);
server = replaceOrFail(server,
  '  tokenMatches,\n  validateRuntimeBoundary,',
  '  tokenMatches,\n  validateRuntimeBoundary,\n  validateTransportConfig,',
  "transport export"
);
fs.writeFileSync(serverPath, server);

const testPath = "mobile/server.test.js";
let tests = fs.readFileSync(testPath, "utf8");
tests = replaceOrFail(tests,
  '  resolveMobileHost,\n  securityHeaders,',
  '  resolveMobileHost,\n  resolveRemoteTransport,\n  securityHeaders,',
  "test imports 1"
);
tests = replaceOrFail(tests,
  '  tokenMatches,\n  validateRuntimeBoundary,',
  '  tokenMatches,\n  validateRuntimeBoundary,\n  validateTransportConfig,',
  "test imports 2"
);
tests = replaceOrFail(tests,
`  assert.doesNotThrow(() =>
    validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token: "a".repeat(64) })
  );
});`,
`  assert.throws(
    () => validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token: "a".repeat(64) }),
    /MOBILE_REMOTE_TRANSPORT/
  );
  assert.doesNotThrow(() =>
    validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token: "a".repeat(64), transport: "tunnel" })
  );
});

test("remote transport requires TLS or an explicitly trusted encrypted tunnel", () => {
  assert.equal(resolveRemoteTransport("", false), "local");
  assert.equal(resolveRemoteTransport("tls", true), "tls");
  assert.equal(resolveRemoteTransport("https", true), "tls");
  assert.equal(resolveRemoteTransport("tunnel", true), "tunnel");
  assert.equal(resolveRemoteTransport("vpn", true), "tunnel");
  assert.throws(() => resolveRemoteTransport("http", true), /MOBILE_REMOTE_TRANSPORT/);
  assert.throws(() => resolveRemoteTransport("", true), /MOBILE_REMOTE_TRANSPORT/);
});

test("TLS transport requires both certificate and private key paths", () => {
  assert.throws(() => validateTransportConfig({ mode: "tls", certFile: "", keyFile: "" }), /MOBILE_TLS_CERT_FILE/);
  const config = validateTransportConfig({ mode: "tls", certFile: "./cert.pem", keyFile: "./key.pem" });
  assert.equal(config.mode, "tls");
  assert.ok(config.certFile.endsWith("cert.pem"));
  assert.ok(config.keyFile.endsWith("key.pem"));
  assert.deepEqual(validateTransportConfig({ mode: "tunnel" }), { mode: "tunnel", certFile: "", keyFile: "" });
});`,
  "boundary tests"
);
fs.writeFileSync(testPath, tests);

const pkgPath = "mobile/package.json";
let pkg = fs.readFileSync(pkgPath, "utf8");
pkg = replaceOrFail(pkg, '"version": "1.1.0"', '"version": "1.2.0"', "mobile version");
fs.writeFileSync(pkgPath, pkg);

const launcherPath = "bin/open-cursor";
let launcher = fs.readFileSync(launcherPath, "utf8");
launcher = replaceOrFail(launcher,
`MOBILE_ALLOW_EXEC="\${MOBILE_ALLOW_EXEC:-0}"
MOBILE_HOST="\${MOBILE_HOST:-}"
MOBILE_TOKEN="\${MOBILE_TOKEN:-}"`,
`MOBILE_ALLOW_EXEC="\${MOBILE_ALLOW_EXEC:-0}"
MOBILE_HOST="\${MOBILE_HOST:-}"
MOBILE_TOKEN="\${MOBILE_TOKEN:-}"
MOBILE_REMOTE_TRANSPORT="\${MOBILE_REMOTE_TRANSPORT:-}"
MOBILE_TLS_CERT_FILE="\${MOBILE_TLS_CERT_FILE:-}"
MOBILE_TLS_KEY_FILE="\${MOBILE_TLS_KEY_FILE:-}"
MOBILE_PUBLIC_URL="\${MOBILE_PUBLIC_URL:-}"`,
  "launcher vars"
);
launcher = replaceOrFail(launcher,
`if is_true "$MOBILE_ALLOW_REMOTE"; then
  MOBILE_HOST="\${MOBILE_HOST:-0.0.0.0}"
  if [ -z "$MOBILE_TOKEN" ] && [ -r "$MOBILE_TOKEN_FILE" ]; then`,
`if is_true "$MOBILE_ALLOW_REMOTE"; then
  MOBILE_HOST="\${MOBILE_HOST:-0.0.0.0}"
  case "\${MOBILE_REMOTE_TRANSPORT,,}" in
    tls|https)
      MOBILE_REMOTE_TRANSPORT="tls"
      if [ -z "$MOBILE_TLS_CERT_FILE" ] || [ -z "$MOBILE_TLS_KEY_FILE" ]; then
        echo "Error: TLS remote mode requires MOBILE_TLS_CERT_FILE and MOBILE_TLS_KEY_FILE." >&2
        exit 1
      fi
      if [ ! -r "$MOBILE_TLS_CERT_FILE" ] || [ ! -r "$MOBILE_TLS_KEY_FILE" ]; then
        echo "Error: Mobile TLS certificate/key is not readable." >&2
        exit 1
      fi
      MOBILE_SCHEME="https"
      ;;
    tunnel|trusted-tunnel|vpn)
      MOBILE_REMOTE_TRANSPORT="tunnel"
      MOBILE_SCHEME="http"
      ;;
    *)
      echo "Error: Remote mobile access requires MOBILE_REMOTE_TRANSPORT=tls or tunnel." >&2
      exit 1
      ;;
  esac
  if [ -z "$MOBILE_TOKEN" ] && [ -r "$MOBILE_TOKEN_FILE" ]; then`,
  "launcher transport policy"
);
launcher = replaceOrFail(launcher,
`else
  MOBILE_HOST="\${MOBILE_HOST:-127.0.0.1}"
fi

export MOBILE_ALLOW_REMOTE MOBILE_ALLOW_EXEC MOBILE_HOST MOBILE_TOKEN`,
`else
  MOBILE_HOST="\${MOBILE_HOST:-127.0.0.1}"
  MOBILE_REMOTE_TRANSPORT=""
  MOBILE_SCHEME="http"
fi

export MOBILE_ALLOW_REMOTE MOBILE_ALLOW_EXEC MOBILE_HOST MOBILE_TOKEN MOBILE_REMOTE_TRANSPORT
export MOBILE_TLS_CERT_FILE MOBILE_TLS_KEY_FILE`,
  "launcher transport export"
);
launcher = replaceOrFail(launcher,
`is_mobile_running() {
  curl -sf --connect-timeout 1 "$MOBILE_URL/healthz" >/dev/null 2>&1
}`,
`is_mobile_running() {
  if [ "\${MOBILE_SCHEME:-http}" = "https" ]; then
    curl -ksf --connect-timeout 1 "https://127.0.0.1:$MOBILE_PORT/healthz" >/dev/null 2>&1
  else
    curl -sf --connect-timeout 1 "http://127.0.0.1:$MOBILE_PORT/healthz" >/dev/null 2>&1
  fi
}`,
  "launcher mobile health"
);
launcher = replaceOrFail(launcher,
`if is_true "$MOBILE_ALLOW_REMOTE"; then
  echo -e "  \${GREEN}\${BOLD}📱 Mobile Web:\${NC} http://\${LOCAL_IP}:\${MOBILE_PORT}/#token=\${MOBILE_TOKEN}"
  echo -e "  \${YELLOW}Pairing token is a secret; use only on a trusted LAN or encrypted tunnel.\${NC}"`,
`if is_true "$MOBILE_ALLOW_REMOTE"; then
  if [ -n "$MOBILE_PUBLIC_URL" ]; then
    MOBILE_PAIRING_BASE="\${MOBILE_PUBLIC_URL%/}"
  else
    MOBILE_PAIRING_BASE="\${MOBILE_SCHEME}://\${LOCAL_IP}:\${MOBILE_PORT}"
  fi
  echo -e "  \${GREEN}\${BOLD}📱 Mobile Web:\${NC} \${MOBILE_PAIRING_BASE}/#token=\${MOBILE_TOKEN}"
  echo -e "  \${CYAN}Transport:\${NC} \${MOBILE_REMOTE_TRANSPORT}"
  echo -e "  \${YELLOW}Pairing token is a secret; remote mode requires TLS or an encrypted trusted tunnel.\${NC}"`,
  "launcher pairing URL"
);
launcher = replaceOrFail(launcher,
`  echo -e "  \${CYAN}Remote opt-in:\${NC} MOBILE_ALLOW_REMOTE=1 $BRIDGE_DIR/bin/open-cursor"`,
`  echo -e "  \${CYAN}Remote opt-in:\${NC} MOBILE_ALLOW_REMOTE=1 MOBILE_REMOTE_TRANSPORT=tls|tunnel $BRIDGE_DIR/bin/open-cursor"`,
  "launcher remote hint"
);
fs.writeFileSync(launcherPath, launcher);

const readmePath = "README.md";
let readme = fs.readFileSync(readmePath, "utf8");
const oldSection = `To opt in to phone/tablet access on a trusted LAN:

\`\`\`bash
MOBILE_ALLOW_REMOTE=1 ~/.cursor-codex-bridge/bin/open-cursor
\`\`\`

The launcher creates a 256-bit pairing token in \`~/.cursor-codex-bridge/mobile.token\` with mode \`0600\` and prints a pairing URL using \`#token=...\`. URL fragments are not sent in HTTP requests; the browser moves the token into session storage and sends it only in a Bearer authorization header.

Arbitrary remote shell execution is a separate high-trust opt-in and remains disabled by default:

\`\`\`bash
MOBILE_ALLOW_REMOTE=1 MOBILE_ALLOW_EXEC=1 ~/.cursor-codex-bridge/bin/open-cursor
\`\`\`

The dashboard uses plain HTTP. LAN mode should only be used on a trusted network or through an encrypted tunnel/VPN, and port 9880 must not be forwarded directly to the public Internet.`;
const newSection = `Remote access requires **both authentication and a protected transport**. \`MOBILE_ALLOW_REMOTE=1\` by itself now fails closed.

Native HTTPS mode:

\`\`\`bash
MOBILE_ALLOW_REMOTE=1 \\
MOBILE_REMOTE_TRANSPORT=tls \\
MOBILE_TLS_CERT_FILE=/path/to/fullchain.pem \\
MOBILE_TLS_KEY_FILE=/path/to/privkey.pem \\
~/.cursor-codex-bridge/bin/open-cursor
\`\`\`

The certificate must be trusted by the phone/tablet and valid for the hostname or IP used in the pairing URL.

Encrypted overlay/tunnel mode (for example Tailscale, a VPN, or an SSH/reverse-proxy tunnel):

\`\`\`bash
MOBILE_ALLOW_REMOTE=1 \\
MOBILE_REMOTE_TRANSPORT=tunnel \\
MOBILE_HOST=100.x.y.z \\
~/.cursor-codex-bridge/bin/open-cursor
\`\`\`

In \`tunnel\` mode Open-Cursor serves HTTP only inside the transport you explicitly declared trusted. The tunnel/VPN is responsible for encryption and peer authentication. Use \`MOBILE_PUBLIC_URL\` when the externally reachable tunnel URL differs from the local bind address.

The launcher creates a 256-bit pairing token in \`~/.cursor-codex-bridge/mobile.token\` with mode \`0600\` and prints a pairing URL using \`#token=...\`. URL fragments are not sent in HTTP requests; the browser moves the token into session storage and sends it only in a Bearer authorization header.

Arbitrary shell execution is a separate high-trust opt-in and remains disabled by default:

\`\`\`bash
MOBILE_ALLOW_REMOTE=1 \\
MOBILE_REMOTE_TRANSPORT=tunnel \\
MOBILE_ALLOW_EXEC=1 \\
~/.cursor-codex-bridge/bin/open-cursor
\`\`\`

Do not expose port 9880 directly to an untrusted network. A pairing token does not make plaintext HTTP safe against an active network attacker because the dashboard JavaScript itself could otherwise be modified in transit.`;
readme = replaceOrFail(readme, oldSection, newSection, "README transport section");
fs.writeFileSync(readmePath, readme);

console.log("secure mobile transport migration applied");

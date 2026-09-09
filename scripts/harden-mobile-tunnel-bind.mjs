import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`tunnel hardening anchor not found: ${label}`);
  return text.replace(from, to);
}

const serverPath = "mobile/server.js";
let server = fs.readFileSync(serverPath, "utf8");
server = replaceOrFail(
  server,
  'const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);',
  'const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);\nconst WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);',
  "wildcard host set"
);
server = replaceOrFail(
  server,
`  const remote = !LOOPBACK_HOSTS.has(host);
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
  return { remote, ...validateTransportConfig({ mode, certFile, keyFile }) };`,
`  const externallyBound = !LOOPBACK_HOSTS.has(host);
  if (externallyBound && !allowRemote) {
    throw new Error(
      \`Refusing to expose the mobile execution dashboard on \${host} without MOBILE_ALLOW_REMOTE=1\`
    );
  }
  if (allowRemote && Buffer.byteLength(String(token || ""), "utf8") < 32) {
    throw new Error(
      "Remote mobile dashboard access requires MOBILE_TOKEN with at least 32 bytes of entropy"
    );
  }
  const mode = resolveRemoteTransport(transport, allowRemote);
  if (mode === "tunnel" && WILDCARD_HOSTS.has(host)) {
    throw new Error(
      "Tunnel transport requires a specific MOBILE_HOST (VPN/overlay IP or loopback), not a wildcard bind"
    );
  }
  return {
    remote: allowRemote,
    externallyBound,
    ...validateTransportConfig({ mode, certFile, keyFile }),
  };`,
  "runtime boundary semantics"
);
server = replaceOrFail(
  server,
  '    remote: !LOOPBACK_HOSTS.has(HOST),\n    shellExecutionEnabled: ALLOW_EXEC,\n    transport: resolveRemoteTransport(REMOTE_TRANSPORT, !LOOPBACK_HOSTS.has(HOST)),',
  '    remote: ALLOW_REMOTE,\n    externallyBound: !LOOPBACK_HOSTS.has(HOST),\n    shellExecutionEnabled: ALLOW_EXEC,\n    transport: resolveRemoteTransport(REMOTE_TRANSPORT, ALLOW_REMOTE),',
  "status boundary semantics"
);
fs.writeFileSync(serverPath, server);

const testPath = "mobile/server.test.js";
let tests = fs.readFileSync(testPath, "utf8");
const marker = 'test("tunnel transport rejects wildcard binds that would leak plaintext to the LAN"';
if (!tests.includes(marker)) {
  tests += `\n\ntest("tunnel transport rejects wildcard binds that would leak plaintext to the LAN", () => {\n  const token = "a".repeat(64);\n  assert.throws(\n    () => validateRuntimeBoundary({ host: "0.0.0.0", allowRemote: true, token, transport: "tunnel" }),\n    /specific MOBILE_HOST/\n  );\n  assert.doesNotThrow(() =>\n    validateRuntimeBoundary({ host: "100.64.0.10", allowRemote: true, token, transport: "tunnel" })\n  );\n  assert.doesNotThrow(() =>\n    validateRuntimeBoundary({ host: "127.0.0.1", allowRemote: true, token, transport: "tunnel" })\n  );\n});\n\ntest("TLS transport may bind all interfaces because the application transport is encrypted", () => {\n  assert.doesNotThrow(() =>\n    validateRuntimeBoundary({\n      host: "0.0.0.0",\n      allowRemote: true,\n      token: "a".repeat(64),\n      transport: "tls",\n      certFile: "./cert.pem",\n      keyFile: "./key.pem",\n    })\n  );\n});\n`;
}
fs.writeFileSync(testPath, tests);

const launcherPath = "bin/open-cursor";
let launcher = fs.readFileSync(launcherPath, "utf8");
launcher = replaceOrFail(
  launcher,
`if is_true "$MOBILE_ALLOW_REMOTE"; then
  MOBILE_HOST="\${MOBILE_HOST:-0.0.0.0}"
  case "\${MOBILE_REMOTE_TRANSPORT,,}" in
    tls|https)
      MOBILE_REMOTE_TRANSPORT="tls"`,
`if is_true "$MOBILE_ALLOW_REMOTE"; then
  case "\${MOBILE_REMOTE_TRANSPORT,,}" in
    tls|https)
      MOBILE_REMOTE_TRANSPORT="tls"
      MOBILE_HOST="\${MOBILE_HOST:-0.0.0.0}"`,
  "launcher transport host default"
);
launcher = replaceOrFail(
  launcher,
`    tunnel|trusted-tunnel|vpn)
      MOBILE_REMOTE_TRANSPORT="tunnel"
      MOBILE_SCHEME="http"
      ;;`,
`    tunnel|trusted-tunnel|vpn)
      MOBILE_REMOTE_TRANSPORT="tunnel"
      if [ -z "$MOBILE_HOST" ]; then
        echo "Error: Tunnel remote mode requires an explicit MOBILE_HOST (VPN/overlay IP or loopback)." >&2
        exit 1
      fi
      case "$MOBILE_HOST" in
        0.0.0.0|::|"[::]")
          echo "Error: Tunnel mode refuses wildcard MOBILE_HOST because it would expose plaintext HTTP outside the tunnel." >&2
          exit 1
          ;;
        127.0.0.1|localhost|::1)
          if [ -z "$MOBILE_PUBLIC_URL" ]; then
            echo "Error: Loopback tunnel mode requires MOBILE_PUBLIC_URL for the externally reachable tunnel/proxy URL." >&2
            exit 1
          fi
          ;;
      esac
      MOBILE_SCHEME="http"
      ;;`,
  "launcher tunnel policy"
);
launcher = replaceOrFail(
  launcher,
`      MOBILE_SCHEME="https"
      ;;`,
`      if [ -n "$MOBILE_PUBLIC_URL" ] && [[ "$MOBILE_PUBLIC_URL" != https://* ]]; then
        echo "Error: MOBILE_PUBLIC_URL must use https:// when MOBILE_REMOTE_TRANSPORT=tls." >&2
        exit 1
      fi
      MOBILE_SCHEME="https"
      ;;`,
  "launcher TLS public URL policy"
);
launcher = replaceOrFail(
  launcher,
`is_mobile_running() {
  if [ "\${MOBILE_SCHEME:-http}" = "https" ]; then
    curl -ksf --connect-timeout 1 "https://127.0.0.1:$MOBILE_PORT/healthz" >/dev/null 2>&1
  else
    curl -sf --connect-timeout 1 "http://127.0.0.1:$MOBILE_PORT/healthz" >/dev/null 2>&1
  fi
}`,
`is_mobile_running() {
  local health_host="\${MOBILE_HOST:-127.0.0.1}"
  case "$health_host" in
    0.0.0.0) health_host="127.0.0.1" ;;
    ::|"[::]") health_host="[::1]" ;;
    ::1) health_host="[::1]" ;;
  esac
  if [ "\${MOBILE_SCHEME:-http}" = "https" ]; then
    curl -ksf --connect-timeout 1 "https://$health_host:$MOBILE_PORT/healthz" >/dev/null 2>&1
  else
    curl -sf --connect-timeout 1 "http://$health_host:$MOBILE_PORT/healthz" >/dev/null 2>&1
  fi
}`,
  "launcher health host"
);
fs.writeFileSync(launcherPath, launcher);

const readmePath = "README.md";
let readme = fs.readFileSync(readmePath, "utf8");
readme = replaceOrFail(
  readme,
  'MOBILE_REMOTE_TRANSPORT=tunnel \\\nMOBILE_HOST=100.x.y.z \\\n~/.cursor-codex-bridge/bin/open-cursor',
  'MOBILE_REMOTE_TRANSPORT=tunnel \\\nMOBILE_HOST=100.x.y.z \\\n~/.cursor-codex-bridge/bin/open-cursor',
  "README tunnel example"
);
const tunnelSentence = 'In `tunnel` mode Open-Cursor serves HTTP only inside the transport you explicitly declared trusted. The tunnel/VPN is responsible for encryption and peer authentication. Use `MOBILE_PUBLIC_URL` when the externally reachable tunnel URL differs from the local bind address.';
const replacement = tunnelSentence + ' Tunnel mode refuses wildcard binds such as `0.0.0.0`; bind a specific VPN/overlay address, or bind `127.0.0.1` behind a reverse proxy and set `MOBILE_PUBLIC_URL`.';
readme = replaceOrFail(readme, tunnelSentence, replacement, "README tunnel wildcard warning");
fs.writeFileSync(readmePath, readme);

console.log("mobile tunnel bind hardening applied");

import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { exec, execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.MOBILE_PORT || 9880);
const ALLOW_REMOTE = parseBoolean(process.env.MOBILE_ALLOW_REMOTE, false);
const HOST = resolveMobileHost(process.env.MOBILE_HOST, ALLOW_REMOTE);
const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:9876";
const WORKSPACE_DIR = resolve(
  process.env.WORKSPACE_DIR || process.env.OPEN_CURSOR_WORKSPACE || dirname(__dirname)
);
const MOBILE_TOKEN = String(process.env.MOBILE_TOKEN || "").trim();
const ALLOW_EXEC = parseBoolean(process.env.MOBILE_ALLOW_EXEC, false);
const REMOTE_TRANSPORT = String(process.env.MOBILE_REMOTE_TRANSPORT || "").trim().toLowerCase();
const TLS_CERT_FILE = String(process.env.MOBILE_TLS_CERT_FILE || "").trim();
const TLS_KEY_FILE = String(process.env.MOBILE_TLS_KEY_FILE || "").trim();
const MAX_BODY_BYTES = boundedInteger(process.env.MOBILE_MAX_BODY_BYTES, 256 * 1024, 1024, 2 * 1024 * 1024);
const MAX_COMMAND_CHARS = boundedInteger(process.env.MOBILE_MAX_COMMAND_CHARS, 8192, 64, 32768);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD_HOSTS = new Set(["0.0.0.0", "::", "[::]"]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function resolveMobileHost(configuredHost, allowRemote) {
  const configured = String(configuredHost || "").trim();
  if (configured) return configured;
  return allowRemote ? "0.0.0.0" : "127.0.0.1";
}

function resolveRemoteTransport(value, remote) {
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
  const externallyBound = !LOOPBACK_HOSTS.has(host);
  if (externallyBound && !allowRemote) {
    throw new Error(
      `Refusing to expose the mobile execution dashboard on ${host} without MOBILE_ALLOW_REMOTE=1`
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
  };
}

function createMobileServer(boundary, handler) {
  if (boundary.mode === "tls") {
    let cert;
    let key;
    try {
      cert = readFileSync(boundary.certFile);
      key = readFileSync(boundary.keyFile);
    } catch (error) {
      throw new Error(`Unable to read mobile TLS certificate/key: ${error.message}`);
    }
    return createHttpsServer({ cert, key }, handler);
  }
  return createHttpServer(handler);
}

function bearerToken(req) {
  const header = typeof req?.headers?.authorization === "string" ? req.headers.authorization : "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

function tokenMatches(candidate, expected) {
  if (!expected) return true;
  if (!candidate) return false;
  const left = Buffer.from(String(candidate), "utf8");
  const right = Buffer.from(String(expected), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function isAuthorized(req, expectedToken = MOBILE_TOKEN) {
  return tokenMatches(bearerToken(req), expectedToken);
}

function securityHeaders(contentType) {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), geolocation=(), payment=()",
  };
}

function sendJSON(res, status, data, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function requireApiAuth(req, res) {
  if (isAuthorized(req)) return true;
  sendJSON(
    res,
    401,
    { ok: false, error: "Mobile API authentication required" },
    { "WWW-Authenticate": 'Bearer realm="open-cursor-mobile"' }
  );
  return false;
}

async function readBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) {
      throw new HttpError(413, `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "Request body must be valid JSON");
  }
}

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    cwd: WORKSPACE_DIR,
    maxBuffer: options.maxBuffer || 1024 * 1024,
    timeout: options.timeout || 5000,
  });
}

async function handleStatus(req, res) {
  let bridgeHealth = { status: "unknown" };
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    bridgeHealth = await bridgeRes.json();
  } catch (error) {
    bridgeHealth = { status: "offline", error: error.message };
  }

  let gitInfo = { branch: "unknown", dirty: 0, files: [] };
  try {
    const { stdout: branch } = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const { stdout: status } = await git(["status", "--porcelain"]);
    const dirtyFiles = status.trim() ? status.trim().split("\n").map((line) => line.trim()) : [];
    gitInfo = {
      branch: branch.trim(),
      dirty: dirtyFiles.length,
      files: dirtyFiles.slice(0, 10),
    };
  } catch {}

  sendJSON(res, 200, {
    ok: true,
    bridge: bridgeHealth,
    git: gitInfo,
    localIp: getLocalIp(),
    port: PORT,
    workspace: WORKSPACE_DIR,
    remote: ALLOW_REMOTE,
    externallyBound: !LOOPBACK_HOSTS.has(HOST),
    shellExecutionEnabled: ALLOW_EXEC,
    transport: resolveRemoteTransport(REMOTE_TRANSPORT, ALLOW_REMOTE),
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

async function handleGit(req, res) {
  try {
    const [branchRes, statusRes, logRes, diffRes] = await Promise.allSettled([
      git(["rev-parse", "--abbrev-ref", "HEAD"]),
      git(["status", "-s"]),
      git(["log", "-n", "8", "--pretty=format:%h|%an|%cr|%s"]),
      git(["diff", "HEAD"], { maxBuffer: 1024 * 1024 }),
    ]);

    const commits = (logRes.status === "fulfilled" ? logRes.value.stdout : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [hash = "", author = "", date = "", ...messageParts] = line.split("|");
        return { hash, author, date, message: messageParts.join("|") };
      });

    sendJSON(res, 200, {
      ok: true,
      branch: branchRes.status === "fulfilled" ? branchRes.value.stdout.trim() : "unknown",
      status: statusRes.status === "fulfilled" ? statusRes.value.stdout.trim() : "",
      commits,
      diff: diffRes.status === "fulfilled" ? diffRes.value.stdout : "",
    });
  } catch (error) {
    sendJSON(res, 500, { ok: false, error: error.message });
  }
}

async function handleExec(req, res) {
  if (!ALLOW_EXEC) {
    return sendJSON(res, 403, {
      ok: false,
      error: "Remote shell execution is disabled. Set MOBILE_ALLOW_EXEC=1 explicitly to enable it.",
    });
  }

  const body = await readBody(req);
  const command = typeof body.command === "string" ? body.command.trim() : "";
  if (!command) return sendJSON(res, 400, { ok: false, error: "Command is required" });
  if (command.length > MAX_COMMAND_CHARS) {
    return sendJSON(res, 413, { ok: false, error: "Command exceeds configured length limit" });
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKSPACE_DIR,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    });
    sendJSON(res, 200, { ok: true, stdout, stderr, code: 0 });
  } catch (error) {
    sendJSON(res, 200, {
      ok: false,
      stdout: error.stdout || "",
      stderr: error.stderr || error.message,
      code: Number.isInteger(error.code) ? error.code : 1,
    });
  }
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const model = typeof body.model === "string" ? body.model : "auto";
  const prompt = typeof body.prompt === "string" ? body.prompt : "";

  if (!prompt.trim()) return sendJSON(res, 400, { ok: false, error: "Prompt is required" });

  res.writeHead(200, {
    ...securityHeaders("text/event-stream; charset=utf-8"),
    "Cache-Control": "no-cache, no-store, no-transform",
    Connection: "keep-alive",
  });

  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded && !controller.signal.aborted) controller.abort();
  };
  res.once("close", onClose);

  try {
    const upstreamRes = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Path": WORKSPACE_DIR,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        stream: true,
      }),
      signal: controller.signal,
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text();
      res.write(`data: ${JSON.stringify({ error: errText })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }

    const reader = upstreamRes.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    const tail = decoder.decode();
    if (tail) res.write(tail);
    res.end();
  } catch (error) {
    if (!res.writableEnded && !res.destroyed) {
      res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } finally {
    res.removeListener("close", onClose);
  }
}

function serveStatic(res, contentType, content) {
  res.writeHead(200, {
    ...securityHeaders(contentType),
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  res.end(content);
}

async function requestHandler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { Allow: "GET, POST, OPTIONS", ...securityHeaders() });
    return res.end();
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === "/healthz" && req.method === "GET") {
      return sendJSON(res, 200, { status: "ok" });
    }

    if (url.pathname.startsWith("/api/") && !requireApiAuth(req, res)) return;

    if (url.pathname === "/api/status" && req.method === "GET") {
      await handleStatus(req, res);
    } else if (url.pathname === "/api/git" && req.method === "GET") {
      await handleGit(req, res);
    } else if (url.pathname === "/api/exec" && req.method === "POST") {
      await handleExec(req, res);
    } else if (url.pathname === "/api/chat" && req.method === "POST") {
      await handleChat(req, res);
    } else if (url.pathname === "/manifest.json" && req.method === "GET") {
      const content = await readFile(join(__dirname, "public", "manifest.json"), "utf8");
      serveStatic(res, "application/manifest+json; charset=utf-8", content);
    } else if ((url.pathname === "/" || url.pathname === "/index.html") && req.method === "GET") {
      const content = await readFile(join(__dirname, "public", "index.html"), "utf8");
      serveStatic(res, "text/html; charset=utf-8", content);
    } else {
      res.writeHead(404, securityHeaders("text/plain; charset=utf-8"));
      res.end("Not Found");
    }
  } catch (error) {
    const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
    console.error("Error serving request:", error?.message || error);
    if (!res.headersSent) {
      sendJSON(res, status, {
        ok: false,
        error: status >= 500 ? "Internal server error" : error.message,
      });
    }
  }
}

function startServer() {
  const boundary = validateRuntimeBoundary();
  const server = createMobileServer(boundary, requestHandler);
  server.listen(PORT, HOST, () => {
    const ip = getLocalIp();
    const scheme = boundary.mode === "tls" ? "https" : "http";
    const remoteLine = boundary.remote ? `${scheme}://${ip}:${PORT}` : "disabled (localhost only)";
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║             Open-Cursor Mobile Web Dashboard                 ║
║       authenticated local companion for Open-Cursor          ║
╠══════════════════════════════════════════════════════════════╣
║  Local URL  : http://127.0.0.1:${PORT}
║  Remote URL : ${remoteLine}
║  Bridge     : ${BRIDGE_URL}
║  Workspace  : ${WORKSPACE_DIR}
║  Transport  : ${boundary.mode}
║  Shell exec : ${ALLOW_EXEC ? "ENABLED" : "DISABLED"}
╚══════════════════════════════════════════════════════════════╝
`);
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    startServer();
  } catch (error) {
    console.error(`[open-cursor-mobile] ${error.message}`);
    process.exit(1);
  }
}

export {
  HttpError,
  bearerToken,
  isAuthorized,
  parseBoolean,
  readBody,
  createMobileServer,
  requireApiAuth,
  requestHandler,
  resolveMobileHost,
  resolveRemoteTransport,
  securityHeaders,
  startServer,
  tokenMatches,
  validateRuntimeBoundary,
  validateTransportConfig,
};

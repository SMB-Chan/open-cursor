import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { networkInterfaces } from "node:os";

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MOBILE_PORT || 9880);
const HOST = "0.0.0.0";
const BRIDGE_URL = process.env.BRIDGE_URL || "http://127.0.0.1:9876";
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || dirname(__dirname);

function getLocalIp() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "127.0.0.1";
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

async function handleStatus(req, res) {
  let bridgeHealth = { status: "unknown" };
  try {
    const bridgeRes = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
    bridgeHealth = await bridgeRes.json();
  } catch (err) {
    bridgeHealth = { status: "offline", error: err.message };
  }

  let gitInfo = { branch: "unknown", dirty: 0, files: [] };
  try {
    const { stdout: branch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: WORKSPACE_DIR });
    const { stdout: status } = await execAsync("git status --porcelain", { cwd: WORKSPACE_DIR });
    const dirtyFiles = status.trim() ? status.trim().split("\n").map(l => l.trim()) : [];
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
    uptime: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
}

async function handleGit(req, res) {
  try {
    const [branchRes, statusRes, logRes, diffRes] = await Promise.allSettled([
      execAsync("git rev-parse --abbrev-ref HEAD", { cwd: WORKSPACE_DIR }),
      execAsync("git status -s", { cwd: WORKSPACE_DIR }),
      execAsync("git log -n 8 --pretty=format:'%h|%an|%cr|%s'", { cwd: WORKSPACE_DIR }),
      execAsync("git diff HEAD", { cwd: WORKSPACE_DIR, maxBuffer: 1024 * 1024 }),
    ]);

    const commits = (logRes.status === "fulfilled" ? logRes.value.stdout : "")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => {
        const [hash, author, date, message] = line.split("|");
        return { hash, author, date, message };
      });

    sendJSON(res, 200, {
      ok: true,
      branch: branchRes.status === "fulfilled" ? branchRes.value.stdout.trim() : "unknown",
      status: statusRes.status === "fulfilled" ? statusRes.value.stdout.trim() : "",
      commits,
      diff: diffRes.status === "fulfilled" ? diffRes.value.stdout : "",
    });
  } catch (err) {
    sendJSON(res, 500, { ok: false, error: err.message });
  }
}

async function handleExec(req, res) {
  const body = await readBody(req);
  const command = (body.command || "").trim();

  if (!command) {
    return sendJSON(res, 400, { ok: false, error: "Command is required" });
  }

  // Basic guard against destructive commands outside workspace
  const forbidden = [/\brm\s+-rf\s+\/($|\s)/, /\bmkfs\b/, /\bdd\b/];
  for (const re of forbidden) {
    if (re.test(command)) {
      return sendJSON(res, 403, { ok: false, error: "Command not permitted for security" });
    }
  }

  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: WORKSPACE_DIR,
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    });
    sendJSON(res, 200, { ok: true, stdout, stderr, code: 0 });
  } catch (err) {
    sendJSON(res, 200, {
      ok: false,
      stdout: err.stdout || "",
      stderr: err.stderr || err.message,
      code: err.code || 1,
    });
  }
}

async function handleChat(req, res) {
  const body = await readBody(req);
  const { model = "auto", prompt = "" } = body;

  if (!prompt.trim()) {
    return sendJSON(res, 400, { ok: false, error: "Prompt is required" });
  }

  // Set up SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const controller = new AbortController();
  req.on("close", () => controller.abort());

  try {
    const upstreamRes = await fetch(`${BRIDGE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Workspace-Path": encodeURI(WORKSPACE_DIR),
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
      const text = decoder.decode(value, { stream: true });
      res.write(text);
    }
    res.end();
  } catch (err) {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  }
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  try {
    if (url.pathname === "/api/status" && req.method === "GET") {
      await handleStatus(req, res);
    } else if (url.pathname === "/api/git" && req.method === "GET") {
      await handleGit(req, res);
    } else if (url.pathname === "/api/exec" && req.method === "POST") {
      await handleExec(req, res);
    } else if (url.pathname === "/api/chat" && req.method === "POST") {
      await handleChat(req, res);
    } else if (url.pathname === "/manifest.json" && req.method === "GET") {
      const manifestPath = join(__dirname, "public", "manifest.json");
      const content = await readFile(manifestPath, "utf-8");
      res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8" });
      res.end(content);
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      const htmlPath = join(__dirname, "public", "index.html");
      const content = await readFile(htmlPath, "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(content);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  } catch (err) {
    console.error("Error serving request:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }
});

server.listen(PORT, HOST, () => {
  const ip = getLocalIp();
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║             Open-Cursor Mobile Web Dashboard                 ║
║       スマートフォン・タブレットから確認・実行が可能            ║
╠══════════════════════════════════════════════════════════════╣
║  ローカルURL : http://127.0.0.1:${PORT}
║  モバイルURL : http://${ip}:${PORT}
║  ブリッジ接続 : ${BRIDGE_URL}
║  作業ディレクトリ: ${WORKSPACE_DIR}
╚══════════════════════════════════════════════════════════════╝
`);
});

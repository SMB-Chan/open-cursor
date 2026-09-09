#!/usr/bin/env node
/**
 * Open-Cursor Multi-Agent Bridge
 *
 * 課金なしのマルチLLM協調コーディングプロキシ
 * - Codex CLI (ChatGPT subscription, OAuth)
 * - Antigravity CLI (Gemini AI Pro subscription, Google OAuth)
 *
 * Zero billing APIs. Both use subscription-included access.
 * Survives Cursor updates by living in ~/.cursor-codex-bridge/
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const PORT = parseInt(process.env.BRIDGE_PORT || "9876", 10);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const AGY_BIN = process.env.AGY_BIN || join(homedir(), ".local/bin/agy");
const CODEX_HOME = join(homedir(), ".codex");
const GEMINI_HOME = join(homedir(), ".gemini");
const MAX_BODY_BYTES = parseInt(process.env.BRIDGE_MAX_BODY_BYTES || "1048576", 10);
const ROUTING_MODES = new Set(["codex", "antigravity", "collaborative", "pipeline"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

// ── Agent Registry ──────────────────────────────────────────────

const AGENTS = {
  codex: {
    name: "Codex (OpenAI/ChatGPT)",
    bin: CODEX_BIN,
    authCheck: async () => {
      try {
        await readFile(join(CODEX_HOME, "auth.json"), "utf-8");
        return true;
      } catch {
        return false;
      }
    },
    strengths: ["code-generation", "refactoring", "debugging", "git-operations"],
  },
  antigravity: {
    name: "Antigravity (Gemini AI Pro)",
    bin: AGY_BIN,
    authCheck: async () => {
      try {
        const s = await readFile(join(GEMINI_HOME, "antigravity-cli/settings.json"), "utf-8");
        const d = JSON.parse(s);
        return !d.useG1Credits; // true = using subscription, not credits
      } catch {
        return false;
      }
    },
    strengths: ["analysis", "architecture", "research", "multimodal", "web-search"],
  },
};

const activeProcesses = new Set();

// ── Codex CLI runner ────────────────────────────────────────────

async function getCodexModel() {
  try {
    const config = await readFile(join(CODEX_HOME, "config.toml"), "utf-8");
    const match = config.match(/^model\s*=\s*"([^"]+)"/m);
    return match ? match[1] : "auto";
  } catch {
    return "auto";
  }
}

function runCodex(prompt, { cwd, model }) {
  return new Promise((resolvePromise, reject) => {
    const args = ["exec"];
    if (model) args.push("-m", model);
    args.push(
      "-C",
      cwd || process.cwd(),
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "never",
      "--output-format",
      "text",
      prompt
    );

    const child = spawn(CODEX_BIN, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, CODEX_HOME, OPENAI_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      activeProcesses.delete(child);
      resolvePromise({ content: stdout.trim() || stderr.trim(), agent: "codex", code });
    });
    child.on("error", (e) => {
      activeProcesses.delete(child);
      reject(e);
    });
  });
}

// ── Antigravity CLI runner ──────────────────────────────────────

function runAntigravity(prompt, { cwd, model }) {
  return new Promise((resolvePromise, reject) => {
    const args = [`-p=${prompt}`, "--output-format", "text", "--dangerously-skip-permissions"];
    if (model) args.push("--model", model);

    const child = spawn(AGY_BIN, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, GEMINI_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      activeProcesses.delete(child);
      resolvePromise({ content: stdout.trim() || stderr.trim(), agent: "antigravity", code });
    });
    child.on("error", (e) => {
      activeProcesses.delete(child);
      reject(e);
    });
  });
}

// ── Antigravity agentapi runner (sub-agent mode) ────────────────

function runAntigravityAgent(prompt, { cwd, model }) {
  return new Promise((resolvePromise, reject) => {
    const args = ["agentapi", "new-conversation", "--title", "bridge-task"];
    if (model) args.push(`--model=${model}`);
    args.push(prompt);

    const child = spawn(AGY_BIN, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, GEMINI_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      activeProcesses.delete(child);
      let content = stdout.trim();
      try {
        const parsed = JSON.parse(content);
        if (parsed.response) content = parsed.response;
        if (parsed.content) content = parsed.content;
      } catch {}
      resolvePromise({ content: content || stderr.trim(), agent: "antigravity-agentapi", code });
    });
    child.on("error", (e) => {
      activeProcesses.delete(child);
      reject(e);
    });
  });
}

// ── Orchestrator: Multi-Agent Task Router ───────────────────────

/**
 * Routes tasks to the optimal agent based on task analysis.
 * For collaborative tasks, runs both agents and merges results.
 */
async function orchestrate(prompt, { cwd, mode, model }) {
  const taskType = analyzeTask(prompt);

  switch (mode || taskType.routing) {
    case "codex":
      return runCodex(prompt, { cwd, model });

    case "antigravity":
      return runAntigravity(prompt, { cwd, model });

    case "collaborative": {
      const [codexResult, geminiResult] = await Promise.all([
        runCodex(prompt, { cwd }).catch((e) => ({
          content: `[Codex error: ${e.message}]`,
          agent: "codex",
          code: 1,
        })),
        runAntigravity(prompt, { cwd }).catch((e) => ({
          content: `[Antigravity error: ${e.message}]`,
          agent: "antigravity",
          code: 1,
        })),
      ]);

      return {
        content: formatCollaborativeResult(codexResult, geminiResult),
        agent: "collaborative",
        code: codexResult.code === 0 || geminiResult.code === 0 ? 0 : 1,
      };
    }

    case "pipeline": {
      const analysis = await runAntigravity(
        `Analyze this task and provide a detailed implementation plan:\n${prompt}`,
        { cwd, model: "pro" }
      );

      const implementation = await runCodex(
        `Based on this analysis, implement the solution:\n\n${analysis.content}\n\nOriginal task:\n${prompt}`,
        { cwd }
      );

      return {
        content: `## Analysis (Gemini/Antigravity)\n${analysis.content}\n\n## Implementation (Codex/GPT)\n${implementation.content}`,
        agent: "pipeline",
        code: implementation.code,
      };
    }

    default:
      return runCodex(prompt, { cwd, model });
  }
}

function analyzeTask(prompt) {
  const p = prompt.toLowerCase();

  if (/\b(analyze|research|explain|review|audit|compare|survey|study)\b/.test(p)) {
    return { routing: "antigravity", reason: "analysis task" };
  }

  if (/\b(implement|create|build|write|fix|debug|refactor|deploy)\b/.test(p)) {
    return { routing: "codex", reason: "implementation task" };
  }

  if (prompt.length > 500 || /\b(and then|after|also|additionally|furthermore)\b/.test(p)) {
    return { routing: "collaborative", reason: "complex multi-step task" };
  }

  return { routing: "collaborative", reason: "general task" };
}

function formatCollaborativeResult(codexResult, geminiResult) {
  const sections = [];

  if (geminiResult.content && !geminiResult.content.startsWith("[")) {
    sections.push(`### Gemini Analysis\n${geminiResult.content}`);
  }

  if (codexResult.content && !codexResult.content.startsWith("[")) {
    sections.push(`### Codex Implementation\n${codexResult.content}`);
  }

  if (sections.length === 0) {
    return codexResult.content || geminiResult.content || "Both agents returned empty responses.";
  }

  return sections.join("\n\n---\n\n");
}

// ── Request validation ──────────────────────────────────────────

function parseAgentSelection(modelName, headerMode) {
  const requestedModel = typeof modelName === "string" ? modelName.trim() : "";
  const requestedMode = typeof headerMode === "string" ? headerMode.trim().toLowerCase() : "";

  if (requestedMode && !ROUTING_MODES.has(requestedMode)) {
    throw new HttpError(400, `Unsupported X-Agent-Mode: ${requestedMode}`);
  }

  let mode = requestedMode || null;
  let model;

  const slash = requestedModel.indexOf("/");
  if (slash > 0) {
    const namespace = requestedModel.slice(0, slash).toLowerCase();
    const suffix = requestedModel.slice(slash + 1).trim();
    if (namespace === "codex") {
      if (!mode) mode = "codex";
      if (mode === "codex" && suffix) model = suffix;
    } else if (namespace === "antigravity" || namespace === "gemini") {
      if (!mode) mode = "antigravity";
      if (mode === "antigravity" && suffix) model = suffix;
    }
  } else if (!mode) {
    if (ROUTING_MODES.has(requestedModel)) {
      mode = requestedModel;
    } else if (requestedModel.toLowerCase() === "gemini") {
      mode = "antigravity";
    }
  } else if ((mode === "codex" || mode === "antigravity") && requestedModel) {
    if (!ROUTING_MODES.has(requestedModel) && requestedModel.toLowerCase() !== "gemini") {
      model = requestedModel;
    }
  }

  return { mode, model };
}

async function resolveWorkspacePath(rawPath) {
  const candidate = rawPath ? String(rawPath) : process.cwd();
  if (!isAbsolute(candidate)) {
    throw new HttpError(400, "X-Workspace-Path must be an absolute path");
  }

  const workspacePath = resolve(candidate);
  let info;
  try {
    info = await stat(workspacePath);
  } catch {
    throw new HttpError(400, "Workspace path does not exist");
  }

  if (!info.isDirectory()) {
    throw new HttpError(400, "Workspace path must be a directory");
  }

  return workspacePath;
}

function parseBody(req) {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    let bytes = 0;
    let settled = false;

    req.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      body += chunk.toString();
    });

    req.on("end", () => {
      if (settled) return;
      if (!body.trim()) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(body));
      } catch {
        reject(new HttpError(400, "Request body must be valid JSON"));
      }
    });

    req.on("error", reject);
  });
}

function buildPrompt(messages) {
  if (!Array.isArray(messages)) {
    throw new HttpError(400, "messages must be an array");
  }

  let prompt = "";
  let systemContext = "";

  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || typeof msg.role !== "string") {
      throw new HttpError(400, "Each message must include a role");
    }
    if (typeof msg.content !== "string") {
      throw new HttpError(400, "Only string message content is currently supported");
    }

    if (msg.role === "system") systemContext += `${msg.content}\n`;
    else if (msg.role === "user") prompt += `${msg.content}\n`;
    else if (msg.role === "assistant") prompt += `[Previous response]\n${msg.content}\n\n`;
  }

  const fullPrompt = systemContext ? `[System]\n${systemContext}\n${prompt}` : prompt;
  if (!fullPrompt.trim()) {
    throw new HttpError(400, "At least one non-empty message is required");
  }
  return fullPrompt;
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}

function sendError(res, err) {
  const status = Number.isInteger(err?.statusCode) ? err.statusCode : 500;
  sendJSON(res, status, {
    error: {
      message: err?.message || "Internal server error",
      type: status >= 500 ? "server_error" : "invalid_request_error",
    },
  });
}

function rejectBrowserOrigin(req) {
  if (typeof req.headers.origin === "string" && req.headers.origin.length > 0) {
    throw new HttpError(
      403,
      "Browser-origin requests are not allowed on the local execution bridge"
    );
  }
}

function responseModel(agent, requestedModel) {
  return requestedModel ? `${agent}/${requestedModel}` : agent;
}

// ── /v1/chat/completions ────────────────────────────────────────

async function handleChat(req, res) {
  rejectBrowserOrigin(req);

  const body = await parseBody(req);
  const stream = body.stream === true;
  const fullPrompt = buildPrompt(body.messages || []);
  const cwd = await resolveWorkspacePath(req.headers["x-workspace-path"]);
  const selection = parseAgentSelection(body.model || "", req.headers["x-agent-mode"]);

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Content-Type-Options": "nosniff",
    });

    try {
      const result = await orchestrate(fullPrompt, {
        cwd,
        mode: selection.mode,
        model: selection.model,
      });

      const content = result.content;
      const chunkSize = 50;
      for (let i = 0; i < content.length; i += chunkSize) {
        const chunk = {
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: responseModel(result.agent, selection.model),
          choices: [
            {
              index: 0,
              delta: { content: content.slice(i, i + chunkSize) },
              finish_reason: null,
            },
          ],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      const finalChunk = {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: responseModel(result.agent, selection.model),
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      const errChunk = {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: "error",
        choices: [
          {
            index: 0,
            delta: { content: `\n\n[Error: ${err.message}]` },
            finish_reason: "stop",
          },
        ],
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } else {
    const result = await orchestrate(fullPrompt, {
      cwd,
      mode: selection.mode,
      model: selection.model,
    });
    sendJSON(res, 200, {
      id: `chatcmpl-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: responseModel(result.agent, selection.model),
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: result.content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
}

// ── /v1/models ──────────────────────────────────────────────────

async function handleModels(req, res) {
  const codexModel = await getCodexModel();
  const codexAuth = await AGENTS.codex.authCheck();
  const agyAuth = await AGENTS.antigravity.authCheck();

  const models = [
    {
      id: "collaborative",
      object: "model",
      owned_by: "bridge",
      description: "Both agents collaborate",
    },
    {
      id: "pipeline",
      object: "model",
      owned_by: "bridge",
      description: "Gemini analyzes → Codex implements",
    },
  ];

  if (codexAuth) {
    models.push({
      id: `codex/${codexModel}`,
      object: "model",
      owned_by: "openai",
      description: "Codex (ChatGPT subscription)",
    });
  }
  if (agyAuth) {
    models.push({
      id: "antigravity/pro",
      object: "model",
      owned_by: "google",
      description: "Antigravity Gemini Pro",
    });
    models.push({
      id: "antigravity/flash",
      object: "model",
      owned_by: "google",
      description: "Antigravity Gemini Flash",
    });
    models.push({
      id: "antigravity/flash_lite",
      object: "model",
      owned_by: "google",
      description: "Antigravity Gemini Flash Lite",
    });
  }

  sendJSON(res, 200, { object: "list", data: models });
}

// ── /v1/agents ──────────────────────────────────────────────────

async function handleAgents(req, res) {
  const agents = {};
  for (const [key, agent] of Object.entries(AGENTS)) {
    agents[key] = {
      name: agent.name,
      authenticated: await agent.authCheck(),
      strengths: agent.strengths,
    };
  }
  sendJSON(res, 200, { agents, billing: "NONE", auth: "subscription-only" });
}

// ── /health ─────────────────────────────────────────────────────

async function handleHealth(req, res) {
  const codexAuth = await AGENTS.codex.authCheck();
  const agyAuth = await AGENTS.antigravity.authCheck();

  sendJSON(res, 200, {
    status: "ok",
    bridge: "open-cursor-multi-agent",
    version: "2.0.0",
    billing: "NONE",
    agents: {
      codex: { available: codexAuth, source: "ChatGPT subscription" },
      antigravity: { available: agyAuth, source: "Gemini AI Pro subscription" },
    },
  });
}

// ── Server ──────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    // Deliberately do not emit CORS headers. The bridge executes local tools and
    // must not be callable by arbitrary browser origins.
    res.writeHead(204, { Allow: "GET, POST, OPTIONS" });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  try {
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      await handleChat(req, res);
    } else if (url.pathname === "/v1/models" && req.method === "GET") {
      await handleModels(req, res);
    } else if (url.pathname === "/v1/agents" && req.method === "GET") {
      await handleAgents(req, res);
    } else if (url.pathname === "/health" && req.method === "GET") {
      await handleHealth(req, res);
    } else {
      sendJSON(res, 404, { error: { message: "Not found" } });
    }
  } catch (err) {
    sendError(res, err);
  }
});

function stopActiveProcesses() {
  for (const processHandle of activeProcesses) {
    processHandle.kill("SIGTERM");
  }
}

function startServer() {
  if (!LOOPBACK_HOSTS.has(HOST) && process.env.BRIDGE_ALLOW_REMOTE !== "1") {
    throw new Error(
      `Refusing to bind execution bridge to non-loopback host ${HOST}. ` +
        "Set BRIDGE_ALLOW_REMOTE=1 only if you provide an external authentication boundary."
    );
  }

  const shutdown = () => {
    stopActiveProcesses();
    server.close(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(PORT, HOST, async () => {
    const codexAuth = await AGENTS.codex.authCheck();
    const agyAuth = await AGENTS.antigravity.authCheck();

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Open-Cursor Multi-Agent Bridge v2.0                ║
║            課金なし — サブスクリプションのみ                   ║
╠══════════════════════════════════════════════════════════════╣
║  Endpoint : http://${HOST}:${PORT}                          ║
║  Status   : http://${HOST}:${PORT}/health                   ║
║  Models   : http://${HOST}:${PORT}/v1/models                ║
║  Agents   : http://${HOST}:${PORT}/v1/agents                ║
║  Chat API : http://${HOST}:${PORT}/v1/chat/completions      ║
╠══════════════════════════════════════════════════════════════╣
║  Codex (ChatGPT)      : ${codexAuth ? "READY" : "NOT AUTHENTICATED"}                          ║
║  Antigravity (Gemini)  : ${agyAuth ? "READY" : "NOT AUTHENTICATED"}                          ║
║  Billing               : NONE                                ║
╚══════════════════════════════════════════════════════════════╝
  `);
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    startServer();
  } catch (err) {
    console.error(`[open-cursor] ${err.message}`);
    process.exit(1);
  }
}

export {
  HttpError,
  analyzeTask,
  buildPrompt,
  parseAgentSelection,
  rejectBrowserOrigin,
  resolveWorkspacePath,
  server,
  startServer,
};

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
import { spawn, execFile } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const PORT = parseInt(process.env.BRIDGE_PORT || "9876", 10);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const AGY_BIN = process.env.AGY_BIN || join(homedir(), ".local/bin/agy");
const CODEX_HOME = join(homedir(), ".codex");
const GEMINI_HOME = join(homedir(), ".gemini");

// ── Agent Registry ──────────────────────────────────────────────

const AGENTS = {
  codex: {
    name: "Codex (OpenAI/ChatGPT)",
    bin: CODEX_BIN,
    authCheck: async () => {
      try {
        await readFile(join(CODEX_HOME, "auth.json"), "utf-8");
        return true;
      } catch { return false; }
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
      } catch { return false; }
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
    return match ? match[1] : "o3";
  } catch { return "o3"; }
}

function runCodex(prompt, { cwd, model }) {
  return new Promise((resolve, reject) => {
    const args = [
      "exec", "-m", model || "auto",
      "-C", cwd || process.cwd(),
      "--sandbox", "workspace-write",
      "--ask-for-approval", "never",
      "--output-format", "text",
      prompt,
    ];

    const child = spawn(CODEX_BIN, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, CODEX_HOME, OPENAI_API_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      activeProcesses.delete(child);
      resolve({ content: stdout.trim() || stderr.trim(), agent: "codex", code });
    });
    child.on("error", (e) => { activeProcesses.delete(child); reject(e); });
  });
}

// ── Antigravity CLI runner ──────────────────────────────────────

function runAntigravity(prompt, { cwd, model }) {
  return new Promise((resolve, reject) => {
    const args = [
      `-p=${prompt}`,
      "--output-format", "text",
      "--dangerously-skip-permissions",
    ];
    if (model) args.push("--model", model);

    const child = spawn(AGY_BIN, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, GEMINI_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      activeProcesses.delete(child);
      resolve({ content: stdout.trim() || stderr.trim(), agent: "antigravity", code });
    });
    child.on("error", (e) => { activeProcesses.delete(child); reject(e); });
  });
}

// ── Antigravity agentapi runner (sub-agent mode) ────────────────

function runAntigravityAgent(prompt, { cwd, model }) {
  return new Promise((resolve, reject) => {
    const args = [
      "agentapi", "new-conversation",
      "--title", "bridge-task",
    ];
    if (model) args.push(`--model=${model}`);
    args.push(prompt);

    const child = spawn(AGY_BIN, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, GEMINI_HOME },
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeProcesses.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) => {
      activeProcesses.delete(child);
      // Parse conversation response
      let content = stdout.trim();
      try {
        const parsed = JSON.parse(content);
        if (parsed.response) content = parsed.response;
        if (parsed.content) content = parsed.content;
      } catch {}
      resolve({ content: content || stderr.trim(), agent: "antigravity-agentapi", code });
    });
    child.on("error", (e) => { activeProcesses.delete(child); reject(e); });
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
      // Run both in parallel, merge results
      const [codexResult, geminiResult] = await Promise.all([
        runCodex(prompt, { cwd, model }).catch(e => ({ content: `[Codex error: ${e.message}]`, agent: "codex", code: 1 })),
        runAntigravity(prompt, { cwd, model }).catch(e => ({ content: `[Antigravity error: ${e.message}]`, agent: "antigravity", code: 1 })),
      ]);

      return {
        content: formatCollaborativeResult(codexResult, geminiResult, prompt),
        agent: "collaborative",
        code: 0,
      };
    }

    case "pipeline": {
      // First agent analyzes, second implements
      const analysis = await runAntigravity(
        `Analyze this task and provide a detailed implementation plan:\n${prompt}`,
        { cwd, model: "pro" }
      );

      const implementation = await runCodex(
        `Based on this analysis, implement the solution:\n\n${analysis.content}\n\nOriginal task:\n${prompt}`,
        { cwd, model }
      );

      return {
        content: `## Analysis (Gemini/Antigravity)\n${analysis.content}\n\n## Implementation (Codex/GPT)\n${implementation.content}`,
        agent: "pipeline",
        code: 0,
      };
    }

    default:
      return runCodex(prompt, { cwd, model });
  }
}

function analyzeTask(prompt) {
  const p = prompt.toLowerCase();

  // Research/analysis tasks → Gemini
  if (/\b(analyze|research|explain|review|audit|compare|survey|study)\b/.test(p)) {
    return { routing: "antigravity", reason: "analysis task" };
  }

  // Code generation/implementation → Codex
  if (/\b(implement|create|build|write|fix|debug|refactor|deploy)\b/.test(p)) {
    return { routing: "codex", reason: "implementation task" };
  }

  // Complex tasks → collaborative
  if (prompt.length > 500 || /\b(and then|after|also|additionally|furthermore)\b/.test(p)) {
    return { routing: "collaborative", reason: "complex multi-step task" };
  }

  // Default: let orchestrator decide
  return { routing: "collaborative", reason: "general task" };
}

function formatCollaborativeResult(codexResult, geminiResult, originalPrompt) {
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

// ── HTTP API ────────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
    req.on("error", reject);
  });
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "*",
  });
  res.end(JSON.stringify(data));
}

// ── /v1/chat/completions ────────────────────────────────────────

async function handleChat(req, res) {
  const body = await parseBody(req);
  const stream = body.stream === true;
  const messages = body.messages || [];

  // Build prompt
  let prompt = "";
  let systemContext = "";
  for (const msg of messages) {
    if (msg.role === "system") systemContext += msg.content + "\n";
    else if (msg.role === "user") prompt += msg.content + "\n";
    else if (msg.role === "assistant") prompt += `[Previous response]\n${msg.content}\n\n`;
  }

  const fullPrompt = systemContext ? `[System]\n${systemContext}\n${prompt}` : prompt;
  const cwd = req.headers["x-workspace-path"] || process.cwd();

  // Determine routing from model name or header
  let mode = null;
  const modelName = body.model || "";
  if (modelName.startsWith("codex")) mode = "codex";
  else if (modelName.startsWith("gemini") || modelName.startsWith("antigravity")) mode = "antigravity";
  else if (modelName === "collaborative") mode = "collaborative";
  else if (modelName === "pipeline") mode = "pipeline";
  mode = req.headers["x-agent-mode"] || mode;

  if (stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    try {
      const result = await orchestrate(fullPrompt, { cwd, mode, model: modelName });

      // Stream the result as SSE chunks
      const content = result.content;
      const chunkSize = 50;
      for (let i = 0; i < content.length; i += chunkSize) {
        const chunk = {
          id: `chatcmpl-${randomUUID()}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: `${result.agent}/${modelName}`,
          choices: [{ index: 0, delta: { content: content.slice(i, i + chunkSize) }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      const finalChunk = {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model: `${result.agent}/${modelName}`,
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
        choices: [{ index: 0, delta: { content: `\n\n[Error: ${err.message}]` }, finish_reason: "stop" }],
      };
      res.write(`data: ${JSON.stringify(errChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  } else {
    try {
      const result = await orchestrate(fullPrompt, { cwd, mode, model: modelName });
      sendJSON(res, 200, {
        id: `chatcmpl-${randomUUID()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: `${result.agent}/${modelName}`,
        choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (err) {
      sendJSON(res, 500, { error: { message: err.message, type: "server_error" } });
    }
  }
}

// ── /v1/models ──────────────────────────────────────────────────

async function handleModels(req, res) {
  const codexModel = await getCodexModel();
  const codexAuth = await AGENTS.codex.authCheck();
  const agyAuth = await AGENTS.antigravity.authCheck();

  const models = [
    { id: "collaborative", object: "model", owned_by: "bridge", description: "Both agents collaborate" },
    { id: "pipeline", object: "model", owned_by: "bridge", description: "Gemini analyzes → Codex implements" },
  ];

  if (codexAuth) {
    models.push({ id: `codex/${codexModel}`, object: "model", owned_by: "openai", description: "Codex (ChatGPT subscription)" });
  }
  if (agyAuth) {
    models.push({ id: "antigravity/pro", object: "model", owned_by: "google", description: "Antigravity Gemini Pro" });
    models.push({ id: "antigravity/flash", object: "model", owned_by: "google", description: "Antigravity Gemini Flash" });
    models.push({ id: "antigravity/flash_lite", object: "model", owned_by: "google", description: "Antigravity Gemini Flash Lite" });
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
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "*",
      "Access-Control-Allow-Headers": "*",
    });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

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
    sendJSON(res, 500, { error: { message: err.message } });
  }
});

process.on("SIGINT", () => {
  for (const p of activeProcesses) p.kill("SIGTERM");
  server.close(() => process.exit(0));
});
process.on("SIGTERM", () => {
  for (const p of activeProcesses) p.kill("SIGTERM");
  server.close(() => process.exit(0));
});

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

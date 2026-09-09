#!/usr/bin/env node
/**
 * Open-Cursor Multi-Agent Bridge
 *
 * Local subscription-authenticated multi-agent coding bridge.
 * The bridge itself does not use per-call billing APIs.
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const VERSION = "2.2.0";
const PORT = envInt("BRIDGE_PORT", 9876, 1, 65535);
const HOST = process.env.BRIDGE_HOST || "127.0.0.1";
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const LOCAL_AGY_BIN = join(homedir(), ".local/bin/agy");
const AGY_BIN = process.env.AGY_BIN || (existsSync(LOCAL_AGY_BIN) ? LOCAL_AGY_BIN : "agy");
const CODEX_HOME = join(homedir(), ".codex");
const GEMINI_HOME = join(homedir(), ".gemini");
const MAX_BODY_BYTES = envInt("BRIDGE_MAX_BODY_BYTES", 1024 * 1024, 1024);
const MAX_OUTPUT_BYTES = envInt("BRIDGE_MAX_OUTPUT_BYTES", 8 * 1024 * 1024, 1024);
const AGENT_TIMEOUT_MS = envInt("BRIDGE_AGENT_TIMEOUT_MS", 10 * 60 * 1000, 1000);
const KILL_GRACE_MS = envInt("BRIDGE_KILL_GRACE_MS", 1500, 100);
const ROUTING_MODES = new Set(["codex", "antigravity", "collaborative", "pipeline"]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

class ExecutionAbortedError extends Error {
  constructor(message = "Execution aborted") {
    super(message);
    this.name = "AbortError";
  }
}

class ExecutionTimeoutError extends HttpError {
  constructor(timeoutMs) {
    super(504, `Agent execution exceeded ${timeoutMs} ms`);
    this.name = "ExecutionTimeoutError";
  }
}

const AGENTS = {
  codex: {
    name: "Codex (OpenAI/ChatGPT)",
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
    authCheck: async () => {
      try {
        const settings = await readFile(
          join(GEMINI_HOME, "antigravity-cli/settings.json"),
          "utf-8"
        );
        return !JSON.parse(settings).useG1Credits;
      } catch {
        return false;
      }
    },
    strengths: ["analysis", "architecture", "research", "multimodal", "web-search"],
  },
};

const activeProcesses = new Map();

async function getCodexModel() {
  try {
    const config = await readFile(join(CODEX_HOME, "config.toml"), "utf-8");
    const match = config.match(/^model\s*=\s*"([^"]+)"/m);
    return match ? match[1] : "auto";
  } catch {
    return "auto";
  }
}

function activeExecutionCount() {
  return activeProcesses.size;
}

function runProcess({
  agent,
  command,
  args,
  cwd,
  env,
  signal,
  onStdout,
  onStderr,
  timeoutMs = AGENT_TIMEOUT_MS,
  transformContent,
}) {
  if (signal?.aborted) {
    return Promise.reject(new ExecutionAbortedError("Execution aborted before start"));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const executionId = randomUUID();
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    activeProcesses.set(child, {
      id: executionId,
      agent,
      startedAt: Date.now(),
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let outputExceeded = false;
    let forceKillTimer = null;

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode) return;
      try {
        child.kill("SIGTERM");
      } catch {}
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && !child.signalCode) {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const executionTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    executionTimer.unref?.();

    const cleanup = () => {
      activeProcesses.delete(child);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(executionTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const consumeOutput = (kind, text, callback) => {
      if (settled || outputExceeded) return;
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        terminate();
        return;
      }

      if (kind === "stdout") stdout += text;
      else stderr += text;
      callback?.(text);
    };

    child.stdout.on("data", (text) => consumeOutput("stdout", text, onStdout));
    child.stderr.on("data", (text) => consumeOutput("stderr", text, onStderr));

    child.once("error", (error) => settle(rejectPromise, error));
    child.once("close", (code, signalCode) => {
      if (aborted) {
        settle(rejectPromise, new ExecutionAbortedError("Agent execution cancelled"));
        return;
      }
      if (timedOut) {
        settle(rejectPromise, new ExecutionTimeoutError(timeoutMs));
        return;
      }
      if (outputExceeded) {
        settle(
          rejectPromise,
          new HttpError(502, `Agent output exceeded ${MAX_OUTPUT_BYTES} bytes`)
        );
        return;
      }

      const raw = stdout.trim() || stderr.trim();
      const content = transformContent
        ? transformContent(raw, { stdout, stderr, code, signal: signalCode })
        : raw;

      settle(resolvePromise, {
        content,
        stdout,
        stderr,
        agent,
        code,
        signal: signalCode,
        executionId,
      });
    });
  });
}

function runCodex(prompt, { cwd, model, signal, onChunk } = {}) {
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

  return runProcess({
    agent: "codex",
    command: CODEX_BIN,
    args,
    cwd,
    signal,
    onStdout: onChunk,
    env: { ...process.env, CODEX_HOME, OPENAI_API_KEY: "" },
  });
}

function runAntigravity(prompt, { cwd, model, signal, onChunk } = {}) {
  const args = [`-p=${prompt}`, "--output-format", "text", "--dangerously-skip-permissions"];
  if (model) args.push("--model", model);

  return runProcess({
    agent: "antigravity",
    command: AGY_BIN,
    args,
    cwd,
    signal,
    onStdout: onChunk,
    env: { ...process.env, GEMINI_HOME },
  });
}

function requireSuccessfulAgent(result) {
  if (result.code === 0) return result;
  const detail = (result.stderr || result.content || "no diagnostic output").trim().slice(-1200);
  throw new HttpError(
    502,
    `${result.agent} exited with code ${result.code ?? "null"}: ${detail}`
  );
}

function failedAgentResult(agent, error) {
  return {
    content: `[${agent} error: ${error.message}]`,
    agent,
    code: 1,
  };
}

function createCollaborativeEmitter(agent, onEvent) {
  let pending = "";
  const label = agent === "codex" ? "Codex" : "Gemini";

  const emitLine = (text) => {
    if (!text) return;
    onEvent?.({
      text: `[${label}] ${text}`,
      agent,
      phase: "collaborative",
    });
  };

  return {
    push(text) {
      pending += text;
      let newline;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline + 1);
        pending = pending.slice(newline + 1);
        emitLine(line);
      }
      if (pending.length >= 512) {
        emitLine(pending);
        pending = "";
      }
    },
    flush() {
      if (pending) emitLine(pending);
      pending = "";
    },
  };
}

async function orchestrate(prompt, { cwd, mode, model, signal, onEvent } = {}) {
  const taskType = analyzeTask(prompt);
  const selectedMode = mode || taskType.routing;

  switch (selectedMode) {
    case "codex": {
      const result = await runCodex(prompt, {
        cwd,
        model,
        signal,
        onChunk: (text) => onEvent?.({ text, agent: "codex", phase: "response" }),
      });
      return requireSuccessfulAgent(result);
    }

    case "antigravity": {
      const result = await runAntigravity(prompt, {
        cwd,
        model,
        signal,
        onChunk: (text) =>
          onEvent?.({ text, agent: "antigravity", phase: "response" }),
      });
      return requireSuccessfulAgent(result);
    }

    case "collaborative": {
      const codexEmitter = createCollaborativeEmitter("codex", onEvent);
      const geminiEmitter = createCollaborativeEmitter("antigravity", onEvent);

      const [codexResult, geminiResult] = await Promise.all([
        runCodex(prompt, { cwd, signal, onChunk: codexEmitter.push })
          .then(requireSuccessfulAgent)
          .catch((error) => failedAgentResult("codex", error))
          .finally(codexEmitter.flush),
        runAntigravity(prompt, { cwd, signal, onChunk: geminiEmitter.push })
          .then(requireSuccessfulAgent)
          .catch((error) => failedAgentResult("antigravity", error))
          .finally(geminiEmitter.flush),
      ]);

      if (signal?.aborted) throw new ExecutionAbortedError("Collaborative execution cancelled");

      return {
        content: formatCollaborativeResult(codexResult, geminiResult),
        agent: "collaborative",
        code: codexResult.code === 0 || geminiResult.code === 0 ? 0 : 1,
      };
    }

    case "pipeline": {
      onEvent?.({
        text: "## Analysis (Gemini/Antigravity)\n",
        agent: "antigravity",
        phase: "analysis-header",
      });
      const analysis = requireSuccessfulAgent(
        await runAntigravity(
          `Analyze this task and provide a detailed implementation plan:\n${prompt}`,
          {
            cwd,
            model: "pro",
            signal,
            onChunk: (text) =>
              onEvent?.({ text, agent: "antigravity", phase: "analysis" }),
          }
        )
      );

      onEvent?.({
        text: "\n\n## Implementation (Codex/GPT)\n",
        agent: "codex",
        phase: "implementation-header",
      });
      const implementation = requireSuccessfulAgent(
        await runCodex(
          `Based on this analysis, implement the solution:\n\n${analysis.content}\n\nOriginal task:\n${prompt}`,
          {
            cwd,
            signal,
            onChunk: (text) =>
              onEvent?.({ text, agent: "codex", phase: "implementation" }),
          }
        )
      );

      return {
        content: `## Analysis (Gemini/Antigravity)\n${analysis.content}\n\n## Implementation (Codex/GPT)\n${implementation.content}`,
        agent: "pipeline",
        code: implementation.code,
      };
    }

    default: {
      const result = await runCodex(prompt, {
        cwd,
        model,
        signal,
        onChunk: (text) => onEvent?.({ text, agent: "codex", phase: "response" }),
      });
      return requireSuccessfulAgent(result);
    }
  }
}

function analyzeTask(prompt) {
  const p = prompt.toLowerCase();

  if (
    /\b(analyze|research|explain|review|audit|compare|survey|study|evaluate|investigate)\b/.test(p) ||
    /(分析|調査|説明|レビュー|監査|比較|検証|研究|評価|考察)/.test(prompt)
  ) {
    return { routing: "antigravity", reason: "analysis task" };
  }

  if (
    /\b(implement|create|build|write|fix|debug|refactor|deploy|patch|add)\b/.test(p) ||
    /(実装|作成|構築|修正|デバッグ|リファクタ|デプロイ|追加|直して|作って)/.test(prompt)
  ) {
    return { routing: "codex", reason: "implementation task" };
  }

  if (
    prompt.length > 500 ||
    /\b(and then|after that|also|additionally|furthermore|continue)\b/.test(p) ||
    /(その後|さらに|加えて|続けて|続行)/.test(prompt)
  ) {
    return { routing: "collaborative", reason: "complex multi-step task" };
  }

  return { routing: "collaborative", reason: "general task" };
}

function formatCollaborativeResult(codexResult, geminiResult) {
  const sections = [];

  if (geminiResult.content && !geminiResult.content.startsWith("[antigravity error:")) {
    sections.push(`### Gemini Analysis\n${geminiResult.content}`);
  } else if (geminiResult.content) {
    sections.push(geminiResult.content);
  }

  if (codexResult.content && !codexResult.content.startsWith("[codex error:")) {
    sections.push(`### Codex Implementation\n${codexResult.content}`);
  } else if (codexResult.content) {
    sections.push(codexResult.content);
  }

  if (sections.length === 0) {
    return "Both agents returned empty responses.";
  }
  return sections.join("\n\n---\n\n");
}

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
    let namespaceMode = null;

    if (namespace === "codex") namespaceMode = "codex";
    if (namespace === "antigravity" || namespace === "gemini") namespaceMode = "antigravity";

    if (namespaceMode) {
      if (mode && mode !== namespaceMode) {
        throw new HttpError(
          400,
          `Model namespace ${namespace} conflicts with X-Agent-Mode ${mode}`
        );
      }
      mode = namespaceMode;
      if (suffix) model = suffix;
    }
  } else if (!mode) {
    const lower = requestedModel.toLowerCase();
    if (ROUTING_MODES.has(lower)) mode = lower;
    else if (lower === "gemini") mode = "antigravity";
  } else if ((mode === "codex" || mode === "antigravity") && requestedModel) {
    const lower = requestedModel.toLowerCase();
    if (!ROUTING_MODES.has(lower) && lower !== "gemini") model = requestedModel;
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
  return new Promise((resolvePromise, rejectPromise) => {
    let body = "";
    let bytes = 0;
    let settled = false;

    const rejectOnce = (error) => {
      if (settled) return;
      settled = true;
      rejectPromise(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_BODY_BYTES) {
        rejectOnce(new HttpError(413, `Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      body += chunk.toString();
    });

    req.on("aborted", () =>
      rejectOnce(new ExecutionAbortedError("Request aborted while reading body"))
    );
    req.on("error", rejectOnce);

    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (!body.trim()) {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(body));
      } catch {
        rejectPromise(new HttpError(400, "Request body must be valid JSON"));
      }
    });
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
    else throw new HttpError(400, `Unsupported message role: ${msg.role}`);
  }

  const fullPrompt = systemContext ? `[System]\n${systemContext}\n${prompt}` : prompt;
  if (!fullPrompt.trim()) {
    throw new HttpError(400, "At least one non-empty message is required");
  }
  return fullPrompt;
}

function sendJSON(res, status, data, headers = {}) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function sendError(res, error) {
  if (res.destroyed || res.writableEnded) return;
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  sendJSON(res, status, {
    error: {
      message: error?.message || "Internal server error",
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

function bindRequestLifetime(req, res) {
  const controller = new AbortController();

  const abort = (message) => {
    if (!controller.signal.aborted) controller.abort(new Error(message));
  };
  const onAborted = () => abort("Client aborted request");
  const onClose = () => {
    if (!res.writableEnded) abort("Client disconnected");
  };

  req.once("aborted", onAborted);
  res.once("close", onClose);

  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener("aborted", onAborted);
      res.removeListener("close", onClose);
    },
  };
}

function createSseResponse(res, requestId) {
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-store",
    Connection: "keep-alive",
    "X-Content-Type-Options": "nosniff",
    "X-Open-Cursor-Request-Id": requestId,
  });
  res.flushHeaders?.();
  res.write(": open-cursor\n\n");

  const writeChunk = (text, model, metadata = {}) => {
    if (!text || res.destroyed || res.writableEnded) return false;
    const chunk = {
      id: requestId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
      open_cursor: metadata,
    };
    return res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  return {
    delta(text, model, metadata) {
      return writeChunk(text, model, metadata);
    },
    finish(model, metadata = {}) {
      if (res.destroyed || res.writableEnded) return;
      const finalChunk = {
        id: requestId,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        open_cursor: metadata,
      };
      res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    },
    fail(error) {
      if (res.destroyed || res.writableEnded) return;
      writeChunk(`\n\n[Error: ${error.message}]`, "error", {
        error: true,
        type: error.name || "Error",
      });
      res.write("data: [DONE]\n\n");
      res.end();
    },
  };
}

async function handleChat(req, res) {
  rejectBrowserOrigin(req);

  const body = await parseBody(req);
  const stream = body.stream === true;
  const fullPrompt = buildPrompt(body.messages || []);
  const cwd = await resolveWorkspacePath(req.headers["x-workspace-path"]);
  const selection = parseAgentSelection(body.model || "", req.headers["x-agent-mode"]);
  const requestId = `chatcmpl-${randomUUID()}`;
  const lifetime = bindRequestLifetime(req, res);

  if (stream) {
    const sse = createSseResponse(res, requestId);
    try {
      const result = await orchestrate(fullPrompt, {
        cwd,
        mode: selection.mode,
        model: selection.model,
        signal: lifetime.signal,
        onEvent: ({ text, agent, phase }) => {
          sse.delta(text, responseModel(agent, selection.model), {
            agent,
            phase,
          });
        },
      });

      sse.finish(responseModel(result.agent, selection.model), {
        agent: result.agent,
        active_executions: activeExecutionCount(),
      });
    } catch (error) {
      if (!lifetime.signal.aborted) sse.fail(error);
    } finally {
      lifetime.cleanup();
    }
    return;
  }

  try {
    const result = await orchestrate(fullPrompt, {
      cwd,
      mode: selection.mode,
      model: selection.model,
      signal: lifetime.signal,
    });

    sendJSON(
      res,
      200,
      {
        id: requestId,
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
        open_cursor: {
          agent: result.agent,
          active_executions: activeExecutionCount(),
        },
      },
      { "X-Open-Cursor-Request-Id": requestId }
    );
  } finally {
    lifetime.cleanup();
  }
}

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
    models.push(
      {
        id: "antigravity/pro",
        object: "model",
        owned_by: "google",
        description: "Antigravity Gemini Pro",
      },
      {
        id: "antigravity/flash",
        object: "model",
        owned_by: "google",
        description: "Antigravity Gemini Flash",
      },
      {
        id: "antigravity/flash_lite",
        object: "model",
        owned_by: "google",
        description: "Antigravity Gemini Flash Lite",
      }
    );
  }

  sendJSON(res, 200, { object: "list", data: models });
}

async function handleAgents(req, res) {
  const agents = {};
  for (const [key, agent] of Object.entries(AGENTS)) {
    agents[key] = {
      name: agent.name,
      authenticated: await agent.authCheck(),
      strengths: agent.strengths,
    };
  }
  sendJSON(res, 200, {
    agents,
    billing: "NONE",
    auth: "subscription-only",
    execution: {
      active: activeExecutionCount(),
      timeout_ms: AGENT_TIMEOUT_MS,
      max_output_bytes: MAX_OUTPUT_BYTES,
    },
  });
}

async function handleHealth(req, res) {
  const codexAuth = await AGENTS.codex.authCheck();
  const agyAuth = await AGENTS.antigravity.authCheck();

  sendJSON(res, 200, {
    status: "ok",
    bridge: "open-cursor-multi-agent",
    version: VERSION,
    billing: "NONE",
    execution: {
      active: activeExecutionCount(),
      timeout_ms: AGENT_TIMEOUT_MS,
      max_output_bytes: MAX_OUTPUT_BYTES,
    },
    agents: {
      codex: { available: codexAuth, source: "ChatGPT subscription" },
      antigravity: { available: agyAuth, source: "Gemini AI Pro subscription" },
    },
  });
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
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
  } catch (error) {
    if (error?.name !== "AbortError") sendError(res, error);
  }
});

function stopActiveProcesses() {
  for (const child of activeProcesses.keys()) {
    if (child.exitCode === null && !child.signalCode) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
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
    const hardExit = setTimeout(() => process.exit(0), KILL_GRACE_MS + 500);
    hardExit.unref?.();
    server.close(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(PORT, HOST, async () => {
    const codexAuth = await AGENTS.codex.authCheck();
    const agyAuth = await AGENTS.antigravity.authCheck();

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Open-Cursor Multi-Agent Bridge v${VERSION.padEnd(18)}║
║            local · subscription-authenticated               ║
╠══════════════════════════════════════════════════════════════╣
║  Endpoint : http://${HOST}:${PORT}
║  Codex    : ${codexAuth ? "READY" : "NOT AUTHENTICATED"}
║  Gemini   : ${agyAuth ? "READY" : "NOT AUTHENTICATED"}
║  Timeout  : ${AGENT_TIMEOUT_MS} ms
║  Max out  : ${MAX_OUTPUT_BYTES} bytes
╚══════════════════════════════════════════════════════════════╝
`);
  });
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    startServer();
  } catch (error) {
    console.error(`[open-cursor] ${error.message}`);
    process.exit(1);
  }
}

export {
  HttpError,
  ExecutionAbortedError,
  ExecutionTimeoutError,
  activeExecutionCount,
  analyzeTask,
  buildPrompt,
  formatCollaborativeResult,
  orchestrate,
  parseAgentSelection,
  rejectBrowserOrigin,
  resolveWorkspacePath,
  runProcess,
  server,
  startServer,
};

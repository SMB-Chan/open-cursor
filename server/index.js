#!/usr/bin/env node
/**
 * Open-Cursor local HTTP bridge.
 * Execution and multi-agent orchestration live in engine.js.
 */

import { createServer } from "node:http";
import { stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

// Load and project validated configuration before engine.js evaluates its
// environment-backed execution constants.
import { runtimeConfig } from "./config.js";
import { compressMessages } from "./compressor.js";
import {
  AGENTS,
  ExecutionAbortedError,
  ExecutionTimeoutError,
  HttpError,
  VERSION,
  activeExecutionCount,
  analyzeTask,
  executionConfig,
  formatCollaborativeResult,
  getCodexModel,
  orchestrate,
  runProcess,
  stopActiveProcesses,
} from "./engine.js";

const PORT = runtimeConfig.bridge.port;
const HOST = runtimeConfig.bridge.host;
const MAX_BODY_BYTES = runtimeConfig.execution.maxBodyBytes;
const ROUTING_MODES = new Set([
  "codex",
  "antigravity",
  "collaborative",
  "pipeline",
  "mimo",
  "mimo-gemini",
  "auto",
  "autonomous",
]);
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

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
    if (namespace === "mimo") namespaceMode = "mimo";
    if (namespace === "mimo-gemini" || namespace === "gemini-mimo") namespaceMode = "mimo-gemini";

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
    else if (lower === "mimo-gemini" || lower === "gemini-mimo") mode = "mimo-gemini";
  } else if (
    (mode === "codex" || mode === "antigravity" || mode === "mimo" || mode === "mimo-gemini") &&
    requestedModel
  ) {
    const lower = requestedModel.toLowerCase();
    if (!ROUTING_MODES.has(lower) && lower !== "gemini") model = requestedModel;
  }

  return { mode, model };
}

function requiredAgentsForMode(mode) {
  if (mode === "codex") return ["codex"];
  if (mode === "antigravity") return ["antigravity"];
  if (mode === "autonomous") return ["antigravity"];
  if (mode === "mimo") return ["mimo"];
  if (mode === "mimo-gemini") return ["mimo", "antigravity"];
  if (mode === "pipeline" || mode === "collaborative") return ["codex", "antigravity"];
  return [];
}

function assertAgentsEnabled(mode) {
  for (const agent of requiredAgentsForMode(mode)) {
    if (!runtimeConfig.agents[agent]?.enabled) {
      throw new HttpError(503, `${agent} is disabled by runtime configuration`);
    }
  }
}

async function resolveWorkspacePath(rawPath) {
  let candidate = rawPath ? String(rawPath) : process.cwd();
  try {
    candidate = decodeURIComponent(candidate);
  } catch {}
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

  // Validate roles and types
  for (const msg of messages) {
    if (!msg || typeof msg !== "object" || typeof msg.role !== "string") {
      throw new HttpError(400, "Each message must include a role");
    }
    if (typeof msg.content !== "string") {
      throw new HttpError(400, "Only string message content is currently supported");
    }
    if (!["system", "user", "assistant"].includes(msg.role)) {
      throw new HttpError(400, `Unsupported message role: ${msg.role}`);
    }
  }

  // Proactively compress prior turns to prevent context window exhaustion
  const { messages: effectiveMessages } = compressMessages(messages);

  let prompt = "";
  let systemContext = "";

  for (const msg of effectiveMessages) {
    if (!msg || typeof msg.content !== "string") continue;
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
  const effectiveMode = selection.mode || analyzeTask(fullPrompt).routing;
  assertAgentsEnabled(effectiveMode);

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

async function agentStatus(key) {
  const configured = runtimeConfig.agents[key] || { enabled: false, strengths: [] };
  const authenticated = configured.enabled ? await AGENTS[key]?.authCheck() : false;
  return {
    enabled: configured.enabled,
    authenticated: Boolean(authenticated),
    available: Boolean(configured.enabled && authenticated),
  };
}

async function handleModels(req, res) {
  const codexModel = await getCodexModel();
  const codex = await agentStatus("codex");
  const antigravity = await agentStatus("antigravity");
  const mimo = await agentStatus("mimo");

  const models = [
    {
      id: "auto",
      object: "model",
      owned_by: "bridge",
      description: "Auto (自動判別: プロンプト内容から Gemini / MiMo / 協調モードを最適自動選択)",
    },
    {
      id: "autonomous",
      object: "model",
      owned_by: "bridge",
      description: "Autonomous Agent (explicit write mode: auto-approved file edits and commands)",
    },
  ];

  if (mimo.available && antigravity.available) {
    models.push({
      id: "mimo-gemini",
      object: "model",
      owned_by: "bridge",
      description: "MiMo + Gemini (read-only: Gemini plan/review + MiMo solution draft)",
    });
  }

  if (codex.available && antigravity.available) {
    models.push(
      {
        id: "collaborative",
        object: "model",
        owned_by: "bridge",
        description: "Gemini plans/reviews; Codex implements/refines sequentially",
      },
      {
        id: "pipeline",
        object: "model",
        owned_by: "bridge",
        description: "Detached Gemini analysis → Codex implementation",
      }
    );
  }

  if (mimo.available) {
    models.push(
      {
        id: "mimo",
        object: "model",
        owned_by: "xiaomi",
        description: "Xiaomi MiMo read-only response (mimo-v2.5-pro)",
      },
      {
        id: "mimo/mimo-v2.5-pro",
        object: "model",
        owned_by: "xiaomi",
        description: "Xiaomi MiMo (mimo-v2.5-pro)",
      }
    );
  }

  if (codex.available) {
    models.push(
      {
        id: "codex",
        object: "model",
        owned_by: "openai",
        description: `OpenAI ChatGPT (${codexModel}) via Codex CLI`,
      },
      {
        id: `codex/${codexModel}`,
        object: "model",
        owned_by: "openai",
        description: "Codex (ChatGPT subscription)",
      }
    );
  }
  if (antigravity.available) {
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
    const status = await agentStatus(key);
    agents[key] = {
      name: agent.name,
      enabled: status.enabled,
      authenticated: status.authenticated,
      available: status.available,
      strengths: runtimeConfig.agents[key]?.strengths || agent.strengths,
      auth_mode: runtimeConfig.agents[key]?.authMode || "unknown",
      billing: runtimeConfig.agents[key]?.billing || "unknown",
      workspace_access: runtimeConfig.agents[key]?.workspaceAccess || (key === "mimo" ? "none" : "agent-controlled"),
    };
  }
  sendJSON(res, 200, {
    agents,
    billing: "per-agent",
    auth: "per-agent",
    execution: {
      active: activeExecutionCount(),
      ...executionConfig(),
    },
    configuration: {
      env_overrides: runtimeConfig.overrides,
    },
  });
}

async function handleHealth(req, res) {
  const codex = await agentStatus("codex");
  const antigravity = await agentStatus("antigravity");
  const mimo = await agentStatus("mimo");

  sendJSON(res, 200, {
    status: "ok",
    bridge: "open-cursor-multi-agent",
    version: VERSION,
    billing: "per-agent",
    execution: {
      active: activeExecutionCount(),
      ...executionConfig(),
    },
    configuration: {
      env_overrides: runtimeConfig.overrides,
    },
    agents: {
      codex: {
        enabled: codex.enabled,
        available: codex.available,
        source: "ChatGPT subscription",
      },
      antigravity: {
        enabled: antigravity.enabled,
        available: antigravity.available,
        source: "Gemini AI Pro subscription",
      },
      mimo: {
        enabled: mimo.enabled,
        available: mimo.available,
        source: "Xiaomi MiMo token plan",
      },
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

function startServer() {
  if (!LOOPBACK_HOSTS.has(HOST) && !runtimeConfig.bridge.allowRemote) {
    throw new Error(
      `Refusing to bind execution bridge to non-loopback host ${HOST}. ` +
        "Set bridge.allowRemote=true or BRIDGE_ALLOW_REMOTE=1 only behind an authenticated transport boundary."
    );
  }

  const shutdown = () => {
    stopActiveProcesses();
    const hardExit = setTimeout(
      () => process.exit(0),
      executionConfig().kill_grace_ms + 500
    );
    hardExit.unref?.();
    server.close(() => {
      clearTimeout(hardExit);
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  server.listen(PORT, HOST, async () => {
    const codex = await agentStatus("codex");
    const antigravity = await agentStatus("antigravity");
    const mimo = await agentStatus("mimo");
    const execution = executionConfig();
    const configMode = runtimeConfig.overrides.length
      ? `bridge.json + ${runtimeConfig.overrides.length} env override(s)`
      : "bridge.json";

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║           Open-Cursor Multi-Agent Bridge v${VERSION.padEnd(18)}║
║           local · per-agent authenticated                  ║
╠══════════════════════════════════════════════════════════════╣
║  Endpoint : http://${HOST}:${PORT}
║  MiMo     : ${mimo.available ? "READY" : mimo.enabled ? "NOT CONFIGURED" : "DISABLED"}
║  Gemini   : ${antigravity.available ? "READY" : antigravity.enabled ? "NOT AUTHENTICATED" : "DISABLED"}
║  Codex    : ${codex.available ? "READY" : codex.enabled ? "NOT AUTHENTICATED" : "DISABLED"}
║  Timeout  : ${execution.timeout_ms} ms
║  Max out  : ${execution.max_output_bytes} bytes
║  Config   : ${configMode}
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
  ExecutionAbortedError,
  ExecutionTimeoutError,
  HttpError,
  activeExecutionCount,
  analyzeTask,
  assertAgentsEnabled,
  buildPrompt,
  formatCollaborativeResult,
  orchestrate,
  parseAgentSelection,
  rejectBrowserOrigin,
  requiredAgentsForMode,
  resolveWorkspacePath,
  runProcess,
  server,
  startServer,
};

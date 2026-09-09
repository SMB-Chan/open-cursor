/**
 * Open-Cursor Bridge Extension
 * VS Code/Cursor extension for multi-agent coding.
 */

const vscode = require("vscode");
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomBytes, randomUUID } = require("node:crypto");
const { consumeSse } = require("./sse.js");
const { pollExecutionReceipt, summarizeWorkspaceReceipt } = require("./receipt.js");
const markdownSource = require("node:fs").readFileSync(
  require("node:path").join(__dirname, "markdown.js"),
  "utf8"
);

const DEFAULT_PORT = 9876;
const HEALTH_TIMEOUT_MS = 1500;
const STARTUP_TIMEOUT_MS = 10000;
const RECEIPT_FETCH_ATTEMPTS = 8;
const RECEIPT_FETCH_DELAY_MS = 125;
const RECEIPT_FETCH_TIMEOUT_MS = 1000;

function resolveNodeExecutable() {
  const configured = config().get("nodePath", "node") || "node";
  if (configured !== "node") return configured;

  try {
    execSync("node --version", { stdio: "ignore" });
    return "node";
  } catch {}

  const nvmDir = path.join(os.homedir(), ".nvm", "versions", "node");
  try {
    if (fs.existsSync(nvmDir)) {
      const versions = fs.readdirSync(nvmDir).sort();
      for (let i = versions.length - 1; i >= 0; i--) {
        const candidate = path.join(nvmDir, versions[i], "bin", "node");
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {}

  return "node";
}

let bridgeProcess = null;
let bridgeStartPromise = null;
let outputChannel = null;
let statusBar = null;
let shuttingDown = false;
const activeRequests = new Set();

function config() {
  return vscode.workspace.getConfiguration("openCursor");
}

function bridgeUrl() {
  return `http://127.0.0.1:${config().get("bridgePort", DEFAULT_PORT)}`;
}

function updateStatus(state, detail = "") {
  if (!statusBar) return;

  if (state === "online") {
    statusBar.text = "$(check) Open-Cursor";
    statusBar.tooltip = detail || "Bridge online";
  } else if (state === "starting") {
    statusBar.text = "$(sync~spin) Open-Cursor";
    statusBar.tooltip = "Bridge starting";
  } else {
    statusBar.text = "$(circle-slash) Open-Cursor";
    statusBar.tooltip = detail || "Bridge offline";
  }
}

function bridgeErrorMessage(error) {
  if (error?.name === "AbortError") return "Bridge request timed out or was cancelled";
  return error?.message || String(error);
}

async function fetchBridge(pathname, options = {}, timeoutMs = HEALTH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${bridgeUrl()}${pathname}`, {
      ...options,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error?.message || `Bridge returned HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Bridge did not respond at ${bridgeUrl()}`);
    }
    if (error?.message?.startsWith("Bridge returned") || error?.message?.includes("Browser-origin")) {
      throw error;
    }
    throw new Error(`Bridge not reachable at ${bridgeUrl()}: ${bridgeErrorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

async function isBridgeRunning() {
  try {
    const health = await fetchBridge("/health");
    return health?.status === "ok";
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logProcessStream(stream, prefix) {
  stream?.on("data", (chunk) => {
    outputChannel?.append(`${prefix}${chunk.toString()}`);
  });
}

function setManagedProcess(child) {
  bridgeProcess = child;
  logProcessStream(child.stdout, "[bridge] ");
  logProcessStream(child.stderr, "[bridge:error] ");

  child.once("error", (error) => {
    outputChannel?.appendLine(`[bridge] process error: ${error.message}`);
  });

  child.once("exit", (code, signal) => {
    if (bridgeProcess === child) bridgeProcess = null;
    outputChannel?.appendLine(
      `[bridge] exited code=${code ?? "null"} signal=${signal ?? "none"}`
    );
    if (!shuttingDown) updateStatus("offline", "Managed bridge stopped");
  });
}

async function waitForBridge(child) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode) {
      throw new Error("Bridge process exited during startup");
    }
    if (await isBridgeRunning()) return;
    await sleep(250);
  }
  throw new Error(`Bridge did not become healthy within ${STARTUP_TIMEOUT_MS / 1000}s`);
}

async function startManagedBridge(context, { notify = true } = {}) {
  if (await isBridgeRunning()) {
    updateStatus("online", bridgeProcess ? "Bridge online (managed)" : "Bridge online (external)");
    if (notify) vscode.window.showInformationMessage("Open-Cursor bridge is already running.");
    return;
  }

  if (bridgeStartPromise) return bridgeStartPromise;

  bridgeStartPromise = (async () => {
    updateStatus("starting");

    const serverDir = path.resolve(context.extensionPath, "..", "server");
    const nodePath = resolveNodeExecutable();
    const port = String(config().get("bridgePort", DEFAULT_PORT));

    const userLocalBin = path.join(os.homedir(), ".local", "bin");
    const currentPath = process.env.PATH || "";
    const nodeBinDir = nodePath !== "node" && path.isAbsolute(nodePath) ? path.dirname(nodePath) : "";
    let combinedPath = currentPath;
    if (!combinedPath.includes(userLocalBin)) {
      combinedPath = `${userLocalBin}:${combinedPath}`;
    }
    if (nodeBinDir && !combinedPath.includes(nodeBinDir)) {
      combinedPath = `${nodeBinDir}:${combinedPath}`;
    }

    outputChannel?.appendLine(`[bridge] starting ${nodePath} index.js in ${serverDir}`);
    const child = spawn(nodePath, ["index.js"], {
      cwd: serverDir,
      env: {
        ...process.env,
        PATH: combinedPath,
        BRIDGE_PORT: port,
        BRIDGE_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    setManagedProcess(child);

    try {
      await waitForBridge(child);
      updateStatus("online", "Bridge online (managed by extension)");
      if (notify) vscode.window.showInformationMessage("Open-Cursor bridge started.");
    } catch (error) {
      if (child.exitCode === null) child.kill("SIGTERM");
      if (bridgeProcess === child) bridgeProcess = null;
      updateStatus("offline", "Bridge failed to start");
      throw error;
    }
  })();

  try {
    await bridgeStartPromise;
  } finally {
    bridgeStartPromise = null;
  }
}

async function ensureBridge(context) {
  if (await isBridgeRunning()) {
    updateStatus("online", bridgeProcess ? "Bridge online (managed)" : "Bridge online (external)");
    return;
  }
  await startManagedBridge(context, { notify: false });
}

async function stopManagedBridge({ notify = true } = {}) {
  for (const controller of activeRequests) controller.abort();

  const child = bridgeProcess;
  if (!child || child.exitCode !== null) {
    bridgeProcess = null;
    if (await isBridgeRunning()) {
      updateStatus("online", "Bridge online (external)");
      if (notify) {
        vscode.window.showWarningMessage(
          "The bridge is running, but it was not started by this extension, so it was left untouched."
        );
      }
      return;
    }
    updateStatus("offline");
    if (notify) vscode.window.showInformationMessage("Open-Cursor bridge is not running.");
    return;
  }

  child.kill("SIGTERM");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await Promise.race([exited, sleep(2000)]);
  if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
  if (bridgeProcess === child) bridgeProcess = null;
  updateStatus("offline");
  if (notify) vscode.window.showInformationMessage("Open-Cursor bridge stopped.");
}

function workspacePath() {
  return (
    config().get("workspacePath") ||
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
    process.cwd()
  );
}

async function fetchExecutionReceipt(requestId, options = {}) {
  return pollExecutionReceipt({
    requestId,
    bridgeUrl: bridgeUrl(),
    fetchFn: fetch,
    sleepFn: sleep,
    attempts: options.attempts ?? RECEIPT_FETCH_ATTEMPTS,
    delayMs: options.delayMs ?? RECEIPT_FETCH_DELAY_MS,
    timeoutMs: options.timeoutMs ?? RECEIPT_FETCH_TIMEOUT_MS,
  });
}

async function streamMessage(context, prompt, mode, signal, onEvent, onStarted, preferredRequestId) {
  await ensureBridge(context);

  const selectedMode = mode || config().get("defaultAgent", "collaborative");
  const response = await fetch(`${bridgeUrl()}/v1/chat/completions`, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Workspace-Path": workspacePath(),
      "X-Agent-Mode": selectedMode,
      ...(preferredRequestId ? { "X-Open-Cursor-Request-Id": preferredRequestId } : {}),
    },
    body: JSON.stringify({
      model: selectedMode,
      messages: [{ role: "user", content: prompt }],
      stream: true,
    }),
  });

  const bridgeRequestId = response.headers.get("x-open-cursor-request-id") || preferredRequestId || null;
  if (bridgeRequestId) onStarted?.(bridgeRequestId);

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    const error = new Error(payload?.error?.message || `Bridge returned HTTP ${response.status}`);
    error.workspaceReceipt = payload?.open_cursor?.workspace_receipt || null;
    throw error;
  }

  let workspaceReceipt = null;
  let streamError = null;
  const content = await consumeSse(response, (event) => {
    if (event?.metadata?.workspace_receipt) {
      workspaceReceipt = event.metadata.workspace_receipt;
    }
    if (event?.metadata?.error) {
      streamError = new Error(event.metadata.message || "Bridge execution failed");
      streamError.workspaceReceipt = workspaceReceipt;
    }
    onEvent?.(event);
  });

  if (streamError) throw streamError;
  return { content, requestId: bridgeRequestId, workspaceReceipt };
}

async function showStatus() {
  try {
    const health = await fetchBridge("/health");
    const agents = await fetchBridge("/v1/agents");
    updateStatus("online", bridgeProcess ? "Bridge online (managed)" : "Bridge online (external)");

    const lines = [
      `Bridge: ${health.status}${bridgeProcess ? " (managed by extension)" : " (external)"}`,
      `Billing: ${health.billing}`,
      "",
      "Agents:",
    ];

    for (const agent of Object.values(agents.agents || {})) {
      const status = agent.authenticated ? "READY" : "NOT AUTH";
      lines.push(`  ${agent.name}: ${status} [${agent.strengths.join(", ")}]`);
    }

    try {
      const stats = await fetchBridge("/v1/stats");
      const r = stats.requests || {};
      const uptime = stats.uptime_seconds || 0;
      const uptimeLabel =
        uptime >= 3600
          ? `${Math.floor(uptime / 3600)}h${Math.floor((uptime % 3600) / 60)}m`
          : uptime >= 60
            ? `${Math.floor(uptime / 60)}m${uptime % 60}s`
            : `${uptime}s`;
      lines.push(
        "",
        `Requests: ${r.total ?? 0} total · ${r.completed ?? 0} completed · ${r.failed ?? 0} failed · ${r.cancelled ?? 0} cancelled`,
        `Active: ${r.active ?? 0} · Bridge uptime: ${uptimeLabel}`
      );
    } catch {}

    vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
  } catch (error) {
    updateStatus("offline");
    vscode.window.showErrorMessage(error.message);
  }
}

function registerChatCommand(context) {
  return vscode.commands.registerCommand("openCursor.chat", async () => {
    const panel = vscode.window.createWebviewPanel(
      "openCursorChat",
      "Open-Cursor Chat",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );

    panel.webview.html = getChatHTML(panel.webview);
    let currentRequest = null;

    panel.onDidDispose(() => currentRequest?.controller.abort());

    panel.webview.onDidReceiveMessage(async (msg) => {
      if (msg.type === "cancel") {
        currentRequest?.controller.abort();
        return;
      }
      if (msg.type !== "send" || typeof msg.text !== "string" || currentRequest) return;

      const controller = new AbortController();
      const requestState = {
        id: msg.requestId,
        controller,
        bridgeRequestId: `chatcmpl-${randomUUID()}`,
      };
      currentRequest = requestState;
      activeRequests.add(controller);
      panel.webview.postMessage({
        type: "begin",
        requestId: msg.requestId,
        mode: msg.mode,
      });

      try {
        const result = await streamMessage(
          context,
          msg.text,
          msg.mode,
          controller.signal,
          (event) =>
            panel.webview.postMessage({
              type: "delta",
              requestId: msg.requestId,
              text: event.delta,
              agent: event.agent,
              phase: event.phase,
              metadata: event.metadata,
            }),
          (bridgeRequestId) => {
            requestState.bridgeRequestId = bridgeRequestId;
          },
          requestState.bridgeRequestId
        );
        if (!controller.signal.aborted) {
          panel.webview.postMessage({
            type: "complete",
            requestId: msg.requestId,
            empty: !result.content,
            receipt: summarizeWorkspaceReceipt(result.workspaceReceipt),
          });
        }
      } catch (error) {
        let receipt = error?.workspaceReceipt || null;
        if (!receipt && requestState.bridgeRequestId) {
          receipt = await fetchExecutionReceipt(requestState.bridgeRequestId);
        }
        const receiptSummary = summarizeWorkspaceReceipt(receipt);

        if (controller.signal.aborted || error?.name === "AbortError") {
          panel.webview.postMessage({
            type: "cancelled",
            requestId: msg.requestId,
            receipt: receiptSummary,
          });
        } else {
          panel.webview.postMessage({
            type: "error",
            requestId: msg.requestId,
            text: error.message,
            receipt: receiptSummary,
          });
        }
      } finally {
        activeRequests.delete(controller);
        if (currentRequest?.controller === controller) currentRequest = null;
      }
    });
  });
}

function activate(context) {
  outputChannel = vscode.window.createOutputChannel("Open-Cursor");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 30);
  statusBar.command = "openCursor.showStatus";
  updateStatus("offline");
  statusBar.show();

  context.subscriptions.push(outputChannel, statusBar, registerChatCommand(context));

  context.subscriptions.push(
    vscode.commands.registerCommand("openCursor.startBridge", () =>
      startManagedBridge(context, { notify: true }).catch((error) => {
        outputChannel?.appendLine(`[bridge] startup failed: ${error.stack || error.message}`);
        vscode.window.showErrorMessage(`Open-Cursor bridge failed to start: ${error.message}`);
      })
    ),
    vscode.commands.registerCommand("openCursor.stopBridge", () => stopManagedBridge()),
    vscode.commands.registerCommand("openCursor.showStatus", showStatus),
    vscode.commands.registerCommand("openCursor.selectAgent", async () => {
      const mode = await vscode.window.showQuickPick(
        [
          { label: "Auto", description: "Side-effect-aware automatic routing", value: "auto" },
          {
            label: "Goal Loop",
            description: "Codex goal-driven multi-round execution on one thread",
            value: "goal",
          },
          {
            label: "Autonomous",
            description: "Gemini auto-approved file edits and commands",
            value: "autonomous",
          },
          {
            label: "Collaborative",
            description: "Gemini Plan → Codex Implement → Gemini Review → Codex Refine",
            value: "collaborative",
          },
          {
            label: "Pipeline",
            description: "Gemini Plan → Codex Implement",
            value: "pipeline",
          },
          {
            label: "MiMo + Gemini",
            description: "Read-only plan/review + solution draft",
            value: "mimo-gemini",
          },
          { label: "MiMo", description: "Read-only Xiaomi MiMo response", value: "mimo" },
          { label: "Codex Only", description: "ChatGPT/Codex subscription", value: "codex" },
          { label: "Antigravity Only", description: "Gemini explicit route", value: "antigravity" },
        ],
        { placeHolder: "Select agent routing mode" }
      );

      if (mode) {
        await config().update("defaultAgent", mode.value, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Agent mode set to: ${mode.label}`);
      }
    })
  );

  if (config().get("autoStartBridge", true)) {
    startManagedBridge(context, { notify: false }).catch((error) => {
      updateStatus("offline", "Auto-start failed; click for status");
      outputChannel?.appendLine(`[bridge] auto-start failed: ${error.stack || error.message}`);
    });
  } else {
    isBridgeRunning().then((running) =>
      updateStatus(running ? "online" : "offline", running ? "Bridge online (external)" : "Bridge offline")
    );
  }
}

function getChatHTML(webview) {
  const nonce = randomBytes(16).toString("hex");
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    #messages { height: calc(100vh - 150px); overflow-y: auto; margin-bottom: 10px; }
    .msg { padding: 8px 12px; margin: 6px 0; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    .assistant-card { margin: 8px 0; border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; background: var(--vscode-editor-inactiveSelectionBackground); }
    .run-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); }
    .agent-badge { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .phase-strip { display: flex; gap: 5px; flex-wrap: wrap; min-width: 0; }
    .phase-pill { font-size: 10px; line-height: 1; padding: 4px 7px; border-radius: 999px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
    .phase-pill.active { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .phase-pill.done::before { content: '✓ '; }
    .phase-pill.done { color: var(--vscode-testing-iconPassed); }
    .phase-pill.cancelled { text-decoration: line-through; opacity: .7; }
    .phase-pill.failed { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    .assistant-body { padding: 10px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .assistant-body.thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
    /* Markdown blocks (rendered per block; append-only DOM) */
    .assistant-body { white-space: normal; }
    .md-p { white-space: pre-wrap; margin: 6px 0; }
    .md-heading { margin: 12px 0 4px; line-height: 1.3; }
    .md-h1 { font-size: 1.35em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 3px; }
    .md-h2 { font-size: 1.2em; }
    .md-h3 { font-size: 1.08em; }
    .md-h4, .md-h5, .md-h6 { font-size: 1em; }
    .md-hr { border: none; border-top: 1px solid var(--vscode-widget-border); margin: 10px 0; }
    .md-code-wrap { margin: 8px 0; border: 1px solid var(--vscode-widget-border); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
    .md-code-lang { font-size: 10px; padding: 3px 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border); font-family: var(--vscode-editor-font-family); }
    .md-code { margin: 0; padding: 8px 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.45; white-space: pre; }
    .md-code code { font-family: inherit; white-space: pre; }
    .md-quote { margin: 8px 0; padding: 4px 10px; border-left: 3px solid var(--vscode-focusBorder); color: var(--vscode-descriptionForeground); }
    .md-quote-line { white-space: pre-wrap; margin: 2px 0; }
    .md-list { margin: 6px 0; padding-left: 22px; }
    .md-li { margin: 2px 0; }
    .md-icode { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 1px 4px; }
    /* Copy button on code blocks */
    .md-code-wrap { position: relative; }
    .md-copy { position: absolute; top: 4px; right: 6px; padding: 2px 8px; font-size: 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-widget-border); border-radius: 4px; opacity: 0; transition: opacity .15s; cursor: pointer; }
    .md-code-wrap:hover .md-copy, .md-copy:focus-visible { opacity: 1; }
    .md-copy.copied { opacity: 1; color: var(--vscode-testing-iconPassed); }
    /* Collapse toggle for finished runs */
    .run-toggle { background: none; border: none; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; padding: 2px 6px; }
    .assistant-body.restored { color: var(--vscode-descriptionForeground); }
    .assistant-card.collapsed .assistant-body,
    .assistant-card.collapsed .workspace-receipt { display: none; }
    /* Live elapsed timer */
    .run-timer { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    /* Active phase pulse */
    @keyframes phasePulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    .phase-pill.active { animation: phasePulse 1.6s ease-in-out infinite; }
    /* Clear button */
    #clear { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    #actions { align-items: end; }
    textarea#input { height: auto; }
    .workspace-receipt { margin: 0 10px 10px; padding: 9px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-editor-background); font-size: 11px; }
    .receipt-title { font-weight: 600; margin-bottom: 4px; }
    .receipt-summary { color: var(--vscode-foreground); margin-bottom: 5px; }
    .receipt-safety, .receipt-note, .receipt-warning { color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .receipt-warning { color: var(--vscode-editorWarning-foreground); }
    .receipt-group { margin-top: 6px; }
    .receipt-group-label { font-weight: 600; color: var(--vscode-descriptionForeground); }
    .receipt-paths { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
    .error { color: var(--vscode-errorForeground); }
    #input-area { display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: end; }
    #input { resize: vertical; min-height: 38px; max-height: 180px; padding: 8px; font-family: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    #mode { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 8px; }
    #actions { display: flex; gap: 6px; }
    button { padding: 8px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    #cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    @media (max-width: 560px) {
      #input-area { grid-template-columns: 1fr; }
      #actions { justify-content: flex-end; }
      .run-meta { align-items: flex-start; flex-direction: column; gap: 6px; }
    }
  </style>
</head>
<body>
  <div id="messages" role="log" aria-live="polite" aria-label="Conversation"></div>
  <div id="input-area">
    <select id="mode" aria-label="Agent routing mode">
      <option value="auto">Auto (自動判別)</option>
      <option value="goal">Goal Loop (目標達成まで自動継続)</option>
      <option value="autonomous">Autonomous (承認なし全自動)</option>
      <option value="mimo-gemini">MiMo + Gemini</option>
      <option value="collaborative">Collaborative (Codex + Gemini)</option>
      <option value="pipeline">Pipeline</option>
      <option value="mimo">MiMo</option>
      <option value="antigravity">Antigravity (Gemini)</option>
      <option value="codex">Codex</option>
    </select>
    <textarea id="input" placeholder="Ask anything…  Shift+Enter for a new line" aria-label="Message"></textarea>
    <div id="actions">
      <button id="clear" title="Clear the conversation view">Clear</button>
      <button id="cancel" disabled>Stop</button>
      <button id="send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    // Session transcript: rendered blocks survive panel close/reopen within
    // this webview's lifetime (serializeState on saveState).
    const session = [];
    try {
      const previous = vscode.getState && vscode.getState();
      if (previous && Array.isArray(previous.session)) {
        session.push(...previous.session);
      }
    } catch {}
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const mode = document.getElementById('mode');
    const sendButton = document.getElementById('send');
    const cancelButton = document.getElementById('cancel');
    const clearButton = document.getElementById('clear');

    // Streaming markdown renderer (UMD source inlined; see src/markdown.js).
    ${markdownSource.replace(/<\/script>/g, '<\\/script>')}
    const MD = self.OpenCursorMarkdown;

    const PHASE_LABELS = {
      plan: 'Plan',
      implement: 'Implement',
      review: 'Review',
      refine: 'Refine',
      respond: 'Respond',
      goal: 'Goal Loop'
    };

    let activeRequestId = null;
    let assistantCard = null;
    let assistantBody = null;
    let phaseStrip = null;
    let agentBadge = null;
    let activePhase = null;
    let receivedDelta = false;
    let phaseNodes = new Map();
    let runTimer = null;

    // ── Session transcript persistence ───────────────────────────
    const SESSION_MAX_BYTES = 256 * 1024;

    function recordTurn(role, text) {
      session.push({ r: role, t: text, m: mode.value, at: Date.now() });
      while (session.length > 0) {
        const bytes = session.reduce((sum, entry) => sum + entry.t.length, 0);
        if (bytes <= SESSION_MAX_BYTES && session.length <= 40) break;
        session.shift();
      }
    }

    function persistSession(extra = {}) {
      try {
        vscode.setState({ session, draft: input.value, mode: mode.value, ...extra });
      } catch {}
    }

    function restoreSession() {
      for (const entry of session) {
        if (entry.r === 'u') {
          addMsg('> ' + entry.t, 'user');
          continue;
        }
        createAssistant(entry.m || 'respond');
        if (assistantBody) {
          assistantBody.textContent = '';
          assistantBody.classList.remove('thinking');
          assistantBody.classList.add('restored');
          for (const block of MD.tokenizeBlocks(String(entry.t || '').split('\n'))) {
            assistantBody.appendChild(mdRenderBlock(block));
          }
        }
        if (runTimer) {
          clearInterval(runTimer.interval);
          runTimer.node.textContent = 'logged';
          runTimer = null;
        }
        if (agentBadge) agentBadge.textContent = 'Restored';
        finish();
      }
    }

    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 180) + 'px';
    }

    function addMsg(text, cls) {
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
      return div;
    }

    function phaseKey(rawPhase) {
      const phase = String(rawPhase || '').replace(/-header$/, '');
      if (phase === 'planning' || phase === 'analysis') return 'plan';
      if (phase === 'goal') return 'goal';
      if (phase === 'implementation') return 'implement';
      if (phase === 'review') return 'review';
      if (phase === 'refinement') return 'refine';
      if (phase === 'response') return 'respond';
      return phase || null;
    }

    function agentLabel(agent) {
      if (agent === 'antigravity') return 'Gemini';
      if (agent === 'codex') return 'Codex';
      if (agent === 'collaborative') return 'Collaborative';
      if (agent === 'pipeline') return 'Pipeline';
      return agent || 'Starting';
    }

    function phaseSequence(selectedMode) {
      if (selectedMode === 'collaborative') return ['plan', 'implement', 'review', 'refine'];
      if (selectedMode === 'pipeline') return ['plan', 'implement'];
      if (selectedMode === 'goal') return ['goal'];
      return ['respond'];
    }

    function createAssistant(selectedMode) {
      assistantCard = document.createElement('div');
      assistantCard.className = 'assistant-card';

      const meta = document.createElement('div');
      meta.className = 'run-meta';

      agentBadge = document.createElement('span');
      agentBadge.className = 'agent-badge';
      agentBadge.textContent = 'Starting';
      meta.appendChild(agentBadge);

      const timer = document.createElement('span');
      timer.className = 'run-timer';
      timer.textContent = '0.0s';
      meta.appendChild(timer);
      runTimer = { startedAt: Date.now(), node: timer, interval: null };
      runTimer.interval = setInterval(() => {
        if (!runTimer) return;
        const secs = (Date.now() - runTimer.startedAt) / 1000;
        runTimer.node.textContent = secs >= 60
          ? Math.floor(secs / 60) + 'm' + (secs % 60).toFixed(0).padStart(2, '0') + 's'
          : secs.toFixed(1) + 's';
      }, 100);

      const toggle = document.createElement('button');
      toggle.className = 'run-toggle';
      toggle.setAttribute('aria-label', 'Collapse this response');
      toggle.textContent = '▾';
      toggle.addEventListener('click', () => {
        const collapsed = assistantCard.classList.toggle('collapsed');
        toggle.textContent = collapsed ? '▸' : '▾';
        toggle.setAttribute('aria-label', collapsed ? 'Expand this response' : 'Collapse this response');
      });
      meta.appendChild(toggle);

      phaseStrip = document.createElement('div');
      phaseStrip.className = 'phase-strip';
      phaseNodes = new Map();
      for (const phase of phaseSequence(selectedMode)) {
        const pill = document.createElement('span');
        pill.className = 'phase-pill';
        pill.dataset.phase = phase;
        pill.textContent = PHASE_LABELS[phase] || phase;
        phaseNodes.set(phase, pill);
        phaseStrip.appendChild(pill);
      }
      meta.appendChild(phaseStrip);

      assistantBody = document.createElement('div');
      assistantBody.className = 'assistant-body thinking';
      assistantBody.textContent = 'Starting…';

      assistantCard.appendChild(meta);
      assistantCard.appendChild(assistantBody);
      messages.appendChild(assistantCard);
      messages.scrollTop = messages.scrollHeight;
    }

    function renderReceipt(summary) {
      if (!summary || !assistantCard) return;
      const box = document.createElement('div');
      box.className = 'workspace-receipt';

      const title = document.createElement('div');
      title.className = 'receipt-title';
      title.textContent = summary.title || 'Workspace receipt';
      box.appendChild(title);

      const summaryLine = document.createElement('div');
      summaryLine.className = 'receipt-summary';
      summaryLine.textContent = summary.summary || 'No receipt summary available';
      box.appendChild(summaryLine);

      const safety = document.createElement('div');
      safety.className = 'receipt-safety';
      safety.textContent = summary.rollbackPerformed
        ? 'Rollback was performed.'
        : 'Non-destructive observation · no automatic rollback';
      box.appendChild(safety);

      for (const group of Array.isArray(summary.groups) ? summary.groups : []) {
        const groupNode = document.createElement('div');
        groupNode.className = 'receipt-group';
        const label = document.createElement('div');
        label.className = 'receipt-group-label';
        label.textContent = group.label || 'Paths';
        const paths = document.createElement('pre');
        paths.className = 'receipt-paths';
        paths.textContent = Array.isArray(group.paths) ? group.paths.join('\n') : '';
        groupNode.appendChild(label);
        groupNode.appendChild(paths);
        box.appendChild(groupNode);
      }

      if (summary.warning) {
        const warning = document.createElement('div');
        warning.className = 'receipt-warning';
        warning.textContent = summary.warning;
        box.appendChild(warning);
      }
      if (summary.note) {
        const note = document.createElement('div');
        note.className = 'receipt-note';
        note.textContent = summary.note;
        box.appendChild(note);
      }

      assistantCard.appendChild(box);
      messages.scrollTop = messages.scrollHeight;
    }

    function ensurePhaseNode(phase) {
      if (!phase || !phaseStrip) return null;
      if (phaseNodes.has(phase)) return phaseNodes.get(phase);

      const pill = document.createElement('span');
      pill.className = 'phase-pill';
      pill.dataset.phase = phase;
      pill.textContent = PHASE_LABELS[phase] || phase;
      phaseNodes.set(phase, pill);
      phaseStrip.appendChild(pill);
      return pill;
    }

    function updateExecutionMeta(agent, rawPhase) {
      const phase = phaseKey(rawPhase);
      if (!phase) return;

      if (activePhase && activePhase !== phase) {
        const previous = phaseNodes.get(activePhase);
        if (previous) {
          previous.classList.remove('active');
          previous.classList.add('done');
        }
      }

      const node = ensurePhaseNode(phase);
      if (node) {
        node.classList.remove('done', 'cancelled', 'failed');
        node.classList.add('active');
      }
      activePhase = phase;
      if (agentBadge) {
        agentBadge.textContent = agentLabel(agent) + ' · ' + (PHASE_LABELS[phase] || phase);
      }
    }

    function settleActivePhase(state) {
      if (!activePhase) return;
      const node = phaseNodes.get(activePhase);
      if (!node) return;
      node.classList.remove('active');
      if (state) node.classList.add(state);
    }

    function setBusy(busy) {
      sendButton.disabled = busy;
      cancelButton.disabled = !busy;
      mode.disabled = busy;
      input.disabled = busy;
      if (!busy) input.focus();
    }

    function send() {
      const text = input.value.trim();
      if (!text || activeRequestId) return;
      activeRequestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
      addMsg('> ' + text, 'user');
      recordTurn('u', text);
      vscode.postMessage({ type: 'send', requestId: activeRequestId, text, mode: mode.value });
      input.value = '';
      autoGrow();
      setBusy(true);
      persistSession({ draft: '' });
    }

    function finish() {
      if (runTimer) {
        clearInterval(runTimer.interval);
        if (runTimer.node && assistantCard) {
          const secs = (Date.now() - runTimer.startedAt) / 1000;
          runTimer.node.textContent = secs >= 60
            ? Math.floor(secs / 60) + 'm' + Math.round(secs % 60) + 's'
            : secs.toFixed(1) + 's';
        }
        runTimer = null;
      }
      if (assistantBody) {
        const body = mdStream && mdStream.raw ? mdStream.raw : assistantBody.textContent;
        recordTurn('a', body);
        persistSession();
      }
      activeRequestId = null;
      assistantCard = null;
      assistantBody = null;
      phaseStrip = null;
      agentBadge = null;
      activePhase = null;
      receivedDelta = false;
      phaseNodes = new Map();
      mdReset();
      setBusy(false);
    }

    // ── Incremental markdown rendering ──────────────────────────────
    // Completed blocks become DOM once and are never re-parsed; only the live
    // tail block is touched per frame, so long goal-loop transcripts stay
    // smooth regardless of transcript size.

    let mdStream = null;
    let mdScheduled = false;
    let mdTailEl = null;
    let mdTailIsFence = false;
    let mdRenderedFenceLines = 0;

    function mdReset() {
      mdStream = null;
      mdScheduled = false;
      mdTailEl = null;
      mdTailIsFence = false;
      mdRenderedFenceLines = 0;
    }

    function mdBegin() {
      mdReset();
      mdStream = new MD.MarkdownStream();
    }

    function mdPush(text) {
      if (!mdStream) return;
      mdStream.push(text);
      mdScheduleFlush();
    }

    function mdScheduleFlush() {
      if (mdScheduled) return;
      mdScheduled = true;
      const run = () => {
        mdScheduled = false;
        mdFlush();
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, 16);
    }

    function mdFlush(final) {
      if (!mdStream || !assistantBody) return;
      const wasPinned = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;

      const result = final ? mdStream.drainFinal() : mdStream.drain();
      for (const block of result.stable) {
        mdRemoveTailEl();
        assistantBody.appendChild(mdRenderBlock(block));
      }
      if (final) {
        if (result.tail) assistantBody.appendChild(mdRenderBlock(result.tail));
        mdRemoveTailEl();
      } else {
        mdUpdateTail(result.tail);
      }

      if (wasPinned) messages.scrollTop = messages.scrollHeight;
    }

    function mdRemoveTailEl() {
      if (mdTailEl && mdTailEl.parentNode) mdTailEl.parentNode.removeChild(mdTailEl);
      mdTailEl = null;
      mdTailIsFence = false;
      mdRenderedFenceLines = 0;
    }

    function mdUpdateTail(tail) {
      if (!assistantBody) return;
      if (!tail) {
        mdRemoveTailEl();
        return;
      }

      // An open fence grows append-only: push new body lines into the
      // existing text node instead of re-rendering the whole block.
      if (tail.type === 'code' && tail.open) {
        if (mdTailEl && mdTailIsFence) {
          mdAppendFenceLines(tail.body);
          return;
        }
        mdRemoveTailEl();
        mdTailEl = mdRenderBlock(tail);
        mdTailIsFence = true;
        mdRenderedFenceLines = 0;
        mdAppendFenceLines(tail.body);
        assistantBody.appendChild(mdTailEl);
        return;
      }

      // Non-fence tails (paragraphs, lists, quotes) are small: re-render.
      mdRemoveTailEl();
      mdTailEl = mdRenderBlock(tail);
      assistantBody.appendChild(mdTailEl);
    }

    function mdAppendFenceLines(bodyLines) {
      const codeNode = mdTailEl && mdTailEl.querySelector ? mdTailEl.querySelector('code') : null;
      if (!codeNode) return;
      for (let i = mdRenderedFenceLines; i < bodyLines.length; i++) {
        codeNode.appendChild(document.createTextNode((i > 0 ? '\n' : '') + bodyLines[i]));
      }
      mdRenderedFenceLines = bodyLines.length;
    }

    function mdRenderBlock(block) {
      if (block.type === 'heading') {
        const level = Math.max(1, Math.min(6, block.level || 1));
        const el = document.createElement('h' + level);
        el.className = 'md-heading md-h' + level;
        mdRenderInline(block.text, el);
        return el;
      }
      if (block.type === 'hr') {
        const el = document.createElement('hr');
        el.className = 'md-hr';
        return el;
      }
      if (block.type === 'code') {
        const wrap = document.createElement('div');
        wrap.className = 'md-code-wrap';
        if (block.lang) {
          const lang = document.createElement('div');
          lang.className = 'md-code-lang';
          lang.textContent = block.lang;
          wrap.appendChild(lang);
        }
        const pre = document.createElement('pre');
        pre.className = 'md-code';
        const code = document.createElement('code');
        code.textContent = block.body.join('\n');
        pre.appendChild(code);
        wrap.appendChild(pre);
        const copy = document.createElement('button');
        copy.className = 'md-copy';
        copy.textContent = 'Copy';
        copy.setAttribute('aria-label', 'Copy code to clipboard');
        copy.addEventListener('click', () => {
          navigator.clipboard.writeText(block.body.join('\n')).then(() => {
            copy.textContent = 'Copied';
            copy.classList.add('copied');
            setTimeout(() => {
              copy.textContent = 'Copy';
              copy.classList.remove('copied');
            }, 1200);
          }).catch(() => {});
        });
        wrap.appendChild(copy);
        return wrap;
      }
      if (block.type === 'quote') {
        const el = document.createElement('blockquote');
        el.className = 'md-quote';
        for (const line of block.lines) {
          const p = document.createElement('div');
          p.className = 'md-quote-line';
          mdRenderInline(line, p);
          el.appendChild(p);
        }
        return el;
      }
      if (block.type === 'list') {
        const el = document.createElement(block.ordered ? 'ol' : 'ul');
        el.className = 'md-list';
        for (const item of block.items) {
          const li = document.createElement('li');
          li.className = 'md-li';
          mdRenderInline(item.join(' '), li);
          el.appendChild(li);
        }
        return el;
      }
      const p = document.createElement('p');
      p.className = 'md-p';
      mdRenderInline(block.lines.join('\n'), p);
      return p;
    }

    function mdRenderInline(text, parent) {
      for (const token of MD.tokenizeInline(text)) {
        if (token.t === 'code') {
          const code = document.createElement('code');
          code.className = 'md-icode';
          code.textContent = token.v;
          parent.appendChild(code);
        } else if (token.t === 'bold') {
          const strong = document.createElement('strong');
          strong.textContent = token.v;
          parent.appendChild(strong);
        } else {
          parent.appendChild(document.createTextNode(token.v));
        }
      }
    }

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    });
    sendButton.addEventListener('click', send);
    cancelButton.addEventListener('click', () => {
      if (activeRequestId) vscode.postMessage({ type: 'cancel', requestId: activeRequestId });
    });
    clearButton.addEventListener('click', () => {
      if (activeRequestId) return;
      messages.textContent = '';
      session.length = 0;
      persistSession();
      input.focus();
    });
    // Esc cancels the running request (standard chat UX).
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && activeRequestId && !cancelButton.disabled) {
        vscode.postMessage({ type: 'cancel', requestId: activeRequestId });
      }
    });

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.requestId !== activeRequestId) return;

      if (msg.type === 'begin') {
        createAssistant(msg.mode || mode.value);
      } else if (msg.type === 'delta') {
        if (!assistantCard) createAssistant(mode.value);
        updateExecutionMeta(msg.agent, msg.phase);

        if (typeof msg.text === 'string' && msg.text.length > 0) {
          if (!receivedDelta) {
            if (!mdStream) mdBegin();
            assistantBody.textContent = '';
            assistantBody.classList.remove('thinking');
            receivedDelta = true;
          }
          mdPush(msg.text);
        }
      } else if (msg.type === 'complete') {
        settleActivePhase('done');
        if (agentBadge) agentBadge.textContent = 'Complete';
        if (assistantBody && !receivedDelta) {
          assistantBody.textContent = msg.empty ? 'No response' : assistantBody.textContent;
          assistantBody.classList.remove('thinking');
        }
        if (receivedDelta && mdStream) mdFlush(true);
        renderReceipt(msg.receipt);
        finish();
      } else if (msg.type === 'cancelled') {
        settleActivePhase('cancelled');
        if (agentBadge) agentBadge.textContent = 'Cancelled';
        if (assistantBody) {
          if (!receivedDelta) assistantBody.textContent = 'Cancelled.';
          else assistantBody.textContent += '\n\n[Cancelled]';
          assistantBody.classList.remove('thinking');
        }
        if (receivedDelta && mdStream) mdFlush(true);
        renderReceipt(msg.receipt);
        finish();
      } else if (msg.type === 'error') {
        settleActivePhase('failed');
        if (agentBadge) agentBadge.textContent = 'Failed';
        if (assistantBody) {
          if (!receivedDelta) assistantBody.textContent = msg.text;
          else {
            if (mdStream) mdFlush(true);
            assistantBody.textContent += '\n\n[Failed: ' + msg.text + ']';
          }
          assistantBody.classList.remove('thinking');
          assistantBody.classList.add('error');
        } else {
          addMsg(msg.text, 'error');
        }
        renderReceipt(msg.receipt);
        finish();
      }
    });

    // ── Init: restore previous conversation, draft and mode ──
    try {
      const prev = vscode.getState && vscode.getState();
      if (prev) {
        if (prev.mode && Array.prototype.some.call(mode.options, (o) => o.value === prev.mode)) {
          mode.value = prev.mode;
        }
        if (typeof prev.draft === 'string' && prev.draft) {
          input.value = prev.draft;
          autoGrow();
        }
      }
    } catch {}
    restoreSession();
    messages.scrollTop = messages.scrollHeight;

    input.addEventListener('input', autoGrow);
    mode.addEventListener('change', () => persistSession());
  </script>
</body>
</html>`;
}

async function deactivate() {
  shuttingDown = true;
  for (const controller of activeRequests) controller.abort();
  await stopManagedBridge({ notify: false });
}

module.exports = { activate, deactivate };

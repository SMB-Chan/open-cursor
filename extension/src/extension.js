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
  <div id="messages" aria-live="polite"></div>
  <div id="input-area">
    <select id="mode" aria-label="Agent routing mode">
      <option value="auto">Auto (自動判別)</option>
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
      <button id="cancel" disabled>Stop</button>
      <button id="send">Send</button>
    </div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const mode = document.getElementById('mode');
    const sendButton = document.getElementById('send');
    const cancelButton = document.getElementById('cancel');

    const PHASE_LABELS = {
      plan: 'Plan',
      implement: 'Implement',
      review: 'Review',
      refine: 'Refine',
      respond: 'Respond'
    };

    let activeRequestId = null;
    let assistantCard = null;
    let assistantBody = null;
    let phaseStrip = null;
    let agentBadge = null;
    let activePhase = null;
    let receivedDelta = false;
    let phaseNodes = new Map();

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
      vscode.postMessage({ type: 'send', requestId: activeRequestId, text, mode: mode.value });
      input.value = '';
      setBusy(true);
    }

    function finish() {
      activeRequestId = null;
      assistantCard = null;
      assistantBody = null;
      phaseStrip = null;
      agentBadge = null;
      activePhase = null;
      receivedDelta = false;
      phaseNodes = new Map();
      setBusy(false);
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
            assistantBody.textContent = '';
            assistantBody.classList.remove('thinking');
            receivedDelta = true;
          }
          assistantBody.textContent += msg.text;
          messages.scrollTop = messages.scrollHeight;
        }
      } else if (msg.type === 'complete') {
        settleActivePhase('done');
        if (agentBadge) agentBadge.textContent = 'Complete';
        if (assistantBody && !receivedDelta) {
          assistantBody.textContent = msg.empty ? 'No response' : assistantBody.textContent;
          assistantBody.classList.remove('thinking');
        }
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
        renderReceipt(msg.receipt);
        finish();
      } else if (msg.type === 'error') {
        settleActivePhase('failed');
        if (agentBadge) agentBadge.textContent = 'Failed';
        if (assistantBody) {
          if (!receivedDelta) assistantBody.textContent = msg.text;
          else assistantBody.textContent += '\n\n[Failed: ' + msg.text + ']';
          assistantBody.classList.remove('thinking');
          assistantBody.classList.add('error');
        } else {
          addMsg(msg.text, 'error');
        }
        renderReceipt(msg.receipt);
        finish();
      }
    });
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

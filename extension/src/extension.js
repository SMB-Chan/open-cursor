/**
 * Open-Cursor Bridge Extension
 * VS Code/Cursor extension for multi-agent coding.
 */

const vscode = require("vscode");
const { spawn, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { consumeSse } = require("./sse.js");
const { pollExecutionReceipt, summarizeWorkspaceReceipt } = require("./receipt.js");
const { getChatHTML } = require("./chat-html.js");

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
let chatPanel = null;
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
    statusBar.tooltip = detail || "Bridge online · click for status (Command Palette: Update Open-Cursor)";
  } else if (state === "starting") {
    statusBar.text = "$(sync~spin) Open-Cursor";
    statusBar.tooltip = "Bridge starting";
  } else {
    statusBar.text = "$(circle-slash) Open-Cursor";
    statusBar.tooltip = detail || "Bridge offline";
  }
}

// Startup update check: git fetch + ahead-count only; never mutates anything.
async function checkForUpdatesQuietly() {
  const repoDir = path.resolve(context.extensionPath, "..");
  const localVersion = require(path.join(repoDir, "extension", "package.json")).version;

  const git = (args) => new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd: repoDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.once("error", () => resolvePromise(null));
    child.once("exit", (code) => resolvePromise(code === 0 ? out.trim() : null));
  });

  await git(["fetch", "origin", "--quiet"]);
  const ahead = await git(["rev-list", "--count", "origin/master..HEAD"]);
  const behind = await git(["rev-list", "--count", "HEAD..origin/master"]);
  if (behind && Number(behind) > 0) {
    const action = await vscode.window.showInformationMessage(
      `Open-Cursor v${localVersion}: ${behind} update(s) available on GitHub.`,
      "Update Now",
      "Later"
    );
    if (action === "Update Now") await runOpenCursorUpdate(context);
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

let updateInProgress = false;

async function runOpenCursorUpdate(context) {
  if (updateInProgress) {
    vscode.window.showInformationMessage("An Open-Cursor update is already running.");
    return;
  }

  const confirmItem = await vscode.window.showInformationMessage(
    "Update Open-Cursor? (git pull + syntax/test checks + bridge restart + registry refresh)",
    { modal: true },
    "Update"
  );
  if (confirmItem !== "Update") return;

  const repoDir = path.resolve(context.extensionPath, "..");
  const updateScript = path.join(repoDir, "bin", "update.sh");
  if (!fs.existsSync(updateScript)) {
    vscode.window.showErrorMessage(`Update script not found: ${updateScript}`);
    return;
  }

  updateInProgress = true;
  outputChannel?.show(true);
  outputChannel?.appendLine(`[update] running ${updateScript} …`);
  const progress = vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Open-Cursor update", cancellable: false },
    () => new Promise((resolvePromise) => {
      const child = spawn("bash", [updateScript, "--yes"], {
        cwd: repoDir,
        env: {
          ...process.env,
          PATH: `${path.join(os.homedir(), ".local", "bin")}:${process.env.PATH || ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      logProcessStream(child.stdout, "[update] ");
      logProcessStream(child.stderr, "[update:error] ");
      child.once("error", (error) => {
        outputChannel?.appendLine(`[update] spawn error: ${error.message}`);
        resolvePromise({ ok: false, error });
      });
      child.once("exit", (code, signal) => {
        outputChannel?.appendLine(`[update] exited code=${code ?? "null"} signal=${signal ?? "none"}`);
        resolvePromise({ ok: code === 0 });
      });
    })
  );

  const result = await progress;
  updateInProgress = false;

  if (result.ok) {
    const action = await vscode.window.showInformationMessage(
      "Open-Cursor update finished. Reload Cursor to load the updated extension?",
      "Reload Window"
    );
    if (action === "Reload Window") {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
  } else {
    vscode.window.showErrorMessage(
      "Open-Cursor update failed — see the Open-Cursor output channel. Uncommitted changes block git pull; commit or stash first."
    );
  }
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
    // Reuse the existing panel instead of stacking duplicates.
    if (chatPanel) {
      chatPanel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "openCursorChat",
      "Open-Cursor Chat",
      vscode.ViewColumn.Beside,
      { enableScripts: true }
    );
    chatPanel = panel;

    panel.webview.html = getChatHTML(panel.webview);
    let currentRequest = null;

    panel.onDidDispose(() => {
      if (chatPanel === panel) chatPanel = null;
      currentRequest?.controller.abort();
    });

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
    vscode.commands.registerCommand("openCursor.update", () => runOpenCursorUpdate(context)),
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

  if (config().get("updateOnStartup", false)) {
    checkForUpdatesQuietly().catch((error) => {
      outputChannel?.appendLine(`[update] startup check failed: ${error.message}`);
    });
  }

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

async function deactivate() {
  shuttingDown = true;
  for (const controller of activeRequests) controller.abort();
  await stopManagedBridge({ notify: false });
}

module.exports = { activate, deactivate };

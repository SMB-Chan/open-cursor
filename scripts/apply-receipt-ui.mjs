import fs from "node:fs";

function replaceOrFail(text, pattern, replacement, label) {
  const next = text.replace(pattern, replacement);
  if (next === text) throw new Error(`receipt UI anchor not found: ${label}`);
  return next;
}

const extensionPath = "extension/src/extension.js";
let text = fs.readFileSync(extensionPath, "utf8");

text = replaceOrFail(
  text,
  'const { consumeSse } = require("./sse.js");',
  'const { consumeSse } = require("./sse.js");\nconst { summarizeWorkspaceReceipt } = require("./receipt.js");',
  "receipt helper import"
);

text = replaceOrFail(
  text,
  "const STARTUP_TIMEOUT_MS = 10000;",
  [
    "const STARTUP_TIMEOUT_MS = 10000;",
    "const RECEIPT_FETCH_ATTEMPTS = 8;",
    "const RECEIPT_FETCH_DELAY_MS = 125;",
    "const RECEIPT_FETCH_TIMEOUT_MS = 1000;",
  ].join("\n"),
  "receipt polling constants"
);

const streamReplacement = [
  "async function fetchExecutionReceipt(requestId, options = {}) {",
  "  if (!requestId) return null;",
  "  const attempts = Number.isInteger(options.attempts)",
  "    ? Math.max(1, options.attempts)",
  "    : RECEIPT_FETCH_ATTEMPTS;",
  "  const delayMs = Number.isInteger(options.delayMs)",
  "    ? Math.max(0, options.delayMs)",
  "    : RECEIPT_FETCH_DELAY_MS;",
  "",
  "  for (let attempt = 0; attempt < attempts; attempt += 1) {",
  "    const controller = new AbortController();",
  "    const timer = setTimeout(() => controller.abort(), RECEIPT_FETCH_TIMEOUT_MS);",
  "    try {",
  '      const response = await fetch(`${bridgeUrl()}/v1/execution-receipts/${encodeURIComponent(requestId)}`, {',
  '        method: "GET",',
  "        signal: controller.signal,",
  "      });",
  "      if (response.ok) {",
  "        const payload = await response.json().catch(() => ({}));",
  "        return payload?.receipt || null;",
  "      }",
  "      if (response.status !== 404) return null;",
  "    } catch {}",
  "    finally {",
  "      clearTimeout(timer);",
  "    }",
  "",
  "    if (attempt + 1 < attempts && delayMs > 0) await sleep(delayMs);",
  "  }",
  "  return null;",
  "}",
  "",
  "async function streamMessage(context, prompt, mode, signal, onEvent, onStarted) {",
  "  await ensureBridge(context);",
  "",
  '  const selectedMode = mode || config().get("defaultAgent", "collaborative");',
  '  const response = await fetch(`${bridgeUrl()}/v1/chat/completions`, {',
  '    method: "POST",',
  "    signal,",
  "    headers: {",
  '      "Content-Type": "application/json",',
  '      "X-Workspace-Path": workspacePath(),',
  '      "X-Agent-Mode": selectedMode,',
  "    },",
  "    body: JSON.stringify({",
  "      model: selectedMode,",
  '      messages: [{ role: "user", content: prompt }],',
  "      stream: true,",
  "    }),",
  "  });",
  "",
  '  const bridgeRequestId = response.headers.get("x-open-cursor-request-id");',
  "  if (bridgeRequestId) onStarted?.(bridgeRequestId);",
  "",
  "  if (!response.ok) {",
  "    const payload = await response.json().catch(() => ({}));",
  '    const error = new Error(payload?.error?.message || `Bridge returned HTTP ${response.status}`);',
  "    error.workspaceReceipt = payload?.open_cursor?.workspace_receipt || null;",
  "    throw error;",
  "  }",
  "",
  "  let workspaceReceipt = null;",
  "  let streamError = null;",
  "  const content = await consumeSse(response, (event) => {",
  "    if (event?.metadata?.workspace_receipt) {",
  "      workspaceReceipt = event.metadata.workspace_receipt;",
  "    }",
  "    if (event?.metadata?.error) {",
  '      streamError = new Error(event.metadata.message || "Bridge execution failed");',
  "      streamError.workspaceReceipt = workspaceReceipt;",
  "    }",
  "    onEvent?.(event);",
  "  });",
  "",
  "  if (streamError) throw streamError;",
  "  return { content, requestId: bridgeRequestId, workspaceReceipt };",
  "}",
  "",
  "async function showStatus",
].join("\n");

text = replaceOrFail(
  text,
  /async function streamMessage\([\s\S]*?\n}\n\nasync function showStatus/,
  streamReplacement,
  "stream receipt integration"
);

const requestReplacement = [
  "      const controller = new AbortController();",
  "      const requestState = { id: msg.requestId, controller, bridgeRequestId: null };",
  "      currentRequest = requestState;",
  "      activeRequests.add(controller);",
  "      panel.webview.postMessage({",
  '        type: "begin",',
  "        requestId: msg.requestId,",
  "        mode: msg.mode,",
  "      });",
  "",
  "      try {",
  "        const result = await streamMessage(",
  "          context,",
  "          msg.text,",
  "          msg.mode,",
  "          controller.signal,",
  "          (event) =>",
  "            panel.webview.postMessage({",
  '              type: "delta",',
  "              requestId: msg.requestId,",
  "              text: event.delta,",
  "              agent: event.agent,",
  "              phase: event.phase,",
  "              metadata: event.metadata,",
  "            }),",
  "          (bridgeRequestId) => {",
  "            requestState.bridgeRequestId = bridgeRequestId;",
  "          }",
  "        );",
  "        if (!controller.signal.aborted) {",
  "          panel.webview.postMessage({",
  '            type: "complete",',
  "            requestId: msg.requestId,",
  "            empty: !result.content,",
  "            receipt: summarizeWorkspaceReceipt(result.workspaceReceipt),",
  "          });",
  "        }",
  "      } catch (error) {",
  "        let receipt = error?.workspaceReceipt || null;",
  "        if (!receipt && requestState.bridgeRequestId) {",
  "          receipt = await fetchExecutionReceipt(requestState.bridgeRequestId);",
  "        }",
  "        const receiptSummary = summarizeWorkspaceReceipt(receipt);",
  "",
  '        if (controller.signal.aborted || error?.name === "AbortError") {',
  "          panel.webview.postMessage({",
  '            type: "cancelled",',
  "            requestId: msg.requestId,",
  "            receipt: receiptSummary,",
  "          });",
  "        } else {",
  "          panel.webview.postMessage({",
  '            type: "error",',
  "            requestId: msg.requestId,",
  "            text: error.message,",
  "            receipt: receiptSummary,",
  "          });",
  "        }",
  "      } finally {",
  "        activeRequests.delete(controller);",
  "        if (currentRequest?.controller === controller) currentRequest = null;",
  "      }",
].join("\n");

text = replaceOrFail(
  text,
  /      const controller = new AbortController\(\);\n      currentRequest = \{ id: msg\.requestId, controller \};[\s\S]*?      \} finally \{\n        activeRequests\.delete\(controller\);\n        if \(currentRequest\?\.controller === controller\) currentRequest = null;\n      \}/,
  requestReplacement,
  "request receipt lifecycle"
);

const quickPickReplacement = [
  "      const mode = await vscode.window.showQuickPick(",
  "        [",
  '          { label: "Auto", description: "Side-effect-aware automatic routing", value: "auto" },',
  "          {",
  '            label: "Autonomous",',
  '            description: "Gemini auto-approved file edits and commands",',
  '            value: "autonomous",',
  "          },",
  "          {",
  '            label: "Collaborative",',
  '            description: "Gemini Plan → Codex Implement → Gemini Review → Codex Refine",',
  '            value: "collaborative",',
  "          },",
  "          {",
  '            label: "Pipeline",',
  '            description: "Gemini Plan → Codex Implement",',
  '            value: "pipeline",',
  "          },",
  "          {",
  '            label: "MiMo + Gemini",',
  '            description: "Read-only plan/review + solution draft",',
  '            value: "mimo-gemini",',
  "          },",
  '          { label: "MiMo", description: "Read-only Xiaomi MiMo response", value: "mimo" },',
  '          { label: "Codex Only", description: "ChatGPT/Codex subscription", value: "codex" },',
  '          { label: "Antigravity Only", description: "Gemini explicit route", value: "antigravity" },',
  "        ],",
  '        { placeHolder: "Select agent routing mode" }',
  "      );",
].join("\n");

text = replaceOrFail(
  text,
  /      const mode = await vscode\.window\.showQuickPick\([\s\S]*?        \{ placeHolder: "Select agent routing mode" \}\n      \);/,
  quickPickReplacement,
  "routing quick pick"
);

text = replaceOrFail(
  text,
  "    .assistant-body.thinking { color: var(--vscode-descriptionForeground); font-style: italic; }",
  [
    "    .assistant-body.thinking { color: var(--vscode-descriptionForeground); font-style: italic; }",
    "    .workspace-receipt { margin: 0 10px 10px; padding: 9px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-editor-background); font-size: 11px; }",
    "    .receipt-title { font-weight: 600; margin-bottom: 4px; }",
    "    .receipt-summary { color: var(--vscode-foreground); margin-bottom: 5px; }",
    "    .receipt-safety, .receipt-note, .receipt-warning { color: var(--vscode-descriptionForeground); margin-top: 4px; }",
    "    .receipt-warning { color: var(--vscode-editorWarning-foreground); }",
    "    .receipt-group { margin-top: 6px; }",
    "    .receipt-group-label { font-weight: 600; color: var(--vscode-descriptionForeground); }",
    "    .receipt-paths { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }",
  ].join("\n"),
  "receipt CSS"
);

const renderReceipt = [
  "    function renderReceipt(summary) {",
  "      if (!summary || !assistantCard) return;",
  "      const box = document.createElement('div');",
  "      box.className = 'workspace-receipt';",
  "",
  "      const title = document.createElement('div');",
  "      title.className = 'receipt-title';",
  "      title.textContent = summary.title || 'Workspace receipt';",
  "      box.appendChild(title);",
  "",
  "      const summaryLine = document.createElement('div');",
  "      summaryLine.className = 'receipt-summary';",
  "      summaryLine.textContent = summary.summary || 'No receipt summary available';",
  "      box.appendChild(summaryLine);",
  "",
  "      const safety = document.createElement('div');",
  "      safety.className = 'receipt-safety';",
  "      safety.textContent = summary.rollbackPerformed",
  "        ? 'Rollback was performed.'",
  "        : 'Non-destructive observation · no automatic rollback';",
  "      box.appendChild(safety);",
  "",
  "      for (const group of Array.isArray(summary.groups) ? summary.groups : []) {",
  "        const groupNode = document.createElement('div');",
  "        groupNode.className = 'receipt-group';",
  "        const label = document.createElement('div');",
  "        label.className = 'receipt-group-label';",
  "        label.textContent = group.label || 'Paths';",
  "        const paths = document.createElement('pre');",
  "        paths.className = 'receipt-paths';",
  "        paths.textContent = Array.isArray(group.paths) ? group.paths.join('\\n') : '';",
  "        groupNode.appendChild(label);",
  "        groupNode.appendChild(paths);",
  "        box.appendChild(groupNode);",
  "      }",
  "",
  "      if (summary.warning) {",
  "        const warning = document.createElement('div');",
  "        warning.className = 'receipt-warning';",
  "        warning.textContent = summary.warning;",
  "        box.appendChild(warning);",
  "      }",
  "      if (summary.note) {",
  "        const note = document.createElement('div');",
  "        note.className = 'receipt-note';",
  "        note.textContent = summary.note;",
  "        box.appendChild(note);",
  "      }",
  "",
  "      assistantCard.appendChild(box);",
  "      messages.scrollTop = messages.scrollHeight;",
  "    }",
  "",
  "    function ensurePhaseNode",
].join("\n");

text = replaceOrFail(
  text,
  "    function ensurePhaseNode",
  renderReceipt,
  "receipt renderer"
);

text = replaceOrFail(
  text,
  "        finish();\n      } else if (msg.type === 'cancelled') {",
  "        renderReceipt(msg.receipt);\n        finish();\n      } else if (msg.type === 'cancelled') {",
  "complete receipt render"
);

text = replaceOrFail(
  text,
  "          assistantBody.classList.remove('thinking');\n        }\n        finish();\n      } else if (msg.type === 'error') {",
  "          assistantBody.classList.remove('thinking');\n        }\n        renderReceipt(msg.receipt);\n        finish();\n      } else if (msg.type === 'error') {",
  "cancel receipt render"
);

text = replaceOrFail(
  text,
  "        if (assistantBody) {\n          assistantBody.textContent = msg.text;\n          assistantBody.classList.remove('thinking');\n          assistantBody.classList.add('error');\n        } else {\n          addMsg(msg.text, 'error');\n        }\n        finish();",
  "        if (assistantBody) {\n          if (!receivedDelta) assistantBody.textContent = msg.text;\n          else assistantBody.textContent += '\\n\\n[Failed: ' + msg.text + ']';\n          assistantBody.classList.remove('thinking');\n          assistantBody.classList.add('error');\n        } else {\n          addMsg(msg.text, 'error');\n        }\n        renderReceipt(msg.receipt);\n        finish();",
  "error receipt render"
);

fs.writeFileSync(extensionPath, text);

const packagePath = "extension/package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.version = "2.4.0";
pkg.description = "Codex + Antigravity + optional MiMo multi-agent coding bridge with execution receipts";
const selectCommand = pkg.contributes?.commands?.find((command) => command.command === "openCursor.selectAgent");
if (selectCommand) selectCommand.title = "Open-Cursor: Select Agent Routing Mode";
const defaultAgent = pkg.contributes?.configuration?.properties?.["openCursor.defaultAgent"];
if (!defaultAgent) throw new Error("defaultAgent configuration missing");
defaultAgent.enum = [
  "auto",
  "autonomous",
  "collaborative",
  "pipeline",
  "mimo-gemini",
  "mimo",
  "codex",
  "antigravity",
];
defaultAgent.description =
  "Default agent routing mode. Auto is side-effect-aware; Autonomous explicitly enables auto-approved Gemini edits/commands.";
pkg.scripts.check =
  "node --check src/extension.js && node --check src/sse.js && node --check src/receipt.js && node --check src/sse.test.js && node --check src/receipt.test.js";
pkg.scripts.test = "node --test src/sse.test.js src/receipt.test.js";
fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

const readmePath = "README.md";
let readme = fs.readFileSync(readmePath, "utf8");
readme = replaceOrFail(
  readme,
  "A single `chatcmpl-*` ID is retained for the entire stream and is also exposed as `X-Open-Cursor-Request-Id`.\n\n## Runtime configuration",
  [
    "A single `chatcmpl-*` ID is retained for the entire stream and is also exposed as `X-Open-Cursor-Request-Id`.",
    "",
    "### Workspace execution receipts",
    "",
    "Write-capable requests record a bounded, non-destructive Git receipt before and after execution. The receipt distinguishes newly dirty paths, pre-existing dirty paths, paths that became clean, HEAD changes, and files committed during the request. Secret-like paths are omitted from the public receipt.",
    "",
    "Receipts never automatically stash, reset, or roll back the workspace. They are observations, not proof that the agent alone caused every observed change.",
    "",
    "Successful and failed streaming runs include the receipt in final `open_cursor.workspace_receipt` metadata. If the client disconnects or **Stop** aborts the stream, the extension retains `X-Open-Cursor-Request-Id` and retrieves the finalized receipt from:",
    "",
    "```text",
    "GET /v1/execution-receipts/<chatcmpl-id>",
    "```",
    "",
    "Receipts are held only in bounded bridge memory (maximum 100 entries, one-hour TTL) and are not persisted to disk.",
    "",
    "## Runtime configuration",
  ].join("\n"),
  "README receipt section"
);
readme = readme.replace(
  "Open-Cursor: Select Agent (Codex/Antigravity/Collaborative)",
  "Open-Cursor: Select Agent Routing Mode"
);
fs.writeFileSync(readmePath, readme);

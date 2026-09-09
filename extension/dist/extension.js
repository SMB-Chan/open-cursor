// src/extension.js
var vscode = require("vscode");
var DEFAULT_PORT = 9876;
var BRIDGE_URL = () => {
  const cfg = vscode.workspace.getConfiguration("openCursor");
  return `http://127.0.0.1:${cfg.get("bridgePort", DEFAULT_PORT)}`;
};
async function fetchBridge(path, options = {}) {
  const url = `${BRIDGE_URL()}${path}`;
  try {
    const resp = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers
      }
    });
    return await resp.json();
  } catch (e) {
    throw new Error(`Bridge not reachable at ${BRIDGE_URL()}. Is the bridge server running?`);
  }
}
async function sendMessage(prompt, mode) {
  const cfg = vscode.workspace.getConfiguration("openCursor");
  const workspacePath = cfg.get("workspacePath") || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
  const response = await fetchBridge("/v1/chat/completions", {
    method: "POST",
    headers: {
      "X-Workspace-Path": workspacePath,
      "X-Agent-Mode": mode || cfg.get("defaultAgent", "collaborative")
    },
    body: JSON.stringify({
      model: mode || cfg.get("defaultAgent", "collaborative"),
      messages: [{ role: "user", content: prompt }],
      stream: false
    })
  });
  return response.choices?.[0]?.message?.content || "No response";
}
function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("openCursor.chat", async () => {
      const panel = vscode.window.createWebviewPanel(
        "openCursorChat",
        "Open-Cursor Chat",
        vscode.ViewColumn.Beside,
        { enableScripts: true }
      );
      panel.webview.html = getChatHTML();
      panel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === "send") {
          panel.webview.postMessage({ type: "thinking" });
          try {
            const reply = await sendMessage(msg.text, msg.mode);
            panel.webview.postMessage({ type: "reply", text: reply });
          } catch (e) {
            panel.webview.postMessage({ type: "error", text: e.message });
          }
        }
      });
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("openCursor.startBridge", async () => {
      const terminal = vscode.window.createTerminal("Open-Cursor Bridge");
      terminal.sendText(
        `cd ${context.extensionPath}/../server && node index.js`
      );
      terminal.show();
      vscode.window.showInformationMessage("Open-Cursor bridge starting...");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("openCursor.stopBridge", async () => {
      try {
        await fetchBridge("/health");
        vscode.window.showInformationMessage(
          "To stop the bridge, close the terminal running it or kill PID from bridge.pid"
        );
      } catch {
        vscode.window.showInformationMessage("Bridge is not running.");
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("openCursor.showStatus", async () => {
      try {
        const health = await fetchBridge("/health");
        const agents = await fetchBridge("/v1/agents");
        const lines = [
          `Bridge: ${health.status}`,
          `Billing: ${health.billing}`,
          "",
          "Agents:"
        ];
        for (const [key, agent] of Object.entries(agents.agents)) {
          const status = agent.authenticated ? "READY" : "NOT AUTH";
          lines.push(`  ${agent.name}: ${status} [${agent.strengths.join(", ")}]`);
        }
        vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
      } catch (e) {
        vscode.window.showErrorMessage(e.message);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("openCursor.selectAgent", async () => {
      const mode = await vscode.window.showQuickPick(
        [
          {
            label: "Collaborative",
            description: "Both agents work together",
            value: "collaborative"
          },
          {
            label: "Pipeline",
            description: "Gemini analyzes \u2192 Codex implements",
            value: "pipeline"
          },
          {
            label: "Codex Only",
            description: "ChatGPT/Codex (OpenAI subscription)",
            value: "codex"
          },
          {
            label: "Antigravity Only",
            description: "Gemini (Google AI Pro subscription)",
            value: "antigravity"
          }
        ],
        { placeHolder: "Select agent routing mode" }
      );
      if (mode) {
        const cfg = vscode.workspace.getConfiguration("openCursor");
        await cfg.update(
          "defaultAgent",
          mode.value,
          vscode.ConfigurationTarget.Global
        );
        vscode.window.showInformationMessage(`Agent mode set to: ${mode.label}`);
      }
    })
  );
}
function getChatHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: var(--vscode-font-family); padding: 10px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    #messages { height: calc(100vh - 120px); overflow-y: auto; margin-bottom: 10px; }
    .msg { padding: 8px 12px; margin: 4px 0; border-radius: 6px; white-space: pre-wrap; }
    .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); }
    .assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
    .error { color: var(--vscode-errorForeground); }
    .thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
    #input-area { display: flex; gap: 8px; }
    #input { flex: 1; padding: 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    #mode { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 4px 8px; }
    button { padding: 8px 16px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
  </style>
</head>
<body>
  <div id="messages"></div>
  <div id="input-area">
    <select id="mode">
      <option value="collaborative">Collaborative</option>
      <option value="pipeline">Pipeline</option>
      <option value="codex">Codex</option>
      <option value="antigravity">Antigravity</option>
    </select>
    <input id="input" placeholder="Ask anything..." onkeydown="if(event.key==='Enter')send()" autofocus />
    <button onclick="send()">Send</button>
  </div>
  <script>
    const vscode = acquireVsCodeApi();
    const messages = document.getElementById('messages');
    const input = document.getElementById('input');
    const mode = document.getElementById('mode');

    function addMsg(text, cls) {
      const div = document.createElement('div');
      div.className = 'msg ' + cls;
      div.textContent = text;
      messages.appendChild(div);
      messages.scrollTop = messages.scrollHeight;
    }

    function send() {
      const text = input.value.trim();
      if (!text) return;
      addMsg('> ' + text, 'user');
      vscode.postMessage({ type: 'send', text, mode: mode.value });
      input.value = '';
    }

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.type === 'thinking') addMsg('Thinking...', 'thinking');
      if (msg.type === 'reply') { const t = messages.querySelector('.thinking'); if(t) t.remove(); addMsg(msg.text, 'assistant'); }
      if (msg.type === 'error') { const t = messages.querySelector('.thinking'); if(t) t.remove(); addMsg(msg.text, 'error'); }
    });
  </script>
</body>
</html>`;
}
function deactivate() {
}
module.exports = { activate, deactivate };

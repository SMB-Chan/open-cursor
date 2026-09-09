/**
 * Chat webview HTML document for the Open-Cursor panel.
 *
 * Pure Node module (no `vscode` import) so tests can render the document
 * directly. Client behaviour lives in chat-webview.js and the streaming
 * markdown engine in markdown.js; both are inlined at render time so the
 * webview loads zero external resources and stays under a strict CSP.
 */
const { randomBytes } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const markdownSource = fs.readFileSync(path.join(__dirname, "markdown.js"), "utf8");
const webviewSource = fs.readFileSync(path.join(__dirname, "chat-webview.js"), "utf8");

// Keep an inlined source from accidentally terminating the script element.
function inlineScript(source) {
  return source.replace(/<\/script>/g, "<\\/script>");
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
    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body { margin: 0; padding: 10px; display: flex; flex-direction: column; font-family: var(--vscode-font-family); line-height: 1.5; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    /* Messages column grows; the input row keeps its natural height, so a
       grown textarea can never push the actions out of the viewport. */
    #messages { flex: 1 1 auto; min-height: 0; overflow-y: auto; margin-bottom: 10px; }
    #empty { margin: 16vh 12px 24px; text-align: center; color: var(--vscode-descriptionForeground); }
    .empty-title { font-size: 14px; font-weight: 600; margin-bottom: 8px; }
    .empty-hint { font-size: 12px; margin: 3px 0; }
    .msg { padding: 8px 12px; margin: 6px 0; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); border-left: 3px solid var(--vscode-focusBorder); }
    .assistant-card { margin: 8px 0; border: 1px solid var(--vscode-widget-border); border-radius: 8px; overflow: hidden; background: var(--vscode-editor-inactiveSelectionBackground); }
    .run-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 7px 10px; border-bottom: 1px solid var(--vscode-widget-border); background: var(--vscode-sideBar-background); }
    .agent-badge { font-size: 11px; font-weight: 600; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .phase-strip { display: flex; gap: 5px; flex-wrap: wrap; min-width: 0; }
    .phase-pill { font-size: 10px; line-height: 1; padding: 4px 7px; border-radius: 999px; border: 1px solid var(--vscode-widget-border); color: var(--vscode-descriptionForeground); background: var(--vscode-editor-background); }
    .phase-pill.active { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; animation: phasePulse 1.6s ease-in-out infinite; }
    .phase-pill.done::before { content: '✓ '; }
    .phase-pill.done { color: var(--vscode-testing-iconPassed); }
    .phase-pill.cancelled { text-decoration: line-through; opacity: .7; }
    .phase-pill.failed { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
    @keyframes phasePulse { 0%, 100% { opacity: 1; } 50% { opacity: .55; } }
    /* Markdown blocks (rendered per block; append-only DOM) */
    .assistant-body { padding: 10px 12px; overflow-wrap: anywhere; white-space: normal; }
    .assistant-body.thinking { color: var(--vscode-descriptionForeground); font-style: italic; }
    .assistant-body.restored { color: var(--vscode-descriptionForeground); }
    .run-note { margin-top: 8px; color: var(--vscode-descriptionForeground); font-style: italic; }
    .run-note.error { color: var(--vscode-errorForeground); font-style: normal; }
    .md-p { white-space: pre-wrap; margin: 6px 0; }
    .md-heading { margin: 12px 0 4px; line-height: 1.3; }
    .md-h1 { font-size: 1.35em; border-bottom: 1px solid var(--vscode-widget-border); padding-bottom: 3px; }
    .md-h2 { font-size: 1.2em; }
    .md-h3 { font-size: 1.08em; }
    .md-h4, .md-h5, .md-h6 { font-size: 1em; }
    .md-hr { border: none; border-top: 1px solid var(--vscode-widget-border); margin: 10px 0; }
    .md-code-wrap { position: relative; margin: 8px 0; border: 1px solid var(--vscode-widget-border); border-radius: 6px; overflow: hidden; background: var(--vscode-editor-background); }
    .md-code-lang { font-size: 10px; padding: 3px 8px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-widget-border); font-family: var(--vscode-editor-font-family); }
    .md-code { margin: 0; padding: 8px 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size, 12px); line-height: 1.45; white-space: pre; }
    .md-code code { font-family: inherit; white-space: pre; }
    .md-quote { margin: 8px 0; padding: 4px 10px; border-left: 3px solid var(--vscode-focusBorder); color: var(--vscode-descriptionForeground); }
    .md-quote-line { white-space: pre-wrap; margin: 2px 0; }
    .md-list { margin: 6px 0; padding-left: 22px; }
    .md-li { margin: 2px 0; }
    .md-icode { font-family: var(--vscode-editor-font-family); font-size: 0.92em; background: var(--vscode-textCodeBlock-background); border-radius: 3px; padding: 1px 4px; }
    /* Copy button on code blocks */
    .md-copy { position: absolute; top: 4px; right: 6px; padding: 2px 8px; font-size: 10px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: 1px solid var(--vscode-widget-border); border-radius: 4px; opacity: 0; transition: opacity .15s; cursor: pointer; }
    .md-code-wrap:hover .md-copy, .md-copy:focus-visible { opacity: 1; }
    .md-copy.copied { opacity: 1; color: var(--vscode-testing-iconPassed); }
    /* Collapse / copy-response toggles on the run header */
    .run-toggle { background: none; border: none; border-radius: 3px; color: var(--vscode-descriptionForeground); cursor: pointer; font-size: 11px; padding: 2px 6px; }
    .run-toggle:hover { color: var(--vscode-foreground); }
    .assistant-card.collapsed .assistant-body,
    .assistant-card.collapsed .workspace-receipt { display: none; }
    /* Live elapsed timer */
    .run-timer { font-size: 11px; color: var(--vscode-descriptionForeground); font-variant-numeric: tabular-nums; }
    .workspace-receipt { margin: 0 10px 10px; padding: 9px 10px; border: 1px solid var(--vscode-widget-border); border-radius: 6px; background: var(--vscode-editor-background); font-size: 11px; }
    .receipt-title { font-weight: 600; margin-bottom: 4px; }
    .receipt-summary { color: var(--vscode-foreground); margin-bottom: 5px; }
    .receipt-safety, .receipt-note, .receipt-warning { color: var(--vscode-descriptionForeground); margin-top: 4px; }
    .receipt-warning { color: var(--vscode-editorWarning-foreground); }
    .receipt-group { margin-top: 6px; }
    .receipt-group-label { font-weight: 600; color: var(--vscode-descriptionForeground); }
    .receipt-paths { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); }
    .error { color: var(--vscode-errorForeground); }
    #input-area { flex: 0 0 auto; display: grid; grid-template-columns: auto 1fr auto; gap: 8px; align-items: end; }
    #input { resize: vertical; min-height: 38px; max-height: 180px; padding: 8px; font-family: inherit; line-height: inherit; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 4px; }
    textarea#input { height: auto; }
    #input:focus { border-color: var(--vscode-focusBorder); outline: none; }
    #input::placeholder { color: var(--vscode-input-placeholderForeground); }
    #mode { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border); border-radius: 4px; padding: 8px; }
    #actions { display: flex; gap: 6px; }
    button { padding: 8px 14px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 4px; cursor: pointer; }
    button:disabled { opacity: .55; cursor: default; }
    button:focus-visible, #mode:focus-visible, .run-toggle:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
    #cancel { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    #clear { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    @media (max-width: 560px) {
      #input-area { grid-template-columns: 1fr; }
      #actions { justify-content: flex-end; }
      .run-meta { align-items: flex-start; flex-direction: column; gap: 6px; }
    }
  </style>
</head>
<body>
  <div id="messages" role="log" aria-live="polite" aria-label="Conversation">
    <div id="empty">
      <div class="empty-title">Open-Cursor Chat</div>
      <div class="empty-hint">Choose a routing mode below, then describe your task.</div>
      <div class="empty-hint">Enter to send · Shift+Enter for a new line · Esc stops a running agent</div>
    </div>
  </div>
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
${inlineScript(markdownSource)}

${inlineScript(webviewSource)}
  </script>
</body>
</html>`;
}

module.exports = { getChatHTML };

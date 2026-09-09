/**
 * Regression tests for the chat webview document.
 *
 * The webview script used to be embedded in a template literal inside
 * extension.js, which silently ate `\n` escapes and produced a script that
 * Chromium could not parse at all — the whole chat panel shipped dead.
 * chat-html.js + chat-webview.js exist so these tests can pin render output.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { getChatHTML } = require("./chat-html.js");

function render() {
  const html = getChatHTML({ cspSource: "vscode-webview:" });
  const match = html.match(/<script nonce="([0-9a-f]+)">([\s\S]*?)<\/script>/);
  assert.ok(match, "expected a nonce-protected script block");
  return { html, nonce: match[1], script: match[2] };
}

test("chat HTML carries a CSP with a matching script nonce", () => {
  const { html, nonce } = render();
  assert.ok(html.includes(`script-src 'nonce-${nonce}'`));
  assert.ok(html.includes("default-src 'none'"));
});

test("chat HTML inlines the markdown engine and the client script", () => {
  const { html } = render();
  assert.ok(html.includes("OpenCursorMarkdown"));
  assert.ok(html.includes("acquireVsCodeApi"));
});

test("rendered webview script parses as JavaScript", () => {
  const { script } = render();
  assert.doesNotThrow(() => new Function(script));
});

test("newline escapes survive into the rendered script as escapes", () => {
  const { script } = render();
  // A raw line feed inside a string literal is exactly what broke before.
  assert.ok(script.includes('join("\\n")'));
  assert.doesNotMatch(script, /'\n/);
});

test("chat HTML renders the core UI structure", () => {
  const { html } = render();
  for (const id of ['id="messages"', 'id="empty"', 'id="input"', 'id="mode"', 'id="send"', 'id="cancel"', 'id="clear"']) {
    assert.ok(html.includes(id), `missing ${id}`);
  }
});

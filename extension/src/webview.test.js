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

// ── Client smoke test: run the inlined script against a minimal DOM shim ──
// Parse-only checks cannot catch runtime breakage (the panel once shipped
// fully dead), so a full begin → delta → complete cycle is exercised here.

const vm = require("node:vm");

function makeElement(tag = "div") {
  const el = {
    tagName: tag,
    children: [],
    parentNode: null,
    style: {},
    dataset: {},
    value: "",
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    _listeners: {},
    classList: {
      _set: new Set(),
      add(...names) { for (const n of names) this._set.add(n); },
      remove(...names) { for (const n of names) this._set.delete(n); },
      toggle(name) {
        if (this._set.has(name)) { this._set.delete(name); return false; }
        this._set.add(name);
        return true;
      },
      contains(name) { return this._set.has(name); },
    },
    addEventListener(type, fn) { (this._listeners[type] ||= []).push(fn); },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    querySelector() { return null; },
    setAttribute(name, value) { this[name] = value; },
    focus() {},
    textContent: "",
  };
  // Real DOM keeps className and classList in sync; the shim must too.
  Object.defineProperty(el, "className", {
    get() { return Array.from(el.classList._set).join(" "); },
    set(value) {
      el.classList._set = new Set(String(value).split(/\s+/).filter(Boolean));
    },
  });
  return el;
}

function bootWebview() {
  const { html } = render();
  const match = html.match(/<script nonce="[0-9a-f]+">([\s\S]*?)<\/script>/);
  const script = match[1];

  const ids = {};
  for (const id of ["messages", "empty", "input", "mode", "send", "cancel", "clear"]) {
    ids[id] = makeElement(id);
  }
  ids.mode.options = [];
  ids.mode.value = "collaborative";

  const windowListeners = {};
  const posted = [];
  const state = { current: null };
  const sandbox = {
    self: {},
    document: {
      getElementById: (id) => ids[id] || null,
      createElement: (tag) => makeElement(tag),
      createTextNode: (text) => ({ nodeType: 3, textContent: text }),
    },
    window: {
      addEventListener(type, fn) { (windowListeners[type] ||= []).push(fn); },
    },
    navigator: { clipboard: { writeText: async () => {} } },
    acquireVsCodeApi: () => ({
      postMessage: (msg) => posted.push(msg),
      setState: (next) => { state.current = next; },
      getState: () => state.current,
    }),
    requestAnimationFrame: (fn) => { fn(); return 0; },
    setInterval, clearInterval, setTimeout, clearTimeout,
    Date, Math, JSON, Array, String, Number, Map, Set, Promise, RegExp, Error,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  return { ids, posted, state, windowListeners };
}

function fireWindowMessage(harness, msg) {
  for (const fn of harness.windowListeners.message || []) fn({ data: msg });
}

test("webview client runs a full begin → delta → complete cycle", () => {
  const h = bootWebview();
  h.ids.input.value = "hello agents";
  for (const fn of h.ids.send._listeners.click || []) fn();
  assert.equal(h.posted.length, 1);
  assert.equal(h.posted[0].type, "send");
  assert.equal(h.posted[0].text, "hello agents");
  const requestId = h.posted[0].requestId;

  fireWindowMessage(h, { type: "begin", requestId, mode: "collaborative" });
  fireWindowMessage(h, { type: "delta", requestId, text: "# Result\n\n```js\nconst x = 1;\n```\n", agent: "codex", phase: "implementation" });
  fireWindowMessage(h, { type: "complete", requestId, empty: false, receipt: null });

  const card = h.ids.messages.children.find((c) => c.classList && c.classList.contains("assistant-card"));
  assert.ok(card, "assistant card rendered");
  assert.ok(card._rawText.includes("const x = 1;"), "raw text recorded for copy-all");
  const body = card.children.find((c) => c.classList && c.classList.contains("assistant-body"));
  assert.ok(body.children.length > 0, "markdown blocks became DOM");
  const turns = (h.state.current && h.state.current.session) || [];
  // vm-realm arrays are not reference-equal to host-realm ones; re-wrap.
  assert.deepEqual([...turns.map((t) => t.r)], ["u", "a"]);
});

test("webview client keeps rendered markdown intact on cancel", () => {
  const h = bootWebview();
  h.ids.input.value = "work";
  for (const fn of h.ids.send._listeners.click || []) fn();
  const requestId = h.posted[0].requestId;

  fireWindowMessage(h, { type: "begin", requestId, mode: "collaborative" });
  fireWindowMessage(h, { type: "delta", requestId, text: "partial answer\n", agent: "codex", phase: "implementation" });
  fireWindowMessage(h, { type: "cancelled", requestId, receipt: null });

  const card = h.ids.messages.children.find((c) => c.classList && c.classList.contains("assistant-card"));
  const body = card.children.find((c) => c.classList && c.classList.contains("assistant-body"));
  const note = body.children.find((c) => c.classList && c.classList.contains("run-note"));
  assert.ok(note, "cancel note appended as a node");
  assert.equal(note.textContent, "[Cancelled]");
  // The streamed paragraph must remain a DOM block, not a flattened text dump.
  assert.ok(body.children.some((c) => c.classList && c.classList.contains("md-p")));
});

test("IME composition Enter never sends the draft", () => {
  const h = bootWebview();
  h.ids.input.value = "変換中の文章";
  let prevented = false;
  for (const fn of h.ids.input._listeners.keydown || []) {
    fn({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 229, preventDefault: () => { prevented = true; } });
  }
  assert.equal(h.posted.length, 0);
  assert.equal(prevented, false);
});

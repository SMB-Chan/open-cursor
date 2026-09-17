import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const clientSource = await readFile(new URL("./public/chat.js", import.meta.url), "utf8");
const sseSource = await readFile(new URL("../extension/src/sse.js", import.meta.url), "utf8");
const html = await readFile(new URL("./public/index.html", import.meta.url), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function element() {
  return {
    value: "", style: {}, children: [], attributes: {}, listeners: {},
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { this.listeners[name] = callback; },
  };
}

function client(fetch, onRender = () => {}) {
  const elements = Object.fromEntries(["prompt-input", "btn-send", "messages-container", "model-select"].map((id) => [id, element()]));
  elements["model-select"].value = "goal";
  const context = vm.createContext({ AbortController, TextDecoder });
  vm.runInContext(sseSource, context);
  vm.runInContext(clientSource, context);
  const rendererSource = html.match(/function renderMarkdown\(text\) \{[\s\S]*?\n    \}/)[0];
  const render = vm.runInContext(`(${rendererSource})`, context);
  const controller = context.OpenCursorMobileChat.createChatController({
    document: { getElementById: (id) => elements[id], createElement: element },
    fetch,
    consumeSse: context.OpenCursorSse.consumeSse,
    renderMarkdown: (text) => { onRender(); return render(text); },
  });
  return { controller, elements,
    bubble: () => elements["messages-container"].children.at(-1),
    send: (text = "修正してください") => { elements["prompt-input"].value = text; return controller.send(); },
  };
}

const event = (text, metadata = {}) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }], open_cursor: metadata })}\n\n`;
const response = (body, status = 200) => new Response(body, { status });

test("mobile inline scripts and external controllers parse and are loaded by the page", () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
  assert.ok(html.includes('<script src="/sse.js"></script>'));
  assert.ok(html.includes('<script src="/chat.js"></script>'));
  assert.ok(html.includes('value="goal"'));
  assert.ok(html.includes('!e.isComposing'));
});

test("mobile chat sends the selected mode and renders escaped output to completion", async () => {
  let request;
  const app = client(async (url, options) => {
    request = { url, options };
    return response(event("日本語 <script>alert(1)</script>") + "data: [DONE]\n\n");
  });
  await app.send();
  assert.equal(request.url, "/api/chat");
  assert.equal(JSON.parse(request.options.body).model, "goal");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.match(app.bubble().children[0].innerHTML, /&lt;script&gt;/);
  assert.equal(app.bubble().children[1].textContent, "完了");
  assert.equal(app.controller.busy, false);
  assert.equal(app.elements["btn-send"].attributes["aria-label"], "送信");
});

test("stop button aborts the fetch, retains partial output, and permits another request", async () => {
  let count = 0;
  let signal;
  const rendered = deferred();
  const app = client(async (_, options) => {
    count++;
    if (count > 1) return response(event("再送の結果") + "data: [DONE]\n\n");
    signal = options.signal;
    return response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event("途中の結果")));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }));
  }, () => rendered.resolve());
  const pending = app.send();
  await rendered.promise;
  await app.send("重複送信");
  assert.equal(count, 1);
  assert.equal(app.elements["btn-send"].attributes["aria-label"], "実行を中断");
  app.elements["btn-send"].listeners.click();
  assert.equal(signal.aborted, true);
  await pending;
  assert.match(app.bubble().children[0].innerHTML, /途中の結果/);
  assert.match(app.bubble().children[1].textContent, /中断しました/);
  assert.equal(app.elements["btn-send"].disabled, false);
  await app.send("再送");
  assert.equal(count, 2);
  assert.equal(app.bubble().children[1].textContent, "完了");
});

test("HTTP and streaming errors are plain text and never appear as successful completion", async () => {
  for (const fetch of [
    async () => response(JSON.stringify({ error: { message: '<img src=x onerror="bad()">' } }), 409),
    async () => response(event("部分回答") + event("", { error: true, message: "CLI failed" }) + "data: [DONE]\n\n"),
    async () => response(event("部分回答")),
    async () => response('data: {invalid}\n\n'),
  ]) {
    const app = client(fetch);
    await app.send();
    const status = app.bubble().children[1];
    assert.match(status.textContent, /エラー:/);
    assert.equal(status.innerHTML, undefined);
    assert.equal(app.controller.busy, false);
  }
});

test("goal blockers and round exhaustion are distinct from completion", async () => {
  for (const [status, expected] of [["blocked", /追加入力/], ["budget_exhausted", /ラウンド上限/]]) {
    const app = client(async () => response(event("結果", { goal: { status } }) + "data: [DONE]\n\n"));
    await app.send();
    assert.match(app.bubble().children[1].textContent, expected);
  }
});

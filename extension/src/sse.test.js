const test = require("node:test");
const assert = require("node:assert/strict");

const { consumeSse, parseSseBlock } = require("./sse.js");

function streamingResponse(chunks) {
  const encoder = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
  };
}

test("parseSseBlock extracts content and Open-Cursor metadata", () => {
  const parsed = parseSseBlock(
    'data: {"choices":[{"delta":{"content":"hello"}}],"open_cursor":{"agent":"codex","phase":"implementation"}}'
  );

  assert.equal(parsed.kind, "event");
  assert.equal(parsed.delta, "hello");
  assert.equal(parsed.agent, "codex");
  assert.equal(parsed.phase, "implementation");
});

test("parseSseBlock recognizes DONE and ignores comments", () => {
  assert.deepEqual(parseSseBlock("data: [DONE]"), { kind: "done" });
  assert.deepEqual(parseSseBlock(": keepalive"), { kind: "ignore" });
});

test("consumeSse handles JSON split across transport chunks", async () => {
  const events = [];
  const response = streamingResponse([
    'data: {"choices":[{"delta":{"content":"Plan"}}],"open_cursor":{"agent":"antigravity",',
    '"phase":"planning"}}\n\n',
    'data: {"choices":[{"delta":{"content":" done"}}],"open_cursor":{"agent":"antigravity","phase":"planning"}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const content = await consumeSse(response, (event) => events.push(event));

  assert.equal(content, "Plan done");
  assert.equal(events.length, 2);
  assert.equal(events[0].agent, "antigravity");
  assert.equal(events[0].phase, "planning");
  assert.equal(events[1].delta, " done");
});

test("consumeSse forwards metadata-only final chunks without changing content", async () => {
  const events = [];
  const response = streamingResponse([
    'data: {"choices":[{"delta":{"content":"answer"}}],"open_cursor":{"agent":"codex","phase":"refinement"}}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"open_cursor":{"agent":"collaborative","active_executions":0,"workspace_receipt":{"id":"chatcmpl-1","status":"completed","git":{"available":true,"newly_dirty_paths":["src/a.js"]}}}}\n\n',
    "data: [DONE]\n\n",
  ]);

  const content = await consumeSse(response, (event) => events.push(event));

  assert.equal(content, "answer");
  assert.equal(events.length, 2);
  assert.equal(events[1].metadata.active_executions, 0);
  assert.equal(events[1].metadata.workspace_receipt.id, "chatcmpl-1");
  assert.deepEqual(events[1].metadata.workspace_receipt.git.newly_dirty_paths, ["src/a.js"]);
});

test("truncated streams cannot be mistaken for completed work", async () => {
  for (const chunks of [
    [],
    ['data: {"choices":[{"delta":{"content":"Still working"}}]}\n\n'],
    ['data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'],
  ]) {
    const response = streamingResponse(chunks);
    await assert.rejects(consumeSse(response), /ended before completion/);
    assert.equal(response.body.locked, false);
  }
});

test("malformed events reject and release the response reader", async () => {
  const response = streamingResponse(['data: {"unfinished":\n\n', 'data: [DONE]\n\n']);
  await assert.rejects(consumeSse(response), /malformed streaming event/);
  assert.equal(response.body.locked, false);
});

test("DONE without a trailing delimiter still confirms completion", async () => {
  const response = streamingResponse([
    'data: {"choices":[{"delta":{"content":"Done"}}]}\r\n\r\n',
    'data: [DONE]',
  ]);
  assert.equal(await consumeSse(response), "Done");
  assert.equal(response.body.locked, false);
});

test("DONE cancels the remaining transport and discards later events", async () => {
  let cancelled = false;
  const response = { body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\ndata: invalid trailing data\n\n'));
    },
    cancel() { cancelled = true; },
  }) };
  assert.equal(await consumeSse(response), "");
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("consumer exceptions cancel streaming without losing the original error", async () => {
  let cancelled = false;
  const error = new Error("test consumer failure");
  const response = { body: new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"answer"}}]}\n\n'));
    },
    cancel() { cancelled = true; },
  }) };
  await assert.rejects(consumeSse(response, () => { throw error; }), (actual) => actual === error);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("UTF-8 text and CRLF boundaries survive single-byte transport chunks", async () => {
  const bytes = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"日本語 🎉"}}]}\r\n\r\ndata: [DONE]\r\n\r\n');
  const response = { body: new ReadableStream({
    start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    },
  }) };
  assert.equal(await consumeSse(response), "日本語 🎉");
});

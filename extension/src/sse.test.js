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

test("parseSseBlock exposes review-loop iteration and verdict metadata", () => {
  const verdict = parseSseBlock(
    'data: {"choices":[{"delta":{"content":""}}],"open_cursor":{"agent":"auto","phase":"review-verdict","iteration":2,"verdict":"changes_requested","reviewCycles":3}}'
  );

  assert.equal(verdict.iteration, 2);
  assert.equal(verdict.verdict, "changes_requested");
  assert.equal(verdict.reviewCycles, 3);

  const plain = parseSseBlock(
    'data: {"choices":[{"delta":{"content":"x"}}],"open_cursor":{"agent":"codex","phase":"response"}}'
  );
  assert.equal(plain.iteration, null);
  assert.equal(plain.verdict, null);
  assert.equal(plain.reviewCycles, null);
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

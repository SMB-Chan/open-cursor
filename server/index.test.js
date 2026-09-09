import test from "node:test";
import assert from "node:assert/strict";

import {
  HttpError,
  ExecutionTimeoutError,
  activeExecutionCount,
  analyzeTask,
  buildPrompt,
  formatCollaborativeResult,
  parseAgentSelection,
  rejectBrowserOrigin,
  runProcess,
} from "./index.js";

test("routing aliases are not forwarded as CLI model names", () => {
  assert.deepEqual(parseAgentSelection("codex", "codex"), {
    mode: "codex",
    model: undefined,
  });
  assert.deepEqual(parseAgentSelection("antigravity", "antigravity"), {
    mode: "antigravity",
    model: undefined,
  });
  assert.deepEqual(parseAgentSelection("collaborative", undefined), {
    mode: "collaborative",
    model: undefined,
  });
});

test("namespaced models resolve to the correct agent and CLI model", () => {
  assert.deepEqual(parseAgentSelection("codex/gpt-5.3-codex", undefined), {
    mode: "codex",
    model: "gpt-5.3-codex",
  });
  assert.deepEqual(parseAgentSelection("antigravity/pro", undefined), {
    mode: "antigravity",
    model: "pro",
  });
  assert.deepEqual(parseAgentSelection("gemini/flash", undefined), {
    mode: "antigravity",
    model: "flash",
  });
});

test("conflicting model namespace and explicit routing mode are rejected", () => {
  assert.throws(
    () => parseAgentSelection("codex/gpt-5.3-codex", "antigravity"),
    (error) => error instanceof HttpError && error.statusCode === 400
  );
});

test("invalid explicit routing mode is rejected", () => {
  assert.throws(
    () => parseAgentSelection("", "shell"),
    (error) => error instanceof HttpError && error.statusCode === 400
  );
});

test("browser-origin execution requests are rejected", () => {
  assert.throws(
    () => rejectBrowserOrigin({ headers: { origin: "https://example.com" } }),
    (error) => error instanceof HttpError && error.statusCode === 403
  );
  assert.doesNotThrow(() => rejectBrowserOrigin({ headers: {} }));
});

test("prompt builder preserves context and rejects unsupported roles", () => {
  const prompt = buildPrompt([
    { role: "system", content: "Stay concise." },
    { role: "user", content: "Fix the bug." },
    { role: "assistant", content: "I found the cause." },
  ]);

  assert.match(prompt, /^\[System\]/);
  assert.match(prompt, /Stay concise\./);
  assert.match(prompt, /Fix the bug\./);
  assert.match(prompt, /\[Previous response\]/);
  assert.throws(
    () => buildPrompt([{ role: "tool", content: "unsafe implicit tool output" }]),
    (error) => error instanceof HttpError && error.statusCode === 400
  );
});

test("task analyzer routes both English and Japanese prompts", () => {
  assert.equal(analyzeTask("Implement the parser").routing, "codex");
  assert.equal(analyzeTask("Audit the architecture").routing, "antigravity");
  assert.equal(analyzeTask("この不具合を修正して実装せよ").routing, "codex");
  assert.equal(analyzeTask("この設計を分析し比較してくれ").routing, "antigravity");
  assert.equal(analyzeTask("続行せよ").routing, "collaborative");
});

test("collaborative formatter keeps successful and failed agent results visible", () => {
  const text = formatCollaborativeResult(
    { content: "Implemented it.", code: 0 },
    { content: "[antigravity error: unavailable]", code: 1 }
  );
  assert.match(text, /Codex Implementation/);
  assert.match(text, /antigravity error/);
});

test("runProcess forwards stdout incrementally and returns the complete content", async () => {
  const chunks = [];
  const result = await runProcess({
    agent: "test",
    command: process.execPath,
    args: [
      "-e",
      "process.stdout.write('first\\n'); setTimeout(() => { process.stdout.write('second\\n'); }, 30);",
    ],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 2000,
    onStdout: (text) => chunks.push(text),
  });

  assert.equal(result.code, 0);
  assert.equal(result.content, "first\nsecond");
  assert.equal(chunks.join(""), "first\nsecond\n");
  assert.equal(activeExecutionCount(), 0);
});

test("runProcess terminates a child when the request aborts", async () => {
  const controller = new AbortController();
  const promise = runProcess({
    agent: "test",
    command: process.execPath,
    args: ["-e", "setInterval(() => process.stdout.write('tick\\n'), 20)"],
    cwd: process.cwd(),
    env: process.env,
    timeoutMs: 5000,
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 60);
  await assert.rejects(promise, (error) => error?.name === "AbortError");
  assert.equal(activeExecutionCount(), 0);
});

test("runProcess enforces per-agent execution timeout", async () => {
  await assert.rejects(
    runProcess({
      agent: "test",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      env: process.env,
      timeoutMs: 50,
    }),
    (error) => error instanceof ExecutionTimeoutError && error.statusCode === 504
  );
  assert.equal(activeExecutionCount(), 0);
});

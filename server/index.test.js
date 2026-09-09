import test from "node:test";
import assert from "node:assert/strict";

import {
  HttpError,
  analyzeTask,
  buildPrompt,
  parseAgentSelection,
  rejectBrowserOrigin,
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

test("invalid explicit routing mode is rejected", () => {
  assert.throws(
    () => parseAgentSelection("", "shell"),
    (err) => err instanceof HttpError && err.statusCode === 400
  );
});

test("browser-origin execution requests are rejected", () => {
  assert.throws(
    () => rejectBrowserOrigin({ headers: { origin: "https://example.com" } }),
    (err) => err instanceof HttpError && err.statusCode === 403
  );
  assert.doesNotThrow(() => rejectBrowserOrigin({ headers: {} }));
});

test("prompt builder preserves system, user, and assistant context", () => {
  const prompt = buildPrompt([
    { role: "system", content: "Stay concise." },
    { role: "user", content: "Fix the bug." },
    { role: "assistant", content: "I found the cause." },
  ]);

  assert.match(prompt, /^\[System\]/);
  assert.match(prompt, /Stay concise\./);
  assert.match(prompt, /Fix the bug\./);
  assert.match(prompt, /\[Previous response\]/);
});

test("task analyzer keeps implementation and analysis routing distinct", () => {
  assert.equal(analyzeTask("Implement the parser").routing, "codex");
  assert.equal(analyzeTask("Audit the architecture").routing, "antigravity");
});

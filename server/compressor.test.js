import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipByBytes,
  compressMessages,
  compressHandoff,
  compressGitDiff,
  safePromptArg,
  summarizeCollaborativeResponse,
  MAX_CLI_ARG_BYTES,
} from "./compressor.js";

test("clipByBytes clips at exact boundary without throwing on UTF-8", () => {
  const japanese = "こんにちは世界！".repeat(10);
  const clipped = clipByBytes(japanese, 50);
  assert.ok(Buffer.byteLength(clipped, "utf8") <= 50);
  assert.ok(clipped.includes("... [truncated"));
});

test("compressMessages preserves current user task untouched", () => {
  const currentTask = "Implement the new feature with tests";
  const messages = [
    { role: "user", content: "Previous question" },
    { role: "assistant", content: "Previous long answer ".repeat(200) },
    { role: "user", content: currentTask },
  ];

  const result = compressMessages(messages);
  assert.ok(result.compressed);
  assert.equal(result.messages[result.messages.length - 1].content, currentTask);
  assert.ok(result.savedBytes > 0);
});

test("compressMessages summarizes collaborative response", () => {
  const collabResponse = [
    "## Plan (Gemini/Antigravity)\nStep 1: Inspect files\nStep 2: Edit",
    "## Implementation (Codex/GPT)\nRan tests: 3 passed\nModified file.js",
    "## Review (Gemini/Antigravity)\nCode looks good, check edge cases",
    "## Refinement (Codex/GPT)\nFixed edge cases in file.js, all tests pass",
  ].join("\n\n---\n\n");

  const summary = summarizeCollaborativeResponse(collabResponse);
  assert.ok(summary.includes("Fixed edge cases in file.js"));
  assert.ok(summary.length < collabResponse.length);
});

test("compressHandoff compresses implementation report while keeping tests and errors", () => {
  const longImpl = [
    "# Implementation Report",
    "$ npm test",
    "PASS test_one.js",
    "PASS test_two.js",
    "```js",
    "const a = 1;".repeat(1000),
    "```",
    "Summary: All tests passed",
  ].join("\n");

  const compressed = compressHandoff(longImpl, { phase: "implementation", maxBytes: 500 });
  assert.ok(Buffer.byteLength(compressed, "utf8") <= 500);
  assert.ok(compressed.includes("PASS"));
});

test("compressGitDiff ignores lockfiles and truncates massive hunks", () => {
  const diff = [
    "diff --git a/package-lock.json b/package-lock.json",
    "index 123..456 100644",
    "+ lockfile change ".repeat(1000),
    "diff --git a/src/app.js b/src/app.js",
    "index 789..abc 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "+ const x = 1;",
  ].join("\n");

  const result = compressGitDiff(diff, 2048, 50);
  assert.ok(result.includes("package-lock.json omitted"));
  assert.ok(result.includes("src/app.js"));
});

test("safePromptArg guarantees argument stays under 64 KB", () => {
  const hugePrompt = "a".repeat(200 * 1024);
  const safe = safePromptArg(hugePrompt);
  assert.ok(Buffer.byteLength(safe, "utf8") <= MAX_CLI_ARG_BYTES);
});

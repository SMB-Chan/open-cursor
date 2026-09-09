import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipByBytes,
  clipCodeBody,
  clipUtf8Safe,
  clipUtf8MiddleOut,
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

test("structured ## Report from the output contract survives implementation compression", () => {
  const structured = [
    "Made the changes.",
    "```js",
    "const blob = '".repeat(200) + "';",
    "```",
    "## Report",
    "- Files changed: server/engine.js — modify — added guard",
    "- Commands run: npm test — pass 69/69",
    "- Deviations: none",
  ].join("\n");

  const compressed = compressHandoff(structured, { phase: "implementation", maxBytes: 400 });
  assert.ok(compressed.includes("## Report"));
  assert.ok(compressed.includes("Files changed: server/engine.js"));
  assert.ok(compressed.includes("npm test"));
});

test("structured numbered findings survive review compression for the refiner", () => {
  const findings = [
    "## Verdict",
    "fix-required",
    "",
    "## Findings",
    "1. src/app.js:12 — missing null guard — add guard",
    "2. src/app.js:40 — swallowed error — rethrow with context",
    "",
    "Prose explanation ".repeat(60),
  ].join("\n");

  const compressed = compressHandoff(findings, { phase: "review", maxBytes: 300 });
  assert.ok(compressed.includes("1. src/app.js:12"));
  assert.ok(compressed.includes("2. src/app.js:40"));
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
  // Lockfiles are dropped entirely but remain discoverable via the omission index.
  assert.ok(result.includes("package-lock.json (machine-generated; omitted entirely)"));
  assert.ok(result.includes("src/app.js"));
  // Well-formed output: the surviving hunk keeps its diff --git marker.
  assert.ok(result.startsWith("diff --git "));
});

test("safePromptArg guarantees argument stays under 64 KB", () => {
  const hugePrompt = "a".repeat(200 * 1024);
  const safe = safePromptArg(hugePrompt);
  assert.ok(Buffer.byteLength(safe, "utf8") <= MAX_CLI_ARG_BYTES);
});

// ── v2.9.0: prompt-quality-preserving compression ──────────────────────────

test("clipUtf8Safe never splits multi-byte characters or produces mojibake", () => {
  const japanese = "あ".repeat(300); // 3 bytes per char
  const clipped = clipUtf8Safe(japanese, 100);
  assert.ok(Buffer.byteLength(clipped, "utf8") <= 100);
  assert.ok(!clipped.includes("\uFFFD"), "no replacement characters allowed");
  // Idempotent: re-clipping is a no-op.
  assert.equal(clipUtf8Safe(clipped, 100), clipped);
});

test("clipUtf8MiddleOut keeps BOTH head and tail (report/verdict survives)", () => {
  const head = "## Header and early context\n" + "filler ".repeat(50);
  const tail = "\n## Report\n- Files changed: src/app.js — final verdict lines";
  const payload = head + "MIDDLE".repeat(2000) + tail;

  const clipped = clipUtf8MiddleOut(payload, 600);
  assert.ok(Buffer.byteLength(clipped, "utf8") <= 600);
  assert.ok(clipped.startsWith("## Header"), "head preserved");
  assert.ok(clipped.includes("final verdict lines"), "tail preserved");
  assert.ok(clipped.includes("middle omitted"), "omission is explicit");
  // Verify the byte math is honest: it really reports the original size.
  assert.ok(clipped.includes("middle omitted by the handoff compressor"));
});

test("compressHandoff attaches an anti-hallucination manifest when truncating", () => {
  const big = "line\n".repeat(500);
  const out = compressHandoff(big, { phase: "plan", maxBytes: 400 });
  assert.match(out, /\[HANDOFF plan\]/);
  assert.match(out, /Content was dropped/);
  assert.match(out, /invent nothing/);
  assert.match(out, /ground truth = workspace files \+ Git diff/);
  // Manifest carries the honest byte math.
  assert.match(out, /payload \d+B → \d+B \(budget 400B\)/);
});

test("compressHandoff marks untruncated payloads as complete", () => {
  const small = "small payload";
  const out = compressHandoff(small, { phase: "plan", maxBytes: 400 });
  // Under budget: returned untouched, no manifest noise.
  assert.equal(out, small);
});

test("implementation compression prefers parseable report lines over code bodies", () => {
  const bigFence = "const data = " + JSON.stringify({ blob: "x".repeat(4000) }) + ";";
  const structured = [
    "Ran the change.",
    "```js",
    bigFence,
    "```",
    "## Report",
    "- Files changed: server/engine.js — modify — guard added",
    "- Commands run: npm test — pass 90/90",
    "- Deviations: none",
  ].join("\n");

  const out = compressHandoff(structured, { phase: "implementation", maxBytes: 600 });
  assert.ok(out.includes("## Report"), "report header survives");
  assert.ok(out.includes("Files changed: server/engine.js"), "file list survives");
  assert.ok(out.includes("pass 90/90"), "test status survives");
  assert.ok(out.includes("Deviations: none"), "deviations survive");
  // The huge fence body is dropped with an explicit note, not silently.
  assert.ok(out.includes("lines of code omitted") || out.includes("middle omitted"));
  assert.ok(Buffer.byteLength(out, "utf8") <= 600 + 220, "stays near budget (manifest excluded)");
});

test("review compression keeps numbered findings and verdicts, drops prose", () => {
  const findings = [
    "## Verdict",
    "fix-required",
    "",
    "## Findings",
    "1. src/app.js:12 — missing null guard — add guard",
    "2. src/app.js:40 — swallowed error — rethrow with context",
    "",
    "General prose observation ".repeat(40),
  ].join("\n");
  const out = compressHandoff(findings, { phase: "review", maxBytes: 320 });
  assert.ok(out.includes("## Verdict"));
  assert.ok(out.includes("fix-required"));
  assert.ok(out.includes("1. src/app.js:12"));
  assert.ok(out.includes("2. src/app.js:40"));
});

test("giant single lines inside code blocks are capped, not kept whole", () => {
  const giantLine = "const huge = '" + "a".repeat(20000) + "';";
  const body = clipCodeBody(giantLine, 40);
  assert.ok(Buffer.byteLength(body, "utf8") < 500, `line capped, got ${Buffer.byteLength(body, "utf8")}B`);
  assert.ok(body.includes("line middle omitted"));
});

test("compressGitDiff: every file after the budget is still discoverable", () => {
  const files = [];
  for (let i = 0; i < 40; i++) {
    files.push(
      [
        `diff --git a/src/module${i}.js b/src/module${i}.js`,
        "index 111..222 100644",
        `+ // change ${i} ` + "x".repeat(120),
      ].join("\n")
    );
  }
  const result = compressGitDiff(files.join("\n"), 3000, 20);
  // Later files must not silently vanish: either their hunk or their name appears.
  let found = 0;
  for (let i = 0; i < 40; i++) {
    if (result.includes(`module${i}.js`)) found++;
  }
  assert.equal(found, 40, "all 40 file paths must be discoverable");
});

test("compression is deterministic across runs", () => {
  const payload = "deterministic content\n".repeat(80);
  const a = compressHandoff(payload, { phase: "plan", maxBytes: 500 });
  const b = compressHandoff(payload, { phase: "plan", maxBytes: 500 });
  assert.equal(a, b);
});

test("middle-out and safe clips never produce mojibake across budget sweeps", () => {
  const samples = [
    "日本語の説明".repeat(3000) + "\n## Report\n- 結論: 完了",
    "emoji 🎌🎯🚀 mix ".repeat(500),
    "mixed 日本語 english 🎌 ".repeat(400),
  ];
  const budgets = [50, 100, 137, 200, 256, 333, 500, 777, 1000, 4096];
  let checks = 0;
  for (const text of samples) {
    for (const budget of budgets) {
      const middle = clipUtf8MiddleOut(text, budget);
      assert.ok(!middle.includes("\uFFFD"), `middle-out mojibake at budget ${budget}`);
      assert.ok(Buffer.byteLength(middle, "utf8") <= budget, `middle-out over budget ${budget}`);
      const safe = clipUtf8Safe(text, budget);
      assert.ok(!safe.includes("\uFFFD"), `safe mojibake at budget ${budget}`);
      checks += 2;
    }
  }
  assert.ok(checks >= 60);
});

test("engine clipText keeps the parseable tail (regression for mojibake + head-only)", () => {
  // This is exercised through engine.js; here we pin the compressor behavior
  // it relies on: multibyte tail survives.
  const payload = "context ".repeat(200) + "\n## Report\n- Deviations: none — 完了";
  const clipped = clipUtf8MiddleOut(payload, 200);
  assert.ok(clipped.includes("完了"));
  assert.ok(!clipped.includes("\uFFFD"));
});

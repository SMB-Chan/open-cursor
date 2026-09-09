import test from "node:test";
import assert from "node:assert/strict";

import {
  createAntigravityStreamParser,
  isStructuredOutputUnsupported,
  parseAntigravityModels,
  resolveAntigravityModel,
} from "./antigravity.js";

const MODEL_OUTPUT = `
gemini-3.8-flash-high     Gemini 3.8 Flash (High)
gemini-3.8-flash-medium   Gemini 3.8 Flash (Medium)
gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.1-pro-high       Gemini 3.1 Pro (High)
claude-sonnet-4-6          Claude Sonnet 4.6 (Thinking)
`;

test("model list parser extracts canonical slugs and names", () => {
  assert.deepEqual(parseAntigravityModels(MODEL_OUTPUT), [
    { slug: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { slug: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { slug: "gemini-3.7-flash-high", name: "Gemini 3.7 Flash (High)" },
    { slug: "gemini-3.1-pro-high", name: "Gemini 3.1 Pro (High)" },
    { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
  ]);
});

test("legacy aliases resolve against the newest discovered model slugs", () => {
  const models = parseAntigravityModels(MODEL_OUTPUT);
  assert.equal(resolveAntigravityModel("pro", models), "gemini-3.1-pro-high");
  assert.equal(resolveAntigravityModel("flash", models), "gemini-3.8-flash-high");
  assert.equal(resolveAntigravityModel("flash_lite", models), "gemini-3.8-flash-medium");
  assert.equal(
    resolveAntigravityModel("Gemini 3.8 Flash (High)", models),
    "gemini-3.8-flash-high"
  );
  assert.equal(resolveAntigravityModel("claude-sonnet-4-6", models), "claude-sonnet-4-6");
});

test("aliases retain conservative slug fallbacks if model discovery is unavailable", () => {
  assert.equal(resolveAntigravityModel("pro", []), "gemini-3.1-pro-high");
  assert.equal(resolveAntigravityModel("flash", []), "gemini-3.8-flash-high");
  assert.equal(resolveAntigravityModel("flash-lite", []), "gemini-3.8-flash-medium");
});

test("stream parser survives arbitrary transport chunk boundaries", () => {
  const deltas = [];
  const parser = createAntigravityStreamParser({ onText: (text) => deltas.push(text) });

  const lines = [
    JSON.stringify({ event: "init", init: { model: "gemini-3.8-flash-high" } }),
    JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "hello" },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: { step_type: "agent_response", state: "DONE", text_delta: " world" },
    }),
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "hello world" },
    }),
  ].join("\n") + "\n";

  parser.feed(lines.slice(0, 17));
  parser.feed(lines.slice(17, 71));
  parser.feed(lines.slice(71, 139));
  parser.feed(lines.slice(139));

  const result = parser.finish();
  assert.equal(deltas.join(""), "hello world");
  assert.equal(result.response, "hello world");
  assert.equal(result.status, "SUCCESS");
  assert.equal(result.resultSeen, true);
  assert.equal(result.malformedLines, 0);
});

test("result-only structured output is emitted exactly once", () => {
  const deltas = [];
  const parser = createAntigravityStreamParser({ onText: (text) => deltas.push(text) });
  parser.feed(
    `${JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "final only" } })}\n`
  );
  const result = parser.finish();
  assert.deepEqual(deltas, ["final only"]);
  assert.equal(result.response, "final only");
});

test("malformed structured lines are ignored without corrupting valid deltas", () => {
  const deltas = [];
  const parser = createAntigravityStreamParser({ onText: (text) => deltas.push(text) });
  parser.feed("not-json\n");
  parser.feed(
    `${JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "ok" } })}\n`
  );
  const result = parser.finish();
  assert.equal(deltas.join(""), "ok");
  assert.equal(result.malformedLines, 1);
});

test("structured-format fallback detection is deliberately narrow", () => {
  assert.equal(
    isStructuredOutputUnsupported({ code: 2, stderr: "invalid value 'stream-json' for --output-format" }),
    true
  );
  assert.equal(
    isStructuredOutputUnsupported({ code: 1, stderr: "authentication required" }),
    false
  );
  assert.equal(isStructuredOutputUnsupported({ code: 0, stderr: "unknown output-format" }), false);
});

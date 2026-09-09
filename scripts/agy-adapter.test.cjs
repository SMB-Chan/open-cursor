const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const adapterPath = path.resolve(__dirname, "../bin/agy-open-cursor");
const adapter = require(adapterPath);

function makeFakeAgy(directory) {
  const fakePath = path.join(directory, "agy-fake.cjs");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const stateDir = process.env.FAKE_STATE_DIR;
const log = path.join(stateDir, "calls.log");
fs.appendFileSync(log, JSON.stringify(args) + "\\n");
if (args[0] === "models") {
  const countFile = path.join(stateDir, "models-count");
  const count = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, "utf8")) : 0;
  fs.writeFileSync(countFile, String(count + 1));
  process.stdout.write("gemini-3.9-flash-high     Gemini 3.9 Flash (High)\\n");
  process.stdout.write("gemini-3.9-flash-medium   Gemini 3.9 Flash (Medium)\\n");
  process.stdout.write("gemini-3.2-pro-high       Gemini 3.2 Pro (High)\\n");
  process.exit(0);
}
const formatIndex = args.indexOf("--output-format");
const format = formatIndex >= 0 ? args[formatIndex + 1] : "text";
if (format === "stream-json") {
  if (process.env.FAKE_STREAM_UNSUPPORTED === "1") {
    process.stderr.write("invalid value 'stream-json' for --output-format\\n");
    process.exit(2);
  }
  if (process.env.FAKE_PARTIAL_THEN_FAIL === "1") {
    process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_type:"agent_response",state:"ACTIVE",text_delta:"partial"}}) + "\\n");
    process.stderr.write("unsupported stream-json after start\\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({event:"init",init:{model:"fake"}}) + "\\n");
  process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_type:"agent_response",state:"ACTIVE",text_delta:"hello"}}) + "\\n");
  process.stdout.write(JSON.stringify({event:"step_update",step_update:{step_type:"agent_response",state:"DONE",text_delta:" world"}}) + "\\n");
  process.stdout.write(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"hello world"}}) + "\\n");
  process.exit(0);
}
process.stdout.write("fallback text");
`;
  writeFileSync(fakePath, source);
  chmodSync(fakePath, 0o755);
  return fakePath;
}

function runAdapter(directory, fakePath, extraEnv = {}, model = "Gemini 3.8 Flash (High)") {
  return spawnSync(
    process.execPath,
    [adapterPath, "-p=hello", "--output-format", "text", "--dangerously-skip-permissions", "--model", model],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: directory,
        OPEN_CURSOR_AGY_REAL_BIN: fakePath,
        FAKE_STATE_DIR: directory,
        ...extraEnv,
      },
    }
  );
}

test("model parsing and compatibility aliases select newest live slugs", () => {
  const models = adapter.parseModelList(`
gemini-3.9-flash-high     Gemini 3.9 Flash (High)
gemini-3.9-flash-medium   Gemini 3.9 Flash (Medium)
gemini-3.2-pro-high       Gemini 3.2 Pro (High)
`);
  assert.equal(adapter.resolveModel("flash", models), "gemini-3.9-flash-high");
  assert.equal(adapter.resolveModel("Gemini 3.8 Flash (High)", models), "gemini-3.9-flash-high");
  assert.equal(adapter.resolveModel("flash_lite", models), "gemini-3.9-flash-medium");
  assert.equal(adapter.resolveModel("pro", models), "gemini-3.2-pro-high");
});

test("stream parser handles split NDJSON chunks without duplicating result text", () => {
  const chunks = [];
  const parser = adapter.createStreamParser((text) => chunks.push(text));
  const ndjson = [
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "a" } }),
    JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "b" } }),
    JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "abc" } }),
  ].join("\n") + "\n";
  parser.feed(ndjson.slice(0, 13));
  parser.feed(ndjson.slice(13, 71));
  parser.feed(ndjson.slice(71));
  const result = parser.finish();
  assert.equal(chunks.join(""), "abc");
  assert.equal(result.response, "abc");
  assert.equal(result.resultSeen, true);
});

test("adapter discovers models once, caches them, and emits only response deltas", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "open-cursor-agy-test-"));
  const fakePath = makeFakeAgy(directory);

  const first = runAdapter(directory, fakePath);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, "hello world");
  assert.equal(readFileSync(path.join(directory, "models-count"), "utf8"), "1");

  const calls = readFileSync(path.join(directory, "calls.log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse);
  const runCall = calls.find((args) => args[0] !== "models");
  const modelIndex = runCall.indexOf("--model");
  assert.equal(runCall[modelIndex + 1], "gemini-3.9-flash-high");
  const formatIndex = runCall.indexOf("--output-format");
  assert.equal(runCall[formatIndex + 1], "stream-json");

  const second = runAdapter(directory, fakePath);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stdout, "hello world");
  assert.equal(readFileSync(path.join(directory, "models-count"), "utf8"), "1");
});

test("unsupported structured output falls back to text only before model text is emitted", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "open-cursor-agy-fallback-"));
  const fakePath = makeFakeAgy(directory);
  const result = runAdapter(directory, fakePath, { FAKE_STREAM_UNSUPPORTED: "1" }, "flash");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "fallback text");

  const calls = readFileSync(path.join(directory, "calls.log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((args) => args[0] !== "models");
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("stream-json"));
  assert.equal(calls[1].includes("stream-json"), false);
});

test("partial structured output is never retried as a write-capable task", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "open-cursor-agy-no-retry-"));
  const fakePath = makeFakeAgy(directory);
  const result = runAdapter(directory, fakePath, { FAKE_PARTIAL_THEN_FAIL: "1" }, "flash");
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "partial");

  const calls = readFileSync(path.join(directory, "calls.log"), "utf8")
    .trim()
    .split("\n")
    .map(JSON.parse)
    .filter((args) => args[0] !== "models");
  assert.equal(calls.length, 1);
});

test("formatToolSummary and renderStepProgressBar format visual indicators", () => {
  const summary = adapter.formatToolSummary("search_web", { query: "timetable" });
  assert.equal(summary.icon, "🌐");
  assert.equal(summary.action, "Web調査");
  assert.equal(summary.detail, "timetable");
  assert.match(summary.reasoning, /検索/);

  const bar1 = adapter.renderStepProgressBar(1);
  assert.match(bar1, /▰/);
  assert.match(bar1, /%/);

  const bar5 = adapter.renderStepProgressBar(5);
  assert.match(bar5, /▰/);
});

test("stream parser emits visual progress bar and reasoning summary for autonomous tool steps", () => {
  const chunks = [];
  const parser = adapter.createStreamParser((text) => chunks.push(text));
  const ndjson = [
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "ACTIVE",
        step_type: "tool",
        tool_name: "search_web",
        tool_info: { name: "search_web", parameters: { query: "train timetable" } },
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 1,
        state: "DONE",
        step_type: "tool",
        tool_name: "search_web",
        duration_seconds: 0.8,
      },
    }),
    JSON.stringify({
      event: "step_update",
      step_update: {
        step_index: 2,
        state: "ACTIVE",
        step_type: "agent_response",
        text_delta: "Final answer generated.",
      },
    }),
    JSON.stringify({
      event: "result",
      result: { status: "SUCCESS", response: "Final answer generated." },
    }),
  ].join("\n") + "\n";

  parser.feed(ndjson);
  const result = parser.finish();
  const allOutput = chunks.join("");

  assert.match(allOutput, /Web調査/);
  assert.match(allOutput, /train timetable/);
  assert.match(allOutput, /▰/);
  assert.match(allOutput, /0\.8秒/);
  assert.match(allOutput, /自律処理完了/);
  assert.match(allOutput, /Final answer generated\./);
  assert.equal(result.toolStepCount, 1);
});

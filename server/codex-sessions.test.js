import test from "node:test";
import assert from "node:assert/strict";

import {
  GOAL_BLOCKED_MARKER,
  GOAL_COMPLETE_MARKER,
  buildGoalContract,
  buildGoalRoundPrompt,
  codexCliSupportsResume,
  extractSessionId,
  goalLoopConfig,
  parseGoalRoundStatus,
  readGoalStatus,
  sessionIdFromRun,
  stripGoalMarker,
} from "./codex-sessions.js";

test("extractSessionId reads the codex exec stderr header", () => {
  const stderr = [
    "OpenAI Codex v0.153.4",
    "--------",
    "workdir: /tmp/probe",
    "session id: 01a086ec-e4c5-7902-90f1-6e24a631794e",
    "--------",
    "codex",
    "PROBE_OK",
  ].join("\n");
  assert.equal(extractSessionId(stderr), "01a086ec-e4c5-7902-90f1-6e24a631794e");
  assert.equal(extractSessionId("no header here"), null);
  assert.equal(extractSessionId(""), null);
  assert.equal(extractSessionId(undefined), null);
});

test("sessionIdFromRun prefers stderr over other fields", () => {
  const run = { stderr: "session id: 01a086ec-e4c5-7902-90f1-6e24a631794e", stdout: "PROBE_OK" };
  assert.equal(sessionIdFromRun(run), "01a086ec-e4c5-7902-90f1-6e24a631794e");
  assert.equal(sessionIdFromRun({ stderr: "" }), null);
  assert.equal(sessionIdFromRun(null), null);
});

test("parseGoalRoundStatus accepts a final marker and defaults to continue", () => {
  assert.equal(parseGoalRoundStatus("work done\nGOAL_COMPLETE").status, "complete");
  assert.equal(parseGoalRoundStatus("GOAL_COMPLETE\nthen chatter\nGOAL_BLOCKED").status, "blocked");
  assert.equal(parseGoalRoundStatus("GOAL_BLOCKED\nmore work\nGOAL_COMPLETE").status, "complete");
  assert.equal(parseGoalRoundStatus("still working...").status, "continue");
  assert.equal(parseGoalRoundStatus("").status, "continue");
  assert.equal(parseGoalRoundStatus(undefined).status, "continue");
  assert.equal(parseGoalRoundStatus("no marker but mentions GOAL_COMPLETE_INLINE").status, "continue");
});

test("goal status ignores examples, code blocks and non-final markers", () => {
  const examples = [
    "GOAL_COMPLETE\nTests are still failing.",
    "GOAL_BLOCKED\nTrying another approach.",
    "```text\nGOAL_COMPLETE\n```",
    "```text\nGOAL_COMPLETE",
    "~~~\nGOAL_BLOCKED\n~~~",
    "````text\n```\nGOAL_COMPLETE",
    "~~~text\n```\nGOAL_COMPLETE",
    "> GOAL_COMPLETE",
    "    GOAL_COMPLETE",
    "\tGOAL_COMPLETE",
    "GOAL_COMPLETE_INLINE",
  ];
  for (const content of examples) {
    assert.equal(parseGoalRoundStatus(content).status, "continue", content);
    assert.equal(stripGoalMarker(content), content.trim(), content);
  }
  const report = "Example:\n```\nGOAL_BLOCKED\n```\nVerified tests.\nGOAL_COMPLETE\n \n";
  assert.equal(parseGoalRoundStatus(report).status, "complete");
  assert.equal(stripGoalMarker(report), "Example:\n```\nGOAL_BLOCKED\n```\nVerified tests.");
  assert.equal(parseGoalRoundStatus("Verified.\r\nGOAL_COMPLETE\r\n").status, "complete");
});

test("models append explanations to the marker line; they still count", () => {
  assert.equal(
    parseGoalRoundStatus("verified the file\nGOAL_COMPLETE — the goal is fully satisfied and verified").status,
    "complete"
  );
  assert.equal(
    parseGoalRoundStatus("missing credentials\nGOAL_BLOCKED — cannot proceed").status,
    "blocked"
  );
  assert.equal(
    parseGoalRoundStatus("work done\nGOAL_COMPLETE — verified\nchatter\nGOAL_COMPLETE — final").status,
    "complete"
  );
});

test("stripGoalMarker removes status lines only", () => {
  assert.equal(stripGoalMarker("report body\nGOAL_COMPLETE"), "report body");
  assert.equal(stripGoalMarker("reason explained\nGOAL_BLOCKED — cannot proceed"), "reason explained");
  assert.equal(stripGoalMarker("keep GOAL_COMPLETE inline"), "keep GOAL_COMPLETE inline");
  assert.equal(stripGoalMarker("GOAL_COMPLETE"), "");
});

test("buildGoalContract carries goal, budget and thread information", () => {
  const contract = buildGoalContract("Ship the parser fix", { maxRounds: 6, round: 1 });
  assert.match(contract, /Ship the parser fix/);
  assert.match(contract, /GOAL_COMPLETE/);
  assert.match(contract, /GOAL_BLOCKED/);
  assert.match(contract, /1 of at most 6/);
  assert.match(contract, /Do not run git commit unless/);

  const resumed = buildGoalContract("Ship it", { maxRounds: 6, round: 3, threadId: "abc-123" });
  assert.match(resumed, /abc-123/);
});

test("buildGoalRoundPrompt stays tiny and references the previous outcome", () => {
  const prompt = buildGoalRoundPrompt({ round: 2, maxRounds: 8, lastStatus: "continue", lastTail: "next: run tests" });
  assert.match(prompt, /round 2 of at most 8/);
  assert.match(prompt, /Previous round tail/);
  assert.match(prompt, /next: run tests/);

  const blocked = buildGoalRoundPrompt({ round: 3, maxRounds: 8, lastStatus: "blocked" });
  assert.match(blocked, /reported being blocked/);
});

test("goalLoopConfig rejects invalid overrides without silently changing budgets", () => {
  const base = goalLoopConfig();
  assert.equal(base.maxRounds, 8);
  assert.ok(base.roundTimeoutMs >= 1000);

  for (const maxRounds of [99, 0, -1, 1.5, NaN, Infinity, "4", null]) {
    assert.throws(() => goalLoopConfig({ maxRounds }), /goal.maxRounds/);
  }
  for (const roundTimeoutMs of [0, 999, 3600001, 1000.5, NaN, Infinity, "1000", null]) {
    assert.throws(() => goalLoopConfig({ roundTimeoutMs }), /goal.roundTimeoutMs/);
  }
  assert.equal(goalLoopConfig({ maxRounds: 4 }).maxRounds, 4);
  assert.equal(goalLoopConfig({ roundTimeoutMs: 1000 }).roundTimeoutMs, 1000);
  assert.equal(goalLoopConfig({ roundTimeoutMs: 3600000 }).roundTimeoutMs, 3600000);
});

test("codexCliSupportsResume detects the resume subcommand without running an agent", async () => {
  assert.equal(await codexCliSupportsResume("/nonexistent/open-cursor-test-codex"), false);
});

test("readGoalStatus returns null safely without a thread or sqlite3", async () => {
  assert.equal(await readGoalStatus(null), null);
  assert.equal(await readGoalStatus(""), null);
  const status = await readGoalStatus("00000000-0000-0000-0000-000000000000");
  assert.ok(status === null || typeof status === "string");
});

test("marker constants are stable wire format", () => {
  assert.equal(GOAL_COMPLETE_MARKER, "GOAL_COMPLETE");
  assert.equal(GOAL_BLOCKED_MARKER, "GOAL_BLOCKED");
});

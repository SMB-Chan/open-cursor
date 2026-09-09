import test from "node:test";
import assert from "node:assert/strict";

import {
  getBridgeStats,
  recordRequestEnd,
  recordRequestStart,
  resetBridgeStats,
} from "./stats.js";

test("resetBridgeStats returns a fresh baseline", () => {
  const stats = resetBridgeStats();
  assert.equal(stats.requests.total, 0);
  assert.equal(stats.requests.active, 0);
  assert.equal(stats.requests.completed, 0);
  assert.deepEqual(stats.recent, []);
  assert.equal(stats.last_request, null);
  assert.ok(stats.uptime_seconds >= 0);
});

test("request lifecycle tracks totals, active count and per-mode counters", () => {
  resetBridgeStats();

  recordRequestStart("chatcmpl-11111111-1111-1111-1111-111111111111", "collaborative");
  recordRequestStart("chatcmpl-22222222-2222-2222-2222-222222222222", "codex");

  let stats = getBridgeStats();
  assert.equal(stats.requests.total, 2);
  assert.equal(stats.requests.active, 2);
  assert.equal(stats.modes.collaborative, 1);
  assert.equal(stats.modes.codex, 1);

  recordRequestEnd("chatcmpl-11111111-1111-1111-1111-111111111111", {
    status: "completed",
    agent: "collaborative",
  });
  stats = getBridgeStats();
  assert.equal(stats.requests.active, 1);
  assert.equal(stats.requests.completed, 1);
  assert.equal(stats.agents.collaborative, 1);
  assert.equal(stats.last_request.agent, "collaborative");
  assert.equal(stats.recent.length, 1);
  assert.ok(stats.avg_duration_ms >= 0);
});

test("failed and cancelled statuses are preserved with error details", () => {
  resetBridgeStats();

  recordRequestStart("chatcmpl-33333333-3333-3333-3333-333333333333", "codex");
  recordRequestEnd("chatcmpl-33333333-3333-3333-3333-333333333333", {
    status: "failed",
    agent: "codex",
    error: new Error("codex exited with code 1"),
  });

  const stats = getBridgeStats();
  assert.equal(stats.requests.failed, 1);
  assert.equal(stats.requests.completed, 0);
  assert.equal(stats.last_request.status, "failed");
  assert.match(stats.last_request.error, /exited with code 1/);
  assert.equal(stats.agents.codex, 1);
});

test("unknown statuses fall back to completed and double-ends are ignored", () => {
  resetBridgeStats();

  recordRequestStart("chatcmpl-44444444-4444-4444-4444-444444444444", "auto");
  recordRequestEnd("chatcmpl-44444444-4444-4444-4444-444444444444", { status: "weird" });
  recordRequestEnd("chatcmpl-44444444-4444-4444-4444-444444444444", { status: "completed" });

  const stats = getBridgeStats();
  assert.equal(stats.requests.completed, 1);
  assert.equal(stats.requests.failed, 0);
});

test("recent ring buffer stays bounded and omits prompt content", () => {
  resetBridgeStats();

  for (let i = 0; i < 30; i++) {
    const id = `chatcmpl-5${String(i).padStart(7, "0")}-5555-5555-5555-555555555555`;
    recordRequestStart(id, "mimo");
    recordRequestEnd(id, { status: "completed", agent: "mimo" });
  }

  const stats = getBridgeStats();
  assert.equal(stats.recent.length, 20);
  assert.equal(stats.requests.total, 30);
  assert.equal(stats.requests.completed, 30);
  assert.equal(stats.modes.mimo, 30);

  const serialized = JSON.stringify(stats);
  assert.doesNotMatch(serialized, /prompt/i);
});

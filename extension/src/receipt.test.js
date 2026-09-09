const test = require("node:test");
const assert = require("node:assert/strict");

const { pollExecutionReceipt, summarizeWorkspaceReceipt } = require("./receipt.js");

function jsonResponse(status, receipt) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return receipt === undefined ? {} : { receipt };
    },
  };
}

test("pollExecutionReceipt waits until a running receipt is finalized", async () => {
  const responses = [
    jsonResponse(200, { id: "chatcmpl-1", status: "running" }),
    jsonResponse(200, { id: "chatcmpl-1", status: "cancelled" }),
  ];
  let calls = 0;

  const receipt = await pollExecutionReceipt({
    requestId: "chatcmpl-1",
    bridgeUrl: "http://127.0.0.1:9876",
    fetchFn: async () => responses[calls++],
    sleepFn: async () => {},
    attempts: 3,
    delayMs: 0,
  });

  assert.equal(calls, 2);
  assert.equal(receipt.status, "cancelled");
});

test("pollExecutionReceipt retries 404 until receipt appears", async () => {
  const responses = [
    jsonResponse(404),
    jsonResponse(200, { id: "chatcmpl-2", status: "completed" }),
  ];
  let calls = 0;

  const receipt = await pollExecutionReceipt({
    requestId: "chatcmpl-2",
    bridgeUrl: "http://127.0.0.1:9876",
    fetchFn: async () => responses[calls++],
    sleepFn: async () => {},
    attempts: 3,
    delayMs: 0,
  });

  assert.equal(calls, 2);
  assert.equal(receipt.status, "completed");
});

test("pollExecutionReceipt stops on a non-retryable HTTP response", async () => {
  let calls = 0;
  const receipt = await pollExecutionReceipt({
    requestId: "chatcmpl-3",
    bridgeUrl: "http://127.0.0.1:9876",
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(403);
    },
    sleepFn: async () => {},
    attempts: 4,
    delayMs: 0,
  });

  assert.equal(receipt, null);
  assert.equal(calls, 1);
});

test("pollExecutionReceipt returns null after only running receipts", async () => {
  let calls = 0;
  const receipt = await pollExecutionReceipt({
    requestId: "chatcmpl-4",
    bridgeUrl: "http://127.0.0.1:9876",
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(200, { id: "chatcmpl-4", status: "running" });
    },
    sleepFn: async () => {},
    attempts: 2,
    delayMs: 0,
  });

  assert.equal(receipt, null);
  assert.equal(calls, 2);
});

test("summarizes newly dirty, committed, and pre-existing paths", () => {
  const summary = summarizeWorkspaceReceipt({
    status: "completed",
    non_destructive: true,
    rollback_performed: false,
    git: {
      available: true,
      newly_dirty_paths: ["src/a.js"],
      committed_paths: ["src/b.js"],
      persistent_preexisting_dirty_paths: ["notes.txt"],
      no_longer_dirty_paths: [],
      working_tree_fingerprint_changed: true,
      attribution_note: "Observed only.",
    },
  });

  assert.equal(summary.title, "Workspace receipt · completed");
  assert.match(summary.summary, /\+1 newly dirty/);
  assert.match(summary.summary, /1 committed/);
  assert.match(summary.summary, /1 pre-existing still dirty/);
  assert.deepEqual(summary.groups[0], { label: "Newly dirty", paths: ["src/a.js"] });
  assert.equal(summary.nonDestructive, true);
  assert.equal(summary.rollbackPerformed, false);
});

test("reports no visible Git changes when state is stable", () => {
  const summary = summarizeWorkspaceReceipt({
    status: "completed",
    git: {
      available: true,
      newly_dirty_paths: [],
      committed_paths: [],
      persistent_preexisting_dirty_paths: [],
      no_longer_dirty_paths: [],
      working_tree_fingerprint_changed: false,
    },
  });

  assert.equal(summary.summary, "No visible Git state change");
});

test("surfaces secret omission and truncation without exposing hidden paths", () => {
  const summary = summarizeWorkspaceReceipt({
    status: "failed",
    git: {
      available: true,
      newly_dirty_paths: ["src/public.js"],
      secret_like_paths_omitted: true,
      truncated: true,
    },
  });

  assert.equal(summary.warning, "secret-like paths omitted · receipt truncated");
  assert.deepEqual(summary.groups[0].paths, ["src/public.js"]);
});

test("handles non-Git workspaces", () => {
  const summary = summarizeWorkspaceReceipt({
    status: "cancelled",
    non_destructive: true,
    rollback_performed: false,
    git: {
      available: false,
      attribution_note: "Workspace is not a readable Git work tree.",
    },
  });

  assert.equal(summary.summary, "Git change details unavailable for this workspace.");
  assert.match(summary.note, /not a readable Git work tree/);
});

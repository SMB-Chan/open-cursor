const test = require("node:test");
const assert = require("node:assert/strict");

const { summarizeWorkspaceReceipt } = require("./receipt.js");

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

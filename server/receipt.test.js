import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  finishWorkspaceReceipt,
  getExecutionReceipt,
  shouldJournalWorkspace,
  startWorkspaceReceipt,
} from "./receipt.js";

function run(command, args, cwd) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} exited ${code}: ${stderr}`));
    });
  });
}

async function withRepo(callback) {
  const root = await mkdtemp(join(tmpdir(), "open-cursor-receipt-test-"));
  try {
    await run("git", ["init", "-q"], root);
    await run("git", ["config", "user.email", "test@example.invalid"], root);
    await run("git", ["config", "user.name", "Open Cursor Test"], root);
    await writeFile(join(root, "tracked.txt"), "baseline\n");
    await run("git", ["add", "tracked.txt"], root);
    await run("git", ["commit", "-qm", "baseline"], root);
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("journaling follows side-effect capability rather than provider preference", () => {
  assert.equal(shouldJournalWorkspace("auto", { requiresWorkspaceWrite: true }), true);
  assert.equal(shouldJournalWorkspace("auto", { requiresWorkspaceWrite: false }), false);
  assert.equal(shouldJournalWorkspace("autonomous", {}), true);
  assert.equal(shouldJournalWorkspace("antigravity", {}), true);
  assert.equal(shouldJournalWorkspace("mimo", {}), false);
  assert.equal(shouldJournalWorkspace("mimo-gemini", {}), false);
});

test("receipt reports newly dirty paths without mutating the workspace", async () => {
  await withRepo(async (root) => {
    const journal = await startWorkspaceReceipt(root, { id: "receipt-new-dirty", mode: "codex" });
    await writeFile(join(root, "tracked.txt"), "changed\n");
    await writeFile(join(root, "new.txt"), "new\n");

    const receipt = await finishWorkspaceReceipt(journal, { status: "completed" });
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.non_destructive, true);
    assert.equal(receipt.rollback_performed, false);
    assert.deepEqual(receipt.git.newly_dirty_paths, ["new.txt", "tracked.txt"]);
    assert.equal(receipt.git.visible_dirty_before, 0);
    assert.equal(receipt.git.visible_dirty_after, 2);
    assert.equal(receipt.git.head_changed, false);
    assert.equal(getExecutionReceipt("receipt-new-dirty")?.status, "completed");
  });
});

test("pre-existing dirty paths are kept distinct from newly dirty paths", async () => {
  await withRepo(async (root) => {
    await writeFile(join(root, "tracked.txt"), "user change\n");
    const journal = await startWorkspaceReceipt(root, { id: "receipt-preexisting", mode: "collaborative" });
    await writeFile(join(root, "new.txt"), "agent-visible change\n");

    const receipt = await finishWorkspaceReceipt(journal, { status: "failed", error: new Error("boom") });
    assert.deepEqual(receipt.git.newly_dirty_paths, ["new.txt"]);
    assert.deepEqual(receipt.git.persistent_preexisting_dirty_paths, ["tracked.txt"]);
    assert.equal(receipt.error_type, "Error");
  });
});

test("secret-like paths are omitted from public receipt paths", async () => {
  await withRepo(async (root) => {
    const journal = await startWorkspaceReceipt(root, { id: "receipt-secret", mode: "autonomous" });
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await writeFile(join(root, "visible.txt"), "visible\n");

    const receipt = await finishWorkspaceReceipt(journal, { status: "completed" });
    assert.deepEqual(receipt.git.newly_dirty_paths, ["visible.txt"]);
    assert.equal(receipt.git.secret_like_paths_omitted, true);
  });
});

test("receipt detects commits and lists non-secret committed paths", async () => {
  await withRepo(async (root) => {
    const journal = await startWorkspaceReceipt(root, { id: "receipt-commit", mode: "autonomous" });
    await writeFile(join(root, "tracked.txt"), "committed change\n");
    await run("git", ["add", "tracked.txt"], root);
    await run("git", ["commit", "-qm", "during execution"], root);

    const receipt = await finishWorkspaceReceipt(journal, { status: "completed" });
    assert.equal(receipt.git.head_changed, true);
    assert.deepEqual(receipt.git.committed_paths, ["tracked.txt"]);
    assert.equal(receipt.git.visible_dirty_after, 0);
  });
});

test("non-Git workspaces still produce a bounded receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "open-cursor-receipt-nongit-"));
  try {
    const journal = await startWorkspaceReceipt(root, { id: "receipt-nongit", mode: "codex" });
    const receipt = await finishWorkspaceReceipt(journal, { status: "completed" });
    assert.equal(receipt.git.available, false);
    assert.equal(receipt.non_destructive, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireWorkspaceExecution } from "./workspace-lock.js";

const busy = (error) => error.statusCode === 409 && error.name === "WorkspaceBusyError";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "open-cursor-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("simultaneous acquisitions have one owner; old releases cannot remove a new owner", async (t) => {
  const root = await fixture(t);
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireWorkspaceExecution(root)));
  const owners = results.filter((result) => result.status === "fulfilled");
  for (const owner of owners) t.after(owner.value);
  assert.equal(owners.length, 1);
  assert.ok(results.filter((result) => result.status === "rejected").every((result) => busy(result.reason)));
  const release = owners[0].value;
  release();
  const nextRelease = await acquireWorkspaceExecution(root);
  t.after(nextRelease);
  release();
  await assert.rejects(acquireWorkspaceExecution(root), busy);
});

test("Git subdirectories and symlink aliases share a reservation", async (t) => {
  const root = await fixture(t);
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  await mkdir(join(repo, "src"));
  await mkdir(join(repo, "tests"));
  await symlink(repo, join(root, "alias"));
  const release = await acquireWorkspaceExecution(join(repo, "src"));
  t.after(release);
  for (const candidate of [repo, join(repo, "tests"), join(root, "alias", "tests")]) {
    await assert.rejects(acquireWorkspaceExecution(candidate), busy);
  }
});

test("linked worktree .git files define independent checkout roots", async (t) => {
  const root = await fixture(t);
  for (const name of ["one", "two"]) {
    const repo = join(root, name);
    await mkdir(join(repo, "src"), { recursive: true });
    await writeFile(join(repo, ".git"), "gitdir: /unused/test/worktree\n");
  }
  const releaseOne = await acquireWorkspaceExecution(join(root, "one", "src"));
  t.after(releaseOne);
  const releaseTwo = await acquireWorkspaceExecution(join(root, "two"));
  t.after(releaseTwo);
  await assert.rejects(acquireWorkspaceExecution(join(root, "one")), busy);
});

test("non-Git ancestor paths conflict in both directions; sibling prefixes do not", async (t) => {
  const root = await fixture(t);
  for (const name of ["app/child", "application"]) await mkdir(join(root, name), { recursive: true });
  let release = await acquireWorkspaceExecution(join(root, "app"));
  t.after(() => release());
  await assert.rejects(acquireWorkspaceExecution(join(root, "app", "child")), busy);
  const siblingRelease = await acquireWorkspaceExecution(join(root, "application"));
  t.after(siblingRelease);
  release();
  release = await acquireWorkspaceExecution(join(root, "app", "child"));
  await assert.rejects(acquireWorkspaceExecution(join(root, "app")), busy);
});

test("aborted and invalid acquisitions do not leave reservations", async (t) => {
  const root = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(acquireWorkspaceExecution(root, controller.signal), { name: "AbortError" });
  await assert.rejects(acquireWorkspaceExecution(join(root, "missing")), { code: "ENOENT" });
  const release = await acquireWorkspaceExecution(root);
  t.after(release);
});

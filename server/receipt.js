import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

import { isSecretPath } from "./context.js";

const MAX_VISIBLE_PATHS = 200;
const MAX_STATUS_BYTES = 256 * 1024;
const MAX_DIFF_BYTES = 4 * 1024 * 1024;
const MAX_RECEIPTS = 100;
const RECEIPT_TTL_MS = 60 * 60 * 1000;

const receiptStore = new Map();

function runGit(args, { cwd, maxBytes = MAX_STATUS_BYTES, timeoutMs = 4000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let truncated = false;
    let settled = false;
    let timer;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(result);
    };

    const consume = (current, chunk) => {
      if (truncated) return current;
      const available = Math.max(0, maxBytes - current.length);
      if (chunk.length > available) {
        truncated = true;
        try {
          child.kill("SIGTERM");
        } catch {}
        return Buffer.concat([current, chunk.subarray(0, available)]);
      }
      return Buffer.concat([current, chunk]);
    };

    child.stdout.on("data", (chunk) => {
      stdout = consume(stdout, Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderr = consume(stderr, Buffer.from(chunk));
    });
    child.once("error", () =>
      finish({ code: null, stdout: "", stderr: "", truncated: false })
    );
    child.once("close", (code) =>
      finish({
        code,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated,
      })
    );

    timer = setTimeout(() => {
      truncated = true;
      try {
        child.kill("SIGTERM");
      } catch {}
      finish({
        code: null,
        stdout: stdout.toString("utf8"),
        stderr: stderr.toString("utf8"),
        truncated: true,
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

function parseStatusPaths(output) {
  const records = String(output || "").split("\0");
  const paths = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    paths.push(record.slice(3));

    if (/[RC]/.test(code) && records[index + 1]) {
      paths.push(records[index + 1]);
      index += 1;
    }
  }

  return paths.filter(Boolean);
}

function sanitizePaths(paths) {
  const visible = [];
  let secretLikePathsOmitted = false;
  let truncated = false;

  for (const path of new Set(paths)) {
    if (isSecretPath(path)) {
      secretLikePathsOmitted = true;
      continue;
    }
    if (visible.length >= MAX_VISIBLE_PATHS) {
      truncated = true;
      continue;
    }
    visible.push(path);
  }

  visible.sort();
  return { visible, secretLikePathsOmitted, truncated };
}

function hashParts(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(String(part || ""));
  return hash.digest("hex");
}

async function captureWorkspaceState(cwd) {
  const probe = await runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd,
    maxBytes: 128,
  });
  if (probe.code !== 0 || probe.stdout.trim() !== "true") {
    return {
      gitAvailable: false,
      head: null,
      dirtyPaths: [],
      secretLikePathsOmitted: false,
      truncated: false,
      fingerprint: null,
    };
  }

  const [headResult, statusResult, diffResult] = await Promise.all([
    runGit(["rev-parse", "--verify", "HEAD"], { cwd, maxBytes: 256 }),
    runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd,
      maxBytes: MAX_STATUS_BYTES,
    }),
    runGit(["diff", "HEAD", "--no-ext-diff", "--binary", "--"], {
      cwd,
      maxBytes: MAX_DIFF_BYTES,
    }),
  ]);

  const sanitized = sanitizePaths(parseStatusPaths(statusResult.stdout));
  const head = headResult.code === 0 ? headResult.stdout.trim() || null : null;

  return {
    gitAvailable: true,
    head,
    dirtyPaths: sanitized.visible,
    secretLikePathsOmitted: sanitized.secretLikePathsOmitted,
    truncated: Boolean(
      sanitized.truncated || statusResult.truncated || diffResult.truncated
    ),
    fingerprint: hashParts(statusResult.stdout, "\0", diffResult.stdout),
  };
}

async function changedPathsBetweenHeads(cwd, beforeHead, afterHead) {
  if (!beforeHead || !afterHead || beforeHead === afterHead) {
    return { paths: [], secretLikePathsOmitted: false, truncated: false };
  }

  const result = await runGit(
    ["diff", "--name-only", "-z", beforeHead, afterHead, "--"],
    { cwd, maxBytes: MAX_STATUS_BYTES }
  );
  if (result.code !== 0) {
    return { paths: [], secretLikePathsOmitted: false, truncated: result.truncated };
  }
  const sanitized = sanitizePaths(String(result.stdout || "").split("\0").filter(Boolean));
  return {
    paths: sanitized.visible,
    secretLikePathsOmitted: sanitized.secretLikePathsOmitted,
    truncated: Boolean(result.truncated || sanitized.truncated),
  };
}

function pruneReceiptStore(now = Date.now()) {
  for (const [id, entry] of receiptStore) {
    if (now - entry.updatedAtMs > RECEIPT_TTL_MS) receiptStore.delete(id);
  }
  while (receiptStore.size > MAX_RECEIPTS) {
    const oldest = receiptStore.keys().next().value;
    receiptStore.delete(oldest);
  }
}

function storeReceipt(receipt) {
  const updatedAtMs = Date.now();
  receiptStore.delete(receipt.id);
  receiptStore.set(receipt.id, { receipt, updatedAtMs });
  pruneReceiptStore(updatedAtMs);
  return receipt;
}

function getExecutionReceipt(id) {
  pruneReceiptStore();
  return receiptStore.get(String(id || ""))?.receipt || null;
}

function shouldJournalWorkspace(requestedMode, taskInfo = {}) {
  const mode = requestedMode || "auto";
  if (mode === "auto") return taskInfo.requiresWorkspaceWrite === true;
  if (mode === "mimo" || mode === "mimo-gemini") return false;
  return new Set(["codex", "antigravity", "pipeline", "collaborative", "autonomous", "goal", "loop"]).has(mode);
}

async function startWorkspaceReceipt(cwd, { id, mode } = {}) {
  const before = await captureWorkspaceState(cwd);
  const startedAt = new Date().toISOString();
  const journal = {
    id,
    mode: mode || "auto",
    cwd,
    before,
    startedAt,
  };

  storeReceipt({
    id,
    mode: journal.mode,
    status: "running",
    started_at: startedAt,
    non_destructive: true,
    rollback_performed: false,
    git: before.gitAvailable
      ? {
          available: true,
          baseline_head: before.head,
          visible_dirty_before: before.dirtyPaths.length,
          secret_like_paths_omitted: before.secretLikePathsOmitted,
          truncated: before.truncated,
        }
      : { available: false },
  });

  return journal;
}

async function finishWorkspaceReceipt(journal, { status = "completed", error } = {}) {
  if (!journal) return null;

  const after = await captureWorkspaceState(journal.cwd);
  const before = journal.before;
  const beforeSet = new Set(before.dirtyPaths || []);
  const afterSet = new Set(after.dirtyPaths || []);
  const newlyDirty = [...afterSet].filter((path) => !beforeSet.has(path)).sort();
  const noLongerDirty = [...beforeSet].filter((path) => !afterSet.has(path)).sort();
  const persistent = [...afterSet].filter((path) => beforeSet.has(path)).sort();
  const committed =
    before.gitAvailable && after.gitAvailable
      ? await changedPathsBetweenHeads(journal.cwd, before.head, after.head)
      : { paths: [], secretLikePathsOmitted: false, truncated: false };

  const receipt = {
    id: journal.id,
    mode: journal.mode,
    status,
    started_at: journal.startedAt,
    finished_at: new Date().toISOString(),
    non_destructive: true,
    rollback_performed: false,
    error_type: error?.name || undefined,
    git:
      before.gitAvailable && after.gitAvailable
        ? {
            available: true,
            baseline_head: before.head,
            final_head: after.head,
            head_changed: before.head !== after.head,
            working_tree_fingerprint_changed: before.fingerprint !== after.fingerprint,
            visible_dirty_before: before.dirtyPaths.length,
            visible_dirty_after: after.dirtyPaths.length,
            newly_dirty_paths: newlyDirty,
            no_longer_dirty_paths: noLongerDirty,
            persistent_preexisting_dirty_paths: persistent,
            committed_paths: committed.paths,
            secret_like_paths_omitted: Boolean(
              before.secretLikePathsOmitted ||
                after.secretLikePathsOmitted ||
                committed.secretLikePathsOmitted
            ),
            truncated: Boolean(before.truncated || after.truncated || committed.truncated),
            attribution_note:
              "Observed Git state changes are request-scoped observations, not proof that the agent alone caused them. Pre-existing dirty paths may also have changed.",
          }
        : {
            available: false,
            attribution_note:
              "Workspace is not a readable Git work tree; file-level change attribution was not attempted.",
          },
  };

  return storeReceipt(receipt);
}

export {
  captureWorkspaceState,
  finishWorkspaceReceipt,
  getExecutionReceipt,
  shouldJournalWorkspace,
  startWorkspaceReceipt,
};

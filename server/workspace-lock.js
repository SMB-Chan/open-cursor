import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

// Process-local reservations cover complete HTTP executions, including receipts
// and detached planning/review. Separate bridge processes need their own control.
const reservations = new Set();

async function workspaceRoot(cwd) {
  const canonical = await realpath(cwd);
  // Git operates on the whole worktree even when cwd is a subdirectory. A .git
  // file also identifies a linked worktree; its own checkout stays independent.
  for (let candidate = canonical; ; candidate = dirname(candidate)) {
    try {
      const entry = await stat(join(candidate, ".git"));
      if (entry.isDirectory() || entry.isFile()) return candidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    }
    if (dirname(candidate) === candidate) return canonical;
  }
}

function contains(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
}

export async function acquireWorkspaceExecution(cwd, signal) {
  const root = await workspaceRoot(cwd);
  if (signal?.aborted) {
    throw Object.assign(new Error("Execution cancelled before workspace reservation"), { name: "AbortError" });
  }
  // No await between checking and inserting: concurrent acquisitions cannot
  // both succeed after their filesystem lookups complete.
  for (const held of reservations) {
    if (contains(held.root, root) || contains(root, held.root)) {
      throw Object.assign(new Error("Workspace already has an active execution; retry after it finishes"), {
        name: "WorkspaceBusyError", statusCode: 409,
      });
    }
  }
  const reservation = { root };
  reservations.add(reservation);
  // Identity-based deletion is idempotent and cannot release a later owner.
  return () => reservations.delete(reservation);
}

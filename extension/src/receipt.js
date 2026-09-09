function safePaths(value) {
  return Array.isArray(value)
    ? value.filter((path) => typeof path === "string" && path.length > 0)
    : [];
}

function summarizeWorkspaceReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return null;

  const status = typeof receipt.status === "string" ? receipt.status : "unknown";
  const git = receipt.git && typeof receipt.git === "object" ? receipt.git : {};
  const summary = {
    title: `Workspace receipt · ${status}`,
    summary: "",
    groups: [],
    note: typeof git.attribution_note === "string" ? git.attribution_note : "",
    warning: "",
    nonDestructive: receipt.non_destructive === true,
    rollbackPerformed: receipt.rollback_performed === true,
  };

  if (git.available !== true) {
    summary.summary = "Git change details unavailable for this workspace.";
    if (!summary.note) {
      summary.note = "No automatic rollback was attempted.";
    }
    return summary;
  }

  const newlyDirty = safePaths(git.newly_dirty_paths);
  const committed = safePaths(git.committed_paths);
  const persistent = safePaths(git.persistent_preexisting_dirty_paths);
  const noLongerDirty = safePaths(git.no_longer_dirty_paths);

  const counts = [];
  if (newlyDirty.length) counts.push(`+${newlyDirty.length} newly dirty`);
  if (committed.length) counts.push(`${committed.length} committed`);
  if (persistent.length) counts.push(`${persistent.length} pre-existing still dirty`);
  if (noLongerDirty.length) counts.push(`${noLongerDirty.length} pre-existing no longer dirty`);
  if (git.head_changed === true && committed.length === 0) counts.push("HEAD changed");
  if (git.working_tree_fingerprint_changed === true && counts.length === 0) {
    counts.push("Git state changed");
  }
  if (counts.length === 0) counts.push("No visible Git state change");
  summary.summary = counts.join(" · ");

  if (newlyDirty.length) summary.groups.push({ label: "Newly dirty", paths: newlyDirty });
  if (committed.length) summary.groups.push({ label: "Committed", paths: committed });
  if (persistent.length) {
    summary.groups.push({ label: "Pre-existing dirty", paths: persistent });
  }
  if (noLongerDirty.length) {
    summary.groups.push({ label: "No longer dirty", paths: noLongerDirty });
  }

  const warnings = [];
  if (git.secret_like_paths_omitted === true) warnings.push("secret-like paths omitted");
  if (git.truncated === true) warnings.push("receipt truncated");
  if (warnings.length) summary.warning = warnings.join(" · ");

  if (!summary.note) {
    summary.note =
      "Observed changes are request-scoped observations and are not proof that the agent alone caused them.";
  }

  return summary;
}

module.exports = { summarizeWorkspaceReceipt };

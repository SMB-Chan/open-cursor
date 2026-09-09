function safePaths(value) {
  return Array.isArray(value)
    ? value.filter((path) => typeof path === "string" && path.length > 0)
    : [];
}

async function pollExecutionReceipt({
  requestId,
  bridgeUrl,
  fetchFn = globalThis.fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  attempts = 8,
  delayMs = 125,
  timeoutMs = 1000,
} = {}) {
  if (!requestId || typeof bridgeUrl !== "string" || typeof fetchFn !== "function") {
    return null;
  }

  const maxAttempts = Number.isInteger(attempts) ? Math.max(1, attempts) : 8;
  const retryDelay = Number.isInteger(delayMs) ? Math.max(0, delayMs) : 125;
  const requestTimeout = Number.isInteger(timeoutMs) ? Math.max(1, timeoutMs) : 1000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    let shouldRetry = false;

    try {
      const response = await fetchFn(
        `${bridgeUrl}/v1/execution-receipts/${encodeURIComponent(requestId)}`,
        { method: "GET", signal: controller.signal }
      );

      if (response?.ok) {
        const payload = await response.json().catch(() => ({}));
        const receipt = payload?.receipt || null;
        if (receipt && receipt.status !== "running") return receipt;
        shouldRetry = true;
      } else if (response?.status === 404) {
        shouldRetry = true;
      } else {
        return null;
      }
    } catch {
      shouldRetry = true;
    } finally {
      clearTimeout(timer);
    }

    if (!shouldRetry || attempt + 1 >= maxAttempts) break;
    if (retryDelay > 0) await sleepFn(retryDelay);
  }

  return null;
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

module.exports = { pollExecutionReceipt, summarizeWorkspaceReceipt };

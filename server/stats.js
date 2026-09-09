// Bounded in-memory bridge metrics.
//
// Metrics describe the lifetime of the current bridge process only. They are
// never persisted to disk, never include prompts or response bodies, and the
// recent-request ring buffer is capped so memory use stays bounded.

const RECENT_LIMIT = 20;
const ERROR_DETAIL_LIMIT = 200;

let metrics = freshMetrics();

const activeRequests = new Map();

function freshMetrics() {
  return {
    startedAt: Date.now(),
    requests: { total: 0, active: 0, completed: 0, failed: 0, cancelled: 0 },
    modes: {},
    agents: {},
    totalDurationMs: 0,
    lastRequest: null,
    recent: [],
  };
}

function bump(map, key, delta = 1) {
  if (!key) return;
  map[key] = (map[key] || 0) + delta;
}

const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function recordRequestStart(requestId, mode) {
  if (!requestId || activeRequests.has(requestId)) return;

  activeRequests.set(requestId, {
    mode: mode || "unknown",
    startedAt: Date.now(),
  });
  metrics.requests.total += 1;
  metrics.requests.active += 1;
  bump(metrics.modes, mode || "unknown");
}

export function recordRequestEnd(requestId, { status, agent, error } = {}) {
  const entry = activeRequests.get(requestId);
  if (!entry) return;
  activeRequests.delete(requestId);

  const normalizedStatus = FINISHED_STATUSES.has(status) ? status : "completed";
  metrics.requests.active = Math.max(0, metrics.requests.active - 1);
  metrics.requests[normalizedStatus] += 1;

  const durationMs = entry ? Date.now() - entry.startedAt : 0;
  metrics.totalDurationMs += durationMs;

  const record = {
    id: requestId,
    mode: entry?.mode || "unknown",
    status: normalizedStatus,
    agent: agent || null,
    duration_ms: durationMs,
    at: new Date().toISOString(),
  };
  if (error) {
    record.error = String(error?.message || error).slice(0, ERROR_DETAIL_LIMIT);
  }

  metrics.lastRequest = record;
  metrics.recent = [record, ...metrics.recent].slice(0, RECENT_LIMIT);
  bump(metrics.agents, agent);

  return record;
}

export function getBridgeStats() {
  const requests = { ...metrics.requests };
  const finished =
    requests.completed + requests.failed + requests.cancelled;

  return {
    started_at: new Date(metrics.startedAt).toISOString(),
    uptime_seconds: Math.floor((Date.now() - metrics.startedAt) / 1000),
    requests,
    modes: { ...metrics.modes },
    agents: { ...metrics.agents },
    avg_duration_ms: finished ? Math.round(metrics.totalDurationMs / finished) : 0,
    last_request: metrics.lastRequest,
    recent: [...metrics.recent],
  };
}

export function resetBridgeStats() {
  metrics = freshMetrics();
  return getBridgeStats();
}

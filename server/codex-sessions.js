// Codex session continuity helpers (goal/loop support).
//
// Modern Codex CLI exposes the goals subsystem through `codex exec`:
//   - `codex exec <prompt>`            → starts a thread; stderr header carries
//                                        `session id: <uuid>` for later continuation
//   - `codex exec resume <id> -`       → continues an existing thread (goal loop round)
//   - `codex exec fork <id> -`         → branches an existing thread into a new id
// The goals feature tracks status (active/complete/budget_limited/...) inside
// `~/.codex/goals_1.sqlite`; this module drives the loop from the bridge side and
// asks the model itself to declare GOAL_COMPLETE, which keeps the mechanism
// version-independent.

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

const CODEX_HOME = join(homedir(), ".codex");

// Extract `session id: <uuid>` from the stderr header that every codex exec run prints.
export function extractSessionId(stderr) {
  if (!stderr) return null;
  const match = String(stderr).match(/session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return match ? match[1] : null;
}

// The bridge's codex runs stream stdout to the client and only return the full
// result afterwards; runProcess already captures both streams, so callers pass
// the completed run result here.
export function sessionIdFromRun(runResult) {
  if (!runResult) return null;
  return extractSessionId(runResult.stderr) || null;
}

export const GOAL_COMPLETE_MARKER = "GOAL_COMPLETE";
export const GOAL_BLOCKED_MARKER = "GOAL_BLOCKED";

// The model must terminate every round with exactly one standalone status line;
// only exact marker lines count, so inline mentions cannot fake completion.
function lastMarkerLine(content) {
  const lines = String(content || "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === GOAL_COMPLETE_MARKER) return { marker: GOAL_COMPLETE_MARKER, index: i };
    if (line === GOAL_BLOCKED_MARKER) return { marker: GOAL_BLOCKED_MARKER, index: i };
  }
  return null;
}

export function parseGoalRoundStatus(content) {
  const found = lastMarkerLine(content);
  if (!found) return { status: "continue" };
  if (found.marker === GOAL_COMPLETE_MARKER) return { status: "complete", marker: found.marker };
  return { status: "blocked", marker: found.marker };
}

export function stripGoalMarker(content) {
  return String(content || "")
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return t !== GOAL_COMPLETE_MARKER && t !== GOAL_BLOCKED_MARKER;
    })
    .join("\n")
    .trim();
}

// Wrap a user goal in the loop contract. Every round receives the same contract
// so resume prompts stay small and consistent.
export function buildGoalContract(goalPrompt, { maxRounds, round, threadId } = {}) {
  return [
    "You are executing a long-running goal in goal mode. You will be re-invoked on this same thread repeatedly until the goal is done.",
    "",
    `# Goal`,
    goalPrompt,
    "",
    "# Loop rules",
    "- Work autonomously: inspect, edit, run checks, and fix errors without asking for approval.",
    "- Do not run git commit unless the goal explicitly requires it.",
    "- End EVERY response with exactly one status line and nothing after it:",
    `  ${GOAL_COMPLETE_MARKER} — the goal is fully satisfied and verified`,
    `  ${GOAL_BLOCKED_MARKER} — you cannot proceed (missing credentials, destructive action outside scope, etc.); explain why before the marker`,
    "  any other ending — you will be resumed for the next round; end with a one-line plan for the next round",
    "",
    `Rounds used: ${round} of at most ${maxRounds}.`,
    threadId ? `Continuing existing Codex thread ${threadId}.` : "A new Codex thread will be recorded from this round.",
  ].join("\n");
}

// Continuation prompt for rounds 2..N: deliberately tiny.
export function buildGoalRoundPrompt({ round, maxRounds, lastStatus, lastTail }) {
  const tail = lastTail ? `\n\n[Previous round tail]\n${lastTail}` : "";
  return [
    `Goal loop round ${round} of at most ${maxRounds}. Continue the goal on this thread.`,
    lastStatus === "blocked"
      ? "The previous round reported being blocked. Re-evaluate: try an alternative approach if possible."
      : "Continue where the previous round left off.",
    "Remember the loop rules: work autonomously and end with the status line.",
    tail,
  ]
    .filter(Boolean)
    .join("\n");
}

const GOAL_ENV_DEFAULTS = {
  maxRounds: 8,
  roundTimeoutMsDefault: 10 * 60 * 1000,
};

export function goalLoopConfig(overrides = {}) {
  const envInt = (name, fallback, min, max) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return fallback;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
    return parsed;
  };
  return {
    maxRounds: Math.max(1, Math.min(32, overrides.maxRounds ?? envInt("BRIDGE_GOAL_MAX_ROUNDS", GOAL_ENV_DEFAULTS.maxRounds, 1, 32))),
    roundTimeoutMs: Math.max(1000, overrides.roundTimeoutMs ?? envInt("BRIDGE_GOAL_ROUND_TIMEOUT_MS", GOAL_ENV_DEFAULTS.roundTimeoutMsDefault, 1000, 60 * 60 * 1000)),
  };
}

// Best-effort read of the goals subsystem state for a thread (status is written
// by the Codex CLI itself). Never throws: goal status is observational only.
export async function readGoalStatus(threadId) {
  if (!threadId) return null;
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const out = await promisify(execFile)(
      process.env.SQLITE3_BIN || "sqlite3",
      [join(CODEX_HOME, "goals_1.sqlite"), "SELECT status FROM thread_goals WHERE thread_id = ?;"],
      { timeout: 2000 }
    );
    const status = String(out.stdout || "").trim();
    return status || null;
  } catch {
    return null;
  }
}

export async function codexCliSupportsResume(codexBin = process.env.CODEX_BIN || "codex") {
  try {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const result = await promisify(execFile)(codexBin, ["exec", "resume", "--help"], { timeout: 5000 });
    return /resume/i.test(result.stdout || "");
  } catch {
    return false;
  }
}

export async function codexAuthPresent() {
  try {
    await readFile(join(CODEX_HOME, "auth.json"), "utf-8");
    return true;
  } catch {
    return false;
  }
}

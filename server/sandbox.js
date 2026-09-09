// Optional OS-level isolation for detached reviewer processes.
//
// The detached reviewer (automatic Gemini planning/review) already runs from a
// temporary working directory with a temporary HOME, but that is only process
// hygiene: the CLI still runs with the permissions of the local user and could
// write anywhere it likes. When a supported sandbox facility is available, the
// bridge can additionally execute the reviewer inside a bubblewrap mount
// namespace in which:
//
//   - the entire filesystem is mounted read-only
//   - only the reviewer's isolated temporary directory, its GEMINI_HOME, /tmp,
//     and /run are writable
//   - the workspace therefore cannot be modified by a reviewer that is never
//     supposed to write to it
//
// Modes:
//   off        — no sandbox (historical behavior, default)
//   auto       — use bubblewrap when a probe succeeds, otherwise proceed
//                unsandboxed (reporting "auto-unavailable")
//   bubblewrap — require bubblewrap; fail the request when the probe fails
//
// The sandbox is intentionally applied ONLY to detached reviewer processes.
// Workspace writers (Codex, explicitly selected Antigravity) must be able to
// modify the workspace and are never wrapped. As with everything in this
// project this is defense-in-depth, not a security boundary against a
// compromised kernel or a sandbox escape.
import { spawn } from "node:child_process";

export const SANDBOX_MODES = ["off", "auto", "bubblewrap"];

export class SandboxUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "SandboxUnavailableError";
    this.statusCode = 503;
  }
}

export function parseSandboxMode(value, fallback = "off") {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!normalized) return fallback;
  return SANDBOX_MODES.includes(normalized) ? normalized : null;
}

/**
 * Build the bubblewrap argument prefix for a detached reviewer run.
 *
 * The isolated directory is bound writable at its own path because HOME, PWD,
 * and cwd already point there. GEMINI_HOME is bound writable only when it
 * exists, so OAuth token refreshes keep working without granting write access
 * to anything else. The trailing "--" separates the wrapper profile from the
 * wrapped command vector.
 */
export function reviewerSandboxProfile({ isolatedDir, geminiHome }) {
  if (!isolatedDir) {
    throw new Error("reviewer sandbox profile requires an isolated directory");
  }
  const args = [
    "--die-with-parent",
    "--new-session",
    "--dev", "/dev",
    "--proc", "/proc",
    "--tmpfs", "/tmp",
    "--tmpfs", "/run",
    "--ro-bind", "/", "/",
    "--bind", isolatedDir, isolatedDir,
  ];
  if (geminiHome) {
    args.push("--bind", geminiHome, geminiHome);
  }
  args.push("--");
  return args;
}

const PROBE_ARGS = [
  "--die-with-parent",
  "--dev", "/dev",
  "--proc", "/proc",
  "--tmpfs", "/tmp",
  "--ro-bind", "/", "/",
  "--", "/bin/true",
];

/**
 * Probe whether a bubblewrap binary is actually usable (present AND able to
 * create its mount namespace — unprivileged user namespaces are disabled on
 * some distributions). Never rejects; resolves false for any failure.
 */
export function probeSandboxFacility(bin = "bwrap", timeoutMs = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };

    let child;
    try {
      child = spawn(bin, PROBE_ARGS, { stdio: "ignore", windowsHide: true });
    } catch {
      finish(false);
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      finish(false);
    }, timeoutMs);
    timer.unref?.();

    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
}

/**
 * Resolve a requested sandbox mode against the actual environment.
 *
 * - off        → { active: false, label: "off" } (probe never runs)
 * - auto       → probe bubblewrap: active on success, inactive with label
 *                "auto-unavailable" on failure
 * - bubblewrap → probe bubblewrap: active on success, throws
 *                SandboxUnavailableError on failure (fail closed)
 */
export async function resolveReviewerSandbox({
  mode = "off",
  bwrapBin = "bwrap",
  geminiHome = null,
  probe = probeSandboxFacility,
} = {}) {
  const normalized = parseSandboxMode(mode, "off");
  if (!normalized) {
    throw new Error(
      `invalid reviewer sandbox mode: ${mode} (expected one of: ${SANDBOX_MODES.join(", ")})`
    );
  }
  if (normalized === "off") {
    return { active: false, label: "off", bwrapBin, geminiHome: null };
  }

  const available = await probe(bwrapBin);
  if (available) {
    return { active: true, label: "bubblewrap", bwrapBin, geminiHome };
  }
  if (normalized === "auto") {
    return { active: false, label: "auto-unavailable", bwrapBin, geminiHome: null };
  }
  throw new SandboxUnavailableError(
    `reviewer sandbox mode "bubblewrap" requires a working ${bwrapBin} facility, but the probe failed`
  );
}

/**
 * Turn a resolved sandbox + per-run isolated directory into the spawn vector
 * prefix for runProcess: the wrapper command plus the profile arguments.
 */
export function buildSandboxLaunch({ sandbox, isolatedDir }) {
  if (!sandbox?.active) return null;
  return {
    command: sandbox.bwrapBin,
    args: reviewerSandboxProfile({
      isolatedDir,
      geminiHome: sandbox.geminiHome,
    }),
  };
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_OUTPUT_BYTES = envInt("BRIDGE_MAX_OUTPUT_BYTES", 8 * 1024 * 1024, 1024);
const AGENT_TIMEOUT_MS = envInt("BRIDGE_AGENT_TIMEOUT_MS", 10 * 60 * 1000, 1000);
const KILL_GRACE_MS = envInt("BRIDGE_KILL_GRACE_MS", 1500, 100);
const activeProcesses = new Map();

function envInt(name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

class ExecutionAbortedError extends Error {
  constructor(message = "Execution aborted") {
    super(message);
    this.name = "AbortError";
  }
}

class ExecutionTimeoutError extends HttpError {
  constructor(timeoutMs) {
    super(504, `Agent execution exceeded ${timeoutMs} ms`);
    this.name = "ExecutionTimeoutError";
  }
}

function activeExecutionCount() {
  return activeProcesses.size;
}

function executionConfig() {
  return {
    timeout_ms: AGENT_TIMEOUT_MS,
    max_output_bytes: MAX_OUTPUT_BYTES,
    kill_grace_ms: KILL_GRACE_MS,
  };
}

function runProcess({
  agent,
  command,
  args,
  cwd,
  env,
  signal,
  onStdout,
  onStderr,
  timeoutMs = AGENT_TIMEOUT_MS,
  transformContent,
}) {
  if (signal?.aborted) {
    return Promise.reject(new ExecutionAbortedError("Execution aborted before start"));
  }

  return new Promise((resolvePromise, rejectPromise) => {
    const executionId = randomUUID();
    const child = spawn(command, args, {
      cwd: cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    activeProcesses.set(child, {
      id: executionId,
      agent,
      startedAt: Date.now(),
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let aborted = false;
    let timedOut = false;
    let outputExceeded = false;
    let forceKillTimer = null;

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode) return;
      try {
        child.kill("SIGTERM");
      } catch {}
      if (!forceKillTimer) {
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && !child.signalCode) {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
        }, KILL_GRACE_MS);
        forceKillTimer.unref?.();
      }
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    const executionTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    executionTimer.unref?.();

    const cleanup = () => {
      activeProcesses.delete(child);
      signal?.removeEventListener("abort", onAbort);
      clearTimeout(executionTimer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const consumeOutput = (kind, text, callback) => {
      if (settled || outputExceeded) return;
      outputBytes += Buffer.byteLength(text, "utf8");
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        terminate();
        return;
      }

      if (kind === "stdout") stdout += text;
      else stderr += text;
      callback?.(text);
    };

    child.stdout.on("data", (text) => consumeOutput("stdout", text, onStdout));
    child.stderr.on("data", (text) => consumeOutput("stderr", text, onStderr));

    child.once("error", (error) => settle(rejectPromise, error));
    child.once("close", (code, signalCode) => {
      if (aborted) {
        settle(rejectPromise, new ExecutionAbortedError("Agent execution cancelled"));
        return;
      }
      if (timedOut) {
        settle(rejectPromise, new ExecutionTimeoutError(timeoutMs));
        return;
      }
      if (outputExceeded) {
        settle(
          rejectPromise,
          new HttpError(502, `Agent output exceeded ${MAX_OUTPUT_BYTES} bytes`)
        );
        return;
      }

      const raw = stdout.trim() || stderr.trim();
      let content = raw;
      if (transformContent) {
        try {
          content = transformContent(raw, { stdout, stderr, code, signal: signalCode });
        } catch (error) {
          settle(rejectPromise, error);
          return;
        }
      }

      settle(resolvePromise, {
        content,
        stdout,
        stderr,
        agent,
        code,
        signal: signalCode,
        executionId,
      });
    });
  });
}

function stopActiveProcesses() {
  for (const child of activeProcesses.keys()) {
    if (child.exitCode === null && !child.signalCode) {
      try {
        child.kill("SIGTERM");
      } catch {}
    }
  }
}

export {
  ExecutionAbortedError,
  ExecutionTimeoutError,
  HttpError,
  activeExecutionCount,
  executionConfig,
  runProcess,
  stopActiveProcesses,
};

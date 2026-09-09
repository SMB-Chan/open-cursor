import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
  activeExecutionCount, ExecutionTimeoutError, runProcess, stopActiveProcesses,
} from "./engine.js";

function nodeRun(source, options = {}) {
  return runProcess({ agent: "test", command: process.execPath,
    args: ["-e", source], timeoutMs: 5000, ...options });
}

test("early CLI failures during prompt delivery preserve diagnostics without an unhandled EPIPE", async () => {
  const result = await nodeRun("process.stderr.write('test authentication failure'); process.exit(7)", {
    stdinText: "x".repeat(2 * 1024 * 1024),
  });
  assert.equal(result.code, 7);
  assert.match(result.stderr, /test authentication failure/);
  assert.equal(activeExecutionCount(), 0);
});

test("successful exit without accepting a large prompt fails instead of reporting work completed", async () => {
  await assert.rejects(nodeRun("process.exit(0)", { stdinText: "x".repeat(2 * 1024 * 1024) }),
    (error) => error.statusCode === 502 && /prompt input/.test(error.message));
  assert.equal(activeExecutionCount(), 0);
});

test("stdout callback exceptions stop the child and reject the execution", async () => {
  const error = new Error("test streaming failure");
  await assert.rejects(nodeRun("setInterval(() => process.stdout.write('chunk'), 10)", {
    onStdout: () => { throw error; },
  }), (actual) => actual === error);
  assert.equal(activeExecutionCount(), 0);
});

test("content transformation errors reject without escaping the child close handler", async () => {
  const error = new Error("test transformation failure");
  await assert.rejects(nodeRun("process.stdout.write('answer')", {
    transformContent: () => { throw error; },
  }), (actual) => actual === error);
  assert.equal(activeExecutionCount(), 0);
});

test("bridge shutdown cancels active executions instead of treating SIGTERM as completion", async () => {
  await assert.rejects(nodeRun("setInterval(() => process.stdout.write('ready'), 10)", {
    onStdout: () => stopActiveProcesses(),
  }), { name: "AbortError" });
  assert.equal(activeExecutionCount(), 0);
});

async function assertStopped(pid) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      // Orphans can wait briefly for init to reap them, but cannot execute code.
      if (/^State:\s+[ZX]/m.test(status)) return;
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`descendant ${pid} still running after execution settled`);
}

test("cancellation kills SIGTERM-resistant descendants even after the leader exits", {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  for (const keepPipes of [true, false]) {
    const controller = new AbortController();
    let workerPid;
    const worker = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 100);",
      "process.stdout.write('ready');",
      keepPipes ? "" : "process.stdout.end();",
    ].join("\n");
    const leader = `
      const { spawn } = require('node:child_process');
      const worker = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}],
        { stdio: ['ignore', 'pipe', 'ignore'] });
      worker.stdout.once('data', () => process.stdout.write(String(worker.pid)));
      ${keepPipes ? "worker.stdout.pipe(process.stdout);" : ""}
      setInterval(() => {}, 100);
    `;
    try {
      await assert.rejects(nodeRun(leader, {
        signal: controller.signal,
        onStdout: (chunk) => {
          if (workerPid) return;
          workerPid = Number.parseInt(chunk, 10);
          controller.abort();
        },
      }), { name: "AbortError" });
      assert.ok(Number.isInteger(workerPid) && workerPid > 0);
      await assertStopped(workerPid);
      assert.equal(activeExecutionCount(), 0);
    } finally {
      controller.abort();
      if (workerPid) { try { process.kill(workerPid, "SIGKILL"); } catch {} }
    }
  }
});

test("timeout kills descendants retaining inherited output after their leader exits", {
  skip: process.platform !== "linux", timeout: 15000,
}, async () => {
  let workerPid;
  const worker = "process.on('SIGTERM', () => {}); setInterval(() => {}, 100); process.stdout.write(String(process.pid));";
  const leader = `
    const { spawn } = require('node:child_process');
    const worker = spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 'inherit', 'ignore'] });
    worker.unref();
  `;
  try {
    await assert.rejects(nodeRun(leader, {
      timeoutMs: 1000,
      onStdout: (chunk) => { workerPid = Number.parseInt(chunk, 10); },
    }), (error) => error instanceof ExecutionTimeoutError);
    assert.ok(Number.isInteger(workerPid) && workerPid > 0);
    await assertStopped(workerPid);
    assert.equal(activeExecutionCount(), 0);
  } finally {
    if (workerPid) { try { process.kill(workerPid, "SIGKILL"); } catch {} }
  }
});

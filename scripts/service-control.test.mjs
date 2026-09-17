import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { fork } from "node:child_process";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordService, stopService } from "./service-control.mjs";

async function fixture(t, resist = false) {
  const root = await mkdtemp(join(tmpdir(), "open-cursor service 日本語-"));
  const script = join(root, "service.mjs");
  const pidFile = join(root, "service.pid");
  await writeFile(script, `${resist ? "process.on('SIGTERM', () => process.send('stopping'));" : ""}
    setInterval(() => {}, 100); process.send('ready');`);
  const child = fork(script, { cwd: root, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const ready = once(child, "message");
  t.after(async () => {
    if (child.exitCode === null && !child.signalCode) {
      const closed = once(child, "exit");
      child.kill("SIGKILL");
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  });
  await ready;
  return { root, script, pidFile, child };
}

test("ownership records capture identity and stop only the matching process", async (t) => {
  const { script, pidFile, child } = await fixture(t);
  await recordService(pidFile, String(child.pid), script);
  const record = JSON.parse(await readFile(pidFile, "utf8"));
  assert.equal(record.pid, child.pid);
  assert.equal(record.script, script);
  assert.match(record.startTime, /^\d+$/);
  assert.equal(await stopService(pidFile, script), "stopped");
  await assert.rejects(readFile(pidFile), { code: "ENOENT" });
});

test("legacy numeric PID records require the expected service script", async (t) => {
  const { script, pidFile, child } = await fixture(t);
  await writeFile(pidFile, `${child.pid}\n`);
  assert.equal(await stopService(pidFile, script), "stopped");
});

test("unrelated processes and reused PID records are never signalled", async (t) => {
  const { root, script, pidFile, child } = await fixture(t);
  const otherScript = join(root, "other.mjs");
  await writeFile(otherScript, "");
  await writeFile(pidFile, `${child.pid}\n`);
  await assert.rejects(stopService(pidFile, otherScript), /Refusing to signal/);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
  await rm(script);
  await assert.rejects(stopService(pidFile, otherScript), /Refusing to signal/);
  await writeFile(script, "");
  await recordService(pidFile, child.pid, script);
  const record = JSON.parse(await readFile(pidFile, "utf8"));
  await writeFile(pidFile, JSON.stringify({ ...record, startTime: "0" }));
  await assert.rejects(stopService(pidFile, script), /reused PID/);
  assert.equal(child.exitCode, null);
  assert.equal(child.signalCode, null);
});

test("invalid and missing PID files cannot become process-group signals", async (t) => {
  const { script, pidFile } = await fixture(t);
  assert.equal(await stopService(pidFile, script), "not managed");
  for (const text of ["0", "-1", "garbage", "1", "100 200", '{"pid":0}']) {
    await writeFile(pidFile, text);
    await assert.rejects(stopService(pidFile, script), /Invalid service PID/);
    assert.equal(await readFile(pidFile, "utf8"), text);
  }
});

test("SIGTERM-resistant services are killed without deleting a newer launcher record", async (t) => {
  const { script, pidFile, child } = await fixture(t, true);
  await recordService(pidFile, child.pid, script);
  const stopping = once(child, "message");
  const exited = once(child, "exit");
  const result = stopService(pidFile, script, { graceMs: 200 });
  await stopping;
  const replacement = '{"pid":999999,"newOwner":true}\n';
  await writeFile(pidFile, replacement);
  assert.equal(await result, "stopped");
  await exited;
  assert.equal(child.signalCode, "SIGKILL");
  assert.equal(await readFile(pidFile, "utf8"), replacement);
});

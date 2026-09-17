// Linux launcher ownership records. Never infer ownership from a port number.
import { readFile, readlink, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

async function inspect(pid, script) {
  const stat = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  if (fields[0] === "Z" || fields[0] === "X") return null;
  const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
  const cwd = await readlink(`/proc/${pid}/cwd`);
  let actual = null;
  if (argv[1]) {
    try {
      actual = await realpath(resolve(cwd, argv[1]));
    } catch {
      actual = null;
    }
  }
  if (actual !== script) throw new Error(`Refusing to signal PID ${pid}: it does not run the expected service`);
  return { pid, script, startTime: fields[19] };
}

function parsePid(value) {
  const pid = Number(value);
  if (!Number.isSafeInteger(pid) || pid <= 1 || String(pid) !== String(value).trim()) {
    throw new Error("Invalid service PID record");
  }
  return pid;
}

export async function recordService(pidFile, rawPid, expectedScript) {
  const pid = parsePid(rawPid);
  const script = await realpath(expectedScript);
  const record = await inspect(pid, script);
  if (!record) throw new Error("Service exited before its ownership could be recorded");
  const temporary = `${pidFile}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, pidFile);
  } finally {
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function stopService(pidFile, expectedScript, { graceMs = 5000 } = {}) {
  let original;
  try { original = await readFile(pidFile, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return "not managed"; throw error; }
  const record = original.trim().startsWith("{") ? JSON.parse(original) : { pid: original.trim() };
  const pid = parsePid(record.pid);
  const script = await realpath(expectedScript);
  if (record.script && record.script !== script) throw new Error("Service PID record belongs to another installation");
  const current = async () => {
    try {
      const observed = await inspect(pid, script);
      if (observed && record.startTime && observed.startTime !== record.startTime) {
        throw new Error(`Refusing to signal reused PID ${pid}`);
      }
      return observed;
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ESRCH") return null;
      throw error;
    }
  };
  const cleanup = async () => {
    if (await readFile(pidFile, "utf8").catch(() => null) === original) await unlink(pidFile);
  };
  if (!await current()) { await cleanup(); return "not running"; }
  const signal = (name) => {
    try { process.kill(pid, name); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
  };
  signal("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && await current()) await delay(50);
  if (await current()) signal("SIGKILL");
  const killDeadline = Date.now() + 2000;
  while (await current()) {
    if (Date.now() >= killDeadline) throw new Error(`Service PID ${pid} has not stopped`);
    await delay(25);
  }
  await cleanup();
  return "stopped";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [operation, pidFile, ...args] = process.argv.slice(2);
    if (operation === "record" && args.length === 2) await recordService(pidFile, ...args);
    else if (operation === "stop" && args.length === 1) console.log(await stopService(pidFile, args[0]));
    else throw new Error("Usage: service-control.mjs record <pid-file> <pid> <script> | stop <pid-file> <script>");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

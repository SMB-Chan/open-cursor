import test from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), "open-cursor launcher '日本語-"));
  const root = join(base, "install");
  const mock = join(base, "mock");
  const runtime = join(base, "state");
  for (const dir of ["bin", "server", "mobile", "config", "scripts"]) await mkdir(join(root, dir), { recursive: true });
  for (const dir of [mock, runtime]) await mkdir(dir);
  t.after(async () => { await chmod(root, 0o755); await rm(base, { recursive: true, force: true }); });
  for (const file of ["bin/open-cursor", "bin/open-cursor-app", "bin/runtime-env.sh", "bin/stop-bridge", "server/config.js", "server/package.json", "config/bridge.json", "scripts/service-control.mjs"]) {
    await copyFile(join(repo, file), join(root, file));
  }
  // No service or editor is actually started by these tests.
  await writeFile(join(root, "server/index.js"), "");
  await writeFile(join(root, "mobile/server.js"), "");
  for (const [name, script] of Object.entries({
    curl: "#!/bin/sh\nprintf '%s' '{\"status\":\"ok\",\"bridge\":\"open-cursor-multi-agent\"}'\n",
    ip: "#!/bin/sh\nprintf '%s' '1 via 1 dev lo src 127.0.0.1'\n",
    setsid: "#!/bin/sh\necho 'Unexpected service start' >&2\nexit 99\n",
    "notify-send": "#!/bin/sh\nexit 0\n",
    "editor.cjs": "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(process.env.LAUNCH_TEST_RESULT, JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),workspace:process.env.OPEN_CURSOR_WORKSPACE}));\n",
  })) {
    await writeFile(join(mock, name), script, { mode: 0o755 });
  }
  const output = join(base, "editor.json");
  const env = { ...process.env, PATH: `${mock}:${process.env.PATH}`, OPEN_CURSOR_RUNTIME_DIR: runtime,
    OPEN_CURSOR_WORKSPACE: "", WORKSPACE_DIR: "", BRIDGE_PORT: "", BRIDGE_CONFIG_PATH: "",
    MOBILE_ALLOW_REMOTE: "0", MOBILE_ALLOW_EXEC: "0", OPEN_CURSOR_EDITOR_BIN: join(mock, "editor.cjs"),
    LAUNCH_TEST_RESULT: output,
  };
  return { base, root, runtime, env, output };
}

test("GUI launcher preserves quoted editor arguments and selected workspace without overwriting PID records", async (t) => {
  const f = await fixture(t);
  const workspace = join(f.base, "workspace with spaces");
  await mkdir(workspace);
  const existing = '{"pid":12345,"owner":"existing"}\n';
  await writeFile(join(f.runtime, "bridge.pid"), existing);
  const args = ["--new-window", workspace];
  await exec("bash", [join(f.root, "bin/open-cursor-app"), ...args], { env: f.env, cwd: f.base, timeout: 5000 });
  const launched = JSON.parse(await readFile(f.output, "utf8"));
  assert.deepEqual(launched.args, args);
  assert.equal(launched.cwd, f.base);
  assert.equal(launched.workspace, workspace);
  assert.equal(await readFile(join(f.runtime, "bridge.pid"), "utf8"), existing);
});

test("launcher resolves its own installation through command symlinks", async (t) => {
  const f = await fixture(t);
  const link = join(f.base, "command");
  await symlink(join(f.root, "bin/open-cursor"), link);
  const result = await exec("bash", [link], { env: f.env, cwd: f.base, timeout: 5000 });
  assert.match(result.stdout, /Bridge already running/);
  assert.ok(result.stdout.includes(f.runtime));
});

test("read-only installations use the XDG runtime directory for both launch and stop", async (t) => {
  const f = await fixture(t);
  await chmod(f.root, 0o555);
  const env = { ...f.env, OPEN_CURSOR_RUNTIME_DIR: "", XDG_STATE_HOME: join(f.base, "xdg") };
  const result = await exec("bash", [join(f.root, "bin/open-cursor")], { env, cwd: f.base, timeout: 5000 });
  assert.ok(result.stdout.includes(join(f.base, "xdg", "open-cursor")));
  const stopped = await exec("bash", [join(f.root, "bin/stop-bridge")], { env, cwd: f.base, timeout: 5000 });
  assert.match(stopped.stdout, /not managed/);
});

test("invalid configuration aborts GUI startup before the editor or services are started", async (t) => {
  const f = await fixture(t);
  await assert.rejects(exec("bash", [join(f.root, "bin/open-cursor-app")], {
    env: { ...f.env, BRIDGE_PORT: "not-a-port" }, cwd: f.base, timeout: 5000,
  }), (error) => error.code === 1 && /BRIDGE_PORT/.test(error.stderr));
  await assert.rejects(readFile(f.output), { code: "ENOENT" });
});

async function updaterFixture(t) {
  const f = await fixture(t);
  const events = join(f.base, "events");
  await mkdir(join(f.root, ".git"));
  await mkdir(join(f.root, "extension"));
  await copyFile(join(repo, "bin/update.sh"), join(f.root, "bin/update.sh"));
  await copyFile(join(repo, "extension/package.json"), join(f.root, "extension/package.json"));
  await writeFile(join(f.root, "scripts/register-extension.mjs"), "// Mock registry refresh: no user files are modified.\n");
  for (const name of ["stop-bridge", "open-cursor", "install.sh"]) {
    await writeFile(join(f.root, "bin", name), `#!/bin/sh\necho '${name}' >> "$UPDATE_TEST_EVENTS"\n` +
      (name === "stop-bridge" ? 'exit "${UPDATE_TEST_STOP_CODE:-0}"\n' : ''), { mode: 0o755 });
  }
  for (const [name, script] of Object.entries({
    git: '#!/bin/sh\ncase "$*" in *"status --porcelain"*) exit 0;; *"rev-parse --abbrev-ref"*) echo main;; esac\n',
    npm: '#!/bin/sh\nprintf "%s %s\\n" "$PWD" "$*" >> "$UPDATE_TEST_EVENTS"\nif [ "${UPDATE_TEST_FAIL_MOBILE:-0}" = 1 ] && [ "$(basename "$PWD")" = mobile ]; then exit 1; fi\n',
  })) await writeFile(join(f.base, "mock", name), script, { mode: 0o755 });
  return { ...f, events, env: { ...f.env, UPDATE_TEST_EVENTS: events } };
}

test("updater checks mobile as well as server and extension before restarting", async (t) => {
  const f = await updaterFixture(t);
  await exec("bash", [join(f.root, "bin/update.sh"), "--yes"], { env: f.env, cwd: f.base, timeout: 10000 });
  const events = await readFile(f.events, "utf8");
  const stop = events.indexOf("stop-bridge");
  for (const component of ["server", "mobile", "extension"]) {
    assert.ok(events.indexOf(`${component} run check`) < stop);
    assert.ok(events.indexOf(`${component} test`) < stop);
  }
  assert.ok(events.indexOf("open-cursor", stop) > stop);
});

test("failed validation or refused service ownership prevents an update restart", async (t) => {
  for (const failure of [{ UPDATE_TEST_FAIL_MOBILE: "1" }, { UPDATE_TEST_STOP_CODE: "1" }]) {
    const f = await updaterFixture(t);
    await assert.rejects(exec("bash", [join(f.root, "bin/update.sh"), "--yes"], {
      env: { ...f.env, ...failure }, cwd: f.base, timeout: 10000,
    }), (error) => error.code === 1);
    const events = await readFile(f.events, "utf8");
    assert.ok(!events.split("\n").includes("open-cursor"));
    if (failure.UPDATE_TEST_FAIL_MOBILE) assert.ok(!events.includes("stop-bridge"));
  }
});

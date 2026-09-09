import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SANDBOX_MODES,
  SandboxUnavailableError,
  buildSandboxLaunch,
  parseSandboxMode,
  probeSandboxFacility,
  resolveReviewerSandbox,
  reviewerSandboxProfile,
} from "./sandbox.js";

const scratch = mkdtempSync(join(tmpdir(), "open-cursor-sandbox-"));

function stubBin(name, body, code = 0) {
  const path = join(scratch, name);
  writeFileSync(path, `#!/bin/sh\n${body}\nexit ${code}\n`);
  chmodSync(path, 0o755);
  return path;
}

test.after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("sandbox modes parse strictly and fall back only when empty", () => {
  assert.deepEqual(SANDBOX_MODES, ["off", "auto", "bubblewrap"]);
  assert.equal(parseSandboxMode("off"), "off");
  assert.equal(parseSandboxMode("AUTO"), "auto");
  assert.equal(parseSandboxMode(" bubblewrap "), "bubblewrap");
  assert.equal(parseSandboxMode(undefined, "off"), "off");
  assert.equal(parseSandboxMode("", "auto"), "auto");
  assert.equal(parseSandboxMode("jail"), null);
  assert.equal(parseSandboxMode("firejail"), null);
  assert.equal(parseSandboxMode(null, "off"), "off");
});

test("sandbox profile keeps the whole filesystem read-only and grants narrow writable binds", () => {
  const args = reviewerSandboxProfile({
    isolatedDir: "/tmp/reviewer-abc",
    geminiHome: "/home/dev/.gemini",
  });

  assert.equal(args[0], "--die-with-parent");
  assert.ok(args.includes("--new-session"));
  // Read-only root view…
  const roBind = args.indexOf("--ro-bind");
  assert.ok(roBind >= 0);
  assert.equal(args[roBind + 1], "/");
  assert.equal(args[roBind + 2], "/");
  // …plus writable binds for exactly the reviewer scratch dirs and gemini home.
  assert.ok(args.includes("--tmpfs"));
  const isolatedBinds = args.reduce(
    (count, arg, index) =>
      arg === "--bind" && args[index + 1] === "/tmp/reviewer-abc" ? count + 1 : count,
    0
  );
  const geminiBinds = args.reduce(
    (count, arg, index) =>
      arg === "--bind" && args[index + 1] === "/home/dev/.gemini" ? count + 1 : count,
    0
  );
  assert.equal(isolatedBinds, 1);
  assert.equal(geminiBinds, 1);
  // The wrapped command vector follows the separator.
  assert.equal(args[args.length - 1], "--");

  const withoutGemini = reviewerSandboxProfile({
    isolatedDir: "/tmp/reviewer-abc",
    geminiHome: null,
  });
  assert.equal(
    withoutGemini.reduce(
      (count, arg, index) => (arg === "--bind" ? count + 1 : count),
      0
    ),
    1,
    "no geminiHome means the only writable bind is the isolated directory"
  );

  assert.throws(() => reviewerSandboxProfile({ isolatedDir: null, geminiHome: null }));
});

test("probeSandboxFacility succeeds only when the wrapped command exits zero", async () => {
  const good = stubBin("bwrap-good", '# probe stub: exec whatever follows "--"\nwhile [ "$#" -gt 0 ]; do\n  [ "$1" = "--" ] && shift && exec "$@"\n  shift\ndone\nexit 1');
  const failing = stubBin("bwrap-fail", "exit 3", 3);
  const missing = join(scratch, "bwrap-missing");

  assert.equal(await probeSandboxFacility(good), true, "healthy facility probes true");
  assert.equal(await probeSandboxFacility(failing), false, "nonzero probe exit is unavailable");
  assert.equal(await probeSandboxFacility(missing), false, "missing binary is unavailable");
});

test("resolveReviewerSandbox honors off/auto/bubblewrap semantics", async () => {
  const goodBin = stubBin("bwrap-resolve-good", "exit 0");
  const badBin = stubBin("bwrap-resolve-bad", "exit 1");
  const countingProbe = async (bin) => {
    countingProbe.calls = (countingProbe.calls || 0) + 1;
    return bin === goodBin;
  };

  // off never probes.
  countingProbe.calls = 0;
  const off = await resolveReviewerSandbox({ mode: "off", probe: countingProbe });
  assert.equal(off.active, false);
  assert.equal(off.label, "off");
  assert.equal(countingProbe.calls, 0);

  // auto: active when available…
  const autoOn = await resolveReviewerSandbox({
    mode: "auto",
    bwrapBin: goodBin,
    geminiHome: "/home/dev/.gemini",
    probe: countingProbe,
  });
  assert.equal(autoOn.active, true);
  assert.equal(autoOn.label, "bubblewrap");
  assert.equal(autoOn.geminiHome, "/home/dev/.gemini");

  // …and reports auto-unavailable instead of failing when not.
  const autoOff = await resolveReviewerSandbox({ mode: "auto", bwrapBin: badBin, probe: countingProbe });
  assert.equal(autoOff.active, false);
  assert.equal(autoOff.label, "auto-unavailable");

  // bubblewrap: fail closed when the facility is unusable.
  await assert.rejects(
    resolveReviewerSandbox({ mode: "bubblewrap", bwrapBin: badBin, probe: countingProbe }),
    (error) => error instanceof SandboxUnavailableError && error.statusCode === 503
  );

  // Invalid modes are rejected outright.
  await assert.rejects(
    resolveReviewerSandbox({ mode: "firejail", probe: countingProbe }),
    /invalid reviewer sandbox mode/
  );
});

test("buildSandboxLaunch composes the wrapper spawn vector only for active sandboxes", () => {
  const sandbox = {
    active: true,
    label: "bubblewrap",
    bwrapBin: "/usr/bin/bwrap",
    geminiHome: "/home/dev/.gemini",
  };
  const launch = buildSandboxLaunch({ sandbox, isolatedDir: "/tmp/reviewer-abc" });
  assert.equal(launch.command, "/usr/bin/bwrap");
  assert.equal(launch.args[launch.args.length - 1], "--");
  assert.ok(launch.args.includes("/tmp/reviewer-abc"));

  assert.equal(
    buildSandboxLaunch({ sandbox: { active: false }, isolatedDir: "/tmp/x" }),
    null
  );
  assert.equal(buildSandboxLaunch({ sandbox: null, isolatedDir: "/tmp/x" }), null);
});

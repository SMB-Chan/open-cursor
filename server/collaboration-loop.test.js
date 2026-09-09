// End-to-end coverage for the verdict-driven collaborative review loop.
//
// Real agent CLIs are replaced by stub binaries (CODEX_BIN / AGY_BIN) so the
// full orchestrate() path — plan, implement, review, verdict parsing, bounded
// refinement, and re-review — runs without network or subscription access.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate HOME before importing engine/monitor so state writes and auth lookups
// stay inside a temporary directory and cannot observe a real installation.
const testHome = mkdtempSync(join(tmpdir(), "open-cursor-loop-home-"));
process.env.HOME = testHome;

const scratch = mkdtempSync(join(tmpdir(), "open-cursor-loop-"));
const binsDir = join(scratch, "bins");
const workspace = join(scratch, "workspace");
const stubState = join(scratch, "stub-calls.log");
mkdirSync(binsDir);
mkdirSync(workspace);
writeFileSync(join(workspace, "README.md"), "# loop test workspace\n");

execFileSync("git", ["init", "-q"], { cwd: workspace });
execFileSync("git", ["-C", workspace, "-c", "user.email=t@example", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"]);

const codexStub = join(binsDir, "stub-codex.mjs");
writeFileSync(
  codexStub,
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { stdin += chunk; });
process.stdin.on("end", () => {
  appendFileSync(process.env.STUB_STATE, "codex\\n");
  process.stdout.write("IMPLEMENTER REPORT: edits applied and checks ran\\n");
});
`
);

const agyStub = join(binsDir, "stub-agy.mjs");
writeFileSync(
  agyStub,
  `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const prompt = (process.argv.find((arg) => arg.startsWith("-p=")) || "-p=").slice(3);
appendFileSync(process.env.STUB_STATE, "agy\\n");
if (/Review round 1/.test(prompt)) {
  if (process.env.STUB_REVIEW_MODE === "never") {
    process.stdout.write("Round 1: defect remains.\\nVERDICT: CHANGES_REQUESTED\\n");
  } else if (process.env.STUB_REVIEW_MODE === "approve") {
    process.stdout.write("Round 1: everything checks out.\\nVERDICT: APPROVED\\n");
  } else {
    process.stdout.write("Round 1: add the missing regression test.\\nVERDICT: CHANGES_REQUESTED\\n");
  }
} else if (/Review round 2/.test(prompt)) {
  if (process.env.STUB_REVIEW_MODE === "never") {
    process.stdout.write("Round 2: still not satisfied.\\nVERDICT: CHANGES_REQUESTED\\n");
  } else {
    process.stdout.write("Round 2: resolved.\\nVERDICT: APPROVED\\n");
  }
} else {
  process.stdout.write("PLAN: touch README.md only\\n");
}
`
);
chmodSync(codexStub, 0o755);
chmodSync(agyStub, 0o755);

process.env.CODEX_BIN = codexStub;
process.env.AGY_BIN = agyStub;
process.env.STUB_STATE = stubState;

const { orchestrate } = await import("./engine.js");

function resetState() {
  writeFileSync(stubState, "");
}

function stubCalls() {
  return readFileSync(stubState, "utf8").split("\n").filter(Boolean);
}

test.after?.(() => {});

test("collaborative loop iterates on changes_requested and converges on approval", async () => {
  resetState();
  process.env.STUB_REVIEW_MODE = "converge";
  const events = [];

  const result = await orchestrate("Add a feature", {
    cwd: workspace,
    mode: "collaborative",
    maxReviewCycles: 3,
    onEvent: (event) => events.push(event),
  });

  // plan + review round 1 + review round 2 from the reviewer, implement + refine from the writer
  assert.deepEqual(
    stubCalls().filter((line) => line === "codex").length,
    2,
    "codex must run once for implementation and once for refinement"
  );
  assert.equal(result.reviewCycles, 2);
  assert.equal(result.reviewVerdict, "approved");
  assert.equal(result.reviewConverged, true);
  assert.match(result.content, /Round 1/);
  assert.match(result.content, /Round 2/);
  assert.match(result.content, /Refinement \(Codex\/GPT\) — Round 1/);
  assert.match(result.content, /承認済み/);
  assert.doesNotMatch(result.content, /非収束/);

  const verdictEvents = events.filter((event) => event.phase === "review-verdict");
  assert.equal(verdictEvents.length, 2);
  assert.equal(verdictEvents[0].verdict, "changes_requested");
  assert.equal(verdictEvents[0].iteration, 1);
  assert.equal(verdictEvents[1].verdict, "approved");
  assert.equal(verdictEvents[1].iteration, 2);
});

test("collaborative loop approves on the first review and skips refinement entirely", async () => {
  resetState();
  process.env.STUB_REVIEW_MODE = "approve";
  const events = [];

  const result = await orchestrate("Add a feature", {
    cwd: workspace,
    mode: "collaborative",
    maxReviewCycles: 2,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(
    stubCalls().filter((line) => line === "codex").length,
    1,
    "an approved review must not trigger any refinement pass"
  );
  assert.equal(result.reviewCycles, 1);
  assert.equal(result.reviewVerdict, "approved");
  assert.equal(result.reviewConverged, true);
  assert.doesNotMatch(result.content, /## Refinement/);
});

test("collaborative loop stops at the cycle bound and reports non-convergence honestly", async () => {
  resetState();
  process.env.STUB_REVIEW_MODE = "never";
  const events = [];

  const result = await orchestrate("Add a feature", {
    cwd: workspace,
    mode: "collaborative",
    maxReviewCycles: 2,
    onEvent: (event) => events.push(event),
  });

  // implement + one refinement, never a third writer pass
  assert.deepEqual(
    stubCalls().filter((line) => line === "codex").length,
    2
  );
  assert.equal(result.reviewCycles, 2);
  assert.equal(result.reviewVerdict, "changes_requested");
  assert.equal(result.reviewConverged, false);
  assert.match(result.content, /非収束/);
  assert.match(result.content, /最大レビューラウンド数/);
  const verdictEvents = events.filter((event) => event.phase === "review-verdict");
  assert.equal(verdictEvents.length, 2);
});

test("collaborative loop defaults to two review cycles when no bound is supplied", async () => {
  resetState();
  process.env.STUB_REVIEW_MODE = "never";

  const result = await orchestrate("Add a feature", {
    cwd: workspace,
    mode: "collaborative",
  });

  assert.equal(result.reviewCycles, 2);
  assert.equal(result.reviewConverged, false);
});

test("explicit bubblewrap sandbox wraps detached reviewer runs and never wraps codex", async () => {
  const bwrapStub = join(binsDir, "stub-bwrap.sh");
  writeFileSync(
    bwrapStub,
    `#!/bin/sh
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--" ]; then
    shift
    printf 'bwrap:%s\n' "\${1##*/}" >> "$STUB_STATE"
    exec "$@"
  fi
  shift
done
printf 'bwrap-missing-separator\n' >> "$STUB_STATE"
exit 1
`
  );
  chmodSync(bwrapStub, 0o755);

  resetState();
  process.env.STUB_REVIEW_MODE = "approve";
  process.env.BRIDGE_REVIEWER_SANDBOX = "bubblewrap";
  process.env.BWRAP_BIN = bwrapStub;
  try {
    const events = [];
    const result = await orchestrate("Add a feature", {
      cwd: workspace,
      mode: "collaborative",
      maxReviewCycles: 2,
      onEvent: (event) => events.push(event),
    });

    assert.equal(result.reviewConverged, true);

    const calls = stubCalls();
    const wrappedReviewerRuns = calls.filter((line) => line === "bwrap:stub-agy.mjs").length;
    const probeRuns = calls.filter((line) => line === "bwrap:true").length;
    const codexCount = calls.filter((line) => line === "codex").length;
    assert.equal(wrappedReviewerRuns, 2, "plan and review must each run inside the sandbox wrapper");
    assert.equal(probeRuns, 1, "the facility probe runs exactly once for the explicit mode");
    assert.equal(codexCount, 1, "the workspace writer must never be sandboxed");
    assert.equal(calls.filter((line) => line === "bwrap-missing-separator").length, 0);

    const verdictEvents = events.filter((event) => event.phase === "review-verdict");
    assert.equal(verdictEvents.length, 1, "the reviewer still produces verdicts inside the wrapper");
  } finally {
    delete process.env.BRIDGE_REVIEWER_SANDBOX;
    delete process.env.BWRAP_BIN;
  }
});

test("explicit sandbox mode fails closed when the facility probe fails", async () => {
  const failingBwrap = join(binsDir, "stub-bwrap-failing.sh");
  writeFileSync(failingBwrap, "#!/bin/sh\nexit 9\n");
  chmodSync(failingBwrap, 0o755);

  resetState();
  process.env.STUB_REVIEW_MODE = "approve";
  process.env.BRIDGE_REVIEWER_SANDBOX = "bubblewrap";
  process.env.BWRAP_BIN = failingBwrap;
  try {
    await assert.rejects(
      orchestrate("Add a feature", {
        cwd: workspace,
        mode: "collaborative",
        maxReviewCycles: 2,
      }),
      (error) => error?.name === "SandboxUnavailableError" || /sandbox/i.test(error?.message || "")
    );
    assert.equal(stubCalls().filter((line) => line === "agy").length, 0, "no agent may run when a required sandbox is unavailable");
  } finally {
    delete process.env.BRIDGE_REVIEWER_SANDBOX;
    delete process.env.BWRAP_BIN;
  }
});

test.after(() => {
  rmSync(testHome, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

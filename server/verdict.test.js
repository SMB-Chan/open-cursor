import test from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_REVIEW_CYCLES,
  MAX_REVIEW_CYCLES,
  REVIEW_VERDICT_APPROVED,
  REVIEW_VERDICT_CHANGES_REQUESTED,
  REVIEW_VERDICT_UNKNOWN,
  VERDICT_MARKER_APPROVED,
  clampReviewCycles,
  nextReviewLoopAction,
  normalizeReviewVerdictToken,
  parseReviewVerdict,
} from "./verdict.js";

test("verdict tokens normalize across accepted aliases and reject ambiguous ones", () => {
  assert.equal(normalizeReviewVerdictToken("APPROVED"), REVIEW_VERDICT_APPROVED);
  assert.equal(normalizeReviewVerdictToken("approved"), REVIEW_VERDICT_APPROVED);
  assert.equal(normalizeReviewVerdictToken("LGTM"), REVIEW_VERDICT_APPROVED);
  assert.equal(
    normalizeReviewVerdictToken("CHANGES_REQUESTED"),
    REVIEW_VERDICT_CHANGES_REQUESTED
  );
  assert.equal(
    normalizeReviewVerdictToken("changes requested"),
    REVIEW_VERDICT_CHANGES_REQUESTED
  );
  assert.equal(
    normalizeReviewVerdictToken("needs-changes"),
    REVIEW_VERDICT_CHANGES_REQUESTED
  );
  assert.equal(normalizeReviewVerdictToken("REJECTED"), REVIEW_VERDICT_CHANGES_REQUESTED);

  // Ambiguous tokens must never map to an approval.
  assert.equal(normalizeReviewVerdictToken("PASS"), null);
  assert.equal(normalizeReviewVerdictToken("FAIL"), null);
  assert.equal(normalizeReviewVerdictToken("NOT SURE"), null);
  assert.equal(normalizeReviewVerdictToken(""), null);
  assert.equal(normalizeReviewVerdictToken(null), null);
});

test("parseReviewVerdict recognizes both canonical markers", () => {
  const approved = parseReviewVerdict(
    "Solid work overall.\n\n" + VERDICT_MARKER_APPROVED + "\n"
  );
  assert.equal(approved.verdict, REVIEW_VERDICT_APPROVED);

  const changes = parseReviewVerdict(
    "Two defects found.\n\nVERDICT: CHANGES_REQUESTED\n"
  );
  assert.equal(changes.verdict, REVIEW_VERDICT_CHANGES_REQUESTED);
});

test("parseReviewVerdict tolerates markdown fences, emphasis, and full-width colons", () => {
  const fenced = parseReviewVerdict(
    "```\nVERDICT: APPROVED\n```"
  );
  assert.equal(fenced.verdict, REVIEW_VERDICT_APPROVED);

  const quoted = parseReviewVerdict("> **VERDICT：** CHANGES_REQUESTED\n");
  assert.equal(quoted.verdict, REVIEW_VERDICT_CHANGES_REQUESTED);

  const bold = parseReviewVerdict("## Summary\nAll good.\n**VERDICT: APPROVED**");
  assert.equal(bold.verdict, REVIEW_VERDICT_APPROVED);
});

test("parseReviewVerdict lets the final marker win", () => {
  const parsed = parseReviewVerdict(
    "VERDICT: CHANGES_REQUESTED\n\nWait — I re-checked and the guard is correct.\n\nVERDICT: APPROVED\n"
  );
  assert.equal(parsed.verdict, REVIEW_VERDICT_APPROVED);

  const reversed = parseReviewVerdict(
    "VERDICT: APPROVED\n\nOn second thought the migration is unsafe.\nVERDICT: CHANGES_REQUESTED\n"
  );
  assert.equal(reversed.verdict, REVIEW_VERDICT_CHANGES_REQUESTED);
});

test("parseReviewVerdict reports unknown when the marker is absent or unrecognized", () => {
  const missing = parseReviewVerdict("The implementation looks fine to me.");
  assert.equal(missing.verdict, REVIEW_VERDICT_UNKNOWN);
  assert.equal(missing.marker, null);

  const ambiguous = parseReviewVerdict("VERDICT: PROBABLY_FINE");
  assert.equal(ambiguous.verdict, REVIEW_VERDICT_UNKNOWN);
  assert.equal(ambiguous.marker, "PROBABLY_FINE");
});

test("parseReviewVerdict strips the verdict line from findings", () => {
  const parsed = parseReviewVerdict(
    "Issue 1: missing null guard.\nIssue 2: no test.\n\nVERDICT: CHANGES_REQUESTED\n"
  );
  assert.match(parsed.findings, /missing null guard/);
  assert.match(parsed.findings, /no test/);
  assert.doesNotMatch(parsed.findings, /VERDICT/i);

  const unknownFindings = parseReviewVerdict("Just some prose, no marker.");
  assert.equal(unknownFindings.findings, "Just some prose, no marker.");
});

test("review loop approves and stops on the first approval", () => {
  const action = nextReviewLoopAction({
    verdict: REVIEW_VERDICT_APPROVED,
    cycle: 1,
    maxReviewCycles: 4,
  });
  assert.equal(action.action, "complete");
  assert.equal(action.converged, true);
});

test("review loop refines when changes are requested and cycles remain", () => {
  const action = nextReviewLoopAction({
    verdict: REVIEW_VERDICT_CHANGES_REQUESTED,
    cycle: 1,
    maxReviewCycles: 2,
  });
  assert.equal(action.action, "refine");
  assert.equal(action.converged, false);
});

test("review loop terminates honestly when cycles are exhausted without approval", () => {
  const action = nextReviewLoopAction({
    verdict: REVIEW_VERDICT_CHANGES_REQUESTED,
    cycle: 2,
    maxReviewCycles: 2,
  });
  assert.equal(action.action, "complete");
  assert.equal(action.converged, false);
  assert.match(action.reason, /still requested changes/);
});

test("review loop treats unknown verdicts conservatively but stays bounded", () => {
  const midLoop = nextReviewLoopAction({
    verdict: REVIEW_VERDICT_UNKNOWN,
    cycle: 1,
    maxReviewCycles: 2,
  });
  assert.equal(midLoop.action, "refine");

  const exhausted = nextReviewLoopAction({
    verdict: REVIEW_VERDICT_UNKNOWN,
    cycle: 2,
    maxReviewCycles: 2,
  });
  assert.equal(exhausted.action, "complete");
  assert.equal(exhausted.converged, false);
  assert.match(exhausted.reason, /no parseable verdict/);
});

test("review loop can never exceed the validated cycle bound", () => {
  const action = nextReviewLoopAction({
    verdict: REVIEW_VERDICT_CHANGES_REQUESTED,
    cycle: 99,
    maxReviewCycles: 2,
  });
  assert.equal(action.action, "complete");
  assert.equal(action.converged, false);
});

test("clampReviewCycles bounds the loop length", () => {
  assert.equal(clampReviewCycles(1), 1);
  assert.equal(clampReviewCycles(2), 2);
  assert.equal(clampReviewCycles(MAX_REVIEW_CYCLES), MAX_REVIEW_CYCLES);
  assert.equal(clampReviewCycles(0), 1);
  assert.equal(clampReviewCycles(-3), 1);
  assert.equal(clampReviewCycles(99), MAX_REVIEW_CYCLES);
  assert.equal(clampReviewCycles("junk"), DEFAULT_REVIEW_CYCLES);
  assert.equal(clampReviewCycles(undefined), DEFAULT_REVIEW_CYCLES);
  assert.equal(clampReviewCycles(2.5), DEFAULT_REVIEW_CYCLES);
});

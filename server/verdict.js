// Review verdict parsing and bounded autonomous review-loop policy.
//
// The collaborative workflow asks its detached reviewer to end every review
// with an explicit machine-parseable verdict marker:
//
//   VERDICT: APPROVED
//   VERDICT: CHANGES_REQUESTED
//
// The loop policy derived from that verdict is intentionally conservative:
// an unrecognized or missing verdict is treated as "changes requested" so a
// degraded reviewer can never silently wave work through. Every loop is
// bounded by collaboration.maxReviewCycles, so a reviewer that never
// approves still terminates after a fixed number of review/refine cycles.

export const REVIEW_VERDICT_APPROVED = "approved";
export const REVIEW_VERDICT_CHANGES_REQUESTED = "changes_requested";
export const REVIEW_VERDICT_UNKNOWN = "unknown";

export const VERDICT_MARKER_APPROVED = "VERDICT: APPROVED";
export const VERDICT_MARKER_CHANGES_REQUESTED = "VERDICT: CHANGES_REQUESTED";

export const MIN_REVIEW_CYCLES = 1;
export const MAX_REVIEW_CYCLES = 4;
export const DEFAULT_REVIEW_CYCLES = 2;

const APPROVED_ALIASES = new Set([
  "APPROVED",
  "APPROVE",
  "APPROVAL",
  "LGTM",
]);

const CHANGES_REQUESTED_ALIASES = new Set([
  "CHANGES_REQUESTED",
  "CHANGES REQUESTED",
  "REQUESTED_CHANGES",
  "REQUEST CHANGES",
  "REQUEST_CHANGES",
  "NEEDS_CHANGES",
  "NEEDS CHANGES",
  "CHANGES_NEEDED",
  "CHANGES NEEDED",
  "REJECTED",
  "REJECT",
]);

// Matches a verdict marker anywhere in a line, tolerating markdown fences,
// emphasis characters, block quotes, and full-width colons. Only the token
// immediately after the colon counts; prose after the token is ignored.
const VERDICT_LINE_RE = /(?:^|\n)[^\n]*?\bVERDICT\s*[:：]\s*[\*_"'`]*\s*([A-Za-z_][A-Za-z_ \-]*?)\s*[\*_"'`]*\s*(?:\n|$)/gi;

function normalizeVerdictToken(raw) {
  const token = String(raw || "")
    .trim()
    .toUpperCase()
    .replace(/[_\s-]+/g, "_");
  if (!token) return null;
  if (APPROVED_ALIASES.has(token)) return REVIEW_VERDICT_APPROVED;
  if (CHANGES_REQUESTED_ALIASES.has(token)) return REVIEW_VERDICT_CHANGES_REQUESTED;
  return null;
}

export function normalizeReviewVerdictToken(raw) {
  return normalizeVerdictToken(raw);
}

function stripMarkerLines(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => !/\bVERDICT\s*[:：]/i.test(line))
    .join("\n")
    .replace(/\n{3,}$/, "\n\n")
    .trim();
}

/**
 * Parse the final review verdict from reviewer output.
 *
 * The last verdict marker in the document wins, so a reviewer that revises
 * its own conclusion mid-report resolves to its final position. Returns
 * `unknown` when no recognizable marker exists; callers treat that as
 * "changes requested" through nextReviewLoopAction().
 */
export function parseReviewVerdict(text) {
  const value = String(text || "");
  const matches = [...value.matchAll(VERDICT_LINE_RE)];

  if (matches.length === 0) {
    return {
      verdict: REVIEW_VERDICT_UNKNOWN,
      findings: stripMarkerLines(value),
      marker: null,
    };
  }

  const last = matches[matches.length - 1];
  const verdict = normalizeVerdictToken(last[1]) ?? REVIEW_VERDICT_UNKNOWN;
  return {
    verdict,
    findings: stripMarkerLines(value),
    marker: String(last[1] || "").trim(),
  };
}

/**
 * Bounded autonomous loop policy for the collaborative workflow.
 *
 * Returns the next action after a review cycle:
 *   - `complete` + converged:true  — reviewer approved the work
 *   - `complete` + converged:false — cycles exhausted without approval
 *   - `refine`                     — act on findings, then re-review
 *
 * Unknown/missing verdicts behave like changes_requested (conservative),
 * which keeps a degraded reviewer from short-circuiting the loop while the
 * cycle bound still guarantees termination.
 */
export function nextReviewLoopAction({ verdict, cycle, maxReviewCycles }) {
  const round = Number.isInteger(cycle) && cycle > 0 ? cycle : 1;
  const limit = clampReviewCycles(maxReviewCycles);

  const effective =
    verdict === REVIEW_VERDICT_APPROVED
      ? REVIEW_VERDICT_APPROVED
      : REVIEW_VERDICT_CHANGES_REQUESTED;

  if (effective === REVIEW_VERDICT_APPROVED) {
    return {
      action: "complete",
      converged: true,
      treatedAs: verdict,
      reason: "reviewer approved the implementation",
    };
  }

  if (round >= limit) {
    return {
      action: "complete",
      converged: false,
      treatedAs: verdict,
      reason:
        verdict === REVIEW_VERDICT_UNKNOWN
          ? `no parseable verdict after ${limit} review cycle(s)`
          : `reviewer still requested changes after ${limit} review cycle(s)`,
    };
  }

  return {
    action: "refine",
    converged: false,
    treatedAs: verdict,
    reason: "reviewer requested changes; bounded refinement cycle continues",
  };
}

/**
 * Clamp a requested review-cycle bound into the validated 1..4 range.
 * Out-of-range or non-integer values fall back to DEFAULT_REVIEW_CYCLES.
 */
export function clampReviewCycles(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return DEFAULT_REVIEW_CYCLES;
  if (parsed < MIN_REVIEW_CYCLES) return MIN_REVIEW_CYCLES;
  if (parsed > MAX_REVIEW_CYCLES) return MAX_REVIEW_CYCLES;
  return parsed;
}

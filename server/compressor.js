/**
 * Context compression and budget management for Open-Cursor multi-agent workflows.
 * Proactively compresses conversation history, inter-agent handoffs, and Git/workspace
 * evidence to prevent context window exhaustion and Linux argv/E2BIG limits.
 */

const MAX_HISTORY_BYTES = 32 * 1024;       // 32 KB total for past conversation turns
const MAX_TURN_ASSISTANT_BYTES = 2 * 1024;  // 2 KB max per previous assistant turn
const MAX_TURN_USER_BYTES = 1 * 1024;       // 1 KB max per previous user turn
const MAX_PLAN_HANDOFF_BYTES = 24 * 1024;   // 24 KB max for Plan -> Implementation
const MAX_IMPL_HANDOFF_BYTES = 16 * 1024;   // 16 KB max for Implementation -> Review
const MAX_REVIEW_HANDOFF_BYTES = 20 * 1024; // 20 KB max for Review -> Refinement
const MAX_CLI_ARG_BYTES = 64 * 1024;        // 64 KB max for any single CLI argument (Linux safe)

/**
 * Clips text at a safe UTF-8 byte boundary, appending an indicator if truncated.
 */
function clipByBytes(text, maxBytes, indicator = "\n... [truncated for context budget]") {
  const value = String(text || "");
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;

  const indBuf = Buffer.from(indicator, "utf8");
  if (maxBytes <= indBuf.length) {
    return value.slice(0, Math.max(0, Math.floor(maxBytes / 4)));
  }

  const budget = maxBytes - indBuf.length;
  let end = budget;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;

  const lead = buf[end];
  let charLen = 1;
  if ((lead & 0x80) === 0) charLen = 1;
  else if ((lead & 0xe0) === 0xc0) charLen = 2;
  else if ((lead & 0xf0) === 0xe0) charLen = 3;
  else if ((lead & 0xf8) === 0xf0) charLen = 4;

  const finalEnd = end + charLen <= budget ? end + charLen : end;
  const sliced = buf.subarray(0, finalEnd).toString("utf8");
  return sliced + indicator;
}

/**
 * Boundary- and corruption-safe byte clip used everywhere prompt payloads are
 * truncated. Guarantees:
 *  - never splits a multi-byte UTF-8 sequence (no U+FFFD mojibake in prompts)
 *  - never emits a partial line unless the source itself had none
 *  - always appends an explicit omission indicator, never silent truncation
 *  - idempotent: clipping an already-clipped string again at the same budget
 *    yields the same string
 */
function clipUtf8Safe(text, maxBytes, indicator = "\n… [content omitted to fit the handoff budget]") {
  const value = String(text || "");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return "";
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;

  const indBuf = Buffer.from(indicator, "utf8");
  if (maxBytes <= indBuf.length + 16) {
    return indicator.trim();
  }

  let budget = maxBytes - indBuf.length;
  // Snap back to the last newline inside the budget so we never end mid-line
  // or mid-escape; fall back to a raw char boundary when the first line alone
  // exceeds the budget.
  let end = budget;
  const lastNewline = buf.lastIndexOf(0x0a, budget);
  if (lastNewline > 0) {
    budget = lastNewline;
    end = lastNewline;
  }
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;

  const head = buf.subarray(0, end).toString("utf8");
  return head + indicator;
}

/**
 * Middle-out clip (LongLLMLingua-style): keeps the head and the tail of the
 * payload and drops the middle. Agent reports front-load context and back-load
 * conclusions ("## Report" / "## Findings" / verdicts are written last by our
 * own output contracts), so naive head-only clipping destroys exactly the part
 * the next agent must parse.
 */
function clipUtf8MiddleOut(text, maxBytes, { headShare = 0.55, tailShare = 0.4 } = {}) {
  const value = String(text || "");
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) return "";
  const buf = Buffer.from(value, "utf8");
  if (buf.length <= maxBytes) return value;

  const midIndicator =
    `\n… [middle omitted by the handoff compressor: ${buf.length} → ${maxBytes} bytes; ` +
    `head and tail preserved; do not assume missing content exists] …\n`;
  const indLen = Buffer.byteLength(midIndicator, "utf8");
  if (maxBytes <= indLen + 64) {
    return clipUtf8Safe(value, maxBytes);
  }

  const usable = maxBytes - indLen;
  const headBytes = Math.floor(usable * headShare);
  const tailBytes = Math.floor(usable * tailShare);

  const headBuf = safeSliceBack(buf, headBytes, true);
  const tailBuf = safeSliceForward(buf.subarray(buf.length - tailBytes));

  return (
    headBuf.toString("utf8") +
    midIndicator +
    tailBuf.toString("utf8")
  );
}

// Snap a buffer slice back to the nearest UTF-8 char boundary (and, optionally,
// the preceding newline so heads/tails end cleanly at line edges).
function safeSliceBack(buf, maxBytes, snapToNewline) {
  let end = Math.min(maxBytes, buf.length);
  if (snapToNewline) {
    const lastNewline = buf.lastIndexOf(0x0a, end);
    if (lastNewline > 0) end = lastNewline;
  }
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

// Advance the slice start forward to the next UTF-8 char boundary. Used for
// tails cut out of the middle of the source, whose FIRST byte may fall inside
// a multi-byte sequence (the end side is handled by safeSliceBack).
function safeSliceForward(buf) {
  let start = 0;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++;
  return buf.subarray(start);
}

/**
 * Builds a machine-readable handoff manifest placed BEFORE the payload. The
 * receiving agent is told exactly what was compressed and how to treat the
 * result, which suppresses the "silent omission → hallucinate the missing
 * part" failure mode and keeps cross-model semantics stable.
 */
function handoffManifest({ phase, from, to, originalBytes, finalBytes, budget, truncated, content }) {
  const lines = [
    `[HANDOFF ${phase}]`,
    truncated
      ? `payload ${originalBytes}B → ${finalBytes}B (budget ${budget}B). Content was dropped; use what is visible, invent nothing, ask nothing.`
      : `payload ${originalBytes}B fits the budget in full.`,
    "ground truth = workspace files + Git diff, never this payload.",
  ];
  if (content) {
    lines.push(content);
  }
  return lines.join("\n") + "\n\n";
}

/**
 * Truncates one fenced code block body head+tail instead of keeping only its
 * head, so code structure (closing braces, final assertions) survives.
 */
const MAX_CODE_LINE_BYTES = 240;

function clipLongLine(line, maxBytes = MAX_CODE_LINE_BYTES) {
  const buf = Buffer.from(String(line || ""), "utf8");
  if (buf.length <= maxBytes) return line;
  const tailKeep = Math.floor(maxBytes * 0.25);
  const head = safeSliceBack(buf, maxBytes - tailKeep - 32, false).toString("utf8");
  const tail = buf.subarray(buf.length - tailKeep).toString("utf8");
  return `${head}… [+${buf.length - maxBytes}B line middle omitted] …${tail}`;
}

function clipCodeBody(bodyText, maxLines) {
  const lines = String(bodyText || "").split("\n").map((line) => clipLongLine(line));
  if (lines.length <= maxLines) return lines.join("\n");
  const headLines = Math.max(1, Math.floor(maxLines * 0.7));
  const tailLines = Math.max(1, maxLines - headLines);
  const omitted = lines.length - headLines - tailLines;
  return [
    ...lines.slice(0, headLines),
    `… [${omitted} middle lines of this code block omitted] …`,
    ...lines.slice(lines.length - tailLines),
  ].join("\n");
}

/**
 * Extracts a concise summary from collaborative outputs (Plan/Impl/Review/Refine).
 */
function summarizeCollaborativeResponse(content, maxBytes = MAX_TURN_ASSISTANT_BYTES) {
  if (typeof content !== "string" || !content) return "";

  const hasRefine = content.includes("## Refinement");
  const hasReview = content.includes("## Review");
  const hasImpl = content.includes("## Implementation") || content.includes("## 💻 MiMo");

  if (!hasRefine && !hasReview && !hasImpl) {
    return clipByBytes(content, maxBytes);
  }

  const sections = [];

  // Prioritize the final refinement/conclusion
  if (hasRefine) {
    const refineMatch = content.match(/## Refinement[^\n]*\n([\s\S]*?)(?:\n---|\n##|$)/);
    if (refineMatch && refineMatch[1].trim()) {
      sections.push(`### Outcome / Refinement\n${clipByBytes(refineMatch[1].trim(), Math.floor(maxBytes * 0.6))}`);
    }
  }

  // Next prioritize review findings / resolved items
  if (hasReview) {
    const reviewMatch = content.match(/## Review[^\n]*\n([\s\S]*?)(?:\n---|\n##|$)/);
    if (reviewMatch && reviewMatch[1].trim()) {
      sections.push(`### Review Findings\n${clipByBytes(reviewMatch[1].trim(), Math.floor(maxBytes * 0.4))}`);
    }
  }

  // Next capture key changes from implementation
  if (hasImpl && sections.length === 0) {
    const implMatch = content.match(/## (?:Implementation|💻 MiMo)[^\n]*\n([\s\S]*?)(?:\n---|\n##|$)/);
    if (implMatch && implMatch[1].trim()) {
      sections.push(`### Implementation Summary\n${clipByBytes(implMatch[1].trim(), maxBytes)}`);
    }
  }

  const result = sections.join("\n\n");
  return clipByBytes(result || content, maxBytes);
}

/**
 * Compresses an array of chat messages.
 * Always leaves the LAST message (current user prompt) completely untouched.
 */
function compressMessages(messages, options = {}) {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return { messages: messages || [], compressed: false, originalBytes: 0, compressedBytes: 0, savedBytes: 0 };
  }

  const maxTotal = options.maxTotalBytes || MAX_HISTORY_BYTES;
  const maxAssistant = options.maxTurnAssistantBytes || MAX_TURN_ASSISTANT_BYTES;
  const maxUser = options.maxTurnUserBytes || MAX_TURN_USER_BYTES;
  const originalBytes = Buffer.byteLength(JSON.stringify(messages), "utf8");

  // Preserve system message if present
  const systemMsg = messages[0]?.role === "system" ? messages[0] : null;
  const conversation = systemMsg ? messages.slice(1) : messages.slice();

  if (conversation.length <= 1) {
    return { messages, compressed: false, originalBytes, compressedBytes: originalBytes, savedBytes: 0 };
  }

  // The latest user message is the active task — NEVER compress it!
  const currentTaskMsg = conversation[conversation.length - 1];
  const priorMessages = conversation.slice(0, -1);

  // Compress prior messages
  const compressedPrior = [];
  for (let i = 0; i < priorMessages.length; i++) {
    const msg = priorMessages[i];
    if (!msg || typeof msg.content !== "string") continue;

    if (msg.role === "assistant") {
      const summary = summarizeCollaborativeResponse(msg.content, maxAssistant);
      compressedPrior.push({ role: "assistant", content: summary });
    } else if (msg.role === "user") {
      const compacted = clipByBytes(msg.content, maxUser, "\n... [user input trimmed]");
      compressedPrior.push({ role: "user", content: compacted });
    } else {
      compressedPrior.push(msg);
    }
  }

  // Check total byte size and drop oldest turns if still over budget
  let resultHistory = compressedPrior;
  while (resultHistory.length > 2) {
    const totalBytes = Buffer.byteLength(
      resultHistory.map(m => m.content).join("\n"),
      "utf8"
    );
    if (totalBytes <= maxTotal) break;
    // Drop the oldest pair (user + assistant)
    resultHistory.shift();
    if (resultHistory.length > 0 && resultHistory[0].role === "assistant") {
      resultHistory.shift();
    }
  }

  const finalMessages = [];
  if (systemMsg) finalMessages.push(systemMsg);
  finalMessages.push(...resultHistory);
  finalMessages.push(currentTaskMsg);

  const compressedBytes = Buffer.byteLength(JSON.stringify(finalMessages), "utf8");
  return {
    messages: finalMessages,
    compressed: compressedBytes < originalBytes,
    originalBytes,
    compressedBytes,
    savedBytes: Math.max(0, originalBytes - compressedBytes),
  };
}

/**
 * Compresses collaborative handoff payloads between agents.
 *
 * Quality guarantees (research-informed):
 *  - middle-out truncation keeps the payload head (context) AND tail (the
 *    "## Report"/"## Findings" verdicts our output contracts place last);
 *  - truncation is never silent: a HANDOFF manifest states what happened and
 *    forbids the receiver from inventing omitted content;
 *  - truncation is UTF-8/line-boundary safe (no mojibake, no broken escapes);
 *  - UTF-8 safe: multi-byte sequences and line boundaries are respected.
 *  - idempotent within budget: re-compressing an already-compressed payload
 *    never grows it and keeps the parseable contract headers.
 */
function compressHandoff(content, options = {}) {
  const { phase = "general", maxBytes } = options;
  const text = String(content || "");

  let limit = maxBytes;
  if (!limit) {
    if (phase === "plan") limit = MAX_PLAN_HANDOFF_BYTES;
    else if (phase === "implementation") limit = MAX_IMPL_HANDOFF_BYTES;
    else if (phase === "review") limit = MAX_REVIEW_HANDOFF_BYTES;
    else limit = 24 * 1024;
  }

  const originalBytes = Buffer.byteLength(text, "utf8");
  if (originalBytes <= limit) {
    return text;
  }

  // The payload budget excludes the manifest: a huge manifest attached to an
  // over-budget payload would push parseable Report/Findings lines out.
  const manifestOverhead = Buffer.byteLength(handoffManifest({
    phase,
    from: "upstream agent",
    to: "next agent",
    originalBytes,
    finalBytes: limit,
    budget: limit,
    truncated: true,
  }), "utf8");
  const payloadBudget = Math.max(256, limit - manifestOverhead);

  let compressed;
  if (phase === "implementation") {
    compressed = compressImplementationReport(text, payloadBudget);
  } else if (phase === "review") {
    compressed = compressReviewFeedback(text, payloadBudget);
  } else {
    // plan / general: middle-out keeps plan head (targets) and tail (risks).
    compressed = clipUtf8MiddleOut(text, payloadBudget);
  }

  const finalBytes = Buffer.byteLength(compressed, "utf8");
  const truncated = finalBytes < originalBytes;
  const manifest = handoffManifest({
    phase,
    from: "upstream agent",
    to: "next agent",
    originalBytes,
    finalBytes,
    budget: limit,
    truncated,
  });
  return manifest + compressed;
}

function compressImplementationReport(text, limit) {
  // Priority order for the reviewer: parseable report lines (## Report /
  // - Files changed / - Commands run) > command/test status lines > fenced
  // code bodies (the actual diff is the ground truth, bodies are redundant).
  const lines = text.split(/\r?\n/);

  // Split into segments: fenced blocks are collected separately.
  const segments = []; // {type:'line', text} | {type:'fence', open, lang, body, close}
  let inFence = null;
  for (const line of lines) {
    if (inFence) {
      if (/^\s{0,3}```\s*$/.test(line) || /^\s{0,3}~~~\s*$/.test(line)) {
        segments.push(inFence);
        segments.push({ type: "line", text: line });
        inFence = null;
        continue;
      }
      inFence.body.push(line);
      continue;
    }
    const openMatch = line.match(/^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/);
    if (openMatch) {
      inFence = { type: "fence", open: openMatch[1], lang: openMatch[2] || "", body: [] };
      continue;
    }
    segments.push({ type: "line", text: line });
  }
  if (inFence) segments.push(inFence);

  const isSignal = (line) =>
    /^\s*#/.test(line) ||
    /^\s*\$/.test(line) ||
    /^\s*[-*]\s/.test(line) ||
    /^\s*\d+[.)]\s/.test(line) ||
    /(pass|fail|error|ok|test|warning|diff|modified|created|deleted|exit|\[P\d+\])/i.test(line);

  const renderFence = (seg, withBody) => {
    if (!withBody) {
      const note = seg.body.length > 0 ? ` … [${seg.body.length} lines of code omitted; the diff is authoritative] …` : "";
      return [`${seg.open}${seg.lang ? " " + seg.lang : ""}${note}`];
    }
    return [
      `${seg.open}${seg.lang ? " " + seg.lang : ""}`,
      clipCodeBody(seg.body.join("\n"), 40),
      seg.open,
    ];
  };

  const build = (withBodies) => {
    const out = [];
    for (const seg of segments) {
      if (seg.type === "fence") out.push(...renderFence(seg, withBodies));
      else if (isSignal(seg.text) || seg.text.trim() === "") out.push(seg.text);
    }
    return out.join("\n");
  };

  const withBodies = build(true);
  if (Buffer.byteLength(withBodies, "utf8") <= limit) {
    return withBodies;
  }

  // Bodies do not fit: drop them entirely (keep fence markers + line counts).
  const lean = build(false);
  if (Buffer.byteLength(lean, "utf8") <= limit) {
    return lean;
  }

  // Even the report alone is over budget: middle-out preserves its head+tail.
  const clipped = clipUtf8MiddleOut(lean, limit);
  if (Buffer.byteLength(clipped, "utf8") > limit) {
    return clipUtf8Safe(clipped, limit);
  }
  return clipped;
}

function compressReviewFeedback(text, limit) {
  // Findings (## Verdict / numbered items / [P#] verifications) are the
  // parseable contract; prose elaboration is secondary. Filter to signal
  // lines first, then middle-out whatever remains.
  const lines = text.split(/\r?\n/);
  const signal = lines.filter(
    (line) =>
      /^\s*#/.test(line) ||
      /^\s*\d+[.)]\s/.test(line) ||
      /^\s*[-*]\s/.test(line) ||
      /\[P\d+\]|\[F\d+\]/.test(line) ||
      /(issue|defect|bug|risk|fix|regression|missing|correct|recommend|verdict|approve)/i.test(line)
  );
  const filtered = signal.length > 2 ? signal.join("\n") : text;
  const clipped = clipUtf8MiddleOut(filtered, limit);
  if (Buffer.byteLength(clipped, "utf8") > limit) {
    return clipUtf8Safe(clipped, limit);
  }
  return clipped;
}

/**
 * Filters and compacts a Git diff text.
 *
 * Instead of a single global head clip (which silently deletes every file
 * listed after the budget line), each file gets a fair per-file budget:
 * important files (source code) keep more, lockfiles/minified artifacts keep
 * only their name, and every omitted hunk still lists the file path so the
 * receiving agent knows the change exists and can inspect it itself.
 */
function compressGitDiff(diffText, maxBytes = 32 * 1024, maxLinesPerFile = 100) {
  if (!diffText || typeof diffText !== "string") return "";

  const IGNORED_EXTS = [
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.lock",
    ".min.js",
    ".min.css",
    ".map",
  ];

  const totalBytes = Buffer.byteLength(diffText, "utf8");
  if (totalBytes <= maxBytes) return diffText;

  // Strict greedy packing with an always-reserved omission index:
  //   - every changed file is either present (full or line-capped) or named in
  //     the index — nothing vanishes silently;
  //   - the output never exceeds maxBytes, so no post-clip can erase entries;
  //   - allocation is first-come by original order (diffs are already ordered
  //     most-relevant-first by callers), not by size.
  const files = diffText.split(/^diff --git /m).filter(Boolean);
  const INDEX_RESERVE = Math.floor(maxBytes * 0.15);
  const bodyBudget = maxBytes - INDEX_RESERVE;

  const omittedPaths = [];
  const keptHunks = [];
  let used = 0;
  const NEWLINE = 1;

  const byteLen = (text) => Buffer.byteLength(text, "utf8");

  for (const fileDiff of files) {
    const firstLine = fileDiff.split("\n")[0] || "";
    const pathMatch = firstLine.match(/b\/(\S+)/);
    const path = pathMatch ? pathMatch[1] : firstLine.trim();

    if (IGNORED_EXTS.some((ext) => firstLine.includes(ext))) {
      omittedPaths.push(`${path} (machine-generated; omitted entirely)`);
      continue;
    }

    // Forms from cheapest to most expensive; take the first that fits.
    const lines = fileDiff.split("\n");
    const forms = [];
    if (byteLen(fileDiff) + NEWLINE <= bodyBudget - used) {
      forms.push(fileDiff);
    }
    if (lines.length > 8) {
      const headLines = Math.max(3, Math.floor(maxLinesPerFile * 0.6));
      const tailLines = Math.max(2, Math.floor(maxLinesPerFile * 0.2));
      const capped = [
        ...lines.slice(0, headLines),
        `… [${Math.max(0, lines.length - headLines - tailLines)} middle lines omitted for this file] …`,
        ...lines.slice(Math.max(headLines, lines.length - tailLines)),
      ].join("\n");
      if (forms.length === 0 && byteLen(capped) + NEWLINE <= bodyBudget - used) {
        forms.push(capped);
      }
    }
    if (forms.length === 0) {
      // Header-only form (still names the file), then index-only.
      const headerOnly = lines.slice(0, Math.min(2, lines.length)).join("\n") + "\n… [change body omitted; see workspace] …";
      if (byteLen(headerOnly) + NEWLINE <= bodyBudget - used) {
        forms.push(headerOnly);
      } else {
        omittedPaths.push(`${path} (body omitted entirely; budget exhausted)`);
        continue;
      }
    }

    used += byteLen(forms[0]) + NEWLINE;
    keptHunks.push(forms[0]);
  }

  // Convergence loop: if the assembled output (hunks + index) exceeds the
  // budget, drop the LAST kept hunk into the index and retry. Each iteration
  // shrinks the body by more than it grows the index, so this always
  // terminates — and no file is ever lost: dropped hunks are named in the
  // index instead of being erased by a global clip.
  const pack = (hunks, omissions) => {
    let text = hunks.join("\ndiff --git ");
    if (hunks.length > 0 && !text.startsWith("diff --git ")) {
      text = "diff --git " + text;
    }
    if (omissions.length > 0) {
      text +=
        "\n\n[Files changed but omitted from this excerpt — verify in the workspace if relevant]\n" +
        omissions.map((entry) => `- ${entry}`).join("\n") +
        "\n";
    }
    return text;
  };

  let result = pack(keptHunks, omittedPaths);
  while (byteLen(result) > maxBytes && keptHunks.length > 0) {
    const dropped = keptHunks.pop();
    const dropPath = (dropped.split("\n")[0] || "").match(/b\/(\S+)/);
    const name = dropPath ? dropPath[1] : "unknown path";
    const bodyOmitted = dropped.includes("change body omitted")
      ? null
      : "(dropped to fit the budget; full hunk was over allocation)";
    if (bodyOmitted) omittedPaths.unshift(`${name} ${bodyOmitted}`);
    result = pack(keptHunks, omittedPaths);
  }

  // Absolute safety net for degenerate inputs (never silently erase entries).
  if (byteLen(result) > maxBytes) {
    const indexStart = result.indexOf("\n\n[Files changed but omitted");
    const index = indexStart >= 0 ? result.slice(indexStart) : "";
    const base = indexStart >= 0 ? result.slice(0, indexStart) : result;
    result = clipUtf8MiddleOut(base, Math.max(512, maxBytes - byteLen(index))) + index;
  }
  return result;
}

/**
 * Ensures a prompt passed via argv to child processes never triggers Linux E2BIG.
 */
function safePromptArg(prompt, maxBytes = MAX_CLI_ARG_BYTES) {
  return clipByBytes(prompt, maxBytes, "\n... [instruction prompt compacted for execution]");
}

export {
  MAX_HISTORY_BYTES,
  MAX_TURN_ASSISTANT_BYTES,
  MAX_TURN_USER_BYTES,
  MAX_PLAN_HANDOFF_BYTES,
  MAX_IMPL_HANDOFF_BYTES,
  MAX_REVIEW_HANDOFF_BYTES,
  MAX_CLI_ARG_BYTES,
  clipByBytes,
  clipUtf8Safe,
  clipUtf8MiddleOut,
  clipCodeBody,
  compressMessages,
  compressHandoff,
  compressGitDiff,
  safePromptArg,
  summarizeCollaborativeResponse,
  handoffManifest,
};

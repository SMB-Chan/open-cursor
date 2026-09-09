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

  if (Buffer.byteLength(text, "utf8") <= limit) {
    return text;
  }

  // Phase-specific intelligent compression
  if (phase === "implementation") {
    // Extract command outputs, test results, and file edits; strip verbose file dumps
    const lines = text.split(/\r?\n/);
    const keyLines = [];
    let skippingCodeBlock = false;

    for (const line of lines) {
      if (line.startsWith("```")) {
        skippingCodeBlock = !skippingCodeBlock;
        keyLines.push(line);
        continue;
      }
      // Retain headers, tests, errors, and git lines
      if (
        line.startsWith("#") ||
        line.startsWith("$") ||
        /(pass|fail|error|ok|test|warning|diff|modified|created|deleted|exit)/i.test(line) ||
        !skippingCodeBlock
      ) {
        keyLines.push(line);
      }
    }
    const filtered = keyLines.join("\n");
    return clipByBytes(filtered, limit, "\n... [implementation report compacted for review]");
  }

  if (phase === "review") {
    // Focus on defects, issues, recommendations
    const lines = text.split(/\r?\n/);
    const actionable = lines.filter(line =>
      line.startsWith("#") ||
      line.startsWith("- [") ||
      line.startsWith("*") ||
      line.startsWith("1.") ||
      line.startsWith("2.") ||
      line.startsWith("3.") ||
      /(issue|defect|bug|risk|fix|regression|missing|correct|recommend)/i.test(line)
    );
    const filtered = actionable.length > 5 ? actionable.join("\n") : text;
    return clipByBytes(filtered, limit, "\n... [review feedback compacted for refinement]");
  }

  return clipByBytes(text, limit);
}

/**
 * Filters and compacts a Git diff text.
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

  const files = diffText.split(/^diff --git /m).filter(Boolean);
  const keptHunks = [];

  for (const fileDiff of files) {
    const firstLine = fileDiff.split("\n")[0] || "";
    if (IGNORED_EXTS.some(ext => firstLine.includes(ext))) {
      keptHunks.push(`[diff for ${firstLine.trim()} omitted for context budget]`);
      continue;
    }

    const lines = fileDiff.split("\n");
    if (lines.length > maxLinesPerFile) {
      const head = lines.slice(0, Math.floor(maxLinesPerFile * 0.7));
      const tail = lines.slice(-Math.floor(maxLinesPerFile * 0.3));
      keptHunks.push(
        head.join("\n") +
        `\n... [${lines.length - maxLinesPerFile} diff lines omitted for brevity] ...\n` +
        tail.join("\n")
      );
    } else {
      keptHunks.push(fileDiff);
    }
  }

  const result = keptHunks.join("\ndiff --git ");
  return clipByBytes(result, maxBytes, "\n... [git diff truncated to budget]");
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
  compressMessages,
  compressHandoff,
  compressGitDiff,
  safePromptArg,
  summarizeCollaborativeResponse,
};

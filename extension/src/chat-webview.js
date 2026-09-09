/**
 * Open-Cursor chat webview client script.
 *
 * Inlined into the chat panel HTML by chat-html.js (same pattern as
 * markdown.js) and executed only inside the VS Code/Cursor webview, where
 * `acquireVsCodeApi` exists. Kept as a standalone file so `node --check`
 * validates its syntax — a template-literal-embedded script silently ate
 * `\n` escapes before and shipped an unparseable webview.
 *
 * Rendering rule: DOM text nodes only (never innerHTML), so agent or
 * repository content can never inject markup.
 */
"use strict";

const vscode = acquireVsCodeApi();
// Session transcript: rendered blocks survive panel close/reopen within
// this webview's lifetime (serializeState on saveState).
const session = [];
try {
  const previous = vscode.getState && vscode.getState();
  if (previous && Array.isArray(previous.session)) {
    session.push(...previous.session);
  }
} catch {}

const MD = self.OpenCursorMarkdown;

const messages = document.getElementById("messages");
const empty = document.getElementById("empty");
const input = document.getElementById("input");
const mode = document.getElementById("mode");
const sendButton = document.getElementById("send");
const cancelButton = document.getElementById("cancel");
const clearButton = document.getElementById("clear");

const PHASE_LABELS = {
  plan: "Plan",
  implement: "Implement",
  review: "Review",
  refine: "Refine",
  respond: "Respond",
  goal: "Goal Loop",
};

let activeRequestId = null;
let assistantCard = null;
let assistantBody = null;
let phaseStrip = null;
let agentBadge = null;
let activePhase = null;
let receivedDelta = false;
let phaseNodes = new Map();
let runTimer = null;

// ── Session transcript persistence ───────────────────────────
const SESSION_MAX_BYTES = 256 * 1024;
const SESSION_MAX_TURNS = 40;
let sessionBytes = 0;
for (const entry of session) sessionBytes += String(entry.t || "").length;

function recordTurn(role, text) {
  const entry = { r: role, t: text, m: mode.value, at: Date.now() };
  session.push(entry);
  sessionBytes += entry.t.length;
  while (
    session.length > 0 &&
    (sessionBytes > SESSION_MAX_BYTES || session.length > SESSION_MAX_TURNS)
  ) {
    sessionBytes -= session[0].t.length;
    session.shift();
  }
}

function persistSession(extra = {}) {
  try {
    vscode.setState({ session, draft: input.value, mode: mode.value, ...extra });
  } catch {}
}

// Draft persistence is throttled: setState serializes the whole session.
let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistSession();
  }, 250);
}

function restoreSession() {
  for (const entry of session) {
    if (entry.r === "u") {
      addMsg("> " + entry.t, "user");
      continue;
    }
    createAssistant(entry.m || "respond");
    if (assistantBody) {
      const rawText = String(entry.t || "");
      assistantBody.textContent = "";
      assistantBody.classList.remove("thinking");
      assistantBody.classList.add("restored");
      for (const block of MD.tokenizeBlocks(rawText.split("\n"))) {
        assistantBody.appendChild(mdRenderBlock(block));
      }
      if (assistantCard) assistantCard._rawText = rawText;
    }
    if (runTimer) {
      clearInterval(runTimer.interval);
      runTimer.node.textContent = "logged";
      runTimer = null;
    }
    if (agentBadge) agentBadge.textContent = "Restored";
    // Entries are already in `session` — reset the run UI without recording.
    finish({ record: false });
  }
}

function updateEmptyState() {
  if (!empty) return;
  empty.style.display = messages.querySelector(".msg, .assistant-card") ? "none" : "";
}

function autoGrow() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 180) + "px";
}

function addMsg(text, cls) {
  const div = document.createElement("div");
  div.className = "msg " + cls;
  div.textContent = text;
  messages.appendChild(div);
  updateEmptyState();
  messages.scrollTop = messages.scrollHeight;
  return div;
}

function phaseKey(rawPhase) {
  const phase = String(rawPhase || "").replace(/-header$/, "");
  if (phase === "planning" || phase === "analysis") return "plan";
  if (phase === "goal") return "goal";
  if (phase === "implementation") return "implement";
  if (phase === "review") return "review";
  if (phase === "refinement") return "refine";
  if (phase === "response") return "respond";
  return phase || null;
}

function agentLabel(agent) {
  if (agent === "antigravity") return "Gemini";
  if (agent === "codex") return "Codex";
  if (agent === "collaborative") return "Collaborative";
  if (agent === "pipeline") return "Pipeline";
  return agent || "Starting";
}

function phaseSequence(selectedMode) {
  if (selectedMode === "collaborative") return ["plan", "implement", "review", "refine"];
  if (selectedMode === "pipeline") return ["plan", "implement"];
  if (selectedMode === "goal") return ["goal"];
  return ["respond"];
}

function createAssistant(selectedMode) {
  const card = document.createElement("div");
  card.className = "assistant-card";
  card._rawText = "";
  assistantCard = card;

  const meta = document.createElement("div");
  meta.className = "run-meta";

  agentBadge = document.createElement("span");
  agentBadge.className = "agent-badge";
  agentBadge.textContent = "Starting";
  meta.appendChild(agentBadge);

  const timer = document.createElement("span");
  timer.className = "run-timer";
  timer.textContent = "0.0s";
  meta.appendChild(timer);
  runTimer = { startedAt: Date.now(), node: timer, interval: null };
  runTimer.interval = setInterval(() => {
    if (!runTimer) return;
    const secs = (Date.now() - runTimer.startedAt) / 1000;
    runTimer.node.textContent =
      secs >= 60
        ? Math.floor(secs / 60) + "m" + (secs % 60).toFixed(0).padStart(2, "0") + "s"
        : secs.toFixed(1) + "s";
  }, 100);

  // Copy the whole response (live while streaming, recorded after finish).
  const copyAll = document.createElement("button");
  copyAll.className = "run-toggle";
  copyAll.textContent = "Copy";
  copyAll.title = "Copy this response";
  copyAll.setAttribute("aria-label", "Copy this response");
  copyAll.addEventListener("click", () => {
    const text = card === assistantCard && mdStream ? mdStream.raw : card._rawText;
    if (!text) return;
    navigator.clipboard
      .writeText(String(text))
      .then(() => {
        copyAll.textContent = "Copied";
        setTimeout(() => {
          copyAll.textContent = "Copy";
        }, 1200);
      })
      .catch(() => {});
  });
  meta.appendChild(copyAll);

  const toggle = document.createElement("button");
  toggle.className = "run-toggle";
  toggle.setAttribute("aria-label", "Collapse this response");
  toggle.title = "Collapse this response";
  toggle.textContent = "▾";
  toggle.addEventListener("click", () => {
    const collapsed = card.classList.toggle("collapsed");
    toggle.textContent = collapsed ? "▸" : "▾";
    toggle.title = collapsed ? "Expand this response" : "Collapse this response";
    toggle.setAttribute("aria-label", collapsed ? "Expand this response" : "Collapse this response");
  });
  meta.appendChild(toggle);

  phaseStrip = document.createElement("div");
  phaseStrip.className = "phase-strip";
  phaseNodes = new Map();
  for (const phase of phaseSequence(selectedMode)) {
    const pill = document.createElement("span");
    pill.className = "phase-pill";
    pill.dataset.phase = phase;
    pill.textContent = PHASE_LABELS[phase] || phase;
    phaseNodes.set(phase, pill);
    phaseStrip.appendChild(pill);
  }
  meta.appendChild(phaseStrip);

  assistantBody = document.createElement("div");
  assistantBody.className = "assistant-body thinking";
  assistantBody.textContent = "Starting…";

  card.appendChild(meta);
  card.appendChild(assistantBody);
  messages.appendChild(card);
  updateEmptyState();
  messages.scrollTop = messages.scrollHeight;
}

function renderReceipt(summary) {
  if (!summary || !assistantCard) return;
  const box = document.createElement("div");
  box.className = "workspace-receipt";

  const title = document.createElement("div");
  title.className = "receipt-title";
  title.textContent = summary.title || "Workspace receipt";
  box.appendChild(title);

  const summaryLine = document.createElement("div");
  summaryLine.className = "receipt-summary";
  summaryLine.textContent = summary.summary || "No receipt summary available";
  box.appendChild(summaryLine);

  const safety = document.createElement("div");
  safety.className = "receipt-safety";
  safety.textContent = summary.rollbackPerformed
    ? "Rollback was performed."
    : "Non-destructive observation · no automatic rollback";
  box.appendChild(safety);

  for (const group of Array.isArray(summary.groups) ? summary.groups : []) {
    const groupNode = document.createElement("div");
    groupNode.className = "receipt-group";
    const label = document.createElement("div");
    label.className = "receipt-group-label";
    label.textContent = group.label || "Paths";
    const paths = document.createElement("pre");
    paths.className = "receipt-paths";
    paths.textContent = Array.isArray(group.paths) ? group.paths.join("\n") : "";
    groupNode.appendChild(label);
    groupNode.appendChild(paths);
    box.appendChild(groupNode);
  }

  if (summary.warning) {
    const warning = document.createElement("div");
    warning.className = "receipt-warning";
    warning.textContent = summary.warning;
    box.appendChild(warning);
  }
  if (summary.note) {
    const note = document.createElement("div");
    note.className = "receipt-note";
    note.textContent = summary.note;
    box.appendChild(note);
  }

  assistantCard.appendChild(box);
  messages.scrollTop = messages.scrollHeight;
}

function ensurePhaseNode(phase) {
  if (!phase || !phaseStrip) return null;
  if (phaseNodes.has(phase)) return phaseNodes.get(phase);

  const pill = document.createElement("span");
  pill.className = "phase-pill";
  pill.dataset.phase = phase;
  pill.textContent = PHASE_LABELS[phase] || phase;
  phaseNodes.set(phase, pill);
  phaseStrip.appendChild(pill);
  return pill;
}

function updateExecutionMeta(agent, rawPhase) {
  const phase = phaseKey(rawPhase);
  if (!phase) return;

  if (activePhase && activePhase !== phase) {
    const previous = phaseNodes.get(activePhase);
    if (previous) {
      previous.classList.remove("active");
      previous.classList.add("done");
    }
  }

  const node = ensurePhaseNode(phase);
  if (node) {
    node.classList.remove("done", "cancelled", "failed");
    node.classList.add("active");
  }
  activePhase = phase;
  if (agentBadge) {
    agentBadge.textContent = agentLabel(agent) + " · " + (PHASE_LABELS[phase] || phase);
  }
}

function settleActivePhase(state) {
  if (!activePhase) return;
  const node = phaseNodes.get(activePhase);
  if (!node) return;
  node.classList.remove("active");
  if (state) node.classList.add(state);
}

function setBusy(busy) {
  sendButton.disabled = busy;
  cancelButton.disabled = !busy;
  mode.disabled = busy;
  // The textarea stays enabled so the next prompt can be drafted while the
  // current run is still streaming.
  if (!busy) input.focus();
}

function send() {
  const text = input.value.trim();
  if (!text || activeRequestId) return;
  activeRequestId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  addMsg("> " + text, "user");
  recordTurn("u", text);
  vscode.postMessage({ type: "send", requestId: activeRequestId, text, mode: mode.value });
  input.value = "";
  autoGrow();
  setBusy(true);
  persistSession({ draft: "" });
}

function finish(options = {}) {
  const record = options.record !== false;
  if (runTimer) {
    clearInterval(runTimer.interval);
    if (runTimer.node && assistantCard) {
      const secs = (Date.now() - runTimer.startedAt) / 1000;
      runTimer.node.textContent =
        secs >= 60
          ? Math.floor(secs / 60) + "m" + Math.round(secs % 60) + "s"
          : secs.toFixed(1) + "s";
    }
    runTimer = null;
  }
  if (record && assistantBody) {
    const body = mdStream && mdStream.raw ? mdStream.raw : assistantBody.textContent;
    if (assistantCard) assistantCard._rawText = body;
    recordTurn("a", body);
    persistSession();
  }
  activeRequestId = null;
  assistantCard = null;
  assistantBody = null;
  phaseStrip = null;
  agentBadge = null;
  activePhase = null;
  receivedDelta = false;
  phaseNodes = new Map();
  mdReset();
  setBusy(false);
}

// A run-level note appended after the rendered markdown. Mutating
// assistantBody.textContent here would destroy the rendered DOM and leak
// code-block "Copy" labels into the text, so notes are separate nodes.
function appendRunNote(text, cls) {
  if (!assistantBody) return;
  const note = document.createElement("div");
  note.className = cls ? "run-note " + cls : "run-note";
  note.textContent = text;
  assistantBody.appendChild(note);
  messages.scrollTop = messages.scrollHeight;
}

// ── Incremental markdown rendering ──────────────────────────────
// Completed blocks become DOM once and are never re-parsed; only the live
// tail block is touched per frame, so long goal-loop transcripts stay
// smooth regardless of transcript size.

let mdStream = null;
let mdScheduled = false;
let mdTailEl = null;
let mdTailIsFence = false;
let mdRenderedFenceLines = 0;

function mdReset() {
  mdStream = null;
  mdScheduled = false;
  mdTailEl = null;
  mdTailIsFence = false;
  mdRenderedFenceLines = 0;
}

function mdBegin() {
  mdReset();
  mdStream = new MD.MarkdownStream();
}

function mdPush(text) {
  if (!mdStream) return;
  mdStream.push(text);
  mdScheduleFlush();
}

function mdScheduleFlush() {
  if (mdScheduled) return;
  mdScheduled = true;
  const run = () => {
    mdScheduled = false;
    mdFlush();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 16);
}

function mdFlush(final) {
  if (!mdStream || !assistantBody) return;
  const wasPinned = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;

  const result = final ? mdStream.drainFinal() : mdStream.drain();
  for (const block of result.stable) {
    mdRemoveTailEl();
    assistantBody.appendChild(mdRenderBlock(block));
  }
  if (final) {
    if (result.tail) assistantBody.appendChild(mdRenderBlock(result.tail));
    mdRemoveTailEl();
  } else {
    mdUpdateTail(result.tail);
  }

  if (wasPinned) messages.scrollTop = messages.scrollHeight;
}

function mdRemoveTailEl() {
  if (mdTailEl && mdTailEl.parentNode) mdTailEl.parentNode.removeChild(mdTailEl);
  mdTailEl = null;
  mdTailIsFence = false;
  mdRenderedFenceLines = 0;
}

function mdUpdateTail(tail) {
  if (!assistantBody) return;
  if (!tail) {
    mdRemoveTailEl();
    return;
  }

  // An open fence grows append-only: push new body lines into the
  // existing text node instead of re-rendering the whole block.
  if (tail.type === "code" && tail.open) {
    if (mdTailEl && mdTailIsFence) {
      mdAppendFenceLines(tail.body);
      return;
    }
    mdRemoveTailEl();
    mdTailEl = mdRenderBlock(tail);
    mdTailIsFence = true;
    mdRenderedFenceLines = 0;
    mdAppendFenceLines(tail.body);
    assistantBody.appendChild(mdTailEl);
    return;
  }

  // Non-fence tails (paragraphs, lists, quotes) are small: re-render.
  mdRemoveTailEl();
  mdTailEl = mdRenderBlock(tail);
  assistantBody.appendChild(mdTailEl);
}

function mdAppendFenceLines(bodyLines) {
  const codeNode = mdTailEl && mdTailEl.querySelector ? mdTailEl.querySelector("code") : null;
  if (!codeNode) return;
  for (let i = mdRenderedFenceLines; i < bodyLines.length; i++) {
    codeNode.appendChild(document.createTextNode((i > 0 ? "\n" : "") + bodyLines[i]));
  }
  mdRenderedFenceLines = bodyLines.length;
}

function mdRenderBlock(block) {
  if (block.type === "heading") {
    const level = Math.max(1, Math.min(6, block.level || 1));
    const el = document.createElement("h" + level);
    el.className = "md-heading md-h" + level;
    mdRenderInline(block.text, el);
    return el;
  }
  if (block.type === "hr") {
    const el = document.createElement("hr");
    el.className = "md-hr";
    return el;
  }
  if (block.type === "code") {
    const wrap = document.createElement("div");
    wrap.className = "md-code-wrap";
    if (block.lang) {
      const lang = document.createElement("div");
      lang.className = "md-code-lang";
      lang.textContent = block.lang;
      wrap.appendChild(lang);
    }
    const pre = document.createElement("pre");
    pre.className = "md-code";
    const code = document.createElement("code");
    code.textContent = block.body.join("\n");
    pre.appendChild(code);
    wrap.appendChild(pre);
    const copy = document.createElement("button");
    copy.className = "md-copy";
    copy.textContent = "Copy";
    copy.setAttribute("aria-label", "Copy code to clipboard");
    copy.addEventListener("click", () => {
      navigator.clipboard
        .writeText(block.body.join("\n"))
        .then(() => {
          copy.textContent = "Copied";
          copy.classList.add("copied");
          setTimeout(() => {
            copy.textContent = "Copy";
            copy.classList.remove("copied");
          }, 1200);
        })
        .catch(() => {});
    });
    wrap.appendChild(copy);
    return wrap;
  }
  if (block.type === "quote") {
    const el = document.createElement("blockquote");
    el.className = "md-quote";
    for (const line of block.lines) {
      const p = document.createElement("div");
      p.className = "md-quote-line";
      mdRenderInline(line, p);
      el.appendChild(p);
    }
    return el;
  }
  if (block.type === "list") {
    const el = document.createElement(block.ordered ? "ol" : "ul");
    el.className = "md-list";
    for (const item of block.items) {
      const li = document.createElement("li");
      li.className = "md-li";
      mdRenderInline(item.join(" "), li);
      el.appendChild(li);
    }
    return el;
  }
  const p = document.createElement("p");
  p.className = "md-p";
  mdRenderInline(block.lines.join("\n"), p);
  return p;
}

function mdRenderInline(text, parent) {
  for (const token of MD.tokenizeInline(text)) {
    if (token.t === "code") {
      const code = document.createElement("code");
      code.className = "md-icode";
      code.textContent = token.v;
      parent.appendChild(code);
    } else if (token.t === "bold") {
      const strong = document.createElement("strong");
      strong.textContent = token.v;
      parent.appendChild(strong);
    } else {
      parent.appendChild(document.createTextNode(token.v));
    }
  }
}

input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey) return;
  // Enter pressed while the IME candidate window is open confirms the
  // conversion — it must never send the message.
  if (event.isComposing || event.keyCode === 229) return;
  event.preventDefault();
  send();
});
sendButton.addEventListener("click", send);
cancelButton.addEventListener("click", () => {
  if (activeRequestId) vscode.postMessage({ type: "cancel", requestId: activeRequestId });
});
clearButton.addEventListener("click", () => {
  if (activeRequestId) return;
  for (const node of Array.from(messages.children)) {
    if (node !== empty) node.remove();
  }
  session.length = 0;
  sessionBytes = 0;
  persistSession();
  updateEmptyState();
  input.focus();
});
// Esc cancels the running request (standard chat UX). During IME
// composition Esc closes the candidate window instead.
window.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape" && activeRequestId && !cancelButton.disabled) {
    vscode.postMessage({ type: "cancel", requestId: activeRequestId });
  }
});

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (msg.requestId !== activeRequestId) return;

  if (msg.type === "begin") {
    createAssistant(msg.mode || mode.value);
  } else if (msg.type === "delta") {
    if (!assistantCard) createAssistant(mode.value);
    updateExecutionMeta(msg.agent, msg.phase);

    if (typeof msg.text === "string" && msg.text.length > 0) {
      if (!receivedDelta) {
        if (!mdStream) mdBegin();
        assistantBody.textContent = "";
        assistantBody.classList.remove("thinking");
        receivedDelta = true;
      }
      mdPush(msg.text);
    }
  } else if (msg.type === "complete") {
    settleActivePhase("done");
    if (agentBadge) agentBadge.textContent = "Complete";
    if (assistantBody && !receivedDelta) {
      assistantBody.textContent = msg.empty ? "No response" : assistantBody.textContent;
      assistantBody.classList.remove("thinking");
    }
    if (receivedDelta && mdStream) mdFlush(true);
    renderReceipt(msg.receipt);
    finish();
  } else if (msg.type === "cancelled") {
    settleActivePhase("cancelled");
    if (agentBadge) agentBadge.textContent = "Cancelled";
    if (receivedDelta && mdStream) mdFlush(true);
    if (assistantBody) {
      if (!receivedDelta) assistantBody.textContent = "Cancelled.";
      else appendRunNote("[Cancelled]");
      assistantBody.classList.remove("thinking");
    }
    renderReceipt(msg.receipt);
    finish();
  } else if (msg.type === "error") {
    settleActivePhase("failed");
    if (agentBadge) agentBadge.textContent = "Failed";
    if (assistantBody) {
      if (receivedDelta && mdStream) mdFlush(true);
      if (!receivedDelta) {
        assistantBody.textContent = msg.text;
        assistantBody.classList.add("error");
      } else {
        appendRunNote("Failed: " + msg.text, "error");
      }
      assistantBody.classList.remove("thinking");
    } else {
      addMsg(msg.text, "error");
    }
    renderReceipt(msg.receipt);
    finish();
  }
});

// ── Init: restore previous conversation, draft and mode ──
try {
  const prev = vscode.getState && vscode.getState();
  if (prev) {
    if (prev.mode && Array.prototype.some.call(mode.options, (o) => o.value === prev.mode)) {
      mode.value = prev.mode;
    }
    if (typeof prev.draft === "string" && prev.draft) {
      input.value = prev.draft;
      autoGrow();
    }
  }
} catch {}
restoreSession();
updateEmptyState();
messages.scrollTop = messages.scrollHeight;

input.addEventListener("input", () => {
  autoGrow();
  schedulePersist();
});
mode.addEventListener("change", () => persistSession());

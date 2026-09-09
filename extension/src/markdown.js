/**
 * Open-Cursor incremental markdown tokenizer for streaming LLM output.
 *
 * Designed for very long coding sessions: completed blocks are tokenized once
 * and never re-processed, so per-delta cost is proportional to the new text
 * (not the whole transcript). The same source runs in Node (tests) and in the
 * webview (browser global `OpenCursorMarkdown`).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.OpenCursorMarkdown = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var FENCE_RE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)\s*$/;
  var FENCE_CLOSE_RE = /^\s{0,3}(```|~~~)\s*$/;
  var HEADING_RE = /^\s{0,3}(#{1,6})\s+(.*)$/;
  var HR_RE = /^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
  var QUOTE_RE = /^\s{0,3}>/;
  var LIST_RE = /^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/;
  var ORDERED_LIST_RE = /^\s{0,3}\d{1,9}[.)]\s+/;

  function lineKind(line) {
    if (!line.trim()) return "blank";
    if (FENCE_CLOSE_RE.test(line)) {
      // A bare fence that also matches FENCE_RE only closes when we are not
      // looking at an opener with a language tag; bare ``` is ambiguous, so
      // the caller's fence state decides. Here we report both: the block
      // scanner treats ``` inside a fence as close, outside as open.
      return FENCE_RE.test(line) ? "fence-open" : "fence-close";
    }
    if (FENCE_RE.test(line)) return "fence-open";
    if (HEADING_RE.test(line)) return "heading";
    if (HR_RE.test(line)) return "hr";
    if (QUOTE_RE.test(line)) return "quote";
    if (LIST_RE.test(line)) return "list";
    return "text";
  }

  function fenceLanguage(line) {
    var match = line.match(FENCE_RE);
    return match ? match[2] || "" : "";
  }

  // Inside a fence, a bare ``` (or ~~~) line closes it; a fence with a
  // language tag opens a nested literal block that markdown treats as body.
  function isFenceCloseInside(line, openMarker) {
    if (!openMarker) return false;
    if (!FENCE_CLOSE_RE.test(line)) return false;
    return !FENCE_RE.test(line) || fenceLanguage(line) === "";
  }

  function stripQuote(line) {
    return line.replace(/^\s{0,3}>\s?/, "");
  }

  function listMeta(line) {
    var ordered = ORDERED_LIST_RE.test(line);
    return { ordered: ordered, text: line.replace(/^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+/, "") };
  }

  /**
   * Tokenizes an array of COMPLETE lines (each already terminated by \n)
   * into markdown blocks. Each block carries __lines = number of source lines
   * it consumed, so the streaming layer can advance its cursor exactly once
   * per block without re-tokenizing. An unterminated fence becomes a code
   * block with open: true and consumes every remaining line as its body.
   */
  function tokenizeBlocks(lines) {
    var blocks = [];
    var i = 0;
    while (i < lines.length) {
      var start = i;
      var line = lines[i];
      var kind = lineKind(line);
      if (kind === "blank") { i++; continue; }
      // A stray fence-close (no matching opener) is skipped as a line, never
      // as a block: this keeps the tokenizer total (always advances).
      if (kind === "fence-close") { i++; continue; }

      if (kind === "fence-open") {
        var fence = { type: "code", lang: fenceLanguage(line), body: [], open: true };
        var openMarker = line.match(FENCE_RE)[1];
        i++;
        while (i < lines.length) {
          if (isFenceCloseInside(lines[i], openMarker)) { fence.open = false; i++; break; }
          fence.body.push(lines[i]);
          i++;
        }
        fence.__start = start;
        fence.__lines = i - start;
        blocks.push(fence);
        continue;
      }

      if (kind === "heading") {
        var h = line.match(HEADING_RE);
        blocks.push({ type: "heading", level: h[1].length, text: h[2].trim(), __start: start, __lines: 1 });
        i++;
        continue;
      }

      if (kind === "hr") { blocks.push({ type: "hr", __start: start, __lines: 1 }); i++; continue; }

      if (kind === "quote") {
        var quote = { type: "quote", lines: [] };
        while (i < lines.length && lineKind(lines[i]) === "quote") {
          quote.lines.push(stripQuote(lines[i]));
          i++;
        }
        quote.__start = start;
        quote.__lines = i - start;
        blocks.push(quote);
        continue;
      }

      if (kind === "list") {
        var list = { type: "list", ordered: false, items: [] };
        var currentItem = null;
        while (i < lines.length) {
          var lKind = lineKind(lines[i]);
          if (lKind === "blank") break;
          if (lKind === "fence-open" || lKind === "fence-close" || lKind === "heading" || lKind === "hr" || lKind === "quote") break;
          if (lKind === "list") {
            var meta = listMeta(lines[i]);
            list.ordered = list.ordered || meta.ordered;
            currentItem = [meta.text];
            list.items.push(currentItem);
            i++;
            continue;
          }
          if (lKind === "text" && currentItem && /^\s{2,}/.test(lines[i])) {
            currentItem.push(lines[i].replace(/^\s{2,}/, ""));
            i++;
            continue;
          }
          break;
        }
        list.__start = start;
        list.__lines = i - start;
        blocks.push(list);
        continue;
      }

      // paragraph: consecutive text lines until blank line or a new block start
      var para = { type: "p", lines: [] };
      while (i < lines.length) {
        var pKind = lineKind(lines[i]);
        if (pKind !== "text") break;
        para.lines.push(lines[i]);
        i++;
      }
      para.__start = start;
      para.__lines = i - start;
      if (para.lines.length) blocks.push(para);
    }
    return blocks;
  }

  /**
   * Incremental streaming tokenizer.
   *
   * push(delta) appends raw text. drain() tokenizes only the region after the
   * last stable block and returns:
   *   { stable: [blocks completed since last drain], tail: live block or null }
   * Stable blocks are guaranteed append-only: once emitted they are never
   * emitted again or mutated. The tail is re-reported on every drain and may
   * still grow. drainFinal() also flushes a trailing partial line.
   */
  function MarkdownStream() {
    this.raw = "";
    this.consumedChars = 0;
    this.closed = false;
  }

  MarkdownStream.prototype.push = function (delta) {
    if (this.closed || typeof delta !== "string") return;
    this.raw += delta;
  };

  MarkdownStream.prototype._drain = function (final_) {
    var region = this.raw.slice(this.consumedChars);
    var parts = region.split("\n");
    var trailing = parts[parts.length - 1];

    // A non-empty trailing fragment is an incomplete line: hold it back so a
    // half-received line is never rendered as if it were final. With
    // final_=true everything counts as complete.
    var completeLines = final_ ? parts : parts.slice(0, -1);

    var blocks = tokenizeBlocks(completeLines);
    if (blocks.length <= 1) {
      return { stable: [], tail: blocks[0] || null };
    }

    var stable = blocks.slice(0, -1);
    var tail = blocks[blocks.length - 1];

    // Advance the cursor exactly to the line where the tail block starts.
    // Using tail.__start (not the sum of stable block lengths) attributes
    // interleaved blank lines to the consumed region as well, so the cursor
    // can never land mid-block and re-tokenize the same text forever.
    var tailStart = tail.__start || 0;
    if (tailStart > 0) {
      this.consumedChars += completeLines.slice(0, tailStart).join("\n").length + 1;
    }

    return { stable: stable, tail: tail };
  };

  MarkdownStream.prototype.drain = function () { return this._drain(false); };
  MarkdownStream.prototype.drainFinal = function () {
    this.closed = true;
    return this._drain(true);
  };

  /**
   * Splits text into inline tokens: {t:'text'|'code'|'bold', v}.
   * Callers MUST render tokens via DOM text nodes (no innerHTML) so that
   * repository content can never inject markup.
   */
  function tokenizeInline(text) {
    var tokens = [];
    var value = String(text || "");
    var i = 0;
    var buf = "";
    function flushText() {
      if (buf) { tokens.push({ t: "text", v: buf }); buf = ""; }
    }
    while (i < value.length) {
      if (value[i] === "`") {
        var endCode = value.indexOf("`", i + 1);
        if (endCode > -1) {
          flushText();
          tokens.push({ t: "code", v: value.slice(i + 1, endCode) });
          i = endCode + 1;
          continue;
        }
      }
      if (value.startsWith("**", i)) {
        var endBold = value.indexOf("**", i + 2);
        if (endBold > -1) {
          flushText();
          tokens.push({ t: "bold", v: value.slice(i + 2, endBold) });
          i = endBold + 2;
          continue;
        }
      }
      buf += value[i];
      i++;
    }
    flushText();
    return tokens;
  }

  function blockText(block) {
    if (block.type === "heading") return block.text;
    if (block.type === "code") return block.body.join("\n");
    if (block.type === "quote") return block.lines.join("\n");
    if (block.type === "list") return block.items.map(function (item) { return item.join(" "); }).join("\n");
    return block.lines.join("\n");
  }

  return {
    MarkdownStream: MarkdownStream,
    tokenizeBlocks: tokenizeBlocks,
    tokenizeInline: tokenizeInline,
    blockText: blockText,
    lineKind: lineKind,
  };
});

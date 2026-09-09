const { test } = require("node:test");
const assert = require("node:assert/strict");
const md = require("./markdown.js");

test("tokenizeBlocks splits headings, paragraphs, lists and fenced code", () => {
  const lines = [
    "# Title",
    "A paragraph line",
    "continuing here",
    "- item one",
    "- item two",
    "```js",
    "const a = 1;",
    "```",
    "after code",
  ];
  const blocks = md.tokenizeBlocks(lines);

  assert.equal(blocks[0].type, "heading");
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[0].text, "Title");

  assert.equal(blocks[1].type, "p");
  assert.equal(blocks[1].lines.length, 2);

  assert.equal(blocks[2].type, "list");
  assert.equal(blocks[2].items.length, 2);

  assert.equal(blocks[3].type, "code");
  assert.equal(blocks[3].lang, "js");
  assert.equal(blocks[3].open, false);
  assert.deepEqual(blocks[3].body, ["const a = 1;"]);

  assert.equal(blocks[4].type, "p");
  assert.equal(blocks[4].lines[0], "after code");
});

test("unterminated fences stay open and consume the rest", () => {
  const blocks = md.tokenizeBlocks(["```", "line1", "line2"]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "code");
  assert.equal(blocks[0].open, true);
  assert.deepEqual(blocks[0].body, ["line1", "line2"]);
});

test("MarkdownStream emits stable blocks exactly once and holds the tail", () => {
  const stream = new md.MarkdownStream();
  const seen = [];
  const tails = [];

  stream.push("# Header\n\nfirst para\n");
  let result = stream.drain();
  for (const block of result.stable) seen.push(block.type);
  tails.push(result.tail ? result.tail.type : null);

  stream.push("more of the paragraph\n- list item\n");
  result = stream.drain();
  for (const block of result.stable) seen.push(block.type);
  tails.push(result.tail ? result.tail.type : null);

  const final = stream.drainFinal();
  // The final block is always the tail: it is reported via final.tail (with
  // its full content) rather than duplicating it into stable.
  for (const block of final.stable) seen.push(block.type);
  tails.push(final.tail ? final.tail.type : null);

  // Each stable block must appear exactly once across drains.
  assert.deepEqual(seen, ["heading", "p"]);
  assert.equal(final.tail.type, "list");
  assert.deepEqual(final.tail.items.map((item) => item.join(" ")), ["list item"]);
  // No type was emitted twice.
  assert.equal(new Set(seen).size, seen.length);
});

test("stable block content is immutable across drains", () => {
  const stream = new md.MarkdownStream();
  stream.push("## Section\n\nbody text\n");
  const first = stream.drain();
  assert.equal(first.stable.length, 1);
  const stableBefore = first.stable[0].text;

  stream.push("### Another\n");
  stream.drain();
  stream.drainFinal();

  assert.equal(first.stable[0].text, stableBefore);
});

test("partial lines are never emitted as stable", () => {
  const stream = new md.MarkdownStream();
  stream.push("complete line\nhalf line witho");
  const result = stream.drain();
  assert.deepEqual(result.stable.map((b) => b.type), []);
  stream.push("ut newline\nnext\n");
  const result2 = stream.drain();
  // "half line without newline" + "ut newline" form one paragraph.
  const joined = [result.tail, ...result2.stable].filter(Boolean);
  assert.ok(joined.some((b) => b.type === "p"));
});

test("long streaming session keeps per-delta cost bounded (no O(n^2))", () => {
  const stream = new md.MarkdownStream();
  // 700 blocks; tokenizing everything once up front would be quadratic if the
  // implementation re-parsed the transcript per drain.
  const chunk = "para line one\npara line two\n\n```js\ncode();\n```\n\n- item\n";
  const rounds = 100;
  for (let i = 0; i < rounds; i++) stream.push(chunk);

  const start = process.hrtime.bigint();
  let stable = 0;
  // Bound the drain loop: each drain must stabilize at least one block;
  // give it 2x headroom to prove amortized-linear behavior.
  const maxDrains = rounds * 8 * 2;
  let drains = 0;
  while (drains++ < maxDrains) {
    const r = stream.drain();
    stable += r.stable.length;
    if (r.stable.length === 0) break;
  }
  assert.ok(drains < maxDrains, "drain loop did not converge");
  const final = stream.drainFinal();
  stable += final.stable.length;
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;

  // 3 blocks per chunk (p, code, list); everything except the single live
  // tail must have stabilized.
  assert.equal(stable, rounds * 3 - 1, "all but the tail block should stabilize");
  assert.ok(elapsedMs < 500, `drain loop too slow: ${elapsedMs.toFixed(1)}ms`);
});

test("tokenizeInline extracts code and bold without interpreting HTML", () => {
  const tokens = md.tokenizeInline("use `npm test` and **bold** <script>alert(1)</script>");
  assert.deepEqual(
    tokens.map((t) => t.t),
    ["text", "code", "text", "bold", "text"]
  );
  const codeToken = tokens.find((t) => t.t === "code");
  assert.equal(codeToken.v, "npm test");
  // The script tag stays inert plain text.
  const scriptToken = tokens.find((t) => t.v.includes("<script>"));
  assert.ok(scriptToken);
});

test("inline tokens never merge into markup", () => {
  const tokens = md.tokenizeInline("`<img src=x onerror=alert(1)>`");
  assert.equal(tokens[0].t, "code");
  assert.equal(tokens[0].v, "<img src=x onerror=alert(1)>");
});

test("blockText round-trips content for receipts and copying", () => {
  assert.equal(md.blockText({ type: "heading", text: "Hi" }), "Hi");
  assert.equal(md.blockText({ type: "code", body: ["a", "b"] }), "a\nb");
  assert.equal(md.blockText({ type: "quote", lines: ["q"] }), "q");
  assert.equal(md.blockText({ type: "list", items: [["one"], ["two"]] }), "one\ntwo");
  assert.equal(md.blockText({ type: "p", lines: ["x", "y"] }), "x\ny");
});

test("quote blocks group consecutive lines", () => {
  const blocks = md.tokenizeBlocks(["> one", "> two", "", "after"]);
  assert.equal(blocks[0].type, "quote");
  assert.deepEqual(blocks[0].lines, ["one", "two"]);
  assert.equal(blocks[1].type, "p");
  assert.deepEqual(blocks[1].lines, ["after"]);
});

test("horizontal rules and headings terminate paragraphs", () => {
  const blocks = md.tokenizeBlocks(["text before", "---", "## After"]);
  assert.equal(blocks[0].type, "p");
  assert.equal(blocks[1].type, "hr");
  assert.equal(blocks[2].type, "heading");
});

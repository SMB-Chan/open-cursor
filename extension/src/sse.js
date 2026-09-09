function parseSseBlock(block) {
  const data = String(block || "")
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");

  if (!data) return { kind: "ignore" };
  if (data.trim() === "[DONE]") return { kind: "done" };

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    return { kind: "invalid", raw: data };
  }

  const delta = event?.choices?.[0]?.delta?.content;
  const metadata = event?.open_cursor && typeof event.open_cursor === "object"
    ? event.open_cursor
    : {};

  return {
    kind: "event",
    event,
    delta: typeof delta === "string" ? delta : "",
    agent: typeof metadata.agent === "string" ? metadata.agent : null,
    phase: typeof metadata.phase === "string" ? metadata.phase : null,
    iteration: typeof metadata.iteration === "number" && Number.isFinite(metadata.iteration)
      ? metadata.iteration
      : null,
    verdict: typeof metadata.verdict === "string" ? metadata.verdict : null,
    reviewCycles: typeof metadata.reviewCycles === "number" && Number.isFinite(metadata.reviewCycles)
      ? metadata.reviewCycles
      : null,
    metadata,
  };
}

async function consumeSse(response, onEvent = () => {}) {
  if (!response?.body) throw new Error("Bridge returned an empty streaming response");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let done = false;

  const processBlock = (block) => {
    const parsed = parseSseBlock(block);
    if (parsed.kind === "done") return true;
    if (parsed.kind !== "event") return false;

    if (parsed.delta) content += parsed.delta;
    onEvent(parsed);
    return false;
  };

  while (!done) {
    const next = await reader.read();
    if (next.done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(next.value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";

    for (const block of blocks) {
      if (processBlock(block)) {
        done = true;
        break;
      }
    }
  }

  if (!done && buffer.trim()) processBlock(buffer);
  return content;
}

module.exports = { consumeSse, parseSseBlock };

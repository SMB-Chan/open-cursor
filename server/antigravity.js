const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const FALLBACK_ALIASES = Object.freeze({
  pro: "gemini-3.1-pro-high",
  flash: "gemini-3.8-flash-high",
  flash_lite: "gemini-3.8-flash-medium",
  "flash-lite": "gemini-3.8-flash-medium",
});

function parseAntigravityModels(output) {
  const models = [];
  const seen = new Set();

  for (const rawLine of String(output || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const match = line.match(/^(\S+)\s+(.+)$/);
    if (!match) continue;

    const slug = match[1].trim();
    const name = match[2].trim();
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) continue;
    if (!name || /^(model|slug|name)$/i.test(slug)) continue;

    const key = slug.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    models.push({ slug, name });
  }

  return models;
}

function geminiVersion(model) {
  const match = String(model?.slug || "").match(/^gemini-(\d+)(?:\.(\d+))?/i);
  if (!match) return [-1, -1];
  return [Number(match[1]), Number(match[2] || 0)];
}

function effortRank(slug, preference) {
  const lower = String(slug || "").toLowerCase();
  const effort = lower.endsWith("-high")
    ? "high"
    : lower.endsWith("-medium")
      ? "medium"
      : lower.endsWith("-low")
        ? "low"
        : "unknown";
  const index = preference.indexOf(effort);
  return index === -1 ? preference.length : index;
}

function chooseGeminiVariant(models, family, preference) {
  const marker = `-${family}-`;
  const candidates = models
    .filter((model) => {
      const slug = String(model.slug || "").toLowerCase();
      return slug.startsWith("gemini-") && slug.includes(marker);
    })
    .slice()
    .sort((a, b) => {
      const [aMajor, aMinor] = geminiVersion(a);
      const [bMajor, bMinor] = geminiVersion(b);
      if (aMajor !== bMajor) return bMajor - aMajor;
      if (aMinor !== bMinor) return bMinor - aMinor;
      const effort = effortRank(a.slug, preference) - effortRank(b.slug, preference);
      if (effort !== 0) return effort;
      return String(a.slug).localeCompare(String(b.slug));
    });

  return candidates[0]?.slug;
}

function resolveAntigravityModel(requestedModel, models = []) {
  const requested = String(requestedModel || "").trim();
  if (!requested) return undefined;

  const lower = requested.toLowerCase();
  const exactSlug = models.find((model) => model.slug.toLowerCase() === lower);
  if (exactSlug) return exactSlug.slug;

  const exactName = models.find((model) => model.name.toLowerCase() === lower);
  if (exactName) return exactName.slug;

  if (lower === "pro") {
    return chooseGeminiVariant(models, "pro", ["high", "medium", "low"]) || FALLBACK_ALIASES.pro;
  }
  if (lower === "flash") {
    return chooseGeminiVariant(models, "flash", ["high", "medium", "low"]) || FALLBACK_ALIASES.flash;
  }
  if (lower === "flash_lite" || lower === "flash-lite") {
    return (
      chooseGeminiVariant(models, "flash", ["low", "medium", "high"]) ||
      FALLBACK_ALIASES[lower]
    );
  }

  // Custom model slugs are supported by Antigravity settings. Preserve unknown
  // explicit values and let the upstream CLI validate them.
  return requested;
}

function createAntigravityStreamParser({ onText, onEvent } = {}) {
  let buffer = "";
  let streamedText = "";
  let resultResponse = "";
  let resultStatus = null;
  let resultError = null;
  let resultSeen = false;
  let malformedLines = 0;

  const emitText = (text, event) => {
    if (typeof text !== "string" || text.length === 0) return;
    streamedText += text;
    onText?.(text, event);
  };

  const handleEvent = (event) => {
    onEvent?.(event);

    if (event?.event === "step_update") {
      const update = event.step_update;
      if (update?.step_type === "agent_response" && typeof update.text_delta === "string") {
        emitText(update.text_delta, event);
      }
      return;
    }

    if (event?.event !== "result") return;

    resultSeen = true;
    const result = event.result || {};
    resultStatus = typeof result.status === "string" ? result.status : null;
    resultError = typeof result.error === "string" ? result.error : null;
    resultResponse = typeof result.response === "string" ? result.response : "";

    // Some CLI versions may coalesce the final response into the result event.
    // Emit only a provably missing suffix so structured streaming never doubles text.
    if (resultResponse && !streamedText) {
      emitText(resultResponse, event);
    } else if (resultResponse.startsWith(streamedText) && resultResponse.length > streamedText.length) {
      emitText(resultResponse.slice(streamedText.length), event);
    }
  };

  const handleLine = (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handleEvent(JSON.parse(trimmed));
    } catch {
      malformedLines += 1;
    }
  };

  return {
    feed(chunk) {
      buffer += String(chunk || "");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
      }
    },
    finish() {
      if (buffer.trim()) handleLine(buffer);
      buffer = "";
      return {
        response: resultResponse || streamedText,
        streamedText,
        status: resultStatus,
        error: resultError,
        resultSeen,
        malformedLines,
      };
    },
    snapshot() {
      return {
        response: resultResponse || streamedText,
        streamedText,
        status: resultStatus,
        error: resultError,
        resultSeen,
        malformedLines,
      };
    },
  };
}

function isStructuredOutputUnsupported(result) {
  if (!result || result.code === 0) return false;
  const diagnostic = `${result.stderr || ""}\n${result.stdout || ""}`.toLowerCase();
  if (!diagnostic) return false;
  return (
    /(?:unknown|unrecognized|unsupported|invalid).{0,80}(?:output-format|stream-json)/s.test(diagnostic) ||
    /(?:output-format|stream-json).{0,80}(?:unknown|unrecognized|unsupported|invalid)/s.test(diagnostic)
  );
}

export {
  FALLBACK_ALIASES,
  MODEL_CACHE_TTL_MS,
  chooseGeminiVariant,
  createAntigravityStreamParser,
  isStructuredOutputUnsupported,
  parseAntigravityModels,
  resolveAntigravityModel,
};

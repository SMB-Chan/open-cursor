import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`migration anchor not found: ${label}`);
  return text.replace(from, to);
}

function update(path, transform) {
  const before = fs.readFileSync(path, "utf8");
  const after = transform(before);
  if (after === before) throw new Error(`migration produced no change: ${path}`);
  fs.writeFileSync(path, after);
}

update("server/engine.js", (input) => {
  let text = input;

  text = replaceOrFail(
    text,
    '  codex: {\n    name: "Codex (OpenAI/ChatGPT)",\n    authCheck: async () => {\n      try {',
    '  codex: {\n    name: "Codex (OpenAI/ChatGPT)",\n    authCheck: async () => {\n      if (["0", "false"].includes(String(process.env.CODEX_ENABLED || "1").toLowerCase())) return false;\n      try {',
    "codex enabled gate"
  );
  text = replaceOrFail(
    text,
    '  antigravity: {\n    name: "Antigravity (Gemini AI Pro)",\n    authCheck: async () => {\n      try {',
    '  antigravity: {\n    name: "Antigravity (Gemini AI Pro)",\n    authCheck: async () => {\n      if (["0", "false"].includes(String(process.env.AGY_ENABLED || "1").toLowerCase())) return false;\n      try {',
    "antigravity enabled gate"
  );
  text = replaceOrFail(
    text,
    '  mimo: {\n    name: "Xiaomi MiMo (mimo-v2.5-pro)",\n    authCheck: async () => {\n      const key = await getMiMoApiKey();\n      return Boolean(key);\n    },\n    strengths: ["code-generation", "fast-inference", "multilingual"],\n  },',
    '  mimo: {\n    name: "Xiaomi MiMo (mimo-v2.5-pro)",\n    authCheck: async () => {\n      if (["0", "false"].includes(String(process.env.MIMO_ENABLED || "1").toLowerCase())) return false;\n      const key = await getMiMoApiKey();\n      return Boolean(key);\n    },\n    strengths: ["solution-drafting", "fast-inference", "multilingual", "read-only"],\n  },',
    "mimo capability declaration"
  );

  text = replaceOrFail(
    text,
    'async function runMiMo(prompt, { model = "mimo-v2.5-pro", signal, onChunk } = {}) {',
    'async function runMiMo(prompt, { model = process.env.MIMO_MODEL || "mimo-v2.5-pro", signal, onChunk } = {}) {',
    "mimo default model"
  );
  text = replaceOrFail(
    text,
    '  const endpoint = "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions";',
    '  const endpoint = process.env.MIMO_ENDPOINT || "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions";',
    "mimo endpoint"
  );

  const oldAuto = `  const isAuto = !mode || mode === "auto";\n  const taskType = analyzeTask(prompt);\n  let selectedMode = isAuto ? taskType.routing : mode;\n\n  if (isAuto && (await AGENTS.mimo.authCheck())) {\n    if (selectedMode === "collaborative") {\n      selectedMode = "mimo-gemini";\n    } else if (selectedMode === "codex") {\n      selectedMode = "mimo";\n    }\n  }`;
  const newAuto = `  const isAuto = !mode || mode === "auto";\n  const taskType = analyzeTask(prompt);\n  let selectedMode = isAuto ? taskType.routing : mode;\n\n  if (isAuto) {\n    const availability = {\n      codex: await AGENTS.codex.authCheck(),\n      antigravity: await AGENTS.antigravity.authCheck(),\n      mimo: await AGENTS.mimo.authCheck(),\n    };\n    selectedMode = selectAutoMode(taskType, availability);\n  }`;
  text = replaceOrFail(text, oldAuto, newAuto, "auto mode resolution");

  const oldCodex = `    case "codex": {\n      try {\n        const result = await runCodex(prompt, {\n          cwd,\n          model,\n          signal,\n          onChunk: (text) => onEvent?.({ text, agent: "codex", phase: "response" }),\n        });\n        return requireSuccessfulAgent(result);\n      } catch (error) {\n        if (isAuto && (await AGENTS.mimo.authCheck())) {\n          emitHeader(\n            onEvent,\n            \`\\n\\n> ⚠️ [Codex利用不可のため、Xiaomi MiMoへ自動切り替えしました]\\n\\n\`,\n            "mimo",\n            "fallback"\n          );\n          const fallbackResult = await runMiMo(prompt, {\n            model: "mimo-v2.5-pro",\n            signal,\n            onChunk: (text) => onEvent?.({ text, agent: "mimo", phase: "response" }),\n          });\n          return requireSuccessfulAgent(fallbackResult);\n        }\n        throw error;\n      }\n    }`;
  const newCodex = `    case "codex": {\n      const result = await runCodex(prompt, {\n        cwd,\n        model,\n        signal,\n        onChunk: (text) => onEvent?.({ text, agent: "codex", phase: "response" }),\n      });\n      return requireSuccessfulAgent(result);\n    }`;
  text = replaceOrFail(text, oldCodex, newCodex, "unsafe codex fallback");

  text = replaceOrFail(text, "      if (!mode) {", "      if (isAuto) {", "detached auto analysis");

  const oldFallback = `      } catch (err) {\n        if (await AGENTS.mimo.authCheck()) {\n          emitHeader(\n            onEvent,\n            \`\\n\\n> ⚠️ [Codex利用不可のため、MiMo + Gemini 協調モードへ自動切り替えしました]\\n\\n\`,\n            "mimo-gemini",\n            "fallback"\n          );\n          return orchestrate(prompt, { cwd, mode: "mimo-gemini", model, signal, onEvent });\n        }\n        throw err;\n      }`;
  text = replaceOrFail(text, oldFallback, `      } catch (err) {\n        // Never retry a workspace-writing workflow through a response-only agent.\n        // Codex may already have changed files before a later stage failed.\n        throw err;\n      }`, "unsafe collaborative fallback");

  text = text.replaceAll("MiMo 実装・回答 (Implementation)", "MiMo 解決案 (Read-only Solution Draft)");
  text = text.replaceAll("# MiMo Implementation", "# MiMo Solution Draft");
  text = text.replaceAll("Review MiMo's implementation and response", "Review MiMo's read-only solution draft and response");
  text = replaceOrFail(
    text,
    '        "Please provide the complete implementation, code, or answer addressing the user\'s task, following Gemini\'s plan.",\n        "Write clean, production-ready code with clear explanations.",',
    '        "Provide a complete read-only solution draft, code proposal, or answer addressing the user\'s task, following Gemini\'s plan.",\n        "Do not claim that workspace files were changed or commands were executed.",\n        "Write clean, production-ready code proposals with clear explanations.",',
    "mimo read-only prompt"
  );

  const oldAnalyze = `function analyzeTask(prompt) {\n  const p = prompt.toLowerCase();\n\n  if (\n    /\\b(analyze|research|explain|review|audit|compare|survey|study|evaluate|investigate)\\b/.test(p) ||\n    /(分析|調査|説明|レビュー|監査|比較|検証|研究|評価|考察)/.test(prompt)\n  ) {\n    return { routing: "antigravity", reason: "analysis task" };\n  }\n\n  if (\n    /\\b(implement|create|build|write|fix|debug|refactor|deploy|patch|add)\\b/.test(p) ||\n    /(実装|作成|構築|修正|デバッグ|リファクタ|デプロイ|追加|直して|作って)/.test(prompt)\n  ) {\n    return { routing: "codex", reason: "implementation task" };\n  }\n\n  if (\n    prompt.length > 500 ||\n    /\\b(and then|after that|also|additionally|furthermore|continue)\\b/.test(p) ||\n    /(その後|さらに|加えて|続けて|続行)/.test(prompt)\n  ) {\n    return { routing: "collaborative", reason: "complex multi-step task" };\n  }\n\n  return { routing: "collaborative", reason: "general task" };\n}`;
  const newAnalyze = `function analyzeTask(prompt) {\n  const p = prompt.toLowerCase();\n  const hasAnalysis =\n    /\\b(analyze|research|explain|review|audit|compare|survey|study|evaluate|investigate|inspect|verify)\\b/.test(p) ||\n    /(分析|調査|説明|レビュー|監査|比較|検証|研究|評価|考察|確認)/.test(prompt);\n  const hasImplementation =\n    /\\b(implement|create|build|write|fix|debug|refactor|deploy|patch|add|edit|update|delete|remove|rename|migrate|upgrade|install|configure|merge)\\b/.test(p) ||\n    /(実装|作成|構築|修正|デバッグ|リファクタ|デプロイ|追加|直して|作って|編集|更新|削除|変更|移行|改善|導入|設定|統合)/.test(prompt);\n  const hasContinuation =\n    prompt.length > 500 ||\n    /\\b(and then|after that|also|additionally|furthermore|continue|proceed|carry on)\\b/.test(p) ||\n    /(その後|さらに|加えて|続けて|続行|続けよ|進めて)/.test(prompt);\n\n  if (hasImplementation && (hasAnalysis || hasContinuation)) {\n    return {\n      routing: "collaborative",\n      reason: "implementation + verification/continuation task",\n      kind: "complex-write",\n      requiresWorkspaceWrite: true,\n    };\n  }\n  if (hasImplementation) {\n    return { routing: "codex", reason: "implementation task", kind: "write", requiresWorkspaceWrite: true };\n  }\n  if (hasAnalysis) {\n    return { routing: "antigravity", reason: "analysis task", kind: "analysis", requiresWorkspaceWrite: false };\n  }\n  if (hasContinuation) {\n    return { routing: "collaborative", reason: "complex multi-step task", kind: "complex-write", requiresWorkspaceWrite: true };\n  }\n  return { routing: "antigravity", reason: "general read-only task", kind: "general", requiresWorkspaceWrite: false };\n}\n\nfunction selectAutoMode(taskType, availability) {\n  const { codex = false, antigravity = false, mimo = false } = availability || {};\n\n  if (taskType.requiresWorkspaceWrite) {\n    if (taskType.routing === "collaborative" && codex && antigravity) return "collaborative";\n    if (codex) return "codex";\n    throw new HttpError(503, "Auto routing requires a workspace-writing Codex agent for this task");\n  }\n\n  if (antigravity) return "antigravity";\n  if (mimo) return "mimo";\n  if (codex) return "codex";\n  throw new HttpError(503, "No available agent can safely handle this read-only task");\n}`;
  text = replaceOrFail(text, oldAnalyze, newAnalyze, "task classifier");

  text = replaceOrFail(
    text,
    "  runProcess,\n  stopActiveProcesses,",
    "  runProcess,\n  selectAutoMode,\n  stopActiveProcesses,",
    "selectAutoMode export"
  );
  return text;
});

update("server/index.js", (input) => {
  let text = input;
  text = replaceOrFail(
    text,
    `function requiredAgentsForMode(mode) {\n  if (mode === "codex") return ["codex"];\n  if (mode === "antigravity") return ["antigravity"];\n  if (mode === "pipeline" || mode === "collaborative") return ["codex", "antigravity"];\n  return [];\n}`,
    `function requiredAgentsForMode(mode) {\n  if (mode === "codex") return ["codex"];\n  if (mode === "antigravity") return ["antigravity"];\n  if (mode === "mimo") return ["mimo"];\n  if (mode === "mimo-gemini") return ["mimo", "antigravity"];\n  if (mode === "pipeline" || mode === "collaborative") return ["codex", "antigravity"];\n  return [];\n}`,
    "required agents"
  );
  text = text.replace(
    '  const configured = runtimeConfig.agents[key] || { enabled: true };',
    '  const configured = runtimeConfig.agents[key] || { enabled: false, strengths: [] };'
  );
  text = text.replace(
    'description: "MiMo + Gemini (協調モード: Gemini 計画/レビュー + MiMo 実装)",',
    'description: "MiMo + Gemini (read-only: Gemini plan/review + MiMo solution draft)",'
  );
  text = text.replace(
    'description: "Xiaomi MiMo (mimo-v2.5-pro)",',
    'description: "Xiaomi MiMo read-only response (mimo-v2.5-pro)",'
  );
  text = text.replace(
    '      strengths: runtimeConfig.agents[key].strengths,',
    '      strengths: runtimeConfig.agents[key]?.strengths || agent.strengths,\n      auth_mode: runtimeConfig.agents[key]?.authMode || "unknown",\n      billing: runtimeConfig.agents[key]?.billing || "unknown",\n      workspace_access: runtimeConfig.agents[key]?.workspaceAccess || (key === "mimo" ? "none" : "agent-controlled"),'
  );
  text = text.replace('    billing: "NONE",\n    auth: "subscription-only",', '    billing: "per-agent",\n    auth: "per-agent",');
  text = text.replace('    billing: "NONE",\n    execution:', '    billing: "per-agent",\n    execution:');
  text = text.replace('║            local · subscription-authenticated               ║', '║           local · per-agent authenticated                  ║');
  return text;
});

update("server/config.js", (input) => {
  let text = input;
  text = replaceOrFail(
    text,
    '  for (const name of ["codex", "antigravity"]) {',
    '  for (const name of ["codex", "antigravity"]) {',
    "agent validation anchor"
  );
  const anchor = `  const routing = raw.routing || {};`;
  const mimoValidation = `  const mimo = raw.agents?.mimo;\n  if (!mimo || typeof mimo !== "object") {\n    throw new RuntimeConfigError("agents.mimo is required");\n  }\n  if (typeof mimo.enabled !== "boolean") {\n    throw new RuntimeConfigError("agents.mimo.enabled must be boolean");\n  }\n  nonEmptyString(mimo.authMode, "agents.mimo.authMode");\n  nonEmptyString(mimo.billing, "agents.mimo.billing");\n  nonEmptyString(mimo.endpoint, "agents.mimo.endpoint");\n  nonEmptyString(mimo.model, "agents.mimo.model");\n  if (mimo.workspaceAccess !== "none") {\n    throw new RuntimeConfigError("agents.mimo.workspaceAccess must remain none");\n  }\n  if (!Array.isArray(mimo.strengths) || mimo.strengths.some((item) => typeof item !== "string")) {\n    throw new RuntimeConfigError("agents.mimo.strengths must be an array of strings");\n  }\n\n`;
  text = replaceOrFail(text, anchor, mimoValidation + anchor, "mimo validation");

  const beforeReturn = `  return Object.freeze({\n    source,`;
  const mimoParse = `  const mimo = {\n    ...raw.agents.mimo,\n    enabled: envBoolean(env, "MIMO_ENABLED", raw.agents.mimo.enabled, overrides),\n    endpoint: envString(env, "MIMO_ENDPOINT", raw.agents.mimo.endpoint, overrides),\n    model: envString(env, "MIMO_MODEL", raw.agents.mimo.model, overrides),\n    workspaceAccess: "none",\n  };\n\n`;
  text = replaceOrFail(text, beforeReturn, mimoParse + beforeReturn, "mimo runtime config");
  text = replaceOrFail(
    text,
    '      antigravity: Object.freeze({ ...raw.agents.antigravity, binary: antigravityBinary }),\n    }),',
    '      antigravity: Object.freeze({ ...raw.agents.antigravity, binary: antigravityBinary }),\n      mimo: Object.freeze(mimo),\n    }),',
    "mimo runtime agent"
  );
  text = replaceOrFail(
    text,
    '    CODEX_BIN: config.agents.codex.binary,\n    AGY_BIN: config.agents.antigravity.binary,',
    '    CODEX_BIN: config.agents.codex.binary,\n    AGY_BIN: config.agents.antigravity.binary,\n    CODEX_ENABLED: config.agents.codex.enabled ? "1" : "0",\n    AGY_ENABLED: config.agents.antigravity.enabled ? "1" : "0",\n    MIMO_ENABLED: config.agents.mimo.enabled ? "1" : "0",\n    MIMO_ENDPOINT: config.agents.mimo.endpoint,\n    MIMO_MODEL: config.agents.mimo.model,',
    "runtime env projection"
  );
  return text;
});

const bridgePath = "config/bridge.json";
const bridge = JSON.parse(fs.readFileSync(bridgePath, "utf8"));
bridge.agents.mimo = {
  enabled: true,
  authMode: "api-key",
  billing: "external-token-plan",
  endpoint: "https://token-plan-sgp.xiaomimimo.com/v1/chat/completions",
  model: "mimo-v2.5-pro",
  workspaceAccess: "none",
  strengths: ["solution-drafting", "fast-inference", "multilingual", "read-only"],
};
fs.writeFileSync(bridgePath, JSON.stringify(bridge, null, 2) + "\n");

const schemaPath = "config/config.schema.json";
const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
schema.properties.agents.required = ["codex", "antigravity", "mimo"];
schema.properties.agents.properties.mimo = { "$ref": "#/$defs/remoteAgent" };
schema.$defs.remoteAgent = {
  type: "object",
  additionalProperties: false,
  required: ["enabled", "authMode", "billing", "endpoint", "model", "workspaceAccess", "strengths"],
  properties: {
    enabled: { type: "boolean" },
    authMode: { type: "string", minLength: 1 },
    billing: { type: "string", minLength: 1 },
    endpoint: { type: "string", minLength: 1 },
    model: { type: "string", minLength: 1 },
    workspaceAccess: { const: "none" },
    strengths: { type: "array", items: { type: "string", minLength: 1 }, uniqueItems: true },
  },
};
fs.writeFileSync(schemaPath, JSON.stringify(schema, null, 2) + "\n");

const packagePath = "server/package.json";
const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
pkg.scripts.check = pkg.scripts.check.replace("engine.test.js", "engine.test.js routing-safety.test.js");
pkg.scripts.test = pkg.scripts.test.replace("engine.test.js", "engine.test.js routing-safety.test.js");
fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2) + "\n");

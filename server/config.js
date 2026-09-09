import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG_PATH = resolve(SERVER_DIR, "../config/bridge.json");

class RuntimeConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

function integer(value, label, min, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RuntimeConfigError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new RuntimeConfigError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function exactArray(value, expected, label) {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    expected.some((item, index) => value[index] !== item)
  ) {
    throw new RuntimeConfigError(`${label} must be exactly: ${expected.join(" -> ")}`);
  }
}

function envInteger(env, name, fallback, min, max = Number.MAX_SAFE_INTEGER, overrides) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(raw).trim() || parsed < min || parsed > max) {
    throw new RuntimeConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  overrides.push(name);
  return parsed;
}

function envString(env, name, fallback, overrides) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  overrides.push(name);
  return raw;
}

function envBoolean(env, name, fallback, overrides) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const normalized = String(raw).toLowerCase();
  if (normalized === "1" || normalized === "true") {
    overrides.push(name);
    return true;
  }
  if (normalized === "0" || normalized === "false") {
    overrides.push(name);
    return false;
  }
  throw new RuntimeConfigError(`${name} must be one of: 1, 0, true, false`);
}

function expandHome(value, home = homedir()) {
  const text = String(value || "");
  if (text === "~") return home;
  if (text.startsWith("~/")) return resolve(home, text.slice(2));
  return text;
}

function validateRawConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuntimeConfigError("bridge configuration must be a JSON object");
  }

  const bridge = raw.bridge || {};
  integer(bridge.port, "bridge.port", 1, 65535);
  nonEmptyString(bridge.host, "bridge.host");
  if (typeof bridge.allowRemote !== "boolean") {
    throw new RuntimeConfigError("bridge.allowRemote must be boolean");
  }

  const execution = raw.execution || {};
  integer(execution.agentTimeoutMs, "execution.agentTimeoutMs", 1000);
  integer(execution.killGraceMs, "execution.killGraceMs", 100);
  integer(execution.maxBodyBytes, "execution.maxBodyBytes", 1024);
  integer(execution.maxOutputBytes, "execution.maxOutputBytes", 1024);
  if (!["off", "auto", "bubblewrap"].includes(execution.reviewerSandbox)) {
    throw new RuntimeConfigError(
      "execution.reviewerSandbox must be one of: off, auto, bubblewrap"
    );
  }

  const context = raw.context || {};
  integer(context.maxFiles, "context.maxFiles", 10, 5000);
  integer(context.maxBytes, "context.maxBytes", 4096, 2 * 1024 * 1024);
  integer(context.maxFileBytes, "context.maxFileBytes", 1024, 256 * 1024);
  integer(context.diffMaxBytes, "context.diffMaxBytes", 4096, 2 * 1024 * 1024);
  integer(context.untrackedMaxBytes, "context.untrackedMaxBytes", 0, 1024 * 1024);
  if (context.omitSecretLikePaths !== true) {
    throw new RuntimeConfigError("context.omitSecretLikePaths must remain true");
  }

  const collaboration = raw.collaboration || {};
  exactArray(collaboration.pipeline, ["plan", "implement"], "collaboration.pipeline");
  exactArray(
    collaboration.collaborative,
    ["plan", "implement", "review", "refine"],
    "collaboration.collaborative"
  );
  integer(collaboration.maxReviewCycles, "collaboration.maxReviewCycles", 1, 4);
  if (collaboration.workspaceWriter !== "codex") {
    throw new RuntimeConfigError("collaboration.workspaceWriter must be codex");
  }
  if (collaboration.reviewerWorkingDirectory !== "detached-temporary") {
    throw new RuntimeConfigError(
      "collaboration.reviewerWorkingDirectory must be detached-temporary"
    );
  }

  for (const name of ["codex", "antigravity"]) {
    const agent = raw.agents?.[name];
    if (!agent || typeof agent !== "object") {
      throw new RuntimeConfigError(`agents.${name} is required`);
    }
    if (typeof agent.enabled !== "boolean") {
      throw new RuntimeConfigError(`agents.${name}.enabled must be boolean`);
    }
    nonEmptyString(agent.binary, `agents.${name}.binary`);
    if (!Array.isArray(agent.strengths) || agent.strengths.some((item) => typeof item !== "string")) {
      throw new RuntimeConfigError(`agents.${name}.strengths must be an array of strings`);
    }
  }

  const mimo = raw.agents?.mimo;
  if (!mimo || typeof mimo !== "object") {
    throw new RuntimeConfigError("agents.mimo is required");
  }
  if (typeof mimo.enabled !== "boolean") {
    throw new RuntimeConfigError("agents.mimo.enabled must be boolean");
  }
  nonEmptyString(mimo.authMode, "agents.mimo.authMode");
  nonEmptyString(mimo.billing, "agents.mimo.billing");
  nonEmptyString(mimo.endpoint, "agents.mimo.endpoint");
  nonEmptyString(mimo.model, "agents.mimo.model");
  if (mimo.workspaceAccess !== "none") {
    throw new RuntimeConfigError("agents.mimo.workspaceAccess must remain none");
  }
  if (!Array.isArray(mimo.strengths) || mimo.strengths.some((item) => typeof item !== "string")) {
    throw new RuntimeConfigError("agents.mimo.strengths must be an array of strings");
  }

  const routing = raw.routing || {};
  if (!["collaborative", "pipeline", "codex", "antigravity"].includes(routing.default)) {
    throw new RuntimeConfigError("routing.default is invalid");
  }

  return raw;
}

function parseReviewerSandboxEnv(env, overrides, fallback) {
  const raw = envString(env, "BRIDGE_REVIEWER_SANDBOX", fallback, overrides);
  if (!["off", "auto", "bubblewrap"].includes(raw)) {
    throw new RuntimeConfigError("BRIDGE_REVIEWER_SANDBOX must be one of: off, auto, bubblewrap");
  }
  return raw;
}

function parseRuntimeConfig(raw, env = process.env, home = homedir(), source = DEFAULT_CONFIG_PATH) {
  validateRawConfig(raw);
  const overrides = [];

  const bridge = {
    port: envInteger(env, "BRIDGE_PORT", raw.bridge.port, 1, 65535, overrides),
    host: envString(env, "BRIDGE_HOST", raw.bridge.host, overrides),
    allowRemote: envBoolean(env, "BRIDGE_ALLOW_REMOTE", raw.bridge.allowRemote, overrides),
  };

  const execution = {
    agentTimeoutMs: envInteger(
      env,
      "BRIDGE_AGENT_TIMEOUT_MS",
      raw.execution.agentTimeoutMs,
      1000,
      Number.MAX_SAFE_INTEGER,
      overrides
    ),
    killGraceMs: envInteger(
      env,
      "BRIDGE_KILL_GRACE_MS",
      raw.execution.killGraceMs,
      100,
      Number.MAX_SAFE_INTEGER,
      overrides
    ),
    maxBodyBytes: envInteger(
      env,
      "BRIDGE_MAX_BODY_BYTES",
      raw.execution.maxBodyBytes,
      1024,
      Number.MAX_SAFE_INTEGER,
      overrides
    ),
    maxOutputBytes: envInteger(
      env,
      "BRIDGE_MAX_OUTPUT_BYTES",
      raw.execution.maxOutputBytes,
      1024,
      Number.MAX_SAFE_INTEGER,
      overrides
    ),
    reviewerSandbox: parseReviewerSandboxEnv(env, overrides, raw.execution.reviewerSandbox),
  };

  const context = {
    maxFiles: envInteger(
      env,
      "BRIDGE_CONTEXT_MAX_FILES",
      raw.context.maxFiles,
      10,
      5000,
      overrides
    ),
    maxBytes: envInteger(
      env,
      "BRIDGE_CONTEXT_MAX_BYTES",
      raw.context.maxBytes,
      4096,
      2 * 1024 * 1024,
      overrides
    ),
    maxFileBytes: envInteger(
      env,
      "BRIDGE_CONTEXT_FILE_BYTES",
      raw.context.maxFileBytes,
      1024,
      256 * 1024,
      overrides
    ),
    diffMaxBytes: envInteger(
      env,
      "BRIDGE_DIFF_MAX_BYTES",
      raw.context.diffMaxBytes,
      4096,
      2 * 1024 * 1024,
      overrides
    ),
    untrackedMaxBytes: envInteger(
      env,
      "BRIDGE_UNTRACKED_MAX_BYTES",
      raw.context.untrackedMaxBytes,
      0,
      1024 * 1024,
      overrides
    ),
    omitSecretLikePaths: true,
  };

  const codexBinary = expandHome(
    envString(env, "CODEX_BIN", raw.agents.codex.binary, overrides),
    home
  );
  const antigravityBinary = expandHome(
    envString(env, "AGY_BIN", raw.agents.antigravity.binary, overrides),
    home
  );

  const mimo = {
    ...raw.agents.mimo,
    enabled: envBoolean(env, "MIMO_ENABLED", raw.agents.mimo.enabled, overrides),
    endpoint: envString(env, "MIMO_ENDPOINT", raw.agents.mimo.endpoint, overrides),
    model: envString(env, "MIMO_MODEL", raw.agents.mimo.model, overrides),
    workspaceAccess: "none",
  };

  // Built before the frozen result so environment-override bookkeeping for the
  // review-loop bound is recorded in the same overrides list as every other knob.
  const collaboration = {
    pipeline: Object.freeze([...raw.collaboration.pipeline]),
    collaborative: Object.freeze([...raw.collaboration.collaborative]),
    reviewerWorkingDirectory: raw.collaboration.reviewerWorkingDirectory,
    workspaceWriter: raw.collaboration.workspaceWriter,
    maxReviewCycles: envInteger(
      env,
      "BRIDGE_MAX_REVIEW_CYCLES",
      raw.collaboration.maxReviewCycles,
      1,
      4,
      overrides
    ),
  };

  return Object.freeze({
    source,
    overrides: Object.freeze([...new Set(overrides)]),
    bridge: Object.freeze(bridge),
    execution: Object.freeze(execution),
    context: Object.freeze(context),
    collaboration: Object.freeze(collaboration),
    agents: Object.freeze({
      codex: Object.freeze({ ...raw.agents.codex, binary: codexBinary }),
      antigravity: Object.freeze({ ...raw.agents.antigravity, binary: antigravityBinary }),
      mimo: Object.freeze(mimo),
    }),
    routing: Object.freeze({
      default: raw.routing.default,
      rules: Object.freeze({ ...raw.routing.rules }),
      languages: Object.freeze([...(raw.routing.languages || [])]),
    }),
  });
}

function applyRuntimeDefaultsToEnv(config, env = process.env) {
  const defaults = {
    BRIDGE_PORT: config.bridge.port,
    BRIDGE_HOST: config.bridge.host,
    BRIDGE_ALLOW_REMOTE: config.bridge.allowRemote ? "1" : "0",
    BRIDGE_AGENT_TIMEOUT_MS: config.execution.agentTimeoutMs,
    BRIDGE_KILL_GRACE_MS: config.execution.killGraceMs,
    BRIDGE_MAX_BODY_BYTES: config.execution.maxBodyBytes,
    BRIDGE_MAX_OUTPUT_BYTES: config.execution.maxOutputBytes,
    BRIDGE_REVIEWER_SANDBOX: config.execution.reviewerSandbox,
    BRIDGE_CONTEXT_MAX_FILES: config.context.maxFiles,
    BRIDGE_CONTEXT_MAX_BYTES: config.context.maxBytes,
    BRIDGE_CONTEXT_FILE_BYTES: config.context.maxFileBytes,
    BRIDGE_DIFF_MAX_BYTES: config.context.diffMaxBytes,
    BRIDGE_UNTRACKED_MAX_BYTES: config.context.untrackedMaxBytes,
    CODEX_BIN: config.agents.codex.binary,
    AGY_BIN: config.agents.antigravity.binary,
    CODEX_ENABLED: config.agents.codex.enabled ? "1" : "0",
    AGY_ENABLED: config.agents.antigravity.enabled ? "1" : "0",
    MIMO_ENABLED: config.agents.mimo.enabled ? "1" : "0",
    MIMO_ENDPOINT: config.agents.mimo.endpoint,
    MIMO_MODEL: config.agents.mimo.model,
  };

  for (const [name, value] of Object.entries(defaults)) {
    if (env[name] === undefined || env[name] === "") env[name] = String(value);
  }
  return env;
}

function loadRuntimeConfig({ env = process.env, home = homedir(), path } = {}) {
  const configPath = path || env.BRIDGE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  if (!existsSync(configPath)) {
    throw new RuntimeConfigError(`runtime configuration not found: ${configPath}`);
  }

  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new RuntimeConfigError(`failed to parse runtime configuration ${configPath}: ${error.message}`);
  }

  return parseRuntimeConfig(raw, env, home, configPath);
}

const runtimeConfig = loadRuntimeConfig();
applyRuntimeDefaultsToEnv(runtimeConfig);

export {
  DEFAULT_CONFIG_PATH,
  RuntimeConfigError,
  applyRuntimeDefaultsToEnv,
  expandHome,
  loadRuntimeConfig,
  parseRuntimeConfig,
  runtimeConfig,
  validateRawConfig,
};

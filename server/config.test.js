import test from "node:test";
import assert from "node:assert/strict";

import {
  RuntimeConfigError,
  applyRuntimeDefaultsToEnv,
  expandHome,
  parseRuntimeConfig,
  validateRawConfig,
} from "./config.js";

function sampleConfig() {
  return {
    bridge: { port: 9876, host: "127.0.0.1", allowRemote: false },
    execution: {
      agentTimeoutMs: 600000,
      killGraceMs: 1500,
      maxBodyBytes: 1048576,
      maxOutputBytes: 8388608,
    },
    context: {
      maxFiles: 300,
      maxBytes: 131072,
      maxFileBytes: 12288,
      diffMaxBytes: 98304,
      omitSecretLikePaths: true,
    },
    collaboration: {
      pipeline: ["plan", "implement"],
      collaborative: ["plan", "implement", "review", "refine"],
      reviewerWorkingDirectory: "detached-temporary",
      workspaceWriter: "codex",
    },
    agents: {
      codex: {
        enabled: true,
        binary: "codex",
        authMode: "chatgpt",
        billing: "NONE",
        strengths: ["code-generation"],
      },
      antigravity: {
        enabled: true,
        binary: "~/bin/agy",
        authMode: "google-oauth",
        billing: "NONE",
        useG1Credits: false,
        strengths: ["analysis"],
      },
      mimo: {
        enabled: true,
        authMode: "api-key",
        billing: "external-token-plan",
        endpoint: "https://example.invalid/v1/chat/completions",
        model: "mimo-v2.5-pro",
        workspaceAccess: "none",
        strengths: ["solution-drafting", "read-only"],
      },
    },
    routing: {
      default: "collaborative",
      rules: { analysis: "antigravity", implementation: "codex" },
      languages: ["en", "ja"],
    },
  };
}

test("configuration file provides runtime defaults", () => {
  const parsed = parseRuntimeConfig(sampleConfig(), {}, "/home/demo", "/tmp/bridge.json");

  assert.equal(parsed.bridge.port, 9876);
  assert.equal(parsed.bridge.host, "127.0.0.1");
  assert.equal(parsed.bridge.allowRemote, false);
  assert.equal(parsed.execution.agentTimeoutMs, 600000);
  assert.equal(parsed.context.maxBytes, 131072);
  assert.equal(parsed.agents.antigravity.binary, "/home/demo/bin/agy");
  assert.equal(parsed.agents.mimo.workspaceAccess, "none");
  assert.equal(parsed.agents.mimo.model, "mimo-v2.5-pro");
  assert.deepEqual(parsed.overrides, []);
});

test("environment variables override file values and are reported by name only", () => {
  const parsed = parseRuntimeConfig(
    sampleConfig(),
    {
      BRIDGE_PORT: "9999",
      BRIDGE_AGENT_TIMEOUT_MS: "120000",
      BRIDGE_CONTEXT_MAX_FILES: "500",
      BRIDGE_ALLOW_REMOTE: "1",
      AGY_BIN: "/opt/agy",
      MIMO_ENABLED: "0",
      MIMO_ENDPOINT: "https://mimo.example/v1/chat/completions",
      MIMO_MODEL: "mimo-next",
    },
    "/home/demo"
  );

  assert.equal(parsed.bridge.port, 9999);
  assert.equal(parsed.bridge.allowRemote, true);
  assert.equal(parsed.execution.agentTimeoutMs, 120000);
  assert.equal(parsed.context.maxFiles, 500);
  assert.equal(parsed.agents.antigravity.binary, "/opt/agy");
  assert.equal(parsed.agents.mimo.enabled, false);
  assert.equal(parsed.agents.mimo.endpoint, "https://mimo.example/v1/chat/completions");
  assert.equal(parsed.agents.mimo.model, "mimo-next");
  assert.deepEqual(
    new Set(parsed.overrides),
    new Set([
      "BRIDGE_PORT",
      "BRIDGE_AGENT_TIMEOUT_MS",
      "BRIDGE_CONTEXT_MAX_FILES",
      "BRIDGE_ALLOW_REMOTE",
      "AGY_BIN",
      "MIMO_ENABLED",
      "MIMO_ENDPOINT",
      "MIMO_MODEL",
    ])
  );
});

test("invalid environment overrides fail instead of silently falling back", () => {
  assert.throws(
    () => parseRuntimeConfig(sampleConfig(), { BRIDGE_PORT: "9876junk" }),
    (error) => error instanceof RuntimeConfigError && /BRIDGE_PORT/.test(error.message)
  );
  assert.throws(
    () => parseRuntimeConfig(sampleConfig(), { MIMO_ENABLED: "maybe" }),
    (error) => error instanceof RuntimeConfigError && /MIMO_ENABLED/.test(error.message)
  );
});

test("goal loop environment is validated at configuration load and reported", () => {
  assert.deepEqual(parseRuntimeConfig(sampleConfig(), {}).goal, {
    maxRounds: 8, roundTimeoutMs: 600000,
  });
  const parsed = parseRuntimeConfig(sampleConfig(), {
    BRIDGE_GOAL_MAX_ROUNDS: "3", BRIDGE_GOAL_ROUND_TIMEOUT_MS: "12000",
  });
  assert.deepEqual(parsed.goal, { maxRounds: 3, roundTimeoutMs: 12000 });
  assert.ok(Object.isFrozen(parsed.goal));
  assert.deepEqual(parsed.overrides, ["BRIDGE_GOAL_MAX_ROUNDS", "BRIDGE_GOAL_ROUND_TIMEOUT_MS"]);
  for (const [name, values] of [
    ["BRIDGE_GOAL_MAX_ROUNDS", ["0", "33", "4junk", "2.5", "NaN", "Infinity"]],
    ["BRIDGE_GOAL_ROUND_TIMEOUT_MS", ["999", "3600001", "1000ms", "1000.5", "NaN", "Infinity"]],
  ]) {
    for (const value of values) {
      assert.throws(() => parseRuntimeConfig(sampleConfig(), { [name]: value }),
        (error) => error instanceof RuntimeConfigError && error.message.includes(name));
    }
  }
});

test("runtime defaults populate missing process environment without replacing overrides", () => {
  const parsed = parseRuntimeConfig(sampleConfig(), {}, "/home/demo");
  const env = { BRIDGE_PORT: "7777" };

  applyRuntimeDefaultsToEnv(parsed, env);

  assert.equal(env.BRIDGE_PORT, "7777");
  assert.equal(env.BRIDGE_HOST, "127.0.0.1");
  assert.equal(env.BRIDGE_ALLOW_REMOTE, "0");
  assert.equal(env.BRIDGE_AGENT_TIMEOUT_MS, "600000");
  assert.equal(env.BRIDGE_CONTEXT_MAX_BYTES, "131072");
  assert.equal(env.CODEX_BIN, "codex");
  assert.equal(env.AGY_BIN, "/home/demo/bin/agy");
  assert.equal(env.CODEX_ENABLED, "1");
  assert.equal(env.AGY_ENABLED, "1");
  assert.equal(env.MIMO_ENABLED, "1");
  assert.equal(env.MIMO_ENDPOINT, "https://example.invalid/v1/chat/completions");
  assert.equal(env.MIMO_MODEL, "mimo-v2.5-pro");
});

test("security and collaboration invariants cannot be weakened", () => {
  const secretsDisabled = sampleConfig();
  secretsDisabled.context.omitSecretLikePaths = false;
  assert.throws(
    () => validateRawConfig(secretsDisabled),
    (error) => error instanceof RuntimeConfigError && /omitSecretLikePaths/.test(error.message)
  );

  const competingWriter = sampleConfig();
  competingWriter.collaboration.workspaceWriter = "antigravity";
  assert.throws(
    () => validateRawConfig(competingWriter),
    (error) => error instanceof RuntimeConfigError && /workspaceWriter/.test(error.message)
  );

  const parallelized = sampleConfig();
  parallelized.collaboration.collaborative = ["plan", "review", "implement", "refine"];
  assert.throws(
    () => validateRawConfig(parallelized),
    (error) => error instanceof RuntimeConfigError && /collaboration\.collaborative/.test(error.message)
  );

  const remoteWriter = sampleConfig();
  remoteWriter.agents.mimo.workspaceAccess = "write";
  assert.throws(
    () => validateRawConfig(remoteWriter),
    (error) => error instanceof RuntimeConfigError && /workspaceAccess/.test(error.message)
  );
});

test("home expansion is deterministic", () => {
  assert.equal(expandHome("~/bin/tool", "/home/demo"), "/home/demo/bin/tool");
  assert.equal(expandHome("tool", "/home/demo"), "tool");
});

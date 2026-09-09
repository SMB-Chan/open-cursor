import test from "node:test";
import assert from "node:assert/strict";

import {
  RuntimeConfigError,
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
    },
    "/home/demo"
  );

  assert.equal(parsed.bridge.port, 9999);
  assert.equal(parsed.bridge.allowRemote, true);
  assert.equal(parsed.execution.agentTimeoutMs, 120000);
  assert.equal(parsed.context.maxFiles, 500);
  assert.equal(parsed.agents.antigravity.binary, "/opt/agy");
  assert.deepEqual(
    new Set(parsed.overrides),
    new Set([
      "BRIDGE_PORT",
      "BRIDGE_AGENT_TIMEOUT_MS",
      "BRIDGE_CONTEXT_MAX_FILES",
      "BRIDGE_ALLOW_REMOTE",
      "AGY_BIN",
    ])
  );
});

test("invalid environment overrides fail instead of silently falling back", () => {
  assert.throws(
    () => parseRuntimeConfig(sampleConfig(), { BRIDGE_PORT: "not-a-port" }),
    (error) => error instanceof RuntimeConfigError && /BRIDGE_PORT/.test(error.message)
  );
});

test("security invariants cannot be disabled in configuration", () => {
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
});

test("home expansion is deterministic", () => {
  assert.equal(expandHome("~/bin/tool", "/home/demo"), "/home/demo/bin/tool");
  assert.equal(expandHome("tool", "/home/demo"), "tool");
});

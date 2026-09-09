import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { HttpError, analyzeTask, selectAutoMode } from "./engine.js";
import { parseRuntimeConfig } from "./config.js";
import { requiredAgentsForMode } from "./index.js";

test("implementation tasks never auto-route to response-only MiMo", () => {
  const task = analyzeTask("Implement the parser fix");
  assert.equal(task.requiresWorkspaceWrite, true);
  assert.equal(task.routing, "codex");
  assert.equal(
    selectAutoMode(task, { codex: true, antigravity: true, mimo: true }),
    "codex"
  );
});

test("review plus fix is treated as a write-capable collaborative task", () => {
  const task = analyzeTask("Review the parser and fix any regressions");
  assert.equal(task.requiresWorkspaceWrite, true);
  assert.equal(task.routing, "collaborative");
  assert.equal(
    selectAutoMode(task, { codex: true, antigravity: true, mimo: true }),
    "collaborative"
  );
});

test("Japanese review plus correction requires a workspace writer", () => {
  const task = analyzeTask("コードを監査して問題を修正せよ");
  assert.equal(task.requiresWorkspaceWrite, true);
  assert.equal(task.routing, "collaborative");
});

test("continuation requests remain writer-capable", () => {
  const task = analyzeTask("続行せよ");
  assert.equal(task.requiresWorkspaceWrite, true);
  assert.equal(task.routing, "collaborative");
});

test("read-only analysis may fall back to MiMo only when Gemini is unavailable", () => {
  const task = analyzeTask("Analyze the architecture and explain the risks");
  assert.equal(task.requiresWorkspaceWrite, false);
  assert.equal(
    selectAutoMode(task, { codex: true, antigravity: true, mimo: true }),
    "antigravity"
  );
  assert.equal(
    selectAutoMode(task, { codex: true, antigravity: false, mimo: true }),
    "mimo"
  );
});

test("general Auto requests use a read-only path by default", () => {
  const task = analyzeTask("What does this project do?");
  assert.equal(task.requiresWorkspaceWrite, false);
  assert.equal(task.routing, "antigravity");
});

test("Auto refuses to fake a workspace implementation when Codex is unavailable", () => {
  const task = analyzeTask("Fix the failing tests");
  assert.throws(
    () => selectAutoMode(task, { codex: false, antigravity: true, mimo: true }),
    (error) => error instanceof HttpError && error.statusCode === 503
  );
});

test("complex write tasks degrade to Codex rather than response-only MiMo", () => {
  const task = analyzeTask("Implement the fix and then verify it");
  assert.equal(
    selectAutoMode(task, { codex: true, antigravity: false, mimo: true }),
    "codex"
  );
});

test("configured analysis rule participates in auto routing with capability fallback", () => {
  process.env.BRIDGE_ROUTING_RULE_ANALYSIS = "mimo-gemini";
  try {
    const task = analyzeTask("Analyze the architecture and explain the risks");
    assert.equal(task.routing, "mimo-gemini");
    assert.equal(task.requiresWorkspaceWrite, false);
    assert.equal(
      selectAutoMode(task, { codex: true, antigravity: true, mimo: true }),
      "mimo-gemini"
    );
    // MiMo unavailable: degrade inside the read-only set instead of losing the preference.
    assert.equal(
      selectAutoMode(task, { codex: true, antigravity: true, mimo: false }),
      "antigravity"
    );
  } finally {
    delete process.env.BRIDGE_ROUTING_RULE_ANALYSIS;
  }
});

test("implementation tasks honor a configured multi-agent route when writers exist", () => {
  process.env.BRIDGE_ROUTING_RULE_IMPLEMENTATION = "collaborative";
  process.env.BRIDGE_ROUTING_RULE_COMPLEX_MULTI_STEP = "pipeline";
  try {
    const write = analyzeTask("Implement the parser fix");
    assert.equal(write.routing, "collaborative");
    assert.equal(
      selectAutoMode(write, { codex: true, antigravity: true, mimo: false }),
      "collaborative"
    );
    // Gemini unavailable: the workflow degrades to the writer instead of failing the task.
    assert.equal(
      selectAutoMode(write, { codex: true, antigravity: false, mimo: true }),
      "codex"
    );

    const complex = analyzeTask("続行せよ");
    assert.equal(complex.routing, "pipeline");
    assert.equal(
      selectAutoMode(complex, { codex: true, antigravity: true, mimo: false }),
      "pipeline"
    );
  } finally {
    delete process.env.BRIDGE_ROUTING_RULE_IMPLEMENTATION;
    delete process.env.BRIDGE_ROUTING_RULE_COMPLEX_MULTI_STEP;
  }
});

test("engine-level defense: response-only rules can never route write tasks", () => {
  // Runtime configuration rejects these values at startup; this proves the
  // engine keeps the invariant even if a non-managed process bypassed it.
  process.env.BRIDGE_ROUTING_RULE_IMPLEMENTATION = "mimo";
  process.env.BRIDGE_ROUTING_RULE_COMPLEX_MULTI_STEP = "mimo-gemini";
  try {
    const write = analyzeTask("Implement the parser fix");
    assert.equal(write.routing, "codex");
    const complex = analyzeTask("Implement the fix and then verify it");
    assert.equal(complex.routing, "collaborative");
    assert.equal(
      selectAutoMode(complex, { codex: true, antigravity: true, mimo: true }),
      "collaborative"
    );
  } finally {
    delete process.env.BRIDGE_ROUTING_RULE_IMPLEMENTATION;
    delete process.env.BRIDGE_ROUTING_RULE_COMPLEX_MULTI_STEP;
  }
});

test("autonomous remains explicit-selection only for auto rules", () => {
  process.env.BRIDGE_ROUTING_RULE_GENERAL = "autonomous";
  try {
    // The engine ignores an autonomous auto rule: autonomous is never auto-selected.
    const task = analyzeTask("What does this project do?");
    assert.equal(task.routing, "antigravity");
    assert.equal(
      selectAutoMode({ ...task, routing: "autonomous" }, { codex: true, antigravity: true, mimo: true }),
      "antigravity"
    );
  } finally {
    delete process.env.BRIDGE_ROUTING_RULE_GENERAL;
  }
});

test("runtime config declares MiMo as remote read-only and configurable", () => {
  const raw = JSON.parse(
    readFileSync(resolve(process.cwd(), "../config/bridge.json"), "utf8")
  );
  const config = parseRuntimeConfig(raw, {}, "/tmp/open-cursor-test-home", "test-config");
  assert.equal(config.agents.mimo.workspaceAccess, "none");
  assert.equal(config.agents.mimo.authMode, "api-key");
  assert.equal(config.agents.mimo.billing, "external-token-plan");
  assert.match(config.agents.mimo.endpoint, /^https:\/\//);
});

test("explicit MiMo modes participate in runtime enablement checks", () => {
  assert.deepEqual(requiredAgentsForMode("mimo"), ["mimo"]);
  assert.deepEqual(requiredAgentsForMode("mimo-gemini"), ["mimo", "antigravity"]);
});

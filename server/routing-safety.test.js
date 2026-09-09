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

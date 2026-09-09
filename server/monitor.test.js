import test from "node:test";
import assert from "node:assert/strict";
import {
  getExecutionState,
  updateExecutionState,
  getLLMStatus,
  getWorkspaceStatus,
  getMonitorData,
} from "./monitor.js";

test("updateExecutionState updates in-memory state and prepends recent steps", () => {
  updateExecutionState({
    active: true,
    agent: "antigravity",
    mode: "autonomous",
    step: 1,
    currentAction: "Web調査",
    targetFile: "timetable.html",
    newStep: {
      step: 1,
      action: "Web調査",
      file: "timetable.html",
      timestamp: Date.now(),
    },
  });

  const state = getExecutionState();
  assert.equal(state.active, true);
  assert.equal(state.agent, "antigravity");
  assert.equal(state.mode, "autonomous");
  assert.equal(state.step, 1);
  assert.equal(state.targetFile, "timetable.html");
  assert.ok(state.recentSteps.length >= 1);
  assert.equal(state.recentSteps[0].action, "Web調査");
});

test("getLLMStatus reports all three providers and quota types", async () => {
  const llm = await getLLMStatus();
  assert.ok(llm.codex);
  assert.ok(llm.antigravity);
  assert.ok(llm.mimo);

  assert.equal(llm.codex.status, "READY");
  assert.match(llm.codex.billing, /定額サブスク/);
  assert.equal(llm.antigravity.status, "READY");
  assert.match(llm.antigravity.billing, /定額サブスク/);
  assert.equal(llm.mimo.status, "READY");
});

test("getWorkspaceStatus identifies directory files and git details", async () => {
  const ws = await getWorkspaceStatus(process.cwd());
  assert.ok(ws.workspacePath);
  assert.ok(ws.workspaceName);
  assert.ok(Array.isArray(ws.modifiedFiles));
  assert.ok(Array.isArray(ws.recentFiles));
});

test("getMonitorData aggregates llm, workspace and execution", async () => {
  const data = await getMonitorData(process.cwd());
  assert.ok(data.timestamp);
  assert.ok(data.llm);
  assert.ok(data.workspace);
  assert.ok(data.execution);
});

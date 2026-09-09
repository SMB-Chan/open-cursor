import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`integration anchor not found: ${label}`);
  return text.replace(from, to);
}

const path = "server/index.js";
let text = fs.readFileSync(path, "utf8");

text = replaceOrFail(
  text,
  '} from "./engine.js";\n\nconst PORT = runtimeConfig.bridge.port;',
  '} from "./engine.js";\nimport {\n  finishWorkspaceReceipt,\n  getExecutionReceipt,\n  shouldJournalWorkspace,\n  startWorkspaceReceipt,\n} from "./receipt.js";\n\nconst PORT = runtimeConfig.bridge.port;',
  "receipt import"
);

text = replaceOrFail(
  text,
  `  sendJSON(res, status, {\n    error: {\n      message: error?.message || "Internal server error",\n      type: status >= 500 ? "server_error" : "invalid_request_error",\n    },\n  });`,
  `  sendJSON(res, status, {\n    error: {\n      message: error?.message || "Internal server error",\n      type: status >= 500 ? "server_error" : "invalid_request_error",\n    },\n    ...(error?.workspaceReceipt\n      ? { open_cursor: { workspace_receipt: error.workspaceReceipt } }\n      : {}),\n  });`,
  "non-stream error receipt"
);

text = replaceOrFail(
  text,
  `    fail(error) {\n      if (res.destroyed || res.writableEnded) return;\n      writeChunk(\`\\n\\n[Error: \${error.message}]\`, "error", {\n        error: true,\n        type: error.name || "Error",\n      });`,
  `    fail(error, metadata = {}) {\n      if (res.destroyed || res.writableEnded) return;\n      writeChunk(\`\\n\\n[Error: \${error.message}]\`, "error", {\n        ...metadata,\n        error: true,\n        type: error.name || "Error",\n        message: error.message,\n      });`,
  "SSE error receipt"
);

text = replaceOrFail(
  text,
  `  const selection = parseAgentSelection(body.model || "", req.headers["x-agent-mode"]);\n  const effectiveMode = selection.mode || analyzeTask(fullPrompt).routing;\n  assertAgentsEnabled(effectiveMode);\n\n  const requestId = \`chatcmpl-\${randomUUID()}\`;\n  const lifetime = bindRequestLifetime(req, res);`,
  `  const selection = parseAgentSelection(body.model || "", req.headers["x-agent-mode"]);\n  const taskInfo = analyzeTask(fullPrompt);\n  const effectiveMode = selection.mode || taskInfo.routing;\n  assertAgentsEnabled(effectiveMode);\n\n  const requestId = \`chatcmpl-\${randomUUID()}\`;\n  const journal = shouldJournalWorkspace(selection.mode, taskInfo)\n    ? await startWorkspaceReceipt(cwd, {\n        id: requestId,\n        mode: selection.mode || "auto",\n      })\n    : null;\n  const lifetime = bindRequestLifetime(req, res);`,
  "journal start"
);

text = replaceOrFail(
  text,
  `      sse.finish(responseModel(result.agent, selection.model), {\n        agent: result.agent,\n        active_executions: activeExecutionCount(),\n      });\n    } catch (error) {\n      if (!lifetime.signal.aborted) sse.fail(error);`,
  `      const workspaceReceipt = await finishWorkspaceReceipt(journal, { status: "completed" });\n      sse.finish(responseModel(result.agent, selection.model), {\n        agent: result.agent,\n        active_executions: activeExecutionCount(),\n        ...(workspaceReceipt ? { workspace_receipt: workspaceReceipt } : {}),\n      });\n    } catch (error) {\n      const workspaceReceipt = await finishWorkspaceReceipt(journal, {\n        status: lifetime.signal.aborted ? "cancelled" : "failed",\n        error,\n      });\n      if (!lifetime.signal.aborted) {\n        sse.fail(error, workspaceReceipt ? { workspace_receipt: workspaceReceipt } : {});\n      }`,
  "stream receipt finalization"
);

text = replaceOrFail(
  text,
  `    sendJSON(\n      res,\n      200,`,
  `    const workspaceReceipt = await finishWorkspaceReceipt(journal, { status: "completed" });\n\n    sendJSON(\n      res,\n      200,`,
  "non-stream success finalization"
);

text = replaceOrFail(
  text,
  `        open_cursor: {\n          agent: result.agent,\n          active_executions: activeExecutionCount(),\n        },`,
  `        open_cursor: {\n          agent: result.agent,\n          active_executions: activeExecutionCount(),\n          ...(workspaceReceipt ? { workspace_receipt: workspaceReceipt } : {}),\n        },`,
  "non-stream receipt response"
);

text = replaceOrFail(
  text,
  `      { "X-Open-Cursor-Request-Id": requestId }\n    );\n  } finally {\n    lifetime.cleanup();\n  }\n}`,
  `      { "X-Open-Cursor-Request-Id": requestId }\n    );\n  } catch (error) {\n    const workspaceReceipt = await finishWorkspaceReceipt(journal, {\n      status: lifetime.signal.aborted ? "cancelled" : "failed",\n      error,\n    });\n    if (workspaceReceipt) error.workspaceReceipt = workspaceReceipt;\n    throw error;\n  } finally {\n    lifetime.cleanup();\n  }\n}`,
  "non-stream failure finalization"
);

text = replaceOrFail(
  text,
  `async function handleHealth(req, res) {`,
  `function handleExecutionReceipt(req, res, url) {\n  rejectBrowserOrigin(req);\n  const prefix = "/v1/execution-receipts/";\n  const id = decodeURIComponent(url.pathname.slice(prefix.length));\n  if (!id || id.includes("/")) {\n    throw new HttpError(400, "Invalid execution receipt id");\n  }\n  const receipt = getExecutionReceipt(id);\n  if (!receipt) throw new HttpError(404, "Execution receipt not found or expired");\n  sendJSON(res, 200, { object: "execution.receipt", receipt });\n}\n\nasync function handleHealth(req, res) {`,
  "receipt handler"
);

text = replaceOrFail(
  text,
  `    } else if (url.pathname === "/v1/agents" && req.method === "GET") {\n      await handleAgents(req, res);\n    } else if (url.pathname === "/health" && req.method === "GET") {`,
  `    } else if (url.pathname === "/v1/agents" && req.method === "GET") {\n      await handleAgents(req, res);\n    } else if (\n      url.pathname.startsWith("/v1/execution-receipts/") &&\n      req.method === "GET"\n    ) {\n      handleExecutionReceipt(req, res, url);\n    } else if (url.pathname === "/health" && req.method === "GET") {`,
  "receipt route"
);

text = replaceOrFail(
  text,
  `  formatCollaborativeResult,\n  orchestrate,`,
  `  formatCollaborativeResult,\n  getExecutionReceipt,\n  orchestrate,`,
  "receipt export"
);

fs.writeFileSync(path, text);

const enginePath = "server/engine.js";
let engine = fs.readFileSync(enginePath, "utf8");
engine = replaceOrFail(engine, 'const VERSION = "2.3.0";', 'const VERSION = "2.4.0";', "server version");
fs.writeFileSync(enginePath, engine);

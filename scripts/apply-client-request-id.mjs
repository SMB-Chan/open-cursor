import fs from "node:fs";

function replaceOrFail(text, from, to, label) {
  if (!text.includes(from)) throw new Error(`request id anchor not found: ${label}`);
  return text.replace(from, to);
}

let server = fs.readFileSync("server/index.js", "utf8");
server = replaceOrFail(
  server,
  'const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);',
  'const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);\nconst REQUEST_ID_PATTERN = /^chatcmpl-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;\n\nfunction resolveRequestId(rawRequestId) {\n  if (rawRequestId === undefined || rawRequestId === null || String(rawRequestId).trim() === "") {\n    return `chatcmpl-${randomUUID()}`;\n  }\n\n  const value = String(rawRequestId).trim();\n  if (!REQUEST_ID_PATTERN.test(value)) {\n    throw new HttpError(400, "X-Open-Cursor-Request-Id must use chatcmpl-<UUID> format");\n  }\n  return value;\n}',
  "request id resolver"
);
server = replaceOrFail(
  server,
  '  const requestId = `chatcmpl-${randomUUID()}`;',
  '  const requestId = resolveRequestId(req.headers["x-open-cursor-request-id"]);',
  "chat request id"
);
server = replaceOrFail(
  server,
  '  rejectBrowserOrigin,\n  requiredAgentsForMode,',
  '  rejectBrowserOrigin,\n  requiredAgentsForMode,\n  resolveRequestId,',
  "request id export"
);
fs.writeFileSync("server/index.js", server);

let serverTest = fs.readFileSync("server/index.test.js", "utf8");
serverTest = replaceOrFail(
  serverTest,
  '  rejectBrowserOrigin,\n  runProcess,',
  '  rejectBrowserOrigin,\n  resolveRequestId,\n  runProcess,',
  "request id test import"
);
serverTest = replaceOrFail(
  serverTest,
  'test("prompt builder preserves context and rejects unsupported roles", () => {',
  'test("request ids accept strict client UUIDs and reject arbitrary values", () => {\n  const id = "chatcmpl-123e4567-e89b-42d3-a456-426614174000";\n  assert.equal(resolveRequestId(id), id);\n  assert.match(resolveRequestId(undefined), /^chatcmpl-[0-9a-f-]{36}$/i);\n  assert.throws(\n    () => resolveRequestId("../../receipt"),\n    (error) => error instanceof HttpError && error.statusCode === 400\n  );\n  assert.throws(\n    () => resolveRequestId("chatcmpl-not-a-uuid"),\n    (error) => error instanceof HttpError && error.statusCode === 400\n  );\n});\n\ntest("prompt builder preserves context and rejects unsupported roles", () => {',
  "request id tests"
);
fs.writeFileSync("server/index.test.js", serverTest);

let extension = fs.readFileSync("extension/src/extension.js", "utf8");
extension = replaceOrFail(
  extension,
  'const { randomBytes } = require("node:crypto");',
  'const { randomBytes, randomUUID } = require("node:crypto");',
  "extension random uuid import"
);
extension = replaceOrFail(
  extension,
  'async function streamMessage(context, prompt, mode, signal, onEvent, onStarted) {',
  'async function streamMessage(context, prompt, mode, signal, onEvent, onStarted, preferredRequestId) {',
  "stream request id parameter"
);
extension = replaceOrFail(
  extension,
  '      "X-Agent-Mode": selectedMode,\n    },',
  '      "X-Agent-Mode": selectedMode,\n      ...(preferredRequestId ? { "X-Open-Cursor-Request-Id": preferredRequestId } : {}),\n    },',
  "stream request id header"
);
extension = replaceOrFail(
  extension,
  '  const bridgeRequestId = response.headers.get("x-open-cursor-request-id");',
  '  const bridgeRequestId = response.headers.get("x-open-cursor-request-id") || preferredRequestId || null;',
  "stream response request id"
);
extension = replaceOrFail(
  extension,
  '      const requestState = { id: msg.requestId, controller, bridgeRequestId: null };',
  '      const requestState = {\n        id: msg.requestId,\n        controller,\n        bridgeRequestId: `chatcmpl-${randomUUID()}`,\n      };',
  "client request state"
);
extension = replaceOrFail(
  extension,
  '          (bridgeRequestId) => {\n            requestState.bridgeRequestId = bridgeRequestId;\n          }\n        );',
  '          (bridgeRequestId) => {\n            requestState.bridgeRequestId = bridgeRequestId;\n          },\n          requestState.bridgeRequestId\n        );',
  "stream preferred request id argument"
);
fs.writeFileSync("extension/src/extension.js", extension);

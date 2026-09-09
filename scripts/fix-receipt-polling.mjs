import fs from "node:fs";

const path = "extension/src/extension.js";
let text = fs.readFileSync(path, "utf8");

const importFrom = 'const { summarizeWorkspaceReceipt } = require("./receipt.js");';
const importTo = 'const { pollExecutionReceipt, summarizeWorkspaceReceipt } = require("./receipt.js");';
if (!text.includes(importFrom)) throw new Error("receipt helper import anchor not found");
text = text.replace(importFrom, importTo);

const polling = `async function fetchExecutionReceipt(requestId, options = {}) {
  return pollExecutionReceipt({
    requestId,
    bridgeUrl: bridgeUrl(),
    fetchFn: fetch,
    sleepFn: sleep,
    attempts: options.attempts ?? RECEIPT_FETCH_ATTEMPTS,
    delayMs: options.delayMs ?? RECEIPT_FETCH_DELAY_MS,
    timeoutMs: options.timeoutMs ?? RECEIPT_FETCH_TIMEOUT_MS,
  });
}

async function streamMessage`;

const next = text.replace(
  /async function fetchExecutionReceipt\([\s\S]*?\n}\n\nasync function streamMessage/,
  polling
);
if (next === text) throw new Error("receipt polling function anchor not found");
fs.writeFileSync(path, next);

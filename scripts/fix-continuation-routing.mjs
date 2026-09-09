import fs from "node:fs";

const path = "server/engine.js";
const text = fs.readFileSync(path, "utf8");
const from = `  if (hasImplementation) {\n    return { routing: "codex", reason: "implementation task", kind: "write", requiresWorkspaceWrite: true };\n  }\n  if (hasAnalysis) {\n    return { routing: "antigravity", reason: "analysis task", kind: "analysis", requiresWorkspaceWrite: false };\n  }\n  if (hasContinuation) {\n    return { routing: "collaborative", reason: "complex multi-step task", kind: "complex-write", requiresWorkspaceWrite: true };\n  }`;
const to = `  if (hasImplementation) {\n    return { routing: "codex", reason: "implementation task", kind: "write", requiresWorkspaceWrite: true };\n  }\n  if (hasContinuation) {\n    return { routing: "collaborative", reason: "complex multi-step task", kind: "complex-write", requiresWorkspaceWrite: true };\n  }\n  if (hasAnalysis) {\n    return { routing: "antigravity", reason: "analysis task", kind: "analysis", requiresWorkspaceWrite: false };\n  }`;
if (!text.includes(from)) throw new Error("continuation routing anchor not found");
fs.writeFileSync(path, text.replace(from, to));

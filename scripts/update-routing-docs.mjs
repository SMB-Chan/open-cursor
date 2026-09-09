import fs from "node:fs";

const path = "README.md";
let text = fs.readFileSync(path, "utf8");

function replaceOrFail(from, to, label) {
  if (!text.includes(from)) throw new Error(`README anchor not found: ${label}`);
  text = text.replace(from, to);
}

replaceOrFail(
`Current backends:\n\n- **Codex CLI** — implementation/refinement using ChatGPT subscription authentication\n- **Antigravity CLI** — analysis/planning/review using Gemini AI Pro subscription mode\n- **Pipeline** — Plan → Implement\n- **Collaborative** — Plan → Implement → Review → Refine\n\n> Open-Cursor itself does not require a per-call billing API, but upstream CLI availability, authentication methods, quotas, and subscription terms can change. Verify each CLI's active authentication/billing mode before use.`,
`Current backends and orchestration paths:\n\n- **Codex CLI** — workspace-writing implementation/refinement using ChatGPT authentication\n- **Antigravity CLI** — Gemini analysis/planning/review, plus an explicitly selected write-capable Autonomous mode\n- **Xiaomi MiMo** — optional remote, API-key/token-plan-backed **read-only** solution drafting\n- **Auto** — side-effect-aware routing that never substitutes a read-only provider for a workspace writer\n- **Pipeline** — Gemini Plan → Codex Implement\n- **Collaborative** — Gemini Plan → Codex Implement → Gemini Review → Codex Refine\n\n> The local Open-Cursor bridge does not add its own usage charge. Provider billing/authentication is per-agent: Codex and Antigravity may use subscription-backed authentication, while the optional MiMo integration uses an external API key/token plan. Verify the active provider configuration before use.`,
"backend summary"
);

replaceOrFail(
`    └── execution engine\n          ├── Codex        → actual workspace, write-capable\n          └── Antigravity  → detached temporary working directory for automatic planning/review`,
`    └── execution engine\n          ├── Codex        → actual workspace, write-capable\n          ├── Antigravity  → detached temporary directory for automatic planning/review\n          │                  (actual workspace only for explicitly selected write modes)\n          └── MiMo         → remote response-only provider, no workspace access`,
"architecture providers"
);

replaceOrFail(
`- at least one supported agent CLI:\n  - \`codex\`\n  - \`agy\` / Antigravity CLI\n- authentication already completed for the CLI you intend to use`,
`- at least one supported local agent CLI:\n  - \`codex\`\n  - \`agy\` / Antigravity CLI\n- authentication already completed for the CLI you intend to use\n- optional: a configured MiMo API key/token-plan credential if you explicitly use MiMo or allow read-only Auto fallback to it`,
"requirements"
);

replaceOrFail(
`| Mode | Behavior |\n| --- | --- |\n| \`collaborative\` | Gemini Plan → Codex Implement → Gemini Review → Codex Refine |\n| \`pipeline\` | Gemini Plan → Codex Implement |\n| \`codex\` | Codex only |\n| \`antigravity\` | Antigravity only |\n\nAutomatic routing recognizes common English and Japanese analysis/implementation/continuation terms. Explicit routing takes precedence.`,
`| Mode | Behavior | Workspace effect |\n| --- | --- | --- |\n| \`auto\` | Classify intent and choose only a capability-compatible route | Depends on task; write tasks require Codex |\n| \`collaborative\` | Gemini Plan → Codex Implement → Gemini Review → Codex Refine | Writes through Codex |\n| \`pipeline\` | Gemini Plan → Codex Implement | Writes through Codex |\n| \`codex\` | Codex only | Write-capable |\n| \`antigravity\` | Explicit Antigravity route | Write-capable by explicit selection |\n| \`autonomous\` | Explicit Antigravity auto-approved edits/commands | **Write-capable; high trust required** |\n| \`mimo\` | Xiaomi MiMo response/solution draft | Read-only; no workspace access |\n| \`mimo-gemini\` | Gemini plan/review + MiMo solution draft | Read-only; no workspace implementation |\n\nAutomatic routing recognizes common English and Japanese analysis, implementation, verification, and continuation terms. Explicit routing takes precedence. Auto treats side effects as a hard capability constraint: an implementation request is never reported as completed through MiMo, and a failed/partially completed writer run is never silently retried as a response-only success.`,
"routing table"
);

replaceOrFail(
`CODEX_BIN\nAGY_BIN`,
`CODEX_BIN\nAGY_BIN\nCODEX_ENABLED\nAGY_ENABLED\nMIMO_ENABLED\nMIMO_ENDPOINT\nMIMO_MODEL`,
"environment overrides"
);

replaceOrFail(
`\`agents.codex.enabled\` and \`agents.antigravity.enabled\` control model advertisement and routing availability. A request needing a disabled agent fails before the execution phase begins.`,
`\`agents.codex.enabled\`, \`agents.antigravity.enabled\`, and \`agents.mimo.enabled\` control model advertisement and routing availability. MiMo is additionally constrained to \`workspaceAccess: "none"\` by runtime validation. A request needing a disabled agent fails before execution begins.`,
"agent enablement"
);

fs.writeFileSync(path, text);

# Open-Cursor

Open-Cursor is a local multi-agent bridge for Cursor/VS Code-style workflows. It connects subscription-authenticated coding CLIs to a local OpenAI-compatible endpoint and coordinates them as distinct planning, implementation, and review roles.

Current backends:

- **Codex CLI** — implementation/refinement using ChatGPT subscription authentication
- **Antigravity CLI** — analysis/planning/review using Gemini AI Pro subscription mode
- **Pipeline** — Plan → Implement
- **Collaborative** — Plan → Implement → Review → Refine

> Open-Cursor itself does not require a per-call billing API, but upstream CLI availability, authentication methods, quotas, and subscription terms can change. Verify each CLI's active authentication/billing mode before use.

## Architecture

```text
Cursor extension
    │
    │ owns bridge lifecycle when it starts the process
    │ consumes live SSE deltas
    │ aborts requests on Stop / panel close
    ▼
127.0.0.1:9876
Open-Cursor HTTP bridge
    │
    ├── request-scoped AbortSignal
    ├── timeout / output limits
    └── execution engine
          ├── Codex        → actual workspace, write-capable
          └── Antigravity  → detached temporary working directory for automatic planning/review
```

The HTTP layer lives in `server/index.js`, execution/orchestration in `server/engine.js`, and bounded repository context generation in `server/context.js`.

## Why collaborative mode is sequential

Earlier versions could run two write-capable agents against the same workspace concurrently. That creates a race: both agents can edit the same file based on different snapshots.

Open-Cursor 2.3 changes collaborative mode to:

```text
1. Gemini / Antigravity  — Plan
2. Codex                 — Implement
3. Gemini / Antigravity  — Review
4. Codex                 — Refine
```

Only Codex is intentionally given the actual workspace for the write phases. Automatic Gemini planning/review receives a bounded context pack and runs from a temporary working directory instead of the project directory.

This is **not an operating-system sandbox**. A detached working directory reduces accidental workspace coupling and avoids passing the workspace path as the working directory, but the upstream CLI still runs with the permissions of the local user. Do not treat it as a security boundary against a malicious local process or compromised CLI.

## Repository context pack

Planning/review does not blindly copy the repository. `server/context.js` creates a bounded project view containing:

- a capped workspace file map
- selected small source/config/document excerpts ranked against the task
- bounded Git status/diff evidence for review
- a baseline Git HEAD so later agent commits can still be reviewed against the pre-implementation state

Default limits:

| Context guardrail | Default |
| --- | ---: |
| workspace map files | 300 |
| context pack | 128 KiB |
| individual excerpt | 12 KiB |
| review diff | 96 KiB |

Secret-like paths are omitted from generated agent context, including common `.env`, credential/token/secret names, private keys, and keystore formats. Repository content is explicitly framed as **untrusted project data** so instructions embedded inside files are not supposed to override the planning/review task.

These are defense-in-depth controls, not a guarantee that arbitrary secrets can never be inferred or accessed by an upstream local CLI.

## Requirements

- Linux
- Node.js 18 or newer
- Cursor
- at least one supported agent CLI:
  - `codex`
  - `agy` / Antigravity CLI
- authentication already completed for the CLI you intend to use

The launcher/install scripts also account for common GUI-session PATH differences, including user-local binaries and typical NVM installations.

## Install

```bash
git clone https://github.com/SMB-Chan/open-cursor.git
cd open-cursor
bash bin/install.sh
```

The installer establishes the stable project path:

```text
~/.cursor-codex-bridge
```

If the repository is cloned elsewhere, the installer links that stable path to the clone. It also links the Cursor extension and creates a desktop launcher. It refuses to silently replace an unrelated existing bridge installation.

## Start and lifecycle

Normally the extension activates after Cursor starts and manages the local bridge automatically.

If another healthy bridge already owns the configured port, the extension reuses it. The extension only stops a bridge process that it started itself.

Commands:

```text
Open-Cursor: Chat with Agents
Open-Cursor: Start Bridge Server
Open-Cursor: Stop Managed Bridge Server
Open-Cursor: Show Agent Status
Open-Cursor: Select Agent (Codex/Antigravity/Collaborative)
```

Manual launch remains available:

```bash
~/.cursor-codex-bridge/bin/open-cursor-app
```

Bridge-only launch:

```bash
~/.cursor-codex-bridge/bin/open-cursor
```

Legacy shell-managed bridge stop:

```bash
~/.cursor-codex-bridge/bin/stop-bridge
```

## Routing modes

| Mode | Behavior |
| --- | --- |
| `collaborative` | Gemini Plan → Codex Implement → Gemini Review → Codex Refine |
| `pipeline` | Gemini Plan → Codex Implement |
| `codex` | Codex only |
| `antigravity` | Antigravity only |

Automatic routing recognizes common English and Japanese analysis/implementation/continuation terms. Explicit routing takes precedence.

Namespaced models are supported:

```text
codex/<model>
antigravity/pro
antigravity/flash
```

A model namespace that conflicts with `X-Agent-Mode` is rejected instead of silently choosing an unexpected backend.

### Explicit Antigravity mode

An explicitly requested `antigravity` route is treated differently from automatic planning/review: it runs with the requested workspace as its working directory because the user deliberately selected that backend for the task. Automatic analysis routing uses the detached bounded-context path.

## Streaming and cancellation

`stream: true` sends child-process stdout through SSE as it arrives.

The extension's **Stop** action aborts its fetch. The bridge propagates the disconnect/abort to all child processes owned by that request, sends `SIGTERM`, and escalates to `SIGKILL` after the grace period when necessary.

Collaborative streams identify the active phase through Open-Cursor metadata, for example:

```json
{
  "open_cursor": {
    "agent": "antigravity",
    "phase": "review"
  }
}
```

A single `chatcmpl-*` ID is retained for the entire stream and is also exposed as `X-Open-Cursor-Request-Id`.

## Execution guardrails

| Guardrail | Default |
| --- | ---: |
| request body | 1 MiB |
| combined child stdout/stderr | 8 MiB |
| per-agent execution timeout | 10 minutes |
| SIGTERM → SIGKILL grace | 1.5 seconds |

`GET /health` and `GET /v1/agents` expose non-sensitive execution state such as active execution count and configured limits. Prompts and workspace paths are not included.

## Local API

Default endpoint:

```text
http://127.0.0.1:9876
```

Endpoints:

```text
GET  /health
GET  /v1/models
GET  /v1/agents
POST /v1/chat/completions
```

Important environment variables:

```text
BRIDGE_PORT
BRIDGE_HOST
BRIDGE_MAX_BODY_BYTES
BRIDGE_MAX_OUTPUT_BYTES
BRIDGE_AGENT_TIMEOUT_MS
BRIDGE_KILL_GRACE_MS
BRIDGE_ALLOW_REMOTE
BRIDGE_CONTEXT_MAX_FILES
BRIDGE_CONTEXT_MAX_BYTES
BRIDGE_CONTEXT_FILE_BYTES
BRIDGE_DIFF_MAX_BYTES
CODEX_BIN
AGY_BIN
```

`config/bridge.json` documents the intended configuration shape and `config/config.schema.json` validates that reference file. Runtime server values are currently still driven primarily by environment variables and extension settings.

## Extension settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `openCursor.bridgePort` | `9876` | local bridge port |
| `openCursor.autoStartBridge` | `true` | start bridge after Cursor startup |
| `openCursor.nodePath` | `node` | Node executable for managed bridge |
| `openCursor.defaultAgent` | `collaborative` | default routing mode |
| `openCursor.workspacePath` | empty | optional workspace override |

The extension is dependency-free at runtime and loads `extension/src/extension.js` directly.

## Security boundary

The bridge launches write-capable local coding agents. Treat it as a local execution boundary.

Current protections include:

- loopback binding by default
- refusal to bind remotely unless `BRIDGE_ALLOW_REMOTE=1` is explicitly set
- no permissive CORS behavior
- browser-origin execution requests rejected
- request body/output/time limits
- request-scoped cancellation and forced termination fallback
- validation of routing, model namespace conflicts, message roles, and workspace paths
- secret-like path omission from generated context/review evidence
- bounded context generation
- detached temporary working directories for automatic Gemini planning/review
- preservation instructions for pre-existing user changes
- managed-process ownership in the extension
- webview Content Security Policy

Do **not** expose the bridge directly to a LAN or the public Internet. A remote mode needs a real authenticated transport boundary first.

## Development

Bridge checks/tests:

```bash
cd server
npm run check
npm test
```

Tests cover, among other things:

- routing and request validation
- real incremental child stdout
- AbortSignal cancellation
- execution timeout termination
- bounded repository context
- secret-like path omission
- baseline Git diff tracking
- temporary reviewer-directory cleanup
- collaboration prompt contracts for Plan / Implement / Review / Refine

Extension check:

```bash
cd extension
npm run check
```

CI also validates shell launcher syntax and reference configuration JSON.

## Current direction

The execution core is now moving from “two agents attached to one chat” toward a role-based coding workflow.

Near-term priorities after 2.3 are:

1. render `agent` / `phase` metadata as first-class UI state in the Cursor chat panel
2. add installation/upgrade smoke tests and release packaging
3. promote `config/bridge.json` from reference configuration to validated runtime configuration
4. improve changed-file context for newly-created/untracked files while keeping strict secret and size filtering
5. add optional stronger OS-level isolation for detached reviewer processes when a supported sandbox facility is available

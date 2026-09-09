# Open-Cursor

Open-Cursor is a local multi-agent bridge for Cursor/VS Code-style workflows. It connects subscription-authenticated coding CLIs to a local OpenAI-compatible endpoint and coordinates them as distinct planning, implementation, and review roles.

Current backends and orchestration paths:

- **Codex CLI** — workspace-writing implementation/refinement using ChatGPT authentication
- **Antigravity CLI** — Gemini analysis/planning/review, plus an explicitly selected write-capable Autonomous mode
- **Xiaomi MiMo** — optional remote, API-key/token-plan-backed **read-only** solution drafting
- **Auto** — side-effect-aware routing that never substitutes a read-only provider for a workspace writer
- **Pipeline** — Gemini Plan → Codex Implement
- **Collaborative** — Gemini Plan → Codex Implement → Gemini Review → Codex Refine

> The local Open-Cursor bridge does not add its own usage charge. Provider billing/authentication is per-agent: Codex and Antigravity may use subscription-backed authentication, while the optional MiMo integration uses an external API key/token plan. Verify the active provider configuration before use.

## Architecture

```text
Cursor extension
    │
    │ owns bridge lifecycle when it starts the process
    │ consumes live SSE + agent/phase metadata
    │ aborts requests on Stop / panel close
    ▼
127.0.0.1:9876
Open-Cursor HTTP bridge
    │
    ├── validated runtime configuration
    ├── request-scoped AbortSignal
    ├── timeout / output limits
    └── execution engine
          ├── Codex        → actual workspace, write-capable
          ├── Antigravity  → detached temporary directory for automatic planning/review
          │                  (actual workspace only for explicitly selected write modes)
          └── MiMo         → remote response-only provider, no workspace access
```

The HTTP layer lives in `server/index.js`, execution/orchestration in `server/engine.js`, bounded repository context generation in `server/context.js`, and runtime configuration loading in `server/config.js`.

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
- at least one supported local agent CLI:
  - `codex`
  - `agy` / Antigravity CLI
- authentication already completed for the CLI you intend to use
- optional: a configured MiMo API key/token-plan credential if you explicitly use MiMo or allow read-only Auto fallback to it

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
Open-Cursor: Select Agent Routing Mode
```

Manual launch remains available:

```bash
~/.cursor-codex-bridge/bin/open-cursor-app
```

Bridge-only launch:

```bash
~/.cursor-codex-bridge/bin/open-cursor
```

### Mobile dashboard security

The mobile dashboard is **localhost-only by default**. Starting Open-Cursor no longer exposes execution APIs to the LAN automatically.

Remote access requires **both authentication and a protected transport**. `MOBILE_ALLOW_REMOTE=1` by itself now fails closed.

Native HTTPS mode:

```bash
MOBILE_ALLOW_REMOTE=1 \
MOBILE_REMOTE_TRANSPORT=tls \
MOBILE_TLS_CERT_FILE=/path/to/fullchain.pem \
MOBILE_TLS_KEY_FILE=/path/to/privkey.pem \
~/.cursor-codex-bridge/bin/open-cursor
```

The certificate must be trusted by the phone/tablet and valid for the hostname or IP used in the pairing URL.

Encrypted overlay/tunnel mode (for example Tailscale, a VPN, or an SSH/reverse-proxy tunnel):

```bash
MOBILE_ALLOW_REMOTE=1 \
MOBILE_REMOTE_TRANSPORT=tunnel \
MOBILE_HOST=100.x.y.z \
~/.cursor-codex-bridge/bin/open-cursor
```

In `tunnel` mode Open-Cursor serves HTTP only inside the transport you explicitly declared trusted. The tunnel/VPN is responsible for encryption and peer authentication. Use `MOBILE_PUBLIC_URL` when the externally reachable tunnel URL differs from the local bind address. Tunnel mode refuses wildcard binds such as `0.0.0.0`; bind a specific VPN/overlay address, or bind `127.0.0.1` behind a reverse proxy and set `MOBILE_PUBLIC_URL`.

The launcher creates a 256-bit pairing token in `~/.cursor-codex-bridge/mobile.token` with mode `0600` and prints a pairing URL using `#token=...`. URL fragments are not sent in HTTP requests; the browser moves the token into session storage and sends it only in a Bearer authorization header.

Arbitrary shell execution is a separate high-trust opt-in and remains disabled by default:

```bash
MOBILE_ALLOW_REMOTE=1 \
MOBILE_REMOTE_TRANSPORT=tunnel \
MOBILE_ALLOW_EXEC=1 \
~/.cursor-codex-bridge/bin/open-cursor
```

Do not expose port 9880 directly to an untrusted network. A pairing token does not make plaintext HTTP safe against an active network attacker because the dashboard JavaScript itself could otherwise be modified in transit.

Legacy shell-managed bridge stop:

```bash
~/.cursor-codex-bridge/bin/stop-bridge
```

## Routing modes

| Mode | Behavior | Workspace effect |
| --- | --- | --- |
| `auto` | Classify intent and choose only a capability-compatible route | Depends on task; write tasks require Codex |
| `collaborative` | Gemini Plan → Codex Implement → Gemini Review → Codex Refine | Writes through Codex |
| `pipeline` | Gemini Plan → Codex Implement | Writes through Codex |
| `codex` | Codex only | Write-capable |
| `antigravity` | Explicit Antigravity route | Write-capable by explicit selection |
| `autonomous` | Explicit Antigravity auto-approved edits/commands | **Write-capable; high trust required** |
| `mimo` | Xiaomi MiMo response/solution draft | Read-only; no workspace access |
| `mimo-gemini` | Gemini plan/review + MiMo solution draft | Read-only; no workspace implementation |

Automatic routing recognizes common English and Japanese analysis, implementation, verification, and continuation terms. Explicit routing takes precedence. Auto treats side effects as a hard capability constraint: an implementation request is never reported as completed through MiMo, and a failed/partially completed writer run is never silently retried as a response-only success.

Namespaced models are supported:

```text
codex/<model>
antigravity/pro
antigravity/flash
```

A model namespace that conflicts with `X-Agent-Mode` is rejected instead of silently choosing an unexpected backend.

### Explicit Antigravity mode

An explicitly requested `antigravity` route is treated differently from automatic planning/review: it runs with the requested workspace as its working directory because the user deliberately selected that backend for the task. Automatic analysis routing uses the detached bounded-context path.

## Streaming and execution UI

`stream: true` sends child-process stdout through SSE as it arrives. SSE events also carry `open_cursor.agent` and `open_cursor.phase` metadata.

The Cursor chat UI renders that metadata independently from the answer body. Collaborative runs expose **Plan / Implement / Review / Refine** progress and the active Gemini/Codex backend; pipeline runs expose **Plan / Implement**.

The extension's **Stop** action aborts its fetch. The bridge propagates the disconnect/abort to all child processes owned by that request, sends `SIGTERM`, and escalates to `SIGKILL` after the grace period when necessary.

A single `chatcmpl-*` ID is retained for the entire stream and is also exposed as `X-Open-Cursor-Request-Id`.

### Workspace execution receipts

Write-capable requests record a bounded, non-destructive Git receipt before and after execution. The receipt distinguishes newly dirty paths, pre-existing dirty paths, paths that became clean, HEAD changes, and files committed during the request. Secret-like paths are omitted from the public receipt.

Receipts never automatically stash, reset, or roll back the workspace. They are observations, not proof that the agent alone caused every observed change.

Successful and failed streaming runs include the receipt in final `open_cursor.workspace_receipt` metadata. If the client disconnects or **Stop** aborts the stream, the extension retains `X-Open-Cursor-Request-Id` and retrieves the finalized receipt from:

```text
GET /v1/execution-receipts/<chatcmpl-id>
```

Receipts are held only in bounded bridge memory (maximum 100 entries, one-hour TTL) and are not persisted to disk.

## Runtime configuration

`config/bridge.json` is the runtime source of default bridge settings. `config/config.schema.json` documents the same contract, while `server/config.js` performs startup validation before the execution engine is evaluated.

Precedence is:

```text
config/bridge.json
        ↓
explicit environment-variable override
```

A different configuration file can be selected with:

```text
BRIDGE_CONFIG_PATH=/absolute/path/to/bridge.json
```

Invalid configuration or invalid numeric/boolean environment overrides cause startup to fail instead of silently falling back.

Important environment overrides include:

```text
BRIDGE_CONFIG_PATH
BRIDGE_PORT
BRIDGE_HOST
BRIDGE_ALLOW_REMOTE
BRIDGE_MAX_BODY_BYTES
BRIDGE_MAX_OUTPUT_BYTES
BRIDGE_AGENT_TIMEOUT_MS
BRIDGE_KILL_GRACE_MS
BRIDGE_CONTEXT_MAX_FILES
BRIDGE_CONTEXT_MAX_BYTES
BRIDGE_CONTEXT_FILE_BYTES
BRIDGE_DIFF_MAX_BYTES
CODEX_BIN
AGY_BIN
CODEX_ENABLED
AGY_ENABLED
MIMO_ENABLED
MIMO_ENDPOINT
MIMO_MODEL
```

The extension-managed bridge intentionally supplies its configured `BRIDGE_PORT` and safe loopback `BRIDGE_HOST`, so those names appear as runtime overrides when the extension starts the process.

`GET /health` and `GET /v1/agents` report only the **names** of active environment overrides, never their values.

## Bridge stats and execution-state lifecycle

Open-Cursor 2.5 tracks bounded in-memory bridge metrics for the lifetime of the current process:

```text
GET /v1/stats
```

The payload includes uptime, request totals (completed/failed/cancelled/active), per-mode and per-agent counters, average duration, and a capped ring buffer of the 20 most recent requests. Stats never include prompt or response content and are never persisted to disk. `GET /health` also embeds the request totals.

Since 2.5, every orchestrated run — success, failure, cancellation, or timeout — returns the shared execution state to idle. Earlier versions left codex/antigravity/autonomous/auto runs permanently "active" on the live monitor. Pipeline, MiMo, and MiMo+Gemini runs now also publish phase progress to the monitor.

### Safety invariants in configuration

Several properties are validated as invariants rather than freely configurable knobs:

- secret-like path omission must remain enabled
- the workspace writer must remain Codex
- automatic reviewer cwd must remain detached-temporary
- pipeline order remains Plan → Implement
- collaborative order remains Plan → Implement → Review → Refine
- loopback/browser-origin/concurrent-writer protection declarations remain fixed in the schema

`agents.codex.enabled`, `agents.antigravity.enabled`, and `agents.mimo.enabled` control model advertisement and routing availability. MiMo is additionally constrained to `workspaceAccess: "none"` by runtime validation. A request needing a disabled agent fails before execution begins.

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
- refusal to bind remotely unless both a non-loopback host and explicit remote opt-in are configured
- no permissive CORS behavior
- browser-origin execution requests rejected
- request body/output/time limits
- request-scoped cancellation and forced termination fallback
- validation of runtime configuration, routing, model namespace conflicts, message roles, and workspace paths
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

- runtime configuration defaults/overrides/invariants
- routing and request validation
- real incremental child stdout
- AbortSignal cancellation
- execution timeout termination
- bounded repository context
- secret-like path omission
- baseline Git diff tracking
- temporary reviewer-directory cleanup
- collaboration prompt contracts for Plan / Implement / Review / Refine

Extension checks/tests:

```bash
cd extension
npm run check
npm test
```

CI also validates shell launcher syntax and configuration JSON syntax.

## Working on this repository with LLM agents

Open-Cursor is itself developed with the agents it orchestrates. `AGENTS.md` at the repository root is the single onboarding document for coding agents (Codex CLI reads `AGENTS.md` natively; `GEMINI.md` and `CLAUDE.md` are symlinks to it). It documents the repository map, hard sequencing/safety constraints, context budgets, verification commands, and the update flow.

Inter-agent collaboration in collaborative mode uses structured output contracts: each stage prompt requires a parseable section (`## Target files`/`## Steps` from the planner, `## Report` from the implementer, `## Verdict` + numbered `## Findings` from the reviewer, `## Refinement Report` from the refiner). These sections are aligned with the handoff compression filters in `server/compressor.js`, so even over-budget handoffs keep the machine-parsable lines instead of losing them to truncation.

## Current direction

The project is now moving from “two agents attached to one chat” toward a maintainable local multi-agent execution platform with observable phases and one validated configuration model.

Near-term priorities are:

1. add installation/upgrade smoke tests and release packaging
2. include safe bounded excerpts for newly-created/untracked files in review context
3. add optional stronger OS-level isolation for detached reviewer processes when a supported sandbox facility is available
4. make automatic routing rules configurable without weakening the fixed write-safety invariants

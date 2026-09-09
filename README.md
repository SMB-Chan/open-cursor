# Open-Cursor

Open-Cursor is a local multi-agent bridge for Cursor/VS Code-style workflows. It routes coding tasks to subscription-authenticated command-line agents instead of requiring the bridge itself to use per-call API billing.

Current agent backends:

- **Codex CLI** — expected to use ChatGPT subscription OAuth
- **Antigravity CLI** — expected to use Gemini AI Pro subscription mode
- **Collaborative mode** — runs both agents concurrently
- **Pipeline mode** — Gemini/Antigravity analyzes first, then Codex implements

> The bridge does not guarantee that an upstream CLI, subscription, or provider will remain available under the same terms. Verify the authentication/billing mode shown by each upstream CLI before use.

## Architecture

```text
Cursor extension
    │
    │  owns bridge lifecycle when it starts the process
    │  consumes live SSE deltas
    │  aborts requests on Stop / panel close
    ▼
127.0.0.1:9876
Open-Cursor bridge
    │
    ├── request-scoped AbortSignal
    ├── timeout / output limits
    ├── Codex CLI
    └── Antigravity CLI
```

The project uses a stable path at:

```text
~/.cursor-codex-bridge
```

The repository can be cloned directly there, or cloned elsewhere. When the installer is run from another clone path, it creates `~/.cursor-codex-bridge` as a symlink to that clone. The Cursor extension is then linked from `~/.cursor/extensions/open-cursor-bridge`.

This keeps the bridge code outside Cursor's managed application files so Cursor updates do not overwrite it.

## Requirements

- Linux
- Node.js 18 or newer
- Cursor
- At least one supported agent CLI:
  - `codex`
  - `agy` / Antigravity CLI
- Authentication already completed for the CLI you want to use

For Codex, run its normal login flow and verify that it is using your intended ChatGPT subscription authentication. For Antigravity, verify its subscription/credit setting before using the bridge.

## Install

Clone the repository and run the installer:

```bash
git clone https://github.com/SMB-Chan/open-cursor.git
cd open-cursor
bash bin/install.sh
```

The installer:

1. establishes `~/.cursor-codex-bridge`
2. checks supported CLI availability and authentication state
3. repairs the Antigravity `agentapi` shim when applicable
4. links the Cursor extension
5. creates an `Open-Cursor` desktop entry

It refuses to overwrite an existing `~/.cursor-codex-bridge` that points to a different installation.

## Start and bridge lifecycle

By default the extension activates after Cursor starts and automatically starts the local bridge. The status bar shows the bridge state and opens the status view when clicked.

If a bridge is already running on the configured port, the extension reuses it instead of spawning another process. The extension only stops a bridge process that it started itself; externally started bridge processes are deliberately left untouched.

Available commands:

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

To start only the bridge from a shell:

```bash
~/.cursor-codex-bridge/bin/open-cursor
```

The legacy shell-managed bridge can still be stopped with:

```bash
~/.cursor-codex-bridge/bin/stop-bridge
```

## Chat streaming and cancellation

`stream: true` now streams child-process stdout through the bridge as it arrives instead of waiting for the complete CLI response and replaying it afterward.

The chat panel's **Stop** button aborts the fetch. The bridge observes the client disconnect and propagates cancellation to every child process associated with that request. It sends `SIGTERM` first and escalates to `SIGKILL` after the configured grace period if necessary.

Pipeline mode streams the analysis phase first and the implementation phase second. Collaborative mode runs both agents concurrently and prefixes live lines with the originating agent so an OpenAI-compatible text consumer remains readable.

SSE chunks also carry Open-Cursor metadata:

```json
{
  "open_cursor": {
    "agent": "codex",
    "phase": "implementation"
  }
}
```

A single stable `chatcmpl-*` request ID is used for the complete stream and is also returned in the `X-Open-Cursor-Request-Id` response header.

## Execution guardrails

Every spawned agent is request-scoped and bounded by default:

| Guardrail | Default |
| --- | ---: |
| request body | 1 MiB |
| combined child stdout/stderr | 8 MiB |
| per-agent execution timeout | 10 minutes |
| SIGTERM → SIGKILL grace | 1.5 seconds |

`GET /health` and `GET /v1/agents` report the current number of active executions plus the configured timeout/output limit without exposing prompts or workspace paths.

## Extension settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `openCursor.bridgePort` | `9876` | Local bridge port |
| `openCursor.autoStartBridge` | `true` | Start the bridge after Cursor finishes starting |
| `openCursor.nodePath` | `node` | Node.js executable used for the managed bridge |
| `openCursor.defaultAgent` | `collaborative` | Default routing mode |
| `openCursor.workspacePath` | empty | Override workspace path; otherwise the first open workspace is used |

The extension is dependency-free at runtime and loads `extension/src/extension.js` directly. There is no generated extension bundle to keep in sync.

## Routing modes

| Mode | Behavior |
| --- | --- |
| `collaborative` | Codex and Antigravity run concurrently; live output identifies the originating agent |
| `pipeline` | Antigravity analyzes first, then Codex receives the analysis and implements |
| `codex` | Codex only |
| `antigravity` | Antigravity only |

Automatic task analysis recognizes common English and Japanese analysis/implementation terms. Explicit routing always takes precedence.

Namespaced models are supported by the bridge, for example:

```text
codex/<model>
antigravity/pro
antigravity/flash
```

A namespaced model that conflicts with `X-Agent-Mode` is rejected instead of silently selecting an unexpected backend.

## Local API

Default endpoint:

```text
http://127.0.0.1:9876
```

Available endpoints:

```text
GET  /health
GET  /v1/models
GET  /v1/agents
POST /v1/chat/completions
```

Environment variables currently used by the server include:

```text
BRIDGE_PORT
BRIDGE_HOST
BRIDGE_MAX_BODY_BYTES
BRIDGE_MAX_OUTPUT_BYTES
BRIDGE_AGENT_TIMEOUT_MS
BRIDGE_KILL_GRACE_MS
BRIDGE_ALLOW_REMOTE
CODEX_BIN
AGY_BIN
```

`config/bridge.json` is currently a documented reference configuration. `config/config.schema.json` describes its shape. Runtime server settings are still controlled by environment variables and extension settings rather than being loaded from that JSON file.

## Security boundary

The bridge launches coding agents with write-capable permissions, so it must be treated as a local execution boundary.

Current protections include:

- loopback binding by default (`127.0.0.1`)
- refusal to bind to non-loopback addresses unless `BRIDGE_ALLOW_REMOTE=1` is explicitly set
- no permissive CORS headers
- browser-origin requests rejected on `/v1/chat/completions`
- request body and child-output limits
- request-scoped process cancellation
- execution timeouts with forced termination fallback
- validation of routing headers, model namespace conflicts, message roles, and workspace paths
- webview Content Security Policy
- managed-process ownership: the extension does not kill a bridge process it did not start

Do **not** expose the bridge directly to a LAN or the public Internet. If remote access is added later, place a real authenticated transport boundary in front of it first.

## Development

Bridge checks and tests:

```bash
cd server
npm run check
npm test
```

The bridge tests include real child-process checks for incremental stdout delivery, AbortSignal cancellation, and timeout termination.

Extension syntax check:

```bash
cd extension
npm run check
```

The repository CI checks:

- shell script syntax
- server JavaScript syntax
- bridge regression tests
- dependency-free extension source syntax
- reference configuration JSON syntax

## Project status

Open-Cursor now has a hardened localhost boundary, reproducible installation, managed bridge lifecycle, real process-level SSE streaming, request-scoped cancellation, execution limits, basic observability, and English/Japanese routing heuristics.

The next priorities are:

1. redesign `collaborative` mode into a draft → critique → synthesis workflow instead of merely combining two independent answers
2. render structured per-agent/phase metadata in the Cursor chat UI
3. load and validate runtime configuration from `config/bridge.json` rather than keeping it reference-only
4. add release packaging, upgrade/migration handling, and installation smoke tests
5. add optional repository-context summarization so agents receive a compact project map before expensive tasks

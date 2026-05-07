```markdown
# AGENTS.md

This file is the primary reference for any coding agent (or human) working on this
codebase. Read it fully before making changes. It covers architecture, data flow,
conventions, critical rules, and known gotchas.

---

## What This Project Is

pi-forge is a browser UI for the pi coding agent (github.com/badlogic/pi-mono).
It is an HTTP server that embeds the `@mariozechner/pi-coding-agent` SDK and exposes
it to a browser over REST + Server-Sent Events.

It is NOT a reimplementation of the agent, tools, session logic, or LLM communication.
All of that comes from the pi SDK. This project is the HTTP bridge and the UI on top.

Single-tenant by design. One container, one workspace root, one user. No multi-user
auth or isolation is needed or planned.

---

## Repository Layout

```
pi-forge/
├── packages/
│   ├── server/               # Fastify HTTP server (Node.js + TypeScript)
│   │   ├── src/
│   │   │   ├── index.ts          # App entry: registers plugins + routes, starts server
│   │   │   ├── config.ts         # All env var reads — import config from here, nowhere else
│   │   │   ├── auth.ts           # JWT generation and verification
│   │   │   ├── session-registry.ts  # In-memory AgentSession store — THE central module
│   │   │   ├── sse-bridge.ts     # AgentSessionEvent → SSE serialization
│   │   │   ├── project-manager.ts   # projects.json read/write
│   │   │   ├── config-manager.ts    # pi config files read/write (models/auth/settings)
│   │   │   ├── file-manager.ts      # Workspace filesystem operations
│   │   │   ├── git-runner.ts        # git command execution wrapper
│   │   │   ├── turn-diff-builder.ts # Aggregate file diff from session turn
│   │   │   ├── file-searcher.ts     # Workspace ripgrep wrapper (file content search)
│   │   │   ├── pty-manager.ts       # node-pty lifecycle management for terminal
│   │   │   └── routes/
│   │   │       ├── auth.ts
│   │   │       ├── projects.ts
│   │   │       ├── sessions.ts
│   │   │       ├── stream.ts
│   │   │       ├── prompt.ts
│   │   │       ├── control.ts
│   │   │       ├── config.ts
│   │   │       ├── files.ts
│   │   │       ├── git.ts
│   │   │       ├── terminal.ts
│   │   │       └── health.ts
│   │   └── package.json
│   └── client/               # React + Vite frontend (TypeScript)
│       ├── src/
│       │   ├── main.tsx
│       │   ├── App.tsx
│       │   ├── lib/
│       │   │   ├── api-client.ts     # Typed fetch wrapper — all HTTP calls go here
│       │   │   ├── sse-client.ts     # SSE connection manager
│       │   │   └── auth-client.ts    # Token storage and attachment
│       │   ├── store/
│       │   │   ├── auth-store.ts
│       │   │   ├── project-store.ts
│       │   │   └── session-store.ts
│       │   └── components/
│       └── package.json
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
├── tests/                    # Integration test scripts (run via `npm run test:ci`)
├── AGENTS.md                 # This file
└── CLAUDE.md                 # Symlink to AGENTS.md or identical copy
```

---

## Build & Dev Commands

```bash
npm install          # Install all workspace deps (run from root)
npm run build        # Compile server TS + Vite client build
npm run dev          # Start both: server (tsx watch) + client (vite dev server)
npm run check        # tsc typecheck + eslint + prettier (requires npm run build first)
npm run test:ci      # Loop every tests/test-*.ts (skips test-docker; ~40 s)
npm run test         # Same loop, no skip list (run before tagging a release)

# Single test (debugging or `--only` filter):
npx tsx tests/test-session.ts
scripts/run-tests.sh --only session,terminal
```

In dev mode, the Vite dev server runs on :5173 and the Fastify server on :3000.
`@fastify/cors` allows all origins in development. In production (Docker), Fastify
serves the built Vite output as static files — single port, no CORS needed.

---

## Environment Variables

All reads are centralized in `packages/server/src/config.ts`. Never read
`process.env` directly in any other file — always import from config.

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Fastify listen port |
| `WORKSPACE_PATH` | `~/.pi-forge/workspace` | Where project code lives. Docker image overrides to `/workspace` (host bind-mount). Point at an existing dir like `~/Code` to reuse code already on disk. |
| `PI_CONFIG_DIR` | `~/.pi/agent` | Pi SDK config dir (auth/models/settings — owned by the SDK). Docker image points this at `/home/pi/.pi/agent`. |
| `FORGE_DATA_DIR` | `~/.pi-forge` | Forge-owned state (projects.json). Separated from `PI_CONFIG_DIR` so we don't write our state into the SDK's directory. Docker image points this at `/home/pi/.pi-forge`. |
| `SESSION_DIR` | `${WORKSPACE_PATH}/.pi/sessions` | JSONL session storage |
| `UI_PASSWORD` | (unset) | If set, enables browser JWT auth |
| `API_KEY` | (unset) | If set, enables static bearer token for programmatic access |

If both `UI_PASSWORD` and `API_KEY` are unset, auth is disabled entirely.
In production you should set at minimum `API_KEY`. Setting both is fine and common —
browser users log in with the password, scripts use the API key.

---

## Programmatic API

All routes are under `/api/v1/`. The same routes used by the browser UI are usable
by any HTTP client. Interactive docs are at `/api/docs` (Swagger UI). The raw
OpenAPI JSON spec is at `/api/docs/json`.

Authentication for programmatic clients: set `API_KEY` in the environment and
include it as `Authorization: Bearer <key>` on every request.

### Minimal curl workflow

```bash
BASE=http://localhost:3000
KEY=your-api-key

# 1. List projects
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/projects

# 2. Create a session under a project
SESSION=$(curl -s -X POST $BASE/api/v1/sessions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<projectId>"}' | jq -r '.sessionId')

# 3. Send a prompt (fire and forget — response comes via SSE)
curl -s -X POST $BASE/api/v1/sessions/$SESSION/prompt \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Write a test suite for the auth module"}'

# 4. Stream the response (ctrl+c when done)
curl -N -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/stream

# 5. Abort if needed
curl -X POST $BASE/api/v1/sessions/$SESSION/abort \
  -H "Authorization: Bearer $KEY"
```

### SSE event stream format

Each SSE message is a single `data:` line followed by two newlines:
```
data: {"type":"agent_start","sessionId":"..."}

data: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}

data: {"type":"agent_end","sessionId":"..."}

```

Clients should parse `event.type` and handle each type. See `docs/sse-events.md`
for the full event catalogue with example payloads. Unknown event types should be
silently ignored — new types may be added in future versions.

### OpenAPI spec

Every route has JSON Schema on its request body and response. `@fastify/swagger`
collects these automatically — do not maintain a separate spec file. When adding a
new route, always include:
- `schema.description` — one plain English sentence
- `schema.body` — for POST/PUT routes
- `schema.response` — at minimum `{ 200: {...}, 400: {...} }`
- `schema.tags` — one of: `sessions`, `projects`, `config`, `files`, `git`, `auth`

The preHandler auth hook is applied globally. The `/api/v1/health` and
`/api/v1/auth/*` routes are explicitly excluded from the auth hook and marked
with `security: []` in their schema to reflect this in the spec.

---

## Architecture & Data Flow

### Request → Agent → Browser

```
Browser
  │
  ├─ POST /api/v1/sessions/:id/prompt  ─────────────────────────────────┐
  │                                                                   │
  │                                               session-registry.ts │
  │                                               session.prompt()    │
  │                                                    │              │
  │                                           pi SDK agent loop      │
  │                                                    │              │
  │                                           AgentSessionEvents      │
  │                                                    │              │
  │                                             sse-bridge.ts         │
  │                                                    │              │
  └─ GET /api/v1/sessions/:id/stream  ◄──────── SSE stream ◄────────────┘
```

### Session Lifecycle

1. `POST /api/sessions` → `session-registry.ts createSession(projectId, path)`
   → calls `createAgentSession()` from pi SDK with file-backed `SessionManager`
   → wires `session.subscribe()` to fan out events to all SSE clients
   → stores `LiveSession` in in-memory registry Map

2. On server restart, sessions are NOT in the registry. They are lazy-loaded:
   `GET /api/v1/sessions/:id/stream` calls `resumeSession()` if id is missing from
   registry. `resumeSession()` calls `createAgentSession()` with the existing
   JSONL file path, restoring full message history.

3. `discoverSessionsOnDisk(projectPath)` scans the sessions directory and parses
   only the first line (header) of each `.jsonl` file to build the session list
   shown in the sidebar — does NOT load full sessions into memory eagerly.

### SSE Snapshot on Connect

Every new SSE client immediately receives a `snapshot` event:
```json
{
  "type": "snapshot",
  "sessionId": "...",
  "projectId": "...",
  "messages": [...],
  "isStreaming": false
}
```
This hydrates the client's message list on connect or reconnect without needing a
separate HTTP call. The frontend SSE client must handle this event before all others.

### Prompt with Attachments

`POST /api/v1/sessions/:id/prompt` accepts both JSON and `multipart/form-data`:
- JSON: `{ text, streamingBehavior? }` — plain text prompt, no attachments
- Multipart: `text` field + `attachments[]` files
  - Image files → base64 → passed as `images` array to `session.prompt()`
  - Text files → read content → prepended to prompt as fenced code block

`session.prompt()` is always fire-and-forget from the HTTP perspective — returns
202 immediately. The actual response streams over SSE.

---

## Critical Conventions

**1. All AgentSession interactions go through session-registry.ts.**
Never import `AgentSession` or call `createAgentSession()` directly in route
handlers. Routes call functions on the registry. This is the single source of truth
for live session state.

**2. All filesystem operations go through file-manager.ts or git-runner.ts.**
Never call `fs.*` directly in route handlers. `file-manager.ts` enforces path
validation — all other code trusts it.

**3. Path validation is always enforced in file-manager.ts.**
Every method in `file-manager.ts` validates the target path is inside the project
root before executing. Route handlers must NEVER trust raw `path` query params or
body fields without running them through file-manager. Return 403 for any traversal
attempt — do not throw, do not 500.

**4. Auth config reads are read-only in routes.**
`config-manager.ts readAuthSummary()` returns ONLY which providers have credentials
(a boolean presence map plus the SDK-reported source). It NEVER returns actual key
values. This is enforced in `config-manager.ts` itself. Do not add any code path
that returns raw key values.

**5. All config file writes are atomic.**
Write to a `.tmp` file first, then `fs.rename()` to the target. This prevents
half-written config files on crash. This pattern is already in `config-manager.ts`
and `project-manager.ts` — follow it for any new file writes.

**6. No default exports.**
Use named exports everywhere in both server and client packages. This makes
refactoring and import tracing easier.

**7. Fastify plugins and routes are registered in index.ts only.**
Do not call `fastify.register()` in route files. Route files export a Fastify
plugin function; `index.ts` registers them with their route prefix.

**8. React state only through Zustand stores.**
Components do not hold significant local state. API calls are made through
`api-client.ts`. SSE events are dispatched into stores via `sse-client.ts`.
Components read from stores and dispatch actions.

**9. All HTTP calls from the client go through api-client.ts.**
Never call `fetch()` directly in components. `api-client.ts` handles auth token
attachment and 401 redirect. This is also where request/response types are defined.

**10. Auth is global with explicit opt-out — not opt-in.**
A single `preHandler` hook in `index.ts` enforces JWT/API-key auth for every
route under `/api/v1/`. Public routes opt out by setting
`config: { public: true }` on the route definition (currently:
`/api/v1/health`, `/api/v1/auth/*`, and `/api/v1/ui-config`). Adding a new
public route REQUIRES both: (a) the `config: { public: true }` opt-out, and
(b) `security: []` in the route's schema so the OpenAPI spec at `/api/docs`
reflects the public access. Forgetting either is a security/spec bug.

---

## Key Package Reference

### Server

| Package | Purpose |
|---|---|
| `@mariozechner/pi-coding-agent` | `AgentSession`, `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry` |
| `@mariozechner/pi-agent-core` | `Agent`, `AgentSessionEvent` union type, `AgentMessage` types |
| `@mariozechner/pi-ai` | `getModel`, provider abstraction |
| `fastify` | HTTP server |
| `@fastify/static` | Serve built client files in production |
| `@fastify/cors` | CORS for dev (disabled in prod) |
| `@fastify/multipart` | File upload parsing for prompt attachments |
| `@fastify/rate-limit` | Login endpoint rate limiting |
| `@fastify/swagger` | Auto-generate OpenAPI spec from route schemas |
| `@fastify/swagger-ui` | Serve interactive API docs at `/api/docs` |
| `@fastify/websocket` | WebSocket support for terminal PTY (Phase 11) |
| `jsonwebtoken` | JWT sign/verify for browser auth |
| `node-pty` | PTY for integrated terminal (Phase 11) |

### Client

| Package | Purpose |
|---|---|
| `zustand` | State management |
| `react-markdown` + `remark-gfm` | Markdown rendering in chat |
| `react-diff-view` | Diff rendering — unified and side-by-side |
| `prism-react-renderer` | Syntax highlighting for diffs |
| `codemirror` + `@codemirror/*` | File editor |
| `@codemirror/theme-one-dark` | Editor theme |
| `xterm` + `@xterm/addon-fit` + `@xterm/addon-web-links` | Terminal emulator (Phase 11) |
| `lucide-react` | Icons throughout the UI |
| `vite-plugin-pwa` | PWA manifest + service worker (Phase 8) |

---

## Pi SDK Key Facts

These are facts about the pi SDK that are easy to get wrong:

- `createAgentSession()` is async. It must be awaited before the session is usable.
- `session.prompt()` is also async but resolves only after the ENTIRE agent run
  finishes (including retries and compaction). Use SSE for streaming output — do
  not await `prompt()` in a route handler that needs to return quickly. Call it
  without await and return 202 immediately.
- `session.subscribe()` returns an unsubscribe function. Call it on session dispose.
- `AgentSessionEvent` is a union type. Always switch on `event.type` — do not
  assume the shape of an event without checking the type first.
- Sessions stored as JSONL have a tree structure. The first line is always the
  session header: `{ type: "session", version, id, timestamp, cwd }`. Parse this
  to get metadata without loading the full file.
- `ToolResultMessage.details` for `edit` tool calls contains the unified diff string
  directly. Extract it with `event.details?.diff` or similar — check the actual
  type definition in `node_modules/@mariozechner/pi-coding-agent/dist/` for the
  exact field name before using it.
- Pi does NOT have native sub-agent support in the SDK — there is no
  "child session created" event. Sub-agent integration is provided by the
  community [`pi-subagents`](https://github.com/nicobailon/pi-subagents)
  plugin and surfaced in pi-forge by: (a) discovering child JSONLs at
  `<sessionDir>/<projectId>/<basename>/<runId>/run-N/session.jsonl` in
  `discoverSessionsOnDisk`, (b) refetching the project session list on
  `tool_execution_end` for `toolName === "subagent"` and on parent dispose
  (`session-store.ts`), (c) cascade-deleting the parent's sibling subagent
  dir in `deleteColdSession`. The plugin shells out to the `pi` CLI; the
  Docker image puts it on PATH via `/app/node_modules/.bin`.
- `session.fork()` creates a new session FILE. The new session ID is returned.
  The registry must then load this new session before it can be used.
- `session.navigateTree()` operates IN-PLACE on the current session file. It does
  not create a new session.
- Pi does NOT have native MCP (Model Context Protocol) support. MCP is provided
  by pi-forge itself: `packages/server/src/mcp/manager.ts` connects to
  remote MCP servers via `@modelcontextprotocol/sdk`, translates each
  advertised tool into a pi `ToolDefinition`, and feeds the aggregate into
  every `createAgentSession` call as `customTools`. See
  [`docs/mcp.md`](./docs/mcp.md) for the user-facing surface; the doc-comment
  at the top of `mcp/manager.ts` is the integration contract.

---

## Config Files

The SDK and pi-forge own DIFFERENT directories. Never put pi-forge
state into `PI_CONFIG_DIR` or vice versa.

**`PI_CONFIG_DIR` — pi SDK territory.** Managed by `config-manager.ts`.
Never write directly from routes.

| File | Purpose |
|---|---|
| `PI_CONFIG_DIR/models.json` | Custom providers: vLLM, LiteLLM, Ollama, any OpenAI-compatible endpoint |
| `PI_CONFIG_DIR/auth.json` | API keys and OAuth tokens for built-in providers |
| `PI_CONFIG_DIR/settings.json` | Default model, thinking level, steering/followUp mode |

**`FORGE_DATA_DIR` — pi-forge territory.** Managed by `project-manager.ts`.

| File | Purpose |
|---|---|
| `FORGE_DATA_DIR/projects.json` | pi-forge project registry (id/name/path/createdAt) |

`PI_CONFIG_DIR` defaults to `~/.pi/agent`; `FORGE_DATA_DIR` defaults
to `~/.pi-forge`. The Docker compose setup mounts the host's
`~/.pi/agent` into `/home/pi/.pi/agent` so the container inherits the
host's provider config and API keys, and binds a SEPARATE host path
into `/home/pi/.pi-forge` so the container has its own project
list (host vs container projects don't bleed unless you point both
mounts at the same host path on purpose).

**Legacy migration:** earlier versions stored `projects.json` inside
`PI_CONFIG_DIR`. `project-manager.ts` runs a one-time `rename()` on
first read to move it into `FORGE_DATA_DIR` if the new location
is empty.

**Export / import** (`config-export.ts`, `Settings → Backup` tab):
`GET /api/v1/config/export` streams a flat `.tar.gz` containing
`mcp.json`, `settings.json`, and `models.json`. `POST /api/v1/config/
import` accepts a multipart upload of the same shape and writes each
file atomically. Three deliberate exclusions: `auth.json` (provider
keys / OAuth tokens — sensitive enough that bundling them into a
download the user might forward by accident is the wrong default),
`projects.json` (paths are installation-bound), and the auto-
generated `jwt-secret` / `password-hash` (also installation-bound).
Import is all-or-nothing: every accepted file must parse as JSON
before any rename runs, so a corrupted entry can't half-restore.

---

## Project Data Model

```typescript
interface Project {
  id: string;        // UUID — generated by project-manager.ts on creation
  name: string;      // Display name
  path: string;      // Absolute path, e.g. /workspace/my-repo
  createdAt: string; // ISO 8601 timestamp
}
```

Projects are stored in `FORGE_DATA_DIR/projects.json` as a JSON array.
A session belongs to a project when its `cwd` matches the project's `path`.
`WORKSPACE_PATH` is the root that the folder picker defaults to and the boundary
that all project paths must be inside. Reject any project path outside
`WORKSPACE_PATH` with a 403 — never with a 500.

---

## LiveSession Data Model

```typescript
interface LiveSession {
  session: AgentSession;   // pi SDK session object
  sessionId: string;       // Matches session.sessionId — UUID from JSONL header
  projectId: string;       // Which project this session belongs to
  workspacePath: string;   // Absolute project path — the cwd for tool execution
  clients: Set<SSEClient>; // All currently connected SSE listeners
  createdAt: Date;
  lastActivityAt: Date;    // Updated on every AgentSessionEvent
}
```

The registry is `Map<sessionId, LiveSession>`. It is an in-memory singleton in
`session-registry.ts`. There is no database. Sessions survive server restart because
their JSONL files persist on disk — the registry is rebuilt lazily as clients connect.

---

## SSE Event Types

The following `AgentSessionEvent` types are forwarded to browser clients.
All others are filtered out in `sse-bridge.ts`.

| Type | When | UI action |
|---|---|---|
| `snapshot` | On SSE connect | Hydrate full message list |
| `agent_start` | Agent begins processing | Show thinking spinner |
| `agent_end` | Agent finishes | Hide spinner, enable input, refresh git status |
| `turn_start` | LLM call begins | (internal, track for context inspector) |
| `turn_end` | LLM call ends | (internal) |
| `message_start` | New assistant message begins | Create message bubble |
| `message_update` | Token delta or content update | Append to streaming message |
| `message_end` | Assistant message complete | Finalize message |
| `tool_execution_start` | Tool begins | Show tool badge |
| `tool_execution_update` | Tool streaming output | Update tool output |
| `tool_execution_end` | Tool complete | Finalize tool block |
| `tool_call` | Tool invoked (pre-execution) | (can be used for permission UI) |
| `tool_result` | Tool result received | Render result block |
| `queue_update` | Steer/followUp queue changed | Show queued message badges |
| `compaction_start` | Context compaction begins | Show compaction banner |
| `compaction_end` | Compaction complete | Hide banner |
| `auto_retry_start` | Auto-retry triggered | Show retry indicator + countdown |
| `auto_retry_end` | Retry finished | Hide retry indicator |

---

## Error Handling Patterns

**Route handlers:**
- Session not found → 404 `{ error: "session_not_found" }`
- Path outside project root → 403 `{ error: "path_not_allowed" }`
- Validation failure → 400 (Fastify schema validation handles this automatically)
- SDK error (agent crash, LLM error) → 500 `{ error: "agent_error", message }`
- Git command failure → 200 with `{ success: false, error: string }` — git errors
  are user-visible events, not server errors

**Never:**
- Throw unhandled errors in route handlers — always catch and return structured responses
- Return raw `stderr` from git or bash commands to the client — sanitize first
- Return stack traces to the client in production

**SSE errors:**
If the SSE connection drops, the client auto-reconnects with exponential backoff
(implemented in `sse-client.ts`). On reconnect, the snapshot event re-hydrates
state. No special server handling needed for dropped SSE connections — the server
simply removes the client from the `LiveSession.clients` Set on the `close` event.

---

## File Operations Safety Rules

1. All paths from the client are treated as untrusted until validated by
   `file-manager.ts`.
2. `file-manager.ts` resolves paths with `path.resolve()` and checks they start
   with the project root using `startsWith()` AFTER resolving. This prevents
   `../../../etc/passwd` style traversal.
3. Max file read size: 5MB. Larger files return a truncation notice.
4. `getTree()` skips: `node_modules`, `.git`, `dist`, `build`, `__pycache__`,
   `.next`, `.nuxt`, `coverage`, `.vite`, `.turbo`, `.cache`. Max depth: 6 levels.
5. Delete operations on non-empty directories are rejected — return a helpful error
   asking the user to delete contents first. Do not implement recursive force-delete.

---

## Terminal (Phase 11)

The integrated terminal uses `node-pty` on the server and `xterm.js` on the client,
connected over a WebSocket (not SSE — terminals need bidirectional communication).

- One PTY per terminal tab, spawned with `cwd` set to the project path
- Default shell: `process.env.SHELL || '/bin/sh'`
- WebSocket endpoint: `ws://localhost:3000/api/v1/terminal?projectId=<id>&tabId=<optional>&token=<jwt-or-api-key>`
  - `projectId` is required; `tabId` is the stable client-side tab identifier used for reattach across reconnects; `token` is required when auth is enabled (browsers can't attach `Authorization` headers on WebSocket upgrades).
- Fastify WebSocket support via `@fastify/websocket`
- PTY resize messages sent from client to server when the xterm container resizes
- On client disconnect, the PTY is **detached** and kept alive briefly so an immediate reconnect with the same `tabId` can reattach without losing scrollback. The PTY is killed only after the detach grace window or on explicit close — `pty-manager.ts` owns the lifecycle.
- Do NOT share PTY instances across clients or sessions — one PTY per `tabId`, one active WebSocket per PTY at a time.

---

## Diff Rendering

Both the git panel and inline edit tool results use `react-diff-view`. The unified
diff format produced by `git diff` and by pi's `edit` tool are identical — the same
renderer handles both.

`turn-diff-builder.ts` reconstructs the turn diff by:
1. Walking `session.messages` backward from the latest `agent_end` to the prior
   `agent_start`, collecting all `ToolResultMessage` where `toolName` is `write`
   or `edit`
2. For `edit` — extract the unified diff from `ToolResultMessage.details`
3. For `write` — read the current file from disk and diff against an empty string
   (new file) or prior content if available
4. Group by file path, merge multiple edits to the same file in order

---

## Testing Approach

No JS test framework. Each script under `tests/` is a standalone tsx file
that boots its own server in-process (or imports the registry directly), drives
it via fetch / WebSocket, prints PASS/FAIL per assertion, and exits 0 if all
pass or 1 on any failure. Each script is self-contained — `mkdtemp`s its own
WORKSPACE_PATH / PI_CONFIG_DIR / FORGE_DATA_DIR, runs, and cleans up.

### Running tests

Use the runner — never enumerate scripts by hand. The single most common
mistake on this codebase has been "I touched X so I'll only run test-X" while
neighboring tests silently rotted. The runner exists to make "run them all"
the path of least resistance.

```bash
npm run test:ci                      # CI loop (skips test-docker)
npm run test                         # Local loop (no CI skip list)
scripts/run-tests.sh --only session  # Single or comma-separated subset
scripts/run-tests.sh --skip docker,attachments
PI_TEST_LIVE_PROMPT=1 npm run test   # Enables optional live-LLM branches
                                     # in test-session/sse/api (needs a
                                     # configured pi provider)
```

The runner stops on the first failure (downstream tests sharing global state
just produce noise once an upstream broke), prints per-test wall time, and
finishes with a PASS/FAIL summary. Run it locally before opening a PR — CI
runs `npm run test:ci` on every PR via `.github/workflows/ci.yml`.

### What runs in CI vs not

CI (ubuntu-latest, free runner): every `tests/test-*.ts` except those in the
runner's `CI_SKIP` list. Currently that's just **test-docker**, which builds
the production image (2-5 min cold) and is brutal as a per-PR gate; run it
locally before tagging a release.

LLM-gated branches: a few scripts have an optional "send a real prompt to the
agent" tail conditioned on `PI_TEST_LIVE_PROMPT === "1"`. These never run in
CI (the env var isn't set) and require a configured pi provider to run
locally. The non-LLM portions of those scripts always run.

### When you change product behavior, update the test in the same PR

The recurring failure mode on this codebase has been: refine a route's error
codes / change an on-disk format / harden a default, then merge without
touching the integration test. The test's stale assertion goes unnoticed
because no one is iterating the test directory. Months later someone runs the
suite and finds 6 broken tests with no obvious bisect signal.

The fix is procedural: when you change a server-visible contract — error
codes, response shapes, on-disk file format, default behavior — find the
integration test that exercises it (`grep -l <code-or-shape> tests/`) and
update it in the same PR. The runner makes verifying easy: `npm run test:ci`
should be green at PR-merge time, every time.

### Gotchas to know about before writing a new test

- **Project paths are realpath'd on creation.** `project-manager.createProject`
  resolves the input path through `realpath` before storing, so symlinks
  can't bypass the workspace boundary. On macOS that turns the test's
  `mkdtemp(...)` path (`/var/folders/...`) into the canonical form
  (`/private/var/folders/...`). Tests that send file ops with the un-realpath'd
  path get rejected by file-manager as "outside the project root." Capture the
  canonical path from the create response and use it for HTTP requests
  (`tests/test-files.ts` shows the pattern). Setup ops via Node fs against
  the un-realpath'd path are fine — only HTTP-bound paths matter.
- **`disposeSession` is async.** It awaits an in-flight LLM-call abort with
  a 5 s ceiling before tearing down. Always `await` it, or downstream
  assertions race the dispose. Dispose-then-immediate-resume on the same id
  hits a 1.5 s tombstone (`TOMBSTONE_MS`) — sleep through it.
- **Initial-login JWTs are scoped.** With `REQUIRE_PASSWORD_CHANGE=true`
  (default), the JWT issued by `/auth/login` is restricted to
  `POST /auth/change-password`. Tests that just want a "valid JWT passes
  auth" assertion should set `REQUIRE_PASSWORD_CHANGE=false` in the spawned
  server's env.
- **Skills overrides use pattern syntax.** `settings.skills` is a list of
  `!name` (exclude) / `+name` (force-include) patterns, NOT bare names.
  Skills are enabled by default; absence of `!name` is the signal.

### Adding a new test script

Drop a `tests/test-<feature>.ts` that:
1. `mkdtemp`s its own dirs and sets WORKSPACE_PATH / PI_CONFIG_DIR /
   FORGE_DATA_DIR / SESSION_DIR before importing `dist/index.js`.
2. Boots the server via `buildServer()` from the compiled module (or spawns
   a child process — see `tests/test-terminal.ts` for the spawn pattern when
   the test needs env that's read at module load).
3. Prints `PASS`/`FAIL` per assertion using the `assert(label, ok, detail?)`
   helper local to each script. Exits 1 if `failures > 0`.
4. Cleans up its temp dirs in a `try/finally`.

The runner picks up the new file automatically — no registration needed.

### Test-script catalogue

Every script's filename matches the area it covers. Skim the doc-comment at
the top for what each verifies; the runner output prints them in order.

```
test-api          REST surface + OpenAPI spec
test-attachments  multipart prompt uploads + size/type guards
test-auth         password / API-key / JWT flows
test-config       models.json / auth.json / settings.json / skills overrides
test-diff         per-turn diff aggregation
test-docker       full Docker image build + smoke (CI-skipped)
test-files        file browser + write/read/move/delete + path safety
test-fork         session.fork + tree navigation
test-git          git wrapper (status, diff, stage, commit, push)
test-mcp          MCP server registry + customTools wiring
test-projects     project CRUD + workspace boundary enforcement
test-pty-reattach terminal WS reattach across drops
test-scaffold     baseline server boots + health + auth gate
test-search       file content search via ripgrep
test-session      AgentSession registry + dispose / resume / fork
test-sse          SSE event stream + snapshot-on-connect
test-terminal     PTY WebSocket + idle-reap
```

---

## Known Limitations & Deferred Work

- **GitHub integration** — GitHub OAuth, PR creation, issue context. Deferred.
- **Multi-agent parallel worktrees** — parallel agent runs against git worktrees.
  Not feasible with current pi SDK without significant custom work. Deferred.
- **Voice mode** — out of scope for this project.
- **Background push notifications** — browser push notifications for agent
  completion. Deferred to post-v1.
- **Hunk-level git staging** — Phase 12 implements file-level staging only.
  Hunk-level staging is v2 material.
```
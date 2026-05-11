# Architecture

The *what* and the *why* of pi-forge's architecture. The repo-level
[`CLAUDE.md`](../CLAUDE.md) covers the *how* (file-by-file reference,
conventions, do-nots).

## What pi-forge is

A self-hosted HTTP server + browser UI that embeds the
[`pi-coding-agent`](https://github.com/badlogic/pi-mono) SDK. **Not** a
reimplementation of the agent loop — that's all SDK. Pi-forge is the
bridge:

- Fastify HTTP server hosts the SDK as an in-process embedding
- REST + SSE under `/api/v1/` for project / session / file / git /
  config / upload CRUD and agent output streaming
- WebSocket under `/api/v1/terminal` for the integrated PTY
- React + Vite frontend consuming the same REST + SSE surface that a
  programmatic client would

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Browser                                 │
│                                                                      │
│  React + Vite UI (packages/client/)                                  │
│    ├─ ChatView / ChatInput — renders SDK stream, sends prompts       │
│    ├─ ProjectSidebar / SessionList — project + session navigation    │
│    ├─ FileBrowserPanel + EditorPanel — workspace files               │
│    ├─ SearchPanel / TurnDiffPanel / GitPanel / ContextInspectorPanel │
│    ├─ TerminalPanel — xterm.js + WebSocket to PTY                    │
│    ├─ SessionTreePanel — session branching navigator                 │
│    └─ InstallPrompt — mobile PWA install banner                      │
│                                                                      │
│  Zustand stores: auth, project, session, file, mcp, terminal,        │
│                  ui, ui-config                                       │
│  api-client/   — typed wrapper, ALL HTTP calls go here               │
│  sse-client.ts — ALL streaming goes here                             │
└──────────────────────────────────────────────────────────────────────┘
         │ HTTP (REST + SSE) + WebSocket (terminal only)
         │ All under /api/v1/
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Fastify (packages/server/)                     │
│                                                                      │
│  Boot:    index.ts (plugins + routes), cli.ts (argv → env), config.ts│
│  Auth:    auth.ts (JWT + scrypt), preHandler hook in index.ts        │
│                                                                      │
│  Session-state:  session-registry.ts — in-memory Map of LiveSession. │
│                  Single source of truth for live SDK state; ALL      │
│                  session interactions route through it.              │
│  Streaming:      sse-bridge.ts — AgentSessionEvent → SSE             │
│  Terminal:       pty-manager.ts — node-pty lifecycle, detach/reattach│
│                                                                      │
│  Filesystem:     file-manager.ts — every fs.* call, path-validated   │
│  Search:         file-searcher.ts — ripgrep + Node fallback          │
│  Git:            git-runner.ts                                       │
│  Pi config:      config-manager.ts (auth/models/settings.json)       │
│  Forge state:    project-manager.ts (projects.json),                 │
│                  {skill,tool,prompt}-overrides.ts                    │
│  MCP:            mcp/ — connects to remote MCP servers, advertises   │
│                  their tools to the SDK as customTools               │
│  Resources:      agent-resource-loader.ts — merges skills + tools +  │
│                  prompts into createAgentSession                     │
│  Diffs:          turn-diff-builder.ts                                │
│                                                                      │
│  Routes (under /api/v1/):                                            │
│    auth, config, control, exec, files, git, health, mcp, projects,   │
│    prompt, sessions, stream, terminal                                │
│                                                                      │
│         ┌────────────────────────────────────────────────────────┐   │
│         │ embedded:                                              │   │
│         │   @earendil-works/pi-coding-agent — AgentSession,      │   │
│         │     SessionManager, AuthStorage, ModelRegistry         │   │
│         │   @earendil-works/pi-agent-core   — Agent, messages    │   │
│         │   @earendil-works/pi-ai           — provider abstraction│  │
│         └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
         │ filesystem
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                            On-disk state                             │
│                                                                      │
│  ${WORKSPACE_PATH}/<project>/             — user code                │
│  ${SESSION_DIR}/<projectId>/*.jsonl       — session transcripts      │
│  ${FORGE_DATA_DIR}/                       — projects.json, mcp.json, │
│                                             {skill,tool,prompt}-     │
│                                             overrides.json,          │
│                                             jwt-secret, password-hash│
│  ${PI_CONFIG_DIR}/                        — auth.json, models.json,  │
│                                             settings.json (SDK-owned)│
└──────────────────────────────────────────────────────────────────────┘
         │ HTTPS
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   LLM providers + MCP servers                        │
│                                                                      │
│  Configured via models.json + auth.json + ${FORGE_DATA_DIR}/mcp.json │
└──────────────────────────────────────────────────────────────────────┘
```

## Request lifecycles

### Browser sends a prompt

```
Browser                Server                          SDK / Provider
   │                     │                                   │
   ├── POST /api/v1/sessions/:id/prompt ──▶                  │
   │   { text: "..." } or multipart/form-data                │
   │                     │                                   │
   │                     ├── session-registry.getSession()   │
   │                     │   returns LiveSession             │
   │                     │                                   │
   │                     ├── live.session.prompt(text) ─────▶│ async
   │                     │   (fire-and-forget; returns       │
   │                     │   only when the WHOLE agent run   │
   │                     │   finishes including retries +    │
   │                     │   compaction)                     │
   │                     │                                   │
   ◀── 202 Accepted ─────┤                                   │
   │   { accepted: true }│                                   │
   │                     │                                   │
   │                     ├── via sse-bridge.ts ──────────────│
   │   (already-open SSE │   AgentSessionEvent flowing       │
   │   connection)       │   into LiveSession.clients Set    │
   ◀── data: {type:"agent_start", ...}                       │
   ◀── data: {type:"message_update", delta:"Hello"}          │
   ◀── data: {type:"tool_execution_start", ...}              │
   ◀── data: {type:"tool_execution_end",   ...}              │
   ◀── data: {type:"message_update", delta:" world"}         │
   ◀── data: {type:"agent_end",     ...}                     │
```

The HTTP `POST /prompt` returns 202 immediately — the request is
fire-and-forget. The actual response streams over the already-open SSE
connection (`GET /api/v1/sessions/:id/stream`).

### SSE stream connect (cold session resume)

```
Browser                Server                         Disk
   │                     │                              │
   ├── GET /api/v1/sessions/:id/stream ──▶              │
   │                     │                              │
   │                     ├── getSession(id)             │
   │                     │   returns undefined          │
   │                     │   (not in in-memory          │
   │                     │   registry — server          │
   │                     │   restarted, or never        │
   │                     │   touched this session)      │
   │                     │                              │
   │                     ├── findSessionLocation(id) ──▶│ scans
   │                     │                              │ ${SESSION_DIR}
   │                     │                              │
   │                     ◀── { projectId, workspacePath }
   │                     │                              │
   │                     ├── resumeSession(id, ...) ────│ reads
   │                     │   creates LiveSession from    │ JSONL
   │                     │   existing JSONL              │
   │                     │                              │
   │                     ├── snapshot event ────────────│
   ◀── data: {type:"snapshot", messages:[...], isStreaming:false}
   │                     │                              │
   │   (subsequent events flow as they arrive)          │
```

### Server restart preserves sessions

The `LiveSession` registry is **in-memory**. On server restart it's
empty. Sessions survive because their JSONL files persist on disk; the
registry is rebuilt **lazily** as clients reconnect their SSE streams
(see "SSE stream connect" above).

`discoverSessionsOnDisk()` scans `${SESSION_DIR}` and parses **only the
first line** of each `.jsonl` (the session header) to populate the
sidebar's session list — no full sessions land in memory eagerly.

## Persistence model

Pi-forge is stateless server-side **except**:

| State | Storage | Survives restart? |
|---|---|---|
| Live `AgentSession` instances | `session-registry.ts` in-memory Map | **No** — lazy-rebuilt on next SSE connect |
| PTY processes | `pty-manager.ts` in-memory Map | **No** — killed on shutdown; tab list survives via localStorage |
| SSE client connections | `LiveSession.clients` Set | **No** — clients reconnect with exponential backoff |
| Everything else | `${FORGE_DATA_DIR}` + `${PI_CONFIG_DIR}` + `${SESSION_DIR}` + `${WORKSPACE_PATH}` | **Yes** |

The persistence detail (what each file is for, who owns it, atomic
write pattern) lives in
[`configuration.md`](./configuration.md#per-project-overrides).

## Threading + concurrency

Node.js single-threaded event loop; the SDK's agent loop runs on the
same loop. Most work is I/O. Where it matters:

- **Multipart upload** streams part bodies straight into
  `writeFileBytes` — full file never buffered in memory
- **File search** spawns `rg` as a subprocess; Node fallback walks with
  16-wide bounded concurrency
- **PTY data** flows `node-pty` → callback → WebSocket frame, no
  buffering beyond what xterm needs

## Invariants

The do-not / always-do rules for contributors live in
[`CLAUDE.md`](../CLAUDE.md#critical-conventions). The two that are
load-bearing for the architecture above:

- **All session interactions through `session-registry.ts`** — keeps
  the in-memory registry as the single source of truth for live SDK
  state. Without this, two callers could create overlapping
  `AgentSession`s for the same JSONL.
- **All filesystem ops through `file-manager.ts`** — keeps path
  validation and atomic writes in one place. Without this, a route
  bypassing the wrapper could traverse out of the project root.

The rest (no default exports, Zustand-only state, OpenAPI auto-spec
from route schemas, etc.) is in `CLAUDE.md`.

## See also

- [`docs/containers.md`](./containers.md) — Docker image, volumes,
  resource tuning
- [`docs/deployment.md`](./deployment.md) — private-network deploy
  recipes (reverse proxy, auth, optional TLS)
- [`docs/configuration.md`](./configuration.md) — pi config files, custom
  providers, MCP setup
- [`docs/sse-events.md`](./sse-events.md) — full SSE event catalogue
- [`docs/api-examples.md`](./api-examples.md) — REST + SSE programmatic
  examples in curl / Python / Node
- [`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md) — Kubernetes / OpenShift
  manifests + walkthroughs
- [`SECURITY.md`](../SECURITY.md) — threat model + vulnerability reporting

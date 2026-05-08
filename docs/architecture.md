# Architecture

This document is the deeper dive that the [`README.md`](../README.md) ASCII
diagram refers out to. For contributor-focused architecture rules
(conventions, "where does X live", code-organization invariants), see
[`CLAUDE.md`](../CLAUDE.md) at the repo root.

## What pi-forge is

A self-hosted HTTP server + browser UI that wraps the
[`pi-coding-agent`](https://github.com/badlogic/pi-mono) SDK. It is **not**
a reimplementation of the agent loop — all of that is the SDK. The
pi-forge is the bridge:

- Fastify HTTP server hosts the SDK as an in-process embedding
- REST routes for project / session / file / git / config / terminal /
  upload-download CRUD
- Server-Sent Events for streaming agent output
- WebSocket for the integrated terminal
- React + Vite frontend that consumes the same REST + SSE surface a
  programmatic client would

## Component map

```
┌──────────────────────────────────────────────────────────────────────┐
│                              Browser                                 │
│                                                                      │
│  React + Vite UI (packages/client/)                                  │
│    ├─ ChatView    — renders SDK message stream                       │
│    ├─ ChatInput   — sends prompts + attachments                      │
│    ├─ ProjectSidebar / SessionList — project + session navigation    │
│    ├─ FileBrowserPanel + EditorPanel — workspace files               │
│    ├─ SearchPanel + TurnDiffPanel + GitPanel + ContextInspectorPanel │
│    ├─ TerminalPanel — xterm.js + WebSocket to PTY                    │
│    └─ SessionTreePanel — session branching navigator                 │
│                                                                      │
│  Zustand stores: auth, project, session, file, terminal, ui-config   │
│  Single api-client.ts entry point for ALL HTTP calls                 │
│  Single sse-client.ts entry point for ALL streaming                  │
└──────────────────────────────────────────────────────────────────────┘
         │ HTTP (REST + SSE) + WebSocket (terminal only)
         │ All under /api/v1/
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       Fastify (packages/server/)                     │
│                                                                      │
│  index.ts               — plugin registration, auth pre-handler      │
│  config.ts              — single source of truth for env vars        │
│  auth.ts                — JWT sign / verify + API-key check          │
│                                                                      │
│  session-registry.ts    — IN-MEMORY Map<sessionId, LiveSession>.     │
│                           Single source of truth for live SDK state. │
│                           ALL session interactions route through.    │
│  sse-bridge.ts          — AgentSessionEvent → SSE serialization      │
│  pty-manager.ts         — node-pty lifecycle, attach/detach for      │
│                           reconnect-survives-page-refresh            │
│  file-manager.ts        — every fs.* call. Path validation, atomic   │
│                           writes, upload checksum, download streaming│
│  file-searcher.ts       — ripgrep + Node fallback, project-scoped    │
│  git-runner.ts          — git CLI wrapper                            │
│  config-manager.ts      — pi config files (auth/models/settings)     │
│  project-manager.ts     — projects.json CRUD + cascade-delete        │
│  turn-diff-builder.ts   — aggregate diffs from a session turn        │
│                                                                      │
│  routes/{auth,projects,sessions,stream,prompt,control,config,        │
│          files,git,terminal,health}.ts                               │
│                                                                      │
│         ┌────────────────────────────────────────────────────────┐   │
│         │ embedded:                                              │   │
│         │   @earendil-works/pi-coding-agent (AgentSession,         │   │
│         │   SessionManager, AuthStorage, ModelRegistry)          │   │
│         │   @earendil-works/pi-agent-core (Agent, AgentMessage)    │   │
│         │   @earendil-works/pi-ai (provider abstraction)           │   │
│         └────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
         │ filesystem
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                            On-disk state                             │
│                                                                      │
│  ${WORKSPACE_PATH}/<project>/         — user code                    │
│  ${SESSION_DIR}/<projectId>/*.jsonl   — session transcripts          │
│  ${FORGE_DATA_DIR}/projects.json  — project registry             │
│  ${PI_CONFIG_DIR}/auth.json           — provider API keys            │
│  ${PI_CONFIG_DIR}/models.json         — custom provider definitions  │
│  ${PI_CONFIG_DIR}/settings.json       — agent defaults               │
└──────────────────────────────────────────────────────────────────────┘
         │ HTTPS
         ▼
┌──────────────────────────────────────────────────────────────────────┐
│                   LLM providers + MCP servers                        │
│                                                                      │
│  Anthropic / OpenAI / Google / OpenRouter / vLLM / Ollama / ...      │
│  (whatever you've configured in models.json + auth.json)             │
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

The pi-forge is stateless on the server side **except for**:

| State | Storage | Survives restart? |
|---|---|---|
| Project registry | `${FORGE_DATA_DIR}/projects.json` | Yes |
| Session transcripts | `${SESSION_DIR}/<projectId>/*.jsonl` | Yes |
| Pi auth + models + settings | `${PI_CONFIG_DIR}/*.json` (SDK-owned) | Yes |
| Live AgentSession instances | In-memory `session-registry.ts` Map | **No** — lazy-rebuilt on next SSE connect |
| PTY processes | In-memory `pty-manager.ts` Map | **No** — killed on shutdown; client tab list survives via localStorage |
| SSE client connections | In-memory `LiveSession.clients` Set | **No** — clients reconnect with backoff |
| Browser-side state | localStorage | Yes per-browser |

Atomic write pattern (`tmp + rename`) is used for every config write —
`config-manager.ts`, `project-manager.ts`, `file-manager.ts.writeFile`,
`writeFileBytes`. Half-written files never appear at the target path
even on a crash mid-write.

## Threading + concurrency

Node.js single-threaded event loop. The SDK's agent loop runs on the
same loop. Heavy CPU is rare; most work is I/O (HTTP to the LLM,
filesystem ops). For the few cases where it matters:

- **Multipart upload** streams part bodies straight into `writeFileBytes`
  without buffering the full file in memory
- **File search** (`file-searcher.ts`) uses `child_process.spawn(rg)`
  for ripgrep so the heavy work happens in a subprocess; the Node
  fallback walks with bounded concurrency (16-wide)
- **PTY data** flows from `node-pty` → callback → WebSocket frame, no
  buffering beyond what xterm needs

## Key invariants

1. **All filesystem ops go through `file-manager.ts`.** Routes never
   import `node:fs` directly. Every call validates the resolved path is
   inside the project root via `verifyPathSafe()` (lexical + realpath
   walk). Violations return 403, never 500.

2. **All session interactions go through `session-registry.ts`.** Routes
   never call `createAgentSession` or import `AgentSession` directly.
   The registry is the single source of truth for live SDK state.

3. **All config-file writes are atomic.** `tmp + rename` pattern in
   `config-manager.ts` and `project-manager.ts` (and the extension via
   `file-manager.writeFile`).

4. **Auth check is global** with explicit opt-out. `index.ts`'s
   `onRequest` hook checks every request unless the route declares
   `config: { public: true }`. New public routes must explicitly opt in.

5. **OpenAPI spec is auto-generated.** `@fastify/swagger` collects
   `schema.description` + `schema.body` + `schema.response` from each
   route registration. There is no separate spec file; Swagger UI at
   `/api/docs` reads from the live route definitions.

6. **Client routing through `api-client.ts`.** Components never call
   `fetch()`. The api-client handles auth-token attachment, JSON
   parsing, validator boundary, and 401 → logout flow.

## File-by-file reference

For the canonical "where does X live" answer, read [`CLAUDE.md`](../CLAUDE.md)'s
"Repository Layout" + "Critical Conventions" sections. They're the
contributor-side reference and stay in sync with the code.

This document covers the *what* and the *why*; CLAUDE.md covers the
*how* and the *do-not*.

## See also

- [`docs/CONTAINERS.md`](./CONTAINERS.md) — Docker image, volumes,
  resource tuning
- [`docs/deployment.md`](./deployment.md) — production deploy recipes
  (TLS, reverse proxy, auth)
- [`docs/configuration.md`](./configuration.md) — pi config files, custom
  providers, MCP setup
- [`docs/sse-events.md`](./sse-events.md) — full SSE event catalogue
- [`docs/api-examples.md`](./api-examples.md) — REST + SSE programmatic
  examples in curl / Python / Node
- [`kubernetes/DEPLOY.md`](../kubernetes/DEPLOY.md) — Kubernetes / OpenShift
  manifests + walkthroughs
- [`SECURITY.md`](../SECURITY.md) — threat model + vulnerability reporting

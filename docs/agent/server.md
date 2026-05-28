# Agent Notes: Server

Read this when changing Fastify setup, route plugins, session registry use, server-side auth, diagnostics, webhooks, orchestration, process/env config, or SDK session wiring.

## Build & Dev Commands

```bash
npm install          # Install all workspace deps (run from root)
npm run build        # Compile server TS + Vite client build
npm run dev          # Start both: server (tsx watch) + client (vite dev server)
npm run dev:remote   # Same as `dev` but binds both to 0.0.0.0 (LAN-accessible).
                     # Set UI_PASSWORD or API_KEY before exposing — auth is OFF
                     # by default in dev. macOS will prompt to allow incoming
                     # connections on first run.
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

## Server Critical Rules

- All `process.env` reads are centralized in `packages/server/src/config.ts`; operational config must not read env directly elsewhere.
- Every operational env var needs an equivalent CLI flag in `packages/server/src/cli.ts`.
- All AgentSession interactions go through `session-registry.ts`; never import `AgentSession` or call `createAgentSession()` directly in route handlers.
- Fastify plugins and routes are registered in `index.ts` only. Route files export plugin functions.
- Auth is global with explicit opt-out. Public routes require both `config: { public: true }` and `security: []` in schema.
- Auth config reads are read-only in routes; never return raw provider key values.
- All config file writes are atomic: write `.tmp`, then `rename()`.
- No default exports. Use named exports everywhere.

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

## Server Package Reference

## Key Package Reference

### Server

| Package | Purpose |
|---|---|
| `@earendil-works/pi-coding-agent` | `AgentSession`, `createAgentSession`, `SessionManager`, `AuthStorage`, `ModelRegistry` |
| `@earendil-works/pi-agent-core` | `Agent`, `AgentSessionEvent` union type, `AgentMessage` types |
| `@earendil-works/pi-ai` | `getModel`, provider abstraction |
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

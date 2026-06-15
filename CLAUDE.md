# AGENTS.md

This file is the always-loaded entrypoint for coding agents working on pi-forge.
Keep it short and reliable. Detailed guidance has been split into `docs/agent/*`;
read the relevant file(s) before touching that area.

---

## What This Project Is

pi-forge is a browser UI for the pi coding agent (`github.com/badlogic/pi-mono`).
It is an HTTP server that embeds the `@earendil-works/pi-coding-agent` SDK and
exposes it to a browser over REST + Server-Sent Events.

It is NOT a reimplementation of the agent, tools, session logic, or LLM
communication. Those come from the pi SDK. This project is the HTTP bridge and UI.

Single-tenant by design: one container, one workspace root, one user. No multi-user
auth or isolation is needed or planned.

---

## Required Reading by Task

Before making changes, read the most specific guide(s):

| If you are touching... | Read first |
|---|---|
| High-level architecture, repo layout, data flow, data models | `docs/agent/architecture.md` |
| Fastify server setup, route registration, auth hooks, config/env reads, SDK wiring | `docs/agent/server.md` |
| React components, Zustand stores, browser API calls, SSE client, themes, diff UI | `docs/agent/client.md` |
| REST routes, OpenAPI schemas, SSE event payloads, public/private route behavior | `docs/agent/api.md` |
| Sessions, prompt flow, resume/dispose/fork, attachments, pi SDK events, turn diffs | `docs/agent/sessions.md` |
| Env vars, CLI flags, `PI_CONFIG_DIR`, `FORGE_DATA_DIR`, backup import/export | `docs/agent/config.md` |
| File browser, workspace path validation, filesystem writes, git command wrapper | `docs/agent/filesystem.md` |
| Integrated terminal, PTY lifecycle, WebSocket auth, tab reattach | `docs/agent/terminal.md` |
| MCP registry, MCP custom tools, MCP truncation, MCP/tool overrides | `docs/agent/mcp.md` |
| Tests, test runner usage, contract changes, adding/updating integration tests | `docs/agent/testing.md` |
| Cutting a release, bumping versions, release notes, version bump PRs | `docs/agent/releases.md` |
| Reviewing or batching Dependabot PRs | `docs/agent/dependabot.md` |
| End-of-session PR description, handoff summary, merge-ready change report | `docs/agent/prs.md` |

Do not move existing files under `docs/` when updating these agent guides. Add or
edit files under `docs/agent/` only unless the product docs themselves must change.

---

## Build & Dev Commands

```bash
npm install          # Install all workspace deps (run from root)
npm run build        # Compile server TS + Vite client build
npm run dev          # Start server (:3000) + Vite client (:5173)
npm run dev:remote   # Bind both to 0.0.0.0; set auth before exposing
npm run check        # tsc + eslint + prettier (requires npm run build first)
npm run format:check # Prettier formatting check
npm run test:ci      # CI test loop (skips test-docker)
npm run test         # Local full loop (no CI skip list)

# Single/subset tests while debugging:
npx tsx tests/test-session.ts
scripts/run-tests.sh --only session,terminal
```

Use the runner before opening a PR. Run Prettier/format checks for docs-only or
config-only changes when full checks are unnecessary. When product behavior changes,
update the relevant integration test in the same PR.

---

## Critical Conventions

1. **No default exports.** Use named exports everywhere in server and client code.
2. **Operational env reads live only in `packages/server/src/config.ts`.** Every
   operational env var must also have a CLI flag in `packages/server/src/cli.ts`.
3. **All AgentSession interactions go through `session-registry.ts`.** Routes must
   not import `AgentSession` or call `createAgentSession()` directly.
4. **Routes are registered in `index.ts` only.** Route files export Fastify plugin
   functions; they do not call `fastify.register()` themselves.
5. **All filesystem operations go through `file-manager.ts` or `git-runner.ts`.**
   Route handlers must never trust raw path params without file-manager validation.
6. **Traversal attempts return 403, not 500.** Path validation is enforced in
   `file-manager.ts`.
7. **Auth is global with explicit opt-out.** Public routes require both
   `config: { public: true }` and `security: []` in the OpenAPI schema.
8. **Never return raw secrets.** `config-manager.ts readAuthSummary()` returns only
   provider presence/source, never actual key values.
9. **All config/data writes are atomic.** Write a `.tmp` file, then `rename()`.
10. **React state goes through Zustand stores.** Components should not hold
    significant local state.
11. **All browser HTTP calls go through `api-client.ts`.** Do not call `fetch()`
    directly in components.
12. **SSE clients must handle `snapshot` first** and silently ignore unknown event
    types.
13. **Git command failures are user-visible results.** Return 200 with
    `{ success: false, error }`, not a server error; sanitize stderr.
14. **Use structured route errors.** Session not found → 404; validation → 400;
    traversal → 403; SDK crash → 500 `{ error: "agent_error", message }`.
15. **Put git worktrees under `.worktrees/`.** Do not create worker worktrees
    elsewhere in the repository or workspace.

---

## Config Ownership Quick Reference

The SDK and pi-forge own different directories:

- `PI_CONFIG_DIR` (default `~/.pi/agent`) is pi SDK territory. Managed via
  `config-manager.ts`; do not write it directly from routes.
- `FORGE_DATA_DIR` (default `~/.pi-forge`) is pi-forge territory. Each file has a
  dedicated owner module such as `project-manager.ts`, `mcp/manager.ts`, or
  `webhooks/store.ts`.

Read `docs/agent/config.md` before changing either area.

---

## Pi SDK Facts That Are Easy To Get Wrong

- `createAgentSession()` is async and must be awaited.
- `session.prompt()` resolves only after the full agent run finishes. Prompt routes
  should fire-and-forget and return 202; output streams over SSE.
- `session.subscribe()` returns an unsubscribe function. Call it on dispose.
- `AgentSessionEvent` is a union. Always switch on `event.type`.
- Session JSONL first line is the header. Parse it for metadata without loading the
  whole file.
- `session.fork()` creates a new session file. `session.navigateTree()` mutates the
  current session file in place.
- Pi has no native MCP; pi-forge translates MCP tools into pi `customTools`.
- Pi has no native sub-agent support; pi-forge surfaces `pi-subagents` child JSONLs.

Read `docs/agent/sessions.md` and `docs/agent/mcp.md` for details.

---

## End-of-Session PR Summaries

When preparing a PR description or merge-ready handoff, read
`docs/agent/prs.md` and use its Summary / Usage / What changed / Test plan
structure.

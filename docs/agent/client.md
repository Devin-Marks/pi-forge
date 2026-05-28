# Agent Notes: Client

Read this when changing React components, Zustand stores, browser API calls, SSE client handling, themes, mobile behavior, diffs, or subagent UI parsing.

## Client Rules

- React state only through Zustand stores. Components do not hold significant local state.
- All HTTP calls from the client go through `packages/client/src/lib/api-client/`; never call `fetch()` directly in components.
- SSE events are dispatched into stores via `packages/client/src/lib/sse-client.ts`.
- The frontend SSE client must handle the `snapshot` event before all others.
- Unknown SSE event types should be silently ignored; new types may be added in future versions.

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

## Client Package Reference

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

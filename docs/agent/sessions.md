# Agent Notes: Sessions and Pi SDK

Read this when changing session creation/resume/dispose, prompt submission, attachments, compaction, forking, tree navigation, turn diffs, subagent discovery, or SDK event handling.

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
  type definition in `node_modules/@earendil-works/pi-coding-agent/dist/` for the
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
  [`docs/mcp.md`](../mcp.md) for the user-facing surface; the doc-comment
  at the top of `mcp/manager.ts` is the integration contract.

---

## Session Lifecycle
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

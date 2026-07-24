# SSE Event Reference

Server-Sent Events stream from `GET /api/v1/sessions/:id/stream`. Every
client (the React UI, your scripts, your dashboards) consumes the same
stream. This document catalogues every event type, full example payloads,
ordering guarantees, and how to consume the stream from Python and Node.

## Wire format

Standard SSE — one `data:` line per event with a JSON payload, blank
line between events:

```
data: {"type":"agent_start","sessionId":"..."}

data: {"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"Hello"}}

data: {"type":"agent_end","sessionId":"..."}

```

`Content-Type: text/event-stream`, `Cache-Control: no-cache,
no-transform`, `X-Accel-Buffering: no`. Reverse-proxy buffering must
be off — see [`deployment.md`](./deployment.md) for nginx / Caddy /
Traefik snippets.

## Connection lifecycle

```
Client                                                    Server
  │                                                          │
  ├── GET /api/v1/sessions/:id/stream ─────────────────────▶ │
  │   Authorization: Bearer <token>                          │
  │                                                          │
  │                                              getSession(id)
  │                                              or lazy resumeSession
  │                                                          │
  ◀── data: {"type":"snapshot",...} ──────────────────────── │
  │   (always first; hydrates client state)                  │
  │                                                          │
  │   (live events as they arrive)                           │
  ◀── data: {"type":"agent_start",...} ─────────────────────│
  ◀── data: {"type":"message_update",...} ─────────────────│
  ◀── data: {"type":"agent_end",...} ──────────────────────│
  │                                                          │
  │   (idle — connection stays open; next agent activity     │
  │    flows straight through)                               │
```

The server holds the connection open indefinitely; the client closes
by disconnecting. There is no server-side keepalive/heartbeat — long
idle periods on aggressive proxies may drop the connection. The
client's reconnect-with-backoff (described below) recovers
transparently.

## Always-first event: `snapshot`

Every new SSE connection receives a `snapshot` as its first event. This
hydrates a freshly-connected client's view without requiring a separate
HTTP call.

```json
{
  "type": "snapshot",
  "sessionId": "01J7...",
  "projectId": "proj_abc...",
  "messages": [
    { "role": "user", "content": "Refactor utils.ts", "timestamp": 1714398000000 },
    { "role": "assistant", "content": [{ "type": "text", "text": "Reading the file..." }], "usage": { ... }, ... }
  ],
  "isStreaming": false
}
```

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | Echoes the session id from the URL |
| `projectId` | string | The project this session belongs to |
| `messages` | `AgentMessage[]` | Full message history as the LLM sees it (post-compaction). Same shape as `GET /sessions/:id/messages`. |
| `isStreaming` | boolean | True if the agent is mid-run when you connect |

If `isStreaming: true`, expect `agent_end` (and possibly more
`message_update` deltas + tool events) shortly. Otherwise the next
events will arrive only when something happens (a `POST /prompt` or
`POST /steer` call).

## Agent lifecycle events

### `agent_start`

The agent has begun processing a turn. Fired before any
`message_start` / `message_update` / tool events for that turn.

```json
{
  "type": "agent_start",
  "sessionId": "01J7...",
  "timestamp": 1714398100000
}
```

UI action: show "thinking" indicator, disable input or change Send to
"Steer." `lastAgentStartIndex` is captured server-side at this moment to
bound "the latest turn" for the turn-diff route.

### `agent_end`

The agent has finished. Use this to refresh derived state (turn diff,
git status, context inspector, session tree).

```json
{
  "type": "agent_end",
  "sessionId": "01J7...",
  "timestamp": 1714398150000
}
```

UI action: hide thinking indicator, re-enable input, re-fetch
`/turn-diff`, refresh file tree, increment `agentEndCountBySession[id]`.

The session-store's `agentEndCount` is the canonical "the agent just
finished" trigger — components that need to react to agent completion
subscribe to this counter rather than the raw event.

## Message events

The agent's response streams as a sequence of `message_start` →
`message_update` → `message_end`. Multiple messages can flow per turn
(e.g., assistant text → tool call → tool result → assistant text again).

### `message_start`

```json
{
  "type": "message_start",
  "sessionId": "01J7...",
  "messageRole": "assistant"
}
```

### `message_update`

```json
{
  "type": "message_update",
  "sessionId": "01J7...",
  "assistantMessageEvent": {
    "type": "text_delta",
    "delta": "Hello"
  }
}
```

The `assistantMessageEvent` shape is from pi-ai's
`AssistantMessageEventStream`. Common variants:

| `assistantMessageEvent.type` | Payload |
|---|---|
| `text_delta` | `{ type: "text_delta", contentIndex, delta: "...", partial }` — append to streaming text |
| `thinking_delta` | `{ type: "thinking_delta", contentIndex, delta: "...", partial }` — thinking-block token |
| `toolcall_start` | `{ type: "toolcall_start", contentIndex, partial }` — tool-call block began |
| `toolcall_delta` | `{ type: "toolcall_delta", contentIndex, delta: "...", partial }` — JSON args streaming, when the provider exposes them |
| `toolcall_end` | `{ type: "toolcall_end", contentIndex, toolCall, partial }` — tool-call block complete |

The UI renders streaming text by accumulating `text_delta` deltas into
`streamingTextBySession[id]` (see `session-store.ts`). It also reads the
`partial` assistant message on `toolcall_*` updates to show an explicit
"generating tool call" indicator and any partial JSON args the SDK/provider
has exposed. Providers differ: Anthropic streams input JSON deltas, Google
currently emits the function-call args as a complete payload, and other
adapters may do either. pi-forge forwards what the SDK emits and does not
invent argument text before it exists.

### `message_end`

```json
{ "type": "message_end", "sessionId": "01J7..." }
```

### `tool_call`

Pre-execution event. The agent has decided to invoke a tool.

```json
{
  "type": "tool_call",
  "sessionId": "01J7...",
  "toolCallId": "call_abc...",
  "toolName": "read",
  "input": { "path": "src/utils.ts" }
}
```

Useful for permission-style UIs (not implemented in v1 — pi runs all
tool calls without per-call confirmation).

### `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

Tool runner lifecycle. `*_update` carries streaming output (e.g. bash
stdout).

```json
{
  "type": "tool_execution_start",
  "sessionId": "01J7...",
  "toolCallId": "call_abc...",
  "toolName": "bash"
}
```

```json
{
  "type": "tool_execution_update",
  "sessionId": "01J7...",
  "toolCallId": "call_abc...",
  "outputDelta": "Compiling utils.ts...\n"
}
```

```json
{
  "type": "tool_execution_end",
  "sessionId": "01J7...",
  "toolCallId": "call_abc...",
  "exitCode": 0
}
```

### `tool_result`

The tool's result message has been added to the session.

```json
{
  "type": "tool_result",
  "sessionId": "01J7...",
  "message": {
    "role": "toolResult",
    "toolCallId": "call_abc...",
    "toolName": "read",
    "content": [{ "type": "text", "text": "<file contents>" }],
    "details": { "path": "src/utils.ts" },
    "isError": false
  }
}
```

`details` is tool-specific. For `edit` tools it includes a unified
diff string; `turn-diff-builder.ts` extracts these for the Last Turn
pane.

## Steering / queue events

### `queue_update`

The pending steer / followUp queue changed. Pi clears delivered queue
items by emitting a smaller `queue_update`; the client doesn't pop locally.

```json
{
  "type": "queue_update",
  "sessionId": "01J7...",
  "queued": {
    "steering": ["Try a different approach"],
    "followUp": ["Run the tests when done"]
  }
}
```

UI action: render the queued-messages badge in `ChatView`.

## Compaction events

When the agent runs `compact` to free context-window space:

### `compaction_start`

```json
{ "type": "compaction_start", "sessionId": "01J7..." }
```

UI action: show "Compacting context…" banner.

### `compaction_end`

```json
{
  "type": "compaction_end",
  "sessionId": "01J7...",
  "summary": "...",
  "tokensBefore": 95000
}
```

The session's `messages` array now contains a `compactionSummary`-role
message at the position of the compaction; UI should refresh.

## Auto-retry events

Provider-side rate-limit / transient-error backoff:

### `auto_retry_start`

```json
{
  "type": "auto_retry_start",
  "sessionId": "01J7...",
  "attempt": 2,
  "delayMs": 4000,
  "reason": "rate_limit"
}
```

UI action: show "Retrying in 4s..." banner with a countdown.

### `auto_retry_end`

```json
{ "type": "auto_retry_end", "sessionId": "01J7..." }
```

UI action: hide retry banner.

## Extension UI notifications

### `extension_ui_notification`

Sent when an extension command calls `ctx.ui.notify()`. Pi Forge also emits a
warning notification when an extension requests an interactive dialog, which is
not supported in the browser UI.

```json
{
  "type": "extension_ui_notification",
  "sessionId": "01J7...",
  "message": "Command feedback: normal",
  "level": "info"
}
```

| Field | Type | Notes |
|---|---|---|
| `message` | string | The extension-provided Markdown text. |
| `level` | `"info" \| "warning" \| "error"` | Visual severity; defaults to `"info"`. |

UI action: render each notification as Markdown in the chat timeline in arrival
order. Notifications remain until the user dismisses them during the current
browser session; they are not persisted through reload. They are separate from
session-state banners, so multiple notifications stay independently visible
when emitted consecutively.

## Ordering guarantees

Within a single SSE connection:

1. `snapshot` is **always first**.
2. For a single agent turn:
   - `agent_start` precedes everything in that turn.
   - For each message in the turn: `message_start` → 1+ `message_update`
     → `message_end`.
   - For each tool call: `tool_call` → `tool_execution_start` → 0+
     `tool_execution_update` → `tool_execution_end` → `tool_result`.
   - `agent_end` is **last** for that turn.
3. `queue_update`, `compaction_start` / `_end`, and `auto_retry_*` may
   appear at any point.

Across multiple concurrent SSE clients on the same session: every client
sees the same event stream in the same order. Reconnects start with a
fresh `snapshot`; events that fired during the disconnect window are
**not replayed** — the snapshot is authoritative.

## Forwards-compatibility

The server filters events through `sse-bridge.ts` before forwarding —
unknown event types from the SDK are not currently passed through.
Clients should still **silently ignore unknown event types** to be
forwards-compatible with future SDK additions.

The `assistantMessageEvent.type` enum may grow as pi-ai adds streaming
shapes (e.g., new content-block types). Use a switch with a default
that no-ops, not a typed exhaustiveness check that throws.

## Reconnection

The shipped client (`packages/client/src/lib/sse-client.ts`) reconnects
on disconnect with exponential backoff: 1 → 2 → 4 → 8 → 16 → 30 s,
capped at 30 s. On reconnect it gets a fresh `snapshot` and resumes.

For a programmatic client, mirror this pattern:

- Track `reconnectAttempt`. Reset to 0 on successful open.
- On socket close (any code), schedule reconnect with
  `reconnectDelayMs(attempt++)`.
- On 401, drop the connection and prompt re-login (don't retry — the
  token is dead).

## Auth on the SSE route

The `/stream` route goes through the same JWT/API-key check as every
other authenticated route. Pass the token via `Authorization: Bearer
<token>` header. Browsers can't do this with the built-in `EventSource`
API (it doesn't support custom headers), so the browser client uses a
`fetch` + `ReadableStream` reader instead. Programmatic clients should
do the same (Python `httpx`, Node `fetch`).

## Consuming SSE programmatically

### Python (httpx)

```python
import json
import time
import httpx

API_BASE = "http://localhost:3000"
TOKEN = "<your bearer token>"

def stream_session(session_id: str):
    """Connect to a session's SSE stream and yield each event."""
    headers = {"Authorization": f"Bearer {TOKEN}", "Accept": "text/event-stream"}
    url = f"{API_BASE}/api/v1/sessions/{session_id}/stream"

    with httpx.stream("GET", url, headers=headers, timeout=None) as r:
        r.raise_for_status()
        buffer = ""
        for chunk in r.iter_text():
            buffer += chunk
            while "\n\n" in buffer:
                event, buffer = buffer.split("\n\n", 1)
                for line in event.splitlines():
                    if line.startswith("data: "):
                        payload = json.loads(line[6:])
                        yield payload

# Usage with backoff
def stream_with_reconnect(session_id: str):
    delays = [1, 2, 4, 8, 16, 30]
    attempt = 0
    while True:
        try:
            for event in stream_session(session_id):
                attempt = 0  # reset on first successful event
                yield event
        except httpx.HTTPError as e:
            if isinstance(e, httpx.HTTPStatusError) and e.response.status_code == 401:
                raise  # auth dead, don't retry
            delay = delays[min(attempt, len(delays) - 1)]
            print(f"[reconnect in {delay}s] {e}")
            time.sleep(delay)
            attempt += 1

# Run
for event in stream_with_reconnect("01J7..."):
    if event["type"] == "agent_end":
        print("Turn complete")
        break
```

### Node (fetch + ReadableStream)

```javascript
const API_BASE = "http://localhost:3000";
const TOKEN = "<your bearer token>";

async function* streamSession(sessionId) {
  const url = `${API_BASE}/api/v1/sessions/${sessionId}/stream`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "text/event-stream",
    },
  });
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (line.startsWith("data: ")) {
          yield JSON.parse(line.slice(6));
        }
      }
    }
  }
}

// Usage with backoff
async function streamWithReconnect(sessionId, onEvent) {
  const delays = [1, 2, 4, 8, 16, 30];
  let attempt = 0;
  while (true) {
    try {
      for await (const event of streamSession(sessionId)) {
        attempt = 0;
        await onEvent(event);
      }
    } catch (err) {
      if (err.message.includes("401")) throw err;  // auth dead
      const delay = delays[Math.min(attempt, delays.length - 1)] * 1000;
      console.warn(`[reconnect in ${delay}ms]`, err.message);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}

// Run
streamWithReconnect("01J7...", (event) => {
  if (event.type === "agent_end") console.log("Turn complete");
});
```

### curl (one-shot, for debugging)

```bash
curl -N -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/v1/sessions/$SESSION_ID/stream
```

`-N` disables curl's output buffering so events appear as they arrive.
Press Ctrl+C to disconnect.

## Building it yourself

The reference client implementation is `packages/client/src/lib/sse-client.ts`
in this repo. ~150 lines of TypeScript, MIT-licensed, free to port.

## See also

- [`docs/api-examples.md`](./api-examples.md) — REST + SSE end-to-end
  examples (create session → prompt → stream → abort)
- [`docs/architecture.md`](./architecture.md) — request lifecycles
  including SSE
- `/api/docs` (live OpenAPI in your deploy) — every route's schema

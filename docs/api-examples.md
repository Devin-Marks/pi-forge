# API Examples

End-to-end recipes for the most common things you'll do programmatically:
list projects, create a session, send a prompt, stream the response, abort,
fetch the turn diff, run git commands, upload files. Examples in curl,
Python, and Node — all three follow the same shape.

For the full route reference, open `/api/docs` in your deploy (Swagger UI
auto-generated from the route schemas). For the SSE side, see
[`docs/sse-events.md`](./sse-events.md).

## Setup

```bash
BASE=http://localhost:3000
KEY=<your API_KEY>
```

All requests use `Authorization: Bearer <key>`. If your deploy uses
`UI_PASSWORD` instead, get a JWT first:

```bash
TOKEN=$(curl -s -X POST $BASE/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{"password":"your-ui-password"}' | jq -r '.token')
KEY=$TOKEN
```

JWTs expire (default 7 days, configurable via `JWT_EXPIRES_IN_SECONDS`);
API keys don't.

## Health probe (no auth)

```bash
curl -s $BASE/api/v1/health
# {"status":"ok","activeSessions":0,"activePtys":0}
```

```python
import httpx
print(httpx.get(f"{BASE}/api/v1/health").json())
```

```javascript
const res = await fetch(`${BASE}/api/v1/health`);
console.log(await res.json());
```

## End-to-end: create session, send prompt, stream response

### curl

```bash
# 1. List projects
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/projects

# 2. Create a session
SESSION=$(curl -s -X POST $BASE/api/v1/sessions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"projectId":"<projectId>"}' | jq -r '.sessionId')
echo "Session: $SESSION"

# 3. Send a prompt (fire-and-forget — response comes via SSE)
curl -s -X POST $BASE/api/v1/sessions/$SESSION/prompt \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{"text":"Refactor packages/server/src/auth.ts to extract the JWT verifier into its own function"}'
# {"accepted":true}

# 4. Stream the response (Ctrl+C to stop)
curl -N -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/stream

# 5. Abort if needed
curl -X POST -H "Authorization: Bearer $KEY" $BASE/api/v1/sessions/$SESSION/abort
```

### Python

```python
import json
import httpx

BASE = "http://localhost:3000"
KEY = "<your API_KEY>"
H = {"Authorization": f"Bearer {KEY}"}

# 1. List projects
projects = httpx.get(f"{BASE}/api/v1/projects", headers=H).json()["projects"]
print(f"Found {len(projects)} projects")

# 2. Create a session
session = httpx.post(
    f"{BASE}/api/v1/sessions",
    headers=H,
    json={"projectId": projects[0]["id"]},
).json()
session_id = session["sessionId"]
print(f"Created session {session_id}")

# 3. Send a prompt
httpx.post(
    f"{BASE}/api/v1/sessions/{session_id}/prompt",
    headers=H,
    json={"text": "Run the test suite and fix any failures."},
)

# 4. Stream the response
streaming_text = ""
with httpx.stream(
    "GET",
    f"{BASE}/api/v1/sessions/{session_id}/stream",
    headers={**H, "Accept": "text/event-stream"},
    timeout=None,
) as r:
    buffer = ""
    for chunk in r.iter_text():
        buffer += chunk
        while "\n\n" in buffer:
            event, buffer = buffer.split("\n\n", 1)
            for line in event.splitlines():
                if not line.startswith("data: "):
                    continue
                payload = json.loads(line[6:])
                if payload["type"] == "message_update":
                    e = payload.get("assistantMessageEvent") or {}
                    if e.get("type") == "text_delta":
                        streaming_text += e["delta"]
                        print(e["delta"], end="", flush=True)
                elif payload["type"] == "agent_end":
                    print("\n\n[turn complete]")
                    raise SystemExit(0)
```

### Node

```javascript
const BASE = "http://localhost:3000";
const KEY = "<your API_KEY>";
const H = { Authorization: `Bearer ${KEY}` };

// 1. List projects
const projects = (await (await fetch(`${BASE}/api/v1/projects`, { headers: H })).json())
  .projects;
console.log(`Found ${projects.length} projects`);

// 2. Create a session
const session = await (
  await fetch(`${BASE}/api/v1/sessions`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: projects[0].id }),
  })
).json();
const sessionId = session.sessionId;
console.log(`Created session ${sessionId}`);

// 3. Send a prompt
await fetch(`${BASE}/api/v1/sessions/${sessionId}/prompt`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ text: "Run npm test and fix the failures." }),
});

// 4. Stream the response
const streamRes = await fetch(`${BASE}/api/v1/sessions/${sessionId}/stream`, {
  headers: { ...H, Accept: "text/event-stream" },
});
const reader = streamRes.body.pipeThrough(new TextDecoderStream()).getReader();
let buffer = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += value;
  let idx;
  while ((idx = buffer.indexOf("\n\n")) !== -1) {
    const event = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    for (const line of event.split("\n")) {
      if (!line.startsWith("data: ")) continue;
      const payload = JSON.parse(line.slice(6));
      if (payload.type === "message_update") {
        const e = payload.assistantMessageEvent ?? {};
        if (e.type === "text_delta") process.stdout.write(e.delta);
      } else if (payload.type === "agent_end") {
        console.log("\n\n[turn complete]");
        process.exit(0);
      }
    }
  }
}
```

## Project CRUD

### List

```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/projects
# { "projects": [{ "id": "...", "name": "...", "path": "...", "createdAt": "..." }] }
```

### Create

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/projects \
  -d '{"name":"my-app","path":"/workspace/my-app"}'
```

The path must be an existing directory inside `WORKSPACE_PATH`. Server
returns 403 if outside, 409 if a project with that path already exists.

### Browse for a folder (folder picker)

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/projects/browse?path=/workspace"
# { "path":"/workspace", "parentPath":null, "entries":[{ "name","path","isGitRepo" }] }
```

Omit `path` to start at `WORKSPACE_PATH`.

### Rename / delete

```bash
curl -s -X PATCH -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/projects/$PROJECT_ID \
  -d '{"name":"new-name"}'

# Plain delete: removes pi-forge's record; session JSONLs stay on disk
curl -s -X DELETE -H "Authorization: Bearer $KEY" $BASE/api/v1/projects/$PROJECT_ID

# Cascade delete: also rm -rf the project's session directory
curl -s -X DELETE -H "Authorization: Bearer $KEY" "$BASE/api/v1/projects/$PROJECT_ID?cascade=1"
```

## Session lifecycle

> **Cold sessions and lazy resume.** A session created earlier and not currently
> active in the registry is "cold" — it lives only as a `.jsonl` on disk.
> `/sessions/:id/tree` and `/sessions/:id/context` will lazy-resume a cold
> session into memory automatically. `/sessions/:id/messages`,
> `/sessions/:id/turn-diff`, and `/sessions/:id/name` do **not** auto-resume
> and return `404 session_not_found` on a cold id. The reliable workaround
> is to open the SSE stream first (`GET /sessions/:id/stream`), which always
> auto-resumes; subsequent calls then succeed.

### List sessions for a project

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/sessions?projectId=$PROJECT_ID"
# { "sessions": [{ sessionId, projectId, workspacePath, isLive, name?, createdAt, lastActivityAt, messageCount, firstMessage }] }
```

### Get full message history

```bash
curl -s -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/messages
# { "messages": [...] }
```

### Get token + cost telemetry

```bash
curl -s -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/context
# { messages, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheWriteTokens, totalTokens, totalCost, turns[], contextUsage }
```

`turns[]` is the per-turn breakdown derived from each
`AssistantMessage.usage`. `contextUsage.tokens` may be omitted when the
SDK doesn't have a fresh count (right after compaction). The `messages`
array mirrors the SSE `snapshot.messages` payload — it can be large
(tens of KB) for a long session, so consider polling sparingly.

### Get session tree (branching history)

```bash
curl -s -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/tree
# { leafId, branchIds[], entries: [{ id, parentId, type, timestamp, role?, preview?, label? }] }
```

`leafId` is the current branch tip; `branchIds` is the full path from
root to leaf (= the active branch). Off-path entries are alternate
branches.

### Navigate to a different leaf

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/sessions/$SESSION/navigate \
  -d '{"entryId":"<some-entry-id>"}'
# Optional: { entryId, summarize: true, customInstructions: "...", label: "..." }
```

`summarize: true` writes a `branch_summary` entry capturing what the
abandoned branch did. `label` bookmarks the abandoned tip.

### Fork from an entry into a new session

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/sessions/$SESSION/fork \
  -d '{"entryId":"<some-entry-id>"}'
# Returns the new session's summary
```

The new session's path-to-leaf includes everything from the root through
`entryId`. The source session is preserved (in-memory restoration of the
source session manager happens server-side after the SDK's destructive
fork operation).

### Set the model for THIS session only

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/sessions/$SESSION/model \
  -d '{"provider":"anthropic","modelId":"claude-sonnet-4-5-20250929"}'
```

The route snapshots `settings.json` before calling the SDK and restores
it after, so per-session model picks don't mutate the global default.

### Steer or follow up

```bash
# Steer (interrupt at next tool boundary)
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/sessions/$SESSION/steer \
  -d '{"text":"Actually, use TypeScript not JavaScript","mode":"steer"}'

# Follow up (queue for after the current run)
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/sessions/$SESSION/steer \
  -d '{"text":"And then run the tests","mode":"followUp"}'
```

### Abort the current run

```bash
curl -X POST -H "Authorization: Bearer $KEY" $BASE/api/v1/sessions/$SESSION/abort
```

### Dispose / hard-delete

```bash
# Dispose only — kills the live session, preserves the JSONL
curl -X DELETE -H "Authorization: Bearer $KEY" $BASE/api/v1/sessions/$SESSION

# Hard delete — disposes AND removes the JSONL
curl -X DELETE -H "Authorization: Bearer $KEY" "$BASE/api/v1/sessions/$SESSION?hard=1"
```

## Multipart prompt with attachments

```bash
curl -s -X POST -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/sessions/$SESSION/prompt \
  -F "text=Look at this screenshot and tell me what's wrong" \
  -F "attachments=@./screenshot.png" \
  -F "attachments=@./logs.txt"
```

Image attachments are base64-encoded and forwarded as `images` to the
SDK. Text attachments are decoded as UTF-8 and prepended to the prompt
as fenced code blocks (with backtick-fence-break-safe fence selection).
Caps: 10 MB / file, 8 files, 4 images max.

## File operations

### List the project tree

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/files/tree?projectId=$PROJECT_ID&maxDepth=4"
```

### Read a file

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/files/read?projectId=$PROJECT_ID&path=/workspace/my-app/src/index.ts"
# { path, content, size, language, binary }
```

### Write / create a file (atomic tmp + rename)

```bash
curl -s -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/files/write \
  -d '{"projectId":"...","path":"/workspace/my-app/notes.md","content":"# Notes\n\n..."}'
```

### Search

```bash
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/files/search?projectId=$PROJECT_ID&q=TODO&caseSensitive=1"
# { engine: "ripgrep" | "node", matches: [...], truncated: bool }
```

### Upload (multipart, with SHA-256 verification)

```bash
# Compute SHA-256 yourself, send as `sha256:<filename>` field BEFORE the file part
SHA=$(sha256sum ./report.pdf | cut -d' ' -f1)
curl -s -X POST -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/files/upload \
  -F "projectId=$PROJECT_ID" \
  -F "parentPath=/workspace/my-app/uploads" \
  -F "sha256:report.pdf=$SHA" \
  -F "files=@./report.pdf"
# { files: [{ path, size, sha256 }] }
```

Server hashes the received bytes and rejects with 422
`checksum_mismatch` if your hash doesn't match. Per-file cap 500 MB,
aggregate 2 GB, max 16 files.

### Download (file or folder-as-tar.gz)

```bash
# File: streams the bytes
curl -s -OJ -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/files/download?projectId=$PROJECT_ID&path=/workspace/my-app/src/index.ts"

# Folder: gzipped tar (Content-Disposition includes the .tar.gz filename)
curl -s -OJ -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/files/download?projectId=$PROJECT_ID&path=/workspace/my-app/src"

# Whole project (omit path)
curl -s -OJ -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/files/download?projectId=$PROJECT_ID"
```

The folder/project tar.gz omits the same noise dirs as the file tree
(`node_modules`, `.git`, `dist`, `build`, etc.).

## Git operations

```bash
# Status
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/git/status?projectId=$PROJECT_ID"

# Diff (unstaged)
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/git/diff?projectId=$PROJECT_ID"

# Diff a single file
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/git/diff/file?projectId=$PROJECT_ID&path=/workspace/my-app/src/index.ts&staged=1"

# Log
curl -s -H "Authorization: Bearer $KEY" \
  "$BASE/api/v1/git/log?projectId=$PROJECT_ID&limit=50"

# Stage / unstage / revert
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/git/stage \
  -d '{"projectId":"...","paths":["/workspace/my-app/src/index.ts"]}'

# Commit
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/git/commit \
  -d '{"projectId":"...","message":"feat: ship the thing"}'

# Branch management
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v1/git/branches?projectId=$PROJECT_ID"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/git/branch/create \
  -d '{"projectId":"...","name":"feat/x","checkout":true}'

# Remotes
curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v1/git/remotes?projectId=$PROJECT_ID"
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/git/remote/add \
  -d '{"projectId":"...","name":"origin","url":"git@github.com:you/repo.git"}'

# Push / pull / fetch
curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/git/push \
  -d '{"projectId":"...","remote":"origin","branch":"main","setUpstream":true}'
```

## Configuration

### List providers (presence-only auth)

```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/config/providers
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/config/auth
# Returns presence: { providers: { anthropic: { configured: true, source: "auth.json" }, ... } }
# Key VALUES are never returned.
```

### Set / remove an API key

```bash
curl -s -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/config/auth/anthropic \
  -d '{"apiKey":"sk-ant-..."}'

curl -s -X DELETE -H "Authorization: Bearer $KEY" \
  $BASE/api/v1/config/auth/anthropic
```

### Read / write agent settings

```bash
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/config/settings

curl -s -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/config/settings \
  -d '{"defaultThinkingLevel":"high"}'
# Patch is shallow-merged; pass null to delete a key.
```

### Read / write models.json (custom providers)

```bash
# GET returns the file with `apiKey` / `apiKeyCommand` REPLACED by
# "***REDACTED***" so the raw secret never leaves the server. The
# persisted file is unchanged; PUT takes the actual values.
curl -s -H "Authorization: Bearer $KEY" $BASE/api/v1/config/models

curl -s -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  $BASE/api/v1/config/models \
  -d '{"providers":{"vllm-local":{"api":"openai-completions","url":"http://localhost:8000/v1","models":[...]}}}'
```

### List / toggle skills

```bash
# Merged skills (global from ~/.pi/agent/skills/ + project-local from
# <project>/.pi/skills/) with per-skill enabled state for the workspace.
curl -s -G -H "Authorization: Bearer $KEY" \
  --data-urlencode "workspacePath=/workspace/my-project" \
  $BASE/api/v1/config/skills

# Enable / disable for the current workspace. Toggles persist as
# pattern entries in ${FORGE_DATA_DIR}/skills-overrides.json keyed by
# project — the skill .md files themselves are untouched.
curl -s -X PUT -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  "$BASE/api/v1/config/skills/<skill-name>/enabled" \
  -d '{"enabled":true,"workspacePath":"/workspace/my-project"}'
```

Equivalent endpoints exist for tools (`/api/v1/config/tools/...` →
`tool-overrides.json`) and pi prompts (`/api/v1/config/prompts/...` →
`prompts-overrides.json`).

## UI config (public, no auth)

```bash
curl -s $BASE/api/v1/ui-config
# { minimal: false, workspaceRoot: "/workspace" }
```

Used by the React client at boot to know which surfaces to render.

## Auth

```bash
# Whether auth is enabled at all
curl -s $BASE/api/v1/auth/status
# { authEnabled: true | false }

# Login (when UI_PASSWORD is set)
curl -s -X POST -H "Content-Type: application/json" \
  $BASE/api/v1/auth/login \
  -d '{"password":"your-ui-password"}'
# { token, expiresAt }

# Logout (client-side; server stateless — just discard the token)
```

JWT tokens default to 7-day expiry; the response's `expiresAt` is an ISO
timestamp. Refresh by logging in again before expiry.

## See also

- [`/api/docs`](http://localhost:3000/api/docs) (live in your deploy) —
  Swagger UI with every route's full schema, try-it-out included
- [`docs/sse-events.md`](./sse-events.md) — full SSE event catalogue +
  reconnect patterns
- [`docs/architecture.md`](./architecture.md) — request lifecycles +
  module map
- [`packages/client/src/lib/api-client.ts`](../packages/client/src/lib/api-client.ts) —
  reference TypeScript client (the React UI uses it; same API surface)

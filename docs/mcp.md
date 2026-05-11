# MCP (Model Context Protocol)

pi-forge connects to MCP servers and surfaces their tools to the
agent. Configure from **Settings → MCP** or by editing config files.

> Pi has no native MCP support. The integration lives in
> [`packages/server/src/mcp/`](../packages/server/src/mcp/) — see
> `manager.ts` for the contract.

## Scope

- **Remote servers only.** Transports: `streamable-http` (current MCP
  spec) and `sse` (legacy). The `auto` default tries StreamableHTTP
  first and falls back to SSE — covers
  [fastmcp](https://github.com/jlowin/fastmcp) servers regardless of
  which transport they expose.
- **stdio is not supported.** Run stdio MCP servers as a separate
  process and expose them over HTTP/SSE.
- **Static-header auth only** (Bearer tokens, custom headers). OAuth
  per-server consent flows are not implemented.

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
  "servers": {
    "my-server": {
      "url": "https://mcp.example.com/sse",
      "transport": "auto",
      "enabled": true,
      "headers": {
        "Authorization": "Bearer sk-..."
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
    }
  }
}
```

### Field reference

| Field | Type | Default | Notes |
|---|---|---|---|
| `url` | string | (required) | The MCP endpoint URL. |
| `transport` | `"auto"` \| `"streamable-http"` \| `"sse"` | `"auto"` | Connection probe order. `auto` tries StreamableHTTP first. |
| `enabled` | boolean | `true` | Disabled servers don't connect or contribute tools. |
| `headers` | `Record<string, string>` | (none) | Forwarded on every MCP RPC. Treated as secret on read — `GET /mcp/servers` returns `***REDACTED***` for every value. |
| `disabled` | boolean (top-level) | `false` | Master kill-switch. When `true`, NO MCP tools reach the agent regardless of per-server `enabled`. Surfaced as the toggle at the top of Settings → MCP. |

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
  (reconnects entries whose URL / transport / headers changed).
- **Master toggle.** Flipping it off doesn't disconnect anything —
  future `createAgentSession` calls skip the `customTools` injection.
  Live sessions keep the tools they booted with.

## Header status badge

The badge next to **Settings** shows a colored dot + `MCP X/Y`:

- **emerald** — every global server connected
- **amber** — some connected, some not (per-server `lastError` in
  Settings → MCP)
- **red** — none connected (and at least one configured)
- **neutral** — master toggle off

Hidden when no servers are configured and in `MINIMAL_UI` mode.

## Troubleshooting

**Status stuck in `error`** — Settings → MCP, expand the row, read
`lastError`. Common causes: wrong URL, missing `Authorization`
header, server returning 4xx on `tools/list`. **Probe** forces a
reconnect + tool re-list.

**Both transports fail** — pin `transport` explicitly. The `auto`
probe round-trip wastes ~100 ms per reconnect when only one transport
actually works.

**Headers show `***REDACTED***`** — read-path sentinel, not real
data. The on-disk file still has the real value. On save, a sentinel
value preserves the prior secret; a new value overwrites it (same
pattern as `models.json`).

**Tools don't appear after editing project `.mcp.json`** — the file
is read once per project per server lifetime. Probe the row or
restart pi-forge.

## API surface

All routes under `/api/v1/mcp/`:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/mcp/settings` | Master enable + connected/total count |
| `PUT` | `/mcp/settings` | Toggle the master flag |
| `GET` | `/mcp/servers[?projectId=…]` | Global config (redacted) + status |
| `PUT` | `/mcp/servers/:name` | Upsert a global server |
| `DELETE` | `/mcp/servers/:name` | Remove a global server |
| `POST` | `/mcp/servers/:name/probe[?projectId=…]` | Force reconnect + re-list |
| `GET` | `/mcp/tools?projectId=…` | Flat tool list available to the project's sessions |

Request/response schemas in the Swagger UI at `/api/docs`.

## See also

- [`configuration.md`](./configuration.md) — env vars + per-project overrides
- [`architecture.md`](./architecture.md) — where the MCP manager sits
- [`packages/server/src/mcp/manager.ts`](../packages/server/src/mcp/manager.ts) — integration contract

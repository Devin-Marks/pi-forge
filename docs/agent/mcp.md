# Agent Notes: MCP

Read this when changing MCP server registration, MCP custom tool translation, MCP truncation, MCP docs/routes, or tool override interactions.

## Integration Contract

Pi does NOT have native MCP (Model Context Protocol) support. MCP is provided by pi-forge itself: `packages/server/src/mcp/manager.ts` connects to remote MCP servers via `@modelcontextprotocol/sdk`, translates each advertised tool into a pi `ToolDefinition`, and feeds the aggregate into every `createAgentSession` call as `customTools`. See `docs/mcp.md` for the user-facing surface; the doc-comment at the top of `mcp/manager.ts` is the integration contract.

## Owned Data Files

- `FORGE_DATA_DIR/mcp.json` — MCP server registry, owned by `mcp/manager.ts`.
- Tool overrides can include built-ins and MCP tools; read `docs/agent/config.md` and relevant tests before changing cascade behavior.

## Tests

Relevant scripts include:

- `tests/test-mcp.ts`
- `tests/test-mcp-truncation.ts`
- `tests/test-tool-overrides.ts`

MCP result truncation is a global MCP setting persisted in `FORGE_DATA_DIR/mcp.json`
under `truncation`. The bridge defaults to enabled at 30,000 text characters and
can be disabled or retuned from Settings → MCP; keep this contract in sync with
`tests/test-mcp-truncation.ts`.

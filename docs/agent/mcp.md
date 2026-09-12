# Agent Notes: MCP

Read this when changing MCP server registration, MCP custom tool translation, MCP truncation, MCP docs/routes, or tool override interactions.

## Integration Contract

Pi does NOT have native MCP (Model Context Protocol) support. MCP is provided by pi-forge itself: `packages/server/src/mcp/manager.ts` connects to remote MCP servers via `@modelcontextprotocol/sdk`, translates each advertised tool into a pi `ToolDefinition`, and feeds the aggregate into every `createAgentSession` call as `customTools`. See `docs/mcp.md` for the user-facing surface; the doc-comment at the top of `mcp/manager.ts` is the integration contract.

## Owned Data Files

- `FORGE_DATA_DIR/mcp.json` — MCP server registry, owned by `mcp/manager.ts`.
  Remote `headers` values may be literal strings or `{ env: "VAR_NAME" }`; the
  latter resolves dynamically from the pi-forge process env without returning the
  resolved value to clients.
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

MCP result spooling is a separate global setting under `spooling`, enabled by default.
Oversized successful MCP results are written through `file-manager.writeFile()` to a
workspace-relative JSON file before truncation, and the model receives only a
summary/path/preview. The default destination is `<workspace>/.mcp-results/`. `isError:
true` results deliberately bypass spooling so errors stay visible inline. If the
workspace write fails, the bridge falls back to the same inline conversion/truncation
path with an `MCP_RESULT_SPOOL_FAILED` warning. Because writes go through
`file-manager.writeFile()`, sandbox mode gets the normal ownership/permission handoff
for newly created directories/files. Any change here must preserve project-root
validation and the non-spooled truncation tests.

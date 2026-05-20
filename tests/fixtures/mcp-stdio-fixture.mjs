#!/usr/bin/env node
/**
 * Minimal stdio MCP server fixture for test-mcp-stdio.
 *
 * Runs forever, speaks MCP over stdin/stdout via the SDK's
 * StdioServerTransport. Registers two tools:
 *   - `echo`: returns the input text verbatim
 *   - `report-env`: returns the values of MCP_TEST_VAR_A and
 *     MCP_TEST_VAR_B from the subprocess env, so the test can
 *     verify env passthrough (and that secrets-redaction round-trip
 *     preserved the value across an upsert).
 *
 * Optional `--crash-on-start` arg exits non-zero before the
 * transport is wired so the test can exercise the manager's
 * connect-failure path. Optional `--name <s>` lets the test spawn
 * differently-named fixture servers for the project-overrides-
 * global collision case.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const args = process.argv.slice(2);
if (args.includes("--crash-on-start")) {
  // Exit before transport setup so the parent's connect() throws.
  process.stderr.write("[fixture] crash-on-start requested\n");
  process.exit(2);
}

const nameIdx = args.indexOf("--name");
const serverName = nameIdx >= 0 && args[nameIdx + 1] !== undefined ? args[nameIdx + 1] : "fixture";

const mcp = new McpServer({ name: serverName, version: "0.0.1" });

mcp.registerTool(
  "echo",
  {
    description: "Echo the input text back.",
    inputSchema: { text: z.string() },
  },
  ({ text }) => ({
    content: [{ type: "text", text }],
  }),
);

mcp.registerTool(
  "report-env",
  {
    description: "Report MCP_TEST_VAR_A + MCP_TEST_VAR_B from the subprocess env.",
    inputSchema: {},
  },
  () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          a: process.env.MCP_TEST_VAR_A ?? null,
          b: process.env.MCP_TEST_VAR_B ?? null,
          cwd: process.cwd(),
        }),
      },
    ],
  }),
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
// Keep the process alive until the parent closes stdin. The SDK
// handles the JSON-RPC framing; we just have to not exit.

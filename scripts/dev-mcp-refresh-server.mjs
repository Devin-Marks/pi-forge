#!/usr/bin/env node
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const DEFAULT_PORT = 8787;

function parsePort(argv) {
  const arg = argv.find((value) => value === "--port" || value.startsWith("--port="));
  if (arg === undefined) return Number(process.env.PORT ?? DEFAULT_PORT);
  if (arg === "--port") {
    const index = argv.indexOf(arg);
    return Number(argv[index + 1] ?? DEFAULT_PORT);
  }
  return Number(arg.slice("--port=".length));
}

const port = parsePort(process.argv.slice(2));
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`Invalid port: ${String(port)}`);
  process.exit(1);
}

let secondToolEnabled = process.env.MCP_REFRESH_SECOND_TOOL === "1";

function createRefreshServer() {
  const server = new McpServer({
    name: "pi-forge-mcp-refresh-dev",
    version: "0.0.1",
  });

  server.registerTool(
    "refresh_ping",
    {
      description: "Initial obvious tool for manually verifying pi-forge MCP discovery.",
      inputSchema: {
        name: z.string().optional().describe("Optional name to include in the response."),
      },
    },
    ({ name }) => ({
      content: [
        {
          type: "text",
          text: `refresh_ping ok${name !== undefined && name.length > 0 ? ` for ${name}` : ""}`,
        },
      ],
    }),
  );

  if (secondToolEnabled) {
    server.registerTool(
      "refresh_second",
      {
        description:
          "Second tool toggled at runtime; create a new pi-forge session after enabling it.",
        inputSchema: {
          text: z.string().optional().describe("Optional text to echo."),
        },
      },
      ({ text }) => ({
        content: [
          {
            type: "text",
            text: `refresh_second ok${text !== undefined && text.length > 0 ? `: ${text}` : ""}`,
          },
        ],
      }),
    );
  }

  return server;
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(payload);
}

const httpServer = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);

    if (req.method === "GET" && url.pathname === "/") {
      sendText(
        res,
        200,
        [
          "pi-forge MCP refresh dev server",
          "",
          `MCP URL: http://127.0.0.1:${port}/mcp`,
          `Initial tool: refresh_ping`,
          `Second tool currently: ${secondToolEnabled ? "enabled" : "disabled"}`,
          "",
          "Enable second tool without restarting:",
          `  curl -X POST http://127.0.0.1:${port}/control/enable-second`,
          "Disable second tool:",
          `  curl -X POST http://127.0.0.1:${port}/control/disable-second`,
          "",
        ].join("\n"),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/control/status") {
      sendJson(res, 200, { secondToolEnabled });
      return;
    }

    if (req.method === "POST" && url.pathname === "/control/enable-second") {
      secondToolEnabled = true;
      sendJson(res, 200, { secondToolEnabled, tool: "refresh_second" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/control/disable-second") {
      secondToolEnabled = false;
      sendJson(res, 200, { secondToolEnabled });
      return;
    }

    if (url.pathname === "/mcp") {
      if (req.method !== "POST") {
        sendJson(res, 405, {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed" },
          id: null,
        });
        return;
      }

      const mcpServer = createRefreshServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("[dev-mcp-refresh] request failed", error);
        if (!res.headersSent) {
          sendJson(res, 500, {
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          });
        }
      } finally {
        res.on("close", () => {
          void transport.close().catch(() => undefined);
          void mcpServer.close().catch(() => undefined);
        });
      }
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  })();
});

httpServer.listen(port, "127.0.0.1", () => {
  console.log(`[dev-mcp-refresh] listening on http://127.0.0.1:${port}`);
  console.log(`[dev-mcp-refresh] MCP URL: http://127.0.0.1:${port}/mcp`);
  console.log(
    `[dev-mcp-refresh] second tool: ${secondToolEnabled ? "enabled" : "disabled"} ` +
      `(POST /control/enable-second to enable)`,
  );
  console.log("[dev-mcp-refresh] pi-forge config JSON:");
  console.log(
    JSON.stringify(
      {
        servers: {
          refreshdev: {
            url: `http://127.0.0.1:${port}/mcp`,
            transport: "streamable-http",
          },
        },
      },
      null,
      2,
    ),
  );
});

process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});

process.on("SIGTERM", () => {
  httpServer.close(() => process.exit(0));
});

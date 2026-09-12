/**
 * MCP failure-handling regression test.
 *
 * Exercises the pi-forge MCP bridge without a live MCP server so failures are
 * deterministic: thrown tool calls are converted into visible tool errors,
 * diagnostics are sanitized, and malformed/circular result payloads do not throw
 * while being rendered for the agent.
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolBridgeModule {
  bridgeMcpTool: (opts: {
    serverName: string;
    toolName: string;
    description: string;
    inputSchema: Record<string, unknown>;
    getClient: () => { callTool: (...args: unknown[]) => Promise<unknown> } | undefined;
    recoverStaleSession?: () => Promise<boolean>;
  }) => {
    execute: (
      toolCallId: string,
      params: unknown,
      signal: AbortSignal | undefined,
      update: unknown,
      context: unknown,
    ) => Promise<{ content: TextBlock[]; details: unknown }>;
  };
  mcpResultToAgentResult: (res: unknown) => { content: TextBlock[]; details: unknown };
}

async function main(): Promise<void> {
  const mod = (await import(
    resolve(repoRoot, "packages/server/dist/mcp/tool-bridge.js")
  )) as unknown as ToolBridgeModule;

  // ---------- thrown call becomes sanitized tool result ----------
  {
    const tool = mod.bridgeMcpTool({
      serverName: "secrets",
      toolName: "explode",
      description: "Throws with a secret-looking diagnostic.",
      inputSchema: { type: "object", properties: {} },
      getClient: () => ({
        callTool: async () => {
          throw new Error(
            "upstream failed: Authorization: Bearer sk_live_secret token=abc123 password=hunter2",
          );
        },
      }),
    });
    const result = await tool.execute("tcid-failure", {}, undefined, undefined, {});
    const text = result.content[0]?.text ?? "";
    assert(
      "throw: returns visible MCP failure",
      text.includes("MCP tool 'secrets__explode' failed"),
      text,
    );
    assert(
      "throw: bearer token redacted",
      !text.includes("sk_live_secret") && text.includes("Bearer [REDACTED]"),
      text,
    );
    assert(
      "throw: token assignment redacted",
      !text.includes("abc123") && text.includes("token=[REDACTED]"),
      text,
    );
    assert(
      "throw: password redacted",
      !text.includes("hunter2") && text.includes("password=[REDACTED]"),
      text,
    );
  }

  // ---------- malformed/circular result is rendered safely ----------
  {
    const circular: Record<string, unknown> = { type: "resource", token: "super-secret-value" };
    circular.self = circular;
    const result = mod.mcpResultToAgentResult({ content: [circular], structuredContent: circular });
    const text = result.content[0]?.text ?? "";
    assert("circular result: returns a text block", result.content[0]?.type === "text", text);
    assert("circular result: marks circular reference", text.includes("[Circular]"), text);
    assert(
      "circular result: sanitizes secret-looking keys",
      !text.includes("super-secret-value"),
      text,
    );
    assert(
      "circular details: bounded string detail",
      typeof result.details === "string",
      String(result.details),
    );
  }

  console.log(
    failures === 0
      ? "\n[test-mcp-failure-handling] PASS"
      : `\n[test-mcp-failure-handling] FAIL — ${failures} assertion(s) failed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[test-mcp-failure-handling] uncaught error:", err);
  process.exit(1);
});

import { Type } from "typebox";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

/**
 * Translate a single MCP tool advertised by a connected MCP server
 * into a pi `ToolDefinition` the agent can call.
 *
 * The translated tool's name is namespaced as `<server>__<tool>` so
 * multiple MCP servers can advertise the same tool name without
 * colliding (e.g. two servers both exposing `search`). Pi enforces
 * unique tool names at agent-init; the prefix guarantees uniqueness.
 *
 * `parameters` wraps the MCP tool's JSON Schema with `Type.Unsafe<...>`.
 * Pi runs structural validation on tool-call arguments using whatever
 * is in `parameters`, so the JSON Schema flows through directly.
 *
 * Tool execution forwards to `client.callTool({ name, arguments })`
 * and converts the MCP `CallToolResult.content` array into pi's
 * `(TextContent | ImageContent)[]` shape. Resource-link / unknown
 * content blocks are stringified as JSON text rather than dropped, so
 * the agent at least sees them.
 */
export function bridgeMcpTool(opts: {
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Returns the latest connected client for this server. Re-resolved
   *  on every call so a reconnect (new client instance) is picked up
   *  without the bridged ToolDefinition being rebuilt. */
  getClient: () => Client | undefined;
  /** Reconnects the owning MCP server after the remote rejects the
   *  cached session id. Returns true when a fresh client is available. */
  recoverStaleSession?: () => Promise<boolean>;
}): ToolDefinition {
  const prefixedName = `${opts.serverName}__${opts.toolName}`;
  const description =
    opts.description.length > 0
      ? opts.description
      : `MCP tool '${opts.toolName}' from server '${opts.serverName}'.`;
  return {
    name: prefixedName,
    label: `MCP: ${opts.serverName}/${opts.toolName}`,
    description,
    parameters: Type.Unsafe<Record<string, unknown>>(opts.inputSchema),
    async execute(_toolCallId, params, signal) {
      const client = opts.getClient();
      if (client === undefined) {
        return errorResult(
          `MCP server '${opts.serverName}' is not connected. Re-enable it in Settings → MCP, or check the server logs.`,
        );
      }
      try {
        const res = await callMcpTool(client, opts.toolName, params, signal);
        return mcpResultToAgentResult(res);
      } catch (err) {
        if (
          !isAbortError(err) &&
          isStaleMcpSessionError(err) &&
          opts.recoverStaleSession !== undefined
        ) {
          const recovered = await opts.recoverStaleSession().catch(() => false);
          const retryClient = opts.getClient();
          if (recovered && retryClient !== undefined) {
            try {
              const retryRes = await callMcpTool(retryClient, opts.toolName, params, signal);
              return mcpResultToAgentResult(retryRes);
            } catch (retryErr) {
              return errorResult(
                `MCP tool '${prefixedName}' threw after reconnect: ${errorMessage(retryErr)}`,
              );
            }
          }
        }
        return errorResult(`MCP tool '${prefixedName}' threw: ${errorMessage(err)}`);
      }
    },
  } satisfies ToolDefinition;
}

async function callMcpTool(
  client: Client,
  toolName: string,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  return await client.callTool(
    {
      name: toolName,
      arguments: (params as Record<string, unknown>) ?? {},
    },
    undefined,
    signal !== undefined ? { signal } : undefined,
  );
}

function errorResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: undefined,
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

function isStaleMcpSessionError(err: unknown): boolean {
  const maybe = err as {
    code?: unknown;
    message?: unknown;
    error?: { code?: unknown; message?: unknown };
  };
  const code = maybe.code ?? maybe.error?.code;
  const message = String(maybe.message ?? maybe.error?.message ?? err).toLowerCase();
  const hasStaleMessage =
    message.includes("session not found") || message.includes("sesstion not found");
  return hasStaleMessage && (code === undefined || code === -32600 || message.includes("-32600"));
}

interface McpContentBlock {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
  resource?: unknown;
}

interface McpCallResult {
  content?: unknown;
  isError?: unknown;
  structuredContent?: unknown;
}

/**
 * Map MCP `CallToolResult.content` to pi's content array shape.
 *  - `text`        → `{ type: "text", text }`
 *  - `image`       → `{ type: "image", data, mimeType }`  (data is base64)
 *  - `resource` /
 *    `resource_link` / unknown → JSON-stringified into a text block.
 *
 * `isError: true` is preserved as a leading "[error]" prefix on the
 * first text block so the agent sees something acted-upon rather
 * than a silent dropped result.
 */
export function mcpResultToAgentResult(res: unknown): AgentToolResult<unknown> {
  const r = (res ?? {}) as McpCallResult;
  const isError = r.isError === true;
  const content: (
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  )[] = [];
  const blocks = Array.isArray(r.content) ? (r.content as McpContentBlock[]) : [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      content.push({ type: "image", data: block.data, mimeType: block.mimeType });
    } else {
      // Resource links, audio (rare), or unknown future block types.
      // Stringify so the agent at least gets the payload — a silent
      // drop would look like a successful no-op.
      content.push({
        type: "text",
        text: `[${String(block.type ?? "unknown")}] ${JSON.stringify(block)}`,
      });
    }
  }
  if (content.length === 0) {
    // Some MCP servers signal success with an empty content array;
    // include structuredContent if present so the agent has something
    // to work with.
    if (r.structuredContent !== undefined) {
      content.push({ type: "text", text: JSON.stringify(r.structuredContent) });
    } else {
      content.push({ type: "text", text: isError ? "[error] (no detail)" : "(empty result)" });
    }
  }
  if (isError && content[0]?.type === "text") {
    content[0] = { type: "text", text: `[error] ${content[0].text}` };
  }
  return { content: capTextContent(content), details: r.structuredContent ?? null };
}

/**
 * Default cap on the total *text* size (across all text blocks) of an
 * MCP tool result, in characters. 30k chars ≈ 10k tokens at the
 * code/JSON chars/3 ratio (the older 4:1 estimate was tuned for
 * prose and systematically under-counted real tool output by
 * 20–40%). The earlier 100k-char (≈ 33k-token) cap let one chatty
 * `list_everything` call dump 30k+ real tokens into context, eating
 * most of a session's usable budget in a single round trip and
 * triggering compaction far earlier than the operator expects. 10k
 * tokens is the practical upper bound for a *single* tool round
 * trip — anything bigger should be paginated, filtered, or written
 * to disk for the agent to `read` incrementally. Image blocks are
 * passed through untouched (truncating base64 mid-byte breaks the
 * image; image tokens are provider-specific anyway and not measured
 * here).
 *
 * Split: 60% head + 40% tail. Head usually carries summary / total /
 * schema context that the agent needs to interpret the rest; tail
 * usually has the most recent / most relevant items in time-ordered
 * lists.
 *
 * Warning text is placed at the very start of the returned text so
 * even simple models notice it before consuming a large head/tail
 * payload. It tells the agent (a) truncation happened, (b) by how
 * much, and (c) what to do next. Imperative phrasing nudges the
 * model to narrow scope rather than re-running the same call.
 *
 * No per-tool override yet — add when a real workload needs a higher
 * or lower cap. Hardcoded constant is the deliberate first cut.
 */
export const MCP_TEXT_CAP_CHARS = 30_000;
export const MCP_TEXT_HEAD_RATIO = 0.6;

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function capTextContent(blocks: ContentBlock[]): ContentBlock[] {
  let totalText = 0;
  for (const b of blocks) {
    if (b.type === "text") totalText += b.text.length;
  }
  if (totalText <= MCP_TEXT_CAP_CHARS) return blocks;
  // Flatten all text blocks into one head+tail string. Preserves
  // image blocks in their original positions; drops in-between text
  // separators in exchange for staying under the cap.
  const flat = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
  const headLen = Math.floor(MCP_TEXT_CAP_CHARS * MCP_TEXT_HEAD_RATIO);
  const tailLen = MCP_TEXT_CAP_CHARS - headLen;
  const head = flat.slice(0, headLen);
  const tail = flat.slice(flat.length - tailLen);
  const omitted = flat.length - headLen - tailLen;
  const warning =
    `MCP_RESULT_TRUNCATED: ${omitted.toLocaleString()} characters ` +
    `(~${Math.round(omitted / 4).toLocaleString()} tokens) were omitted from the middle of this tool result. ` +
    `Do not assume the missing content was irrelevant. Next step: call the MCP tool again with a smaller scope, ` +
    `narrower filter, or pagination to inspect the omitted content.\n\n`;
  const marker =
    `\n\n[--- MCP_RESULT_TRUNCATED: omitted middle content. Use a smaller scope, narrower filter, ` +
    `or pagination to inspect it. ---]\n\n`;
  const truncatedText = warning + head + marker + tail;
  // Keep one text block with the truncated payload + every image
  // block from the original (in its original relative order). Drop
  // duplicate text blocks since they were already absorbed into
  // `flat`.
  const out: ContentBlock[] = [];
  let textInjected = false;
  for (const b of blocks) {
    if (b.type === "text") {
      if (!textInjected) {
        out.push({ type: "text", text: truncatedText });
        textInjected = true;
      }
      continue;
    }
    out.push(b);
  }
  return out;
}

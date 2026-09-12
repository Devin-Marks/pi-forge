import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Type } from "typebox";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { writeFile } from "../file-manager.js";

export interface McpResultTruncationSettings {
  enabled: boolean;
  maxChars: number;
}

export interface McpResultSpoolingSettings {
  enabled: boolean;
  thresholdChars: number;
  directory: string;
  format: "json";
}

export interface McpSpoolingContext {
  workspacePath: string;
}

export const MCP_TOOL_CALL_TIMEOUT_MS = 120_000;
const MCP_DIAGNOSTIC_MAX_CHARS = 1_000;
const MCP_DETAIL_MAX_CHARS = 10_000;

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
  /** Workspace context for optional large-result spooling. Omitted for status-only bridge copies. */
  spoolingContext?: McpSpoolingContext;
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
        return await safelyConvertMcpResult(
          prefixedName,
          opts.serverName,
          opts.toolName,
          res,
          opts.spoolingContext,
        );
      } catch (err) {
        if (
          !isAbortError(err) &&
          isStaleMcpSessionError(err) &&
          opts.recoverStaleSession !== undefined
        ) {
          const recovered = await opts.recoverStaleSession().catch((recoverErr: unknown) => {
            logMcpToolFailure({
              serverName: opts.serverName,
              toolName: opts.toolName,
              phase: "reconnect",
              error: recoverErr,
            });
            return false;
          });
          const retryClient = opts.getClient();
          if (recovered && retryClient !== undefined) {
            try {
              const retryRes = await callMcpTool(retryClient, opts.toolName, params, signal);
              return await safelyConvertMcpResult(
                prefixedName,
                opts.serverName,
                opts.toolName,
                retryRes,
                opts.spoolingContext,
              );
            } catch (retryErr) {
              logMcpToolFailure({
                serverName: opts.serverName,
                toolName: opts.toolName,
                phase: "retry",
                error: retryErr,
              });
              return errorResult(
                `MCP tool '${prefixedName}' failed after reconnect: ${errorMessage(retryErr)}`,
              );
            }
          }
        }
        logMcpToolFailure({
          serverName: opts.serverName,
          toolName: opts.toolName,
          phase: isAbortError(err) ? "abort" : "call",
          error: err,
        });
        return errorResult(`MCP tool '${prefixedName}' failed: ${errorMessage(err)}`);
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
  const call = makeAbortableCallSignal(signal, MCP_TOOL_CALL_TIMEOUT_MS);
  try {
    const result = client.callTool(
      {
        name: toolName,
        arguments: isRecord(params) ? params : {},
      },
      undefined,
      { signal: call.signal },
    );
    return await Promise.race([result, call.abortPromise]);
  } finally {
    call.cleanup();
  }
}

async function safelyConvertMcpResult(
  prefixedName: string,
  serverName: string,
  toolName: string,
  res: unknown,
  spoolingContext: McpSpoolingContext | undefined,
): Promise<AgentToolResult<unknown>> {
  try {
    const spooled = await maybeSpoolMcpResult({
      prefixedName,
      serverName,
      toolName,
      res,
      spoolingContext,
    });
    if (spooled !== undefined) return spooled;
    return mcpResultToAgentResult(res);
  } catch (err) {
    logMcpToolFailure({ serverName, toolName, phase: "result_conversion", error: err });
    return errorResult(
      `MCP tool '${prefixedName}' returned a malformed result that pi-forge could not safely render: ${errorMessage(err)}`,
    );
  }
}

function makeAbortableCallSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; abortPromise: Promise<never>; cleanup: () => void } {
  const controller = new AbortController();
  let rejectAbort: (err: Error) => void = () => undefined;
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const fail = (err: Error): void => {
    controller.abort(err);
    rejectAbort(err);
  };
  const timeout = setTimeout(() => {
    fail(new Error(`MCP tool call timed out after ${timeoutMs} ms`));
  }, timeoutMs);
  const abort = (): void => {
    const reason = parent?.reason;
    fail(reason instanceof Error ? reason : new Error("MCP tool call aborted"));
  };
  if (parent?.aborted === true) abort();
  else parent?.addEventListener("abort", abort, { once: true });
  return {
    signal: controller.signal,
    abortPromise,
    cleanup: () => {
      clearTimeout(timeout);
      parent?.removeEventListener("abort", abort);
    },
  };
}

function errorResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: sanitizeDiagnostic(message, MCP_DIAGNOSTIC_MAX_CHARS) }],
    details: undefined,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.name, err.message].filter((p) => p.length > 0);
    return sanitizeDiagnostic(parts.join(": "), MCP_DIAGNOSTIC_MAX_CHARS);
  }
  return sanitizeDiagnostic(safeStringify(err, MCP_DIAGNOSTIC_MAX_CHARS), MCP_DIAGNOSTIC_MAX_CHARS);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted"));
}

function logMcpToolFailure(opts: {
  serverName: string;
  toolName: string;
  phase: "call" | "abort" | "reconnect" | "retry" | "result_conversion" | "spooling";
  error: unknown;
}): void {
  const error = opts.error as { name?: unknown; code?: unknown; cause?: unknown };
  const code =
    typeof error?.code === "string" || typeof error?.code === "number" ? error.code : undefined;
  const name = typeof error?.name === "string" ? error.name : undefined;
  const cause = error?.cause instanceof Error ? errorMessage(error.cause) : undefined;
  console.warn(
    "[mcp] tool failure",
    JSON.stringify({
      server: opts.serverName,
      tool: opts.toolName,
      phase: opts.phase,
      ...(name !== undefined ? { errorName: name } : {}),
      ...(code !== undefined ? { code } : {}),
      message: errorMessage(opts.error),
      ...(cause !== undefined ? { cause } : {}),
    }),
  );
}

function safeStringify(value: unknown, maxChars: number): string {
  return sanitizeDiagnostic(safeStringifyFull(value), maxChars);
}

function safeStringifyFull(value: unknown): string {
  const seen = new WeakSet<object>();
  let text: string | undefined;
  try {
    text = JSON.stringify(value, (_key, nested) => {
      if (typeof nested === "bigint") return nested.toString();
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) return "[Circular]";
        seen.add(nested);
      }
      return nested;
    });
  } catch (err) {
    text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  }
  return text === undefined ? String(value) : text;
}

function safeDetails(value: unknown): unknown {
  if (value === undefined) return null;
  return safeStringify(value, MCP_DETAIL_MAX_CHARS);
}

function sanitizeDiagnostic(value: string, maxChars: number): string {
  const redacted = value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(
      /((?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*)[^\s"',;]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /("(?:api[_-]?key|token|secret|password|passwd|pwd)"\s*:\s*")[^"]*(")/gi,
      "$1[REDACTED]$2",
    )
    .replace(/([A-Za-z0-9_-]{8,}\.)[A-Za-z0-9_-]{8,}(\.[A-Za-z0-9_-]{8,})/g, "$1[REDACTED]$2");
  if (redacted.length <= maxChars) return redacted;
  return `${redacted.slice(0, maxChars)}… [truncated ${redacted.length - maxChars} chars]`;
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

const MCP_SPOOL_PREVIEW_CHARS = 240;
const MCP_SPOOL_SAFE_NAME_RE = /[^A-Za-z0-9_.-]+/g;

let runtimeSpoolingSettings: McpResultSpoolingSettings = {
  enabled: true,
  thresholdChars: 30_000,
  directory: ".mcp-results",
  format: "json",
};

export function setMcpResultSpoolingSettings(settings: McpResultSpoolingSettings): void {
  runtimeSpoolingSettings = {
    enabled: settings.enabled,
    thresholdChars: Math.max(1, Math.floor(settings.thresholdChars)),
    directory: settings.directory.trim().length > 0 ? settings.directory.trim() : ".mcp-results",
    format: "json",
  };
}

export function getMcpResultSpoolingSettings(): McpResultSpoolingSettings {
  return { ...runtimeSpoolingSettings };
}

export function measureMcpResultTextChars(res: unknown): number {
  const r = (res ?? {}) as McpCallResult;
  const blocks = Array.isArray(r.content) ? (r.content as McpContentBlock[]) : [];
  let total = 0;
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") total += block.text.length;
    else if (block.type !== "image") total += safeStringifyFull(block).length;
  }
  if (total === 0 && r.structuredContent !== undefined) {
    total += safeStringifyFull(r.structuredContent).length;
  }
  return total;
}

async function maybeSpoolMcpResult(opts: {
  prefixedName: string;
  serverName: string;
  toolName: string;
  res: unknown;
  spoolingContext: McpSpoolingContext | undefined;
}): Promise<AgentToolResult<unknown> | undefined> {
  const settings = runtimeSpoolingSettings;
  const r = (opts.res ?? {}) as McpCallResult;
  if (!settings.enabled || opts.spoolingContext === undefined || r.isError === true)
    return undefined;
  const textChars = measureMcpResultTextChars(opts.res);
  if (textChars <= settings.thresholdChars) return undefined;

  const serialized = `${safeStringifyFull(opts.res)}\n`;
  const relativePath = buildSpoolRelativePath(settings.directory, opts.serverName, opts.toolName);
  try {
    await writeFile(
      join(opts.spoolingContext.workspacePath, relativePath),
      opts.spoolingContext.workspacePath,
      serialized,
    );
  } catch (err) {
    logMcpToolFailure({
      serverName: opts.serverName,
      toolName: opts.toolName,
      phase: "spooling",
      error: err,
    });
    const fallback = mcpResultToAgentResult(opts.res);
    return prependTextWarning(
      fallback,
      `MCP_RESULT_SPOOL_FAILED: pi-forge could not write the oversized MCP result to a workspace file (${errorMessage(err)}). Falling back to inline/truncated result.\n\n`,
    );
  }

  return {
    content: [
      {
        type: "text",
        text: buildSpooledSummary({
          prefixedName: opts.prefixedName,
          relativePath,
          textChars,
          bytes: Buffer.byteLength(serialized, "utf8"),
          preview: buildMcpPreview(opts.res),
          containsImages: mcpResultContainsImages(opts.res),
        }),
      },
    ],
    details: JSON.stringify({ spooled: true, path: relativePath, textChars }),
  };
}

function buildSpoolRelativePath(directory: string, serverName: string, toolName: string): string {
  const normalizedDir = directory.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/, "");
  const dir = normalizedDir.length > 0 ? normalizedDir : ".mcp-results";
  const server = safeFilenamePart(serverName);
  const tool = safeFilenamePart(toolName);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${dir}/${server}__${tool}__${timestamp}__${randomUUID()}.json`;
}

function safeFilenamePart(value: string): string {
  const cleaned = value.replace(MCP_SPOOL_SAFE_NAME_RE, "_").replace(/^\.+$/, "_").slice(0, 80);
  return cleaned.length > 0 ? cleaned : "mcp";
}

function buildMcpPreview(res: unknown): string {
  const agent = mcpResultToAgentResult(res);
  const text = agent.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n\n");
  return sanitizeDiagnostic(text.length > 0 ? text : "(no text preview)", MCP_SPOOL_PREVIEW_CHARS);
}

function mcpResultContainsImages(res: unknown): boolean {
  const blocks = Array.isArray((res as McpCallResult | undefined)?.content)
    ? ((res as McpCallResult).content as McpContentBlock[])
    : [];
  return blocks.some((block) => block.type === "image");
}

function buildSpooledSummary(opts: {
  prefixedName: string;
  relativePath: string;
  textChars: number;
  bytes: number;
  preview: string;
  containsImages: boolean;
}): string {
  const imageNote = opts.containsImages
    ? "\nImage content was present. The raw JSON file preserves image block metadata/data; inspect carefully instead of dumping it wholesale into model context."
    : "";
  return (
    `MCP_RESULT_SPOOLED: Tool '${opts.prefixedName}' returned an oversized result and pi-forge wrote the complete raw MCP result to a workspace file.\n` +
    `Path: ${opts.relativePath}\n` +
    `Approximate text size: ${opts.textChars.toLocaleString()} characters\n` +
    `File size: ${opts.bytes.toLocaleString()} bytes\n` +
    `${imageNote}\n` +
    `Use file-reading tools to inspect '${opts.relativePath}' incrementally; do not re-run the same broad MCP call just to recover omitted content.\n\n` +
    `Preview (first ${MCP_SPOOL_PREVIEW_CHARS.toLocaleString()} chars max):\n${opts.preview}`
  );
}

function prependTextWarning(
  result: AgentToolResult<unknown>,
  warning: string,
): AgentToolResult<unknown> {
  const content = [...result.content];
  const firstText = content.findIndex((block) => block.type === "text");
  if (firstText >= 0 && content[firstText]?.type === "text") {
    content[firstText] = { type: "text", text: warning + content[firstText].text };
  } else {
    content.unshift({ type: "text", text: warning });
  }
  return { ...result, content };
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
        text: `[${String(block.type ?? "unknown")}] ${safeStringify(block, MCP_DETAIL_MAX_CHARS)}`,
      });
    }
  }
  if (content.length === 0) {
    // Some MCP servers signal success with an empty content array;
    // include structuredContent if present so the agent has something
    // to work with.
    if (r.structuredContent !== undefined) {
      content.push({
        type: "text",
        text: safeStringify(r.structuredContent, MCP_DETAIL_MAX_CHARS),
      });
    } else {
      content.push({ type: "text", text: isError ? "[error] (no detail)" : "(empty result)" });
    }
  }
  if (isError && content[0]?.type === "text") {
    content[0] = { type: "text", text: `[error] ${content[0].text}` };
  }
  return { content: capTextContent(content), details: safeDetails(r.structuredContent) };
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

let runtimeTruncationSettings: McpResultTruncationSettings = {
  enabled: true,
  maxChars: MCP_TEXT_CAP_CHARS,
};

export function setMcpResultTruncationSettings(settings: McpResultTruncationSettings): void {
  runtimeTruncationSettings = {
    enabled: settings.enabled,
    maxChars: Math.max(1, Math.floor(settings.maxChars)),
  };
}

export function getMcpResultTruncationSettings(): McpResultTruncationSettings {
  return { ...runtimeTruncationSettings };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export function capTextContent(blocks: ContentBlock[]): ContentBlock[] {
  const settings = runtimeTruncationSettings;
  if (!settings.enabled) return blocks;
  const capChars = settings.maxChars;
  let totalText = 0;
  for (const b of blocks) {
    if (b.type === "text") totalText += b.text.length;
  }
  if (totalText <= capChars) return blocks;
  // Flatten all text blocks into one head+tail string. Preserves
  // image blocks in their original positions; drops in-between text
  // separators in exchange for staying under the cap.
  const flat = blocks
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n\n");
  const headLen = Math.floor(capChars * MCP_TEXT_HEAD_RATIO);
  const tailLen = capChars - headLen;
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

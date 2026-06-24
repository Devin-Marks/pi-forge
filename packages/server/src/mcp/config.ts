import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * pi-forge-owned MCP server registry. Lives at
 * `${FORGE_DATA_DIR}/mcp.json` (mode 0600). The pi SDK has no
 * native MCP support — this file is read by `mcp/manager.ts`, the
 * configured servers are connected to via @modelcontextprotocol/sdk,
 * and the resulting tools are passed into every `createAgentSession`
 * call as `customTools`.
 *
 * Two server kinds, discriminated by which fields are present (not
 * by an explicit `kind` discriminator). Presence-based matching is
 * deliberate — it matches the Claude Desktop / pi-mcp-adapter
 * convention so a user's existing `.mcp.json` works without
 * rewriting:
 *
 *   - **Remote** servers: have `url`. Spoken via StreamableHTTP /
 *     SSE. Auth via static headers.
 *   - **Stdio** servers: have `command`. The pi-forge spawns the
 *     subprocess and speaks MCP over its stdin/stdout.
 *
 * Exactly one of `url` / `command` must be set per server; the route
 * layer enforces this and rejects ambiguous configs with 400.
 *
 * **Secret hygiene.** `headers` values (remote) and `env` values
 * (stdio) are treated as secret on the read path —
 * `readMcpJsonRedacted` replaces every value with the sentinel so
 * the browser never sees the raw token. On write, a sentinel value
 * round-trips to the prior on-disk value so an "edit and save"
 * doesn't lock the user out (same pattern as `models.json#apiKey`).
 */

export type McpTransport = "auto" | "streamable-http" | "sse";

export interface McpServerConfig {
  /** Default true. Disabled servers don't connect or contribute tools. */
  enabled?: boolean;

  /* --------- remote-only (mutually exclusive with `command`) --------- */
  /** The MCP endpoint URL. Required for remote servers. */
  url?: string;
  /**
   * Transport hint for remote servers. `auto` (default) tries
   * StreamableHTTP first and falls back to SSE — covers fastmcp
   * servers regardless of which transport they expose. Pin to
   * `streamable-http` or `sse` explicitly to skip the fallback
   * round-trip. Ignored for stdio servers.
   */
  transport?: McpTransport;
  /**
   * Per-request headers (e.g. `{ "Authorization": "Bearer ..." }`).
   * Forwarded on every MCP RPC. Treated as secret on the read path —
   * `readMcpJsonRedacted` replaces every value with the sentinel.
   * Ignored for stdio servers.
   */
  headers?: Record<string, string>;

  /* --------- stdio-only (mutually exclusive with `url`) --------- */
  /**
   * Executable to spawn (passed to `child_process.spawn` via the MCP
   * SDK's StdioClientTransport). Required for stdio servers. Resolved
   * via the process PATH if not absolute. Common values: `npx`, `uvx`,
   * `python`, a path to a local binary.
   */
  command?: string;
  /** CLI args appended to `command`. Defaults to `[]`. */
  args?: string[];
  /**
   * Explicit environment for the subprocess. The MCP SDK's
   * `StdioClientTransport` does NOT inherit the pi-forge process
   * env by default — it uses `getDefaultEnvironment()` which only
   * exposes a small allowlist (PATH, HOME, locale vars, etc.). Set
   * this to pass through provider keys / config the MCP server
   * needs (e.g. `GITHUB_TOKEN`, `OPENAI_API_KEY`). Treated as secret
   * on the read path (env values commonly contain credentials).
   */
  env?: Record<string, string>;
  /**
   * Working directory for the subprocess. Defaults to the project
   * path for project-scoped servers, and the pi-forge process cwd
   * for global servers.
   */
  cwd?: string;
}

export interface McpTruncationConfig {
  /** Default true. When false, MCP text results pass through without truncation. */
  enabled?: boolean;
  /** Total text-character cap across all MCP result text blocks. Default 30000. */
  maxChars?: number;
}

export interface McpJson {
  /**
   * Master kill-switch surfaced as a toggle in Settings → MCP. When
   * true, NO MCP tools are passed into createAgentSession (regardless
   * of per-server enabled flags). Connections still happen so the
   * status display stays honest; only the tool-injection step is
   * skipped. Defaults to false (MCP tools available).
   */
  disabled?: boolean;
  /** MCP result truncation settings. Defaults to enabled with a 30k character cap. */
  truncation?: McpTruncationConfig;
  servers: Record<string, McpServerConfig>;
}

/**
 * True when this entry should be opened as a stdio (subprocess)
 * server, false when remote (URL). Single source of truth for the
 * discriminator — callers don't have to re-derive
 * `cfg.command !== undefined` everywhere, and a future migration to
 * an explicit `kind` field has one place to change.
 */
export function isStdioConfig(cfg: McpServerConfig): boolean {
  return typeof cfg.command === "string" && cfg.command.length > 0;
}

const SECRET_PLACEHOLDER = "***REDACTED***";
export const DEFAULT_MCP_TRUNCATION_MAX_CHARS = 30_000;

export function normalizeMcpTruncationConfig(
  input: McpTruncationConfig | undefined,
): Required<McpTruncationConfig> {
  const enabled = input?.enabled !== false;
  const rawMax = input?.maxChars;
  const maxChars =
    typeof rawMax === "number" && Number.isFinite(rawMax) && rawMax >= 1
      ? Math.floor(rawMax)
      : DEFAULT_MCP_TRUNCATION_MAX_CHARS;
  return { enabled, maxChars };
}

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.mcpConfigFile), { recursive: true });
}

async function atomicWriteJson(data: unknown): Promise<void> {
  await ensureDir();
  const path = config.mcpConfigFile;
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  // Some kernels honour the umask on the initial create; reapply 0600
  // explicitly so the persisted file always matches what we promised
  // in the docstring.
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort — if chmod fails (e.g. read-only fs in tests), the
    // umask-applied perms are still likely fine.
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function readMcpJson(): Promise<McpJson> {
  try {
    const raw = await readFile(config.mcpConfigFile, "utf8");
    if (raw.trim().length === 0) return { servers: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("servers" in parsed)) {
      return { servers: {} };
    }
    const servers = (parsed as { servers?: unknown }).servers;
    const disabled = (parsed as { disabled?: unknown }).disabled === true;
    const rawTruncation = (parsed as { truncation?: unknown }).truncation;
    const truncation =
      typeof rawTruncation === "object" && rawTruncation !== null
        ? normalizeMcpTruncationConfig(rawTruncation)
        : undefined;
    if (typeof servers !== "object" || servers === null) {
      return { disabled, ...(truncation !== undefined ? { truncation } : {}), servers: {} };
    }
    return {
      disabled,
      ...(truncation !== undefined ? { truncation } : {}),
      servers: servers as Record<string, McpServerConfig>,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { servers: {} };
    throw err;
  }
}

/**
 * Copy `src` to a fresh `McpServerConfig` keeping only fields that
 * are not `undefined`. Centralizes the field list so the redact /
 * write paths can't drift from each other when we add a field.
 */
function copyServerCleaned(src: McpServerConfig): McpServerConfig {
  const out: McpServerConfig = {};
  if (src.enabled !== undefined) out.enabled = src.enabled;
  if (src.url !== undefined) out.url = src.url;
  if (src.transport !== undefined) out.transport = src.transport;
  if (src.command !== undefined) out.command = src.command;
  if (src.args !== undefined) out.args = [...src.args];
  if (src.cwd !== undefined) out.cwd = src.cwd;
  return out;
}

/**
 * Same as readMcpJson but with every secret VALUE replaced with the
 * redaction sentinel. Covers both `headers` (remote) and `env`
 * (stdio) — both fields commonly carry credentials.
 */
export async function readMcpJsonRedacted(): Promise<McpJson> {
  const raw = await readMcpJson();
  const out: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(raw.servers)) {
    const cleaned = copyServerCleaned(server);
    if (server.headers !== undefined) {
      cleaned.headers = {};
      for (const k of Object.keys(server.headers)) {
        cleaned.headers[k] = SECRET_PLACEHOLDER;
      }
    }
    if (server.env !== undefined) {
      cleaned.env = {};
      for (const k of Object.keys(server.env)) {
        cleaned.env[k] = SECRET_PLACEHOLDER;
      }
    }
    out[name] = cleaned;
  }
  return { disabled: raw.disabled === true, servers: out };
}

/**
 * Merge a sentinel-bearing key/value map with the prior persisted
 * one. Used for both `headers` and `env` — same shape, same logic,
 * single helper. Sentinel ↦ prior value (or drop the key if no
 * prior); real value ↦ overwrite.
 */
function mergeSecretMap(
  next: Record<string, string>,
  prior: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v === SECRET_PLACEHOLDER) {
      if (prior?.[k] !== undefined) out[k] = prior[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Write `mcp.json`, merging the secret-placeholder for `headers`
 * AND `env` values back to the prior persisted value. Without this,
 * an "edit and save" round-trip from the UI (which sees the
 * sentinel) would write the literal sentinel back to disk and lock
 * the user out of their MCP server. Same pattern as
 * config-manager.writeModelsJson for `apiKey`.
 */
export async function writeMcpJson(next: McpJson): Promise<void> {
  const existing: McpJson = await readMcpJson().catch(() => ({ servers: {} }));
  const safe: McpJson = { servers: {} };
  if (next.disabled === true) safe.disabled = true;
  const truncation = normalizeMcpTruncationConfig(next.truncation);
  if (truncation.enabled !== true || truncation.maxChars !== DEFAULT_MCP_TRUNCATION_MAX_CHARS) {
    safe.truncation = truncation;
  }
  for (const [name, server] of Object.entries(next.servers ?? {})) {
    const merged = copyServerCleaned(server);
    if (server.headers !== undefined) {
      merged.headers = mergeSecretMap(server.headers, existing.servers[name]?.headers);
    }
    if (server.env !== undefined) {
      merged.env = mergeSecretMap(server.env, existing.servers[name]?.env);
    }
    safe.servers[name] = merged;
  }
  await atomicWriteJson(safe);
}

export async function upsertMcpServer(name: string, server: McpServerConfig): Promise<void> {
  const cur = await readMcpJson();
  cur.servers[name] = server;
  await writeMcpJson(cur);
}

export async function setMcpDisabled(disabled: boolean): Promise<void> {
  const cur = await readMcpJson();
  cur.disabled = disabled;
  await writeMcpJson(cur);
}

export async function setMcpTruncationConfig(truncation: McpTruncationConfig): Promise<void> {
  const cur = await readMcpJson();
  cur.truncation = normalizeMcpTruncationConfig({
    ...normalizeMcpTruncationConfig(cur.truncation),
    ...truncation,
  });
  await writeMcpJson(cur);
}

export async function deleteMcpServer(name: string): Promise<boolean> {
  const cur = await readMcpJson();
  if (cur.servers[name] === undefined) return false;
  delete cur.servers[name];
  await writeMcpJson(cur);
  return true;
}

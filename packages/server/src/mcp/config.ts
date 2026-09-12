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
export interface McpHeaderEnvValue {
  env: string;
}
export type McpHeaderValue = string | McpHeaderEnvValue;

export function isMcpHeaderEnvValue(value: McpHeaderValue): value is McpHeaderEnvValue {
  return typeof value === "object" && value !== null && typeof value.env === "string";
}

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
   * Values may be literal strings (backward-compatible) or
   * `{ "env": "VAR_NAME" }` references that resolve from the
   * pi-forge process environment when an MCP HTTP request is made.
   * Literal values are treated as secret on the read path —
   * `readMcpJsonRedacted` replaces every value with the sentinel.
   * Env-backed values preserve only the env var name on the read path.
   * Ignored for stdio servers.
   */
  headers?: Record<string, McpHeaderValue>;
  /**
   * Remote-only escape hatch for local/self-signed HTTPS MCP endpoints.
   * When true, TLS certificate validation is disabled for this server's
   * connection attempts. Defaults to false; do not enable for untrusted networks.
   */
  ignoreCertificateErrors?: boolean;

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

export interface McpSpoolingConfig {
  /** Default true. When true, oversized non-error MCP results are written to workspace files. */
  enabled?: boolean;
  /** Total text-character threshold before spooling. Default 30000. */
  thresholdChars?: number;
  /** Workspace-relative directory for result files. Default .mcp-results. */
  directory?: string;
  /** Spool file format. Only json is currently supported. */
  format?: "json";
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
  /** MCP result spooling settings. Defaults to enabled. */
  spooling?: McpSpoolingConfig;
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
export const DEFAULT_MCP_SPOOLING_THRESHOLD_CHARS = 30_000;
export const DEFAULT_MCP_SPOOLING_DIRECTORY = ".mcp-results";

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

export function normalizeMcpSpoolingConfig(
  input: McpSpoolingConfig | undefined,
): Required<McpSpoolingConfig> {
  const enabled = input?.enabled !== false;
  const rawThreshold = input?.thresholdChars;
  const thresholdChars =
    typeof rawThreshold === "number" && Number.isFinite(rawThreshold) && rawThreshold >= 1
      ? Math.floor(rawThreshold)
      : DEFAULT_MCP_SPOOLING_THRESHOLD_CHARS;
  const rawDirectory = typeof input?.directory === "string" ? input.directory.trim() : "";
  const directory = rawDirectory.length > 0 ? rawDirectory : DEFAULT_MCP_SPOOLING_DIRECTORY;
  return { enabled, thresholdChars, directory, format: "json" };
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
    const rawSpooling = (parsed as { spooling?: unknown }).spooling;
    const spooling =
      typeof rawSpooling === "object" && rawSpooling !== null
        ? normalizeMcpSpoolingConfig(rawSpooling)
        : undefined;
    if (typeof servers !== "object" || servers === null) {
      return {
        disabled,
        ...(truncation !== undefined ? { truncation } : {}),
        ...(spooling !== undefined ? { spooling } : {}),
        servers: {},
      };
    }
    return {
      disabled,
      ...(truncation !== undefined ? { truncation } : {}),
      ...(spooling !== undefined ? { spooling } : {}),
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
  if (src.ignoreCertificateErrors !== undefined) {
    out.ignoreCertificateErrors = src.ignoreCertificateErrors;
  }
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
      for (const [k, v] of Object.entries(server.headers)) {
        cleaned.headers[k] = isMcpHeaderEnvValue(v) ? { env: v.env } : SECRET_PLACEHOLDER;
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
  return {
    disabled: raw.disabled === true,
    ...(raw.truncation !== undefined ? { truncation: raw.truncation } : {}),
    ...(raw.spooling !== undefined ? { spooling: raw.spooling } : {}),
    servers: out,
  };
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

function mergeHeaderMap(
  next: Record<string, McpHeaderValue>,
  prior: Record<string, McpHeaderValue> | undefined,
): Record<string, McpHeaderValue> {
  const out: Record<string, McpHeaderValue> = {};
  for (const [k, v] of Object.entries(next)) {
    if (v === SECRET_PLACEHOLDER) {
      if (prior?.[k] !== undefined) out[k] = prior[k];
    } else if (isMcpHeaderEnvValue(v)) {
      out[k] = { env: v.env };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function validateEnvName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Resolve remote MCP headers for an outbound HTTP request. This is the
 * deliberate exception to the usual operational-env centralization rule:
 * header env names are user-authored dynamic MCP config, not pi-forge
 * operational settings with a fixed CLI/env surface.
 */
export function resolveMcpHeaders(
  headers: Record<string, McpHeaderValue> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (isMcpHeaderEnvValue(value)) {
      const envName = value.env.trim();
      if (!validateEnvName(envName)) {
        throw new Error(`MCP header '${name}' references an invalid environment variable name`);
      }
      const resolved = process.env[envName];
      if (resolved === undefined) {
        throw new Error(
          `MCP header '${name}' requires environment variable ${envName}, but it is not set`,
        );
      }
      out[name] = resolved;
    } else {
      out[name] = value;
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
  const spooling = normalizeMcpSpoolingConfig(next.spooling);
  if (
    spooling.enabled !== true ||
    spooling.thresholdChars !== DEFAULT_MCP_SPOOLING_THRESHOLD_CHARS ||
    spooling.directory !== DEFAULT_MCP_SPOOLING_DIRECTORY ||
    spooling.format !== "json"
  ) {
    safe.spooling = spooling;
  }
  for (const [name, server] of Object.entries(next.servers ?? {})) {
    const merged = copyServerCleaned(server);
    if (server.headers !== undefined) {
      merged.headers = mergeHeaderMap(server.headers, existing.servers[name]?.headers);
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

export async function setMcpSpoolingConfig(spooling: McpSpoolingConfig): Promise<void> {
  const cur = await readMcpJson();
  cur.spooling = normalizeMcpSpoolingConfig({
    ...normalizeMcpSpoolingConfig(cur.spooling),
    ...spooling,
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

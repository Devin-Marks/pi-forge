import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readMcpJson, type McpServerConfig, type McpTransport } from "./config.js";
import { bridgeMcpTool } from "./tool-bridge.js";

/** Looser-than-the-SDK transport handle — we only need close().
 *  The SDK's `Transport` interface declares `sessionId: string` (not
 *  optional), but its concrete classes type it as `string | undefined`,
 *  which our exactOptionalPropertyTypes config rejects when narrowed
 *  to the interface. Storing as a structural close-only type sidesteps
 *  that disagreement. */
interface ClosableTransport {
  close(): Promise<void> | void;
}

/**
 * Singleton MCP server pool. Owns the @modelcontextprotocol/sdk
 * `Client` for every configured + enabled server, refreshes the tool
 * catalogue on connect, and aggregates everything into the
 * `customTools` array fed to `createAgentSession`.
 *
 * Scope:
 *  - "global": loaded from `${FORGE_DATA_DIR}/mcp.json`. Available
 *    to every project's sessions.
 *  - "project:<projectId>": loaded from `<projectPath>/.mcp.json`.
 *    Only available to sessions in that project. Project servers OVER-
 *    RIDE global servers on name collision.
 *
 * Connection state surfaces through `getStatus()` which the UI polls.
 * Connections are eager: we attempt to connect on `loadGlobal()` /
 * `loadProject()` so the status badge has something honest to show.
 *
 * v1 supports remote transports only (StreamableHTTP + SSE). stdio
 * deferred — the pi-forge is container-native and arbitrary
 * subprocess spawning has different security trade-offs.
 */

export type ConnectionState = "idle" | "connecting" | "connected" | "error" | "disabled";
export type Scope = "global" | { project: string };

const PROJECT_MCP_FILE = ".mcp.json";

interface PoolEntry {
  scope: Scope;
  name: string;
  config: McpServerConfig;
  client?: Client;
  transport?: ClosableTransport;
  state: ConnectionState;
  lastError?: string;
  /** Cached tool catalogue from the last successful `client.listTools()`. */
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[];
  /** Pre-built ToolDefinitions, rebuilt every reconnect so the closure
   *  captures the latest client instance. */
  bridged: ToolDefinition[];
}

function entryKey(scope: Scope, name: string): string {
  return scope === "global" ? `global::${name}` : `project:${scope.project}::${name}`;
}

const pool = new Map<string, PoolEntry>();

/** Tracks projects we've loaded once already so repeat session
 *  creates in the same project don't redundantly re-read the file. */
const loadedProjects = new Set<string>();

/**
 * Mirrored from `mcp.json#disabled` on every load so the hot path
 * (`customToolsForProject`, called every `createAgentSession`) doesn't
 * have to do file I/O.
 */
let globallyEnabled = true;

export function isGloballyEnabled(): boolean {
  return globallyEnabled;
}

/* ----------------------------- public API ----------------------------- */

export async function loadGlobal(): Promise<void> {
  const cfg = await readMcpJson();
  globallyEnabled = cfg.disabled !== true;
  await syncScope("global", cfg.servers);
}

export async function loadProject(projectId: string, projectPath: string): Promise<void> {
  const cfg = await readProjectMcpJson(projectPath);
  await syncScope({ project: projectId }, cfg);
  loadedProjects.add(projectId);
}

export async function ensureProjectLoaded(projectId: string, projectPath: string): Promise<void> {
  if (loadedProjects.has(projectId)) return;
  await loadProject(projectId, projectPath);
}

/**
 * Re-read the global config file and sync the pool. Called on every
 * write through `routes/mcp.ts` so the UI's "save" reflects in
 * connection state immediately.
 */
export async function reloadGlobal(): Promise<void> {
  loadedProjects.clear(); // project files may reference globals too
  await loadGlobal();
}

/**
 * Build the `customTools` list for a session in `projectId`. Returns
 * the union of every connected, enabled server's bridged tools across
 * the global scope and the project scope. On name collision the
 * project entry wins (the session sees the project's bridged tool,
 * not the global one).
 */
export function customToolsForProject(projectId: string): ToolDefinition[] {
  // Server-name override: when the project has a server with the
  // same NAME as a global server, the project entry replaces the
  // global one entirely (not just on tool-name collision). Reason:
  // operators expect a project's `.mcp.json` to fully shadow a same-
  // named global entry — different auth tokens, different `enabled`
  // flags, and (if URLs match) one TCP connection rather than two.
  const projectServerNames = new Set<string>();
  for (const e of pool.values()) {
    if (e.scope === "global") continue;
    if (e.scope.project !== projectId) continue;
    projectServerNames.add(e.name);
  }
  const seenToolNames = new Set<string>();
  const out: ToolDefinition[] = [];
  // Project entries first so their tools land in `seen` and any
  // remaining tool-name collisions across other servers go to the
  // project's version.
  for (const e of pool.values()) {
    if (e.scope === "global") continue;
    if (e.scope.project !== projectId) continue;
    if (e.state !== "connected") continue;
    for (const t of e.bridged) {
      if (seenToolNames.has(t.name)) continue;
      seenToolNames.add(t.name);
      out.push(t);
    }
  }
  for (const e of pool.values()) {
    if (e.scope !== "global") continue;
    // Server-name shadowed by a project entry — skip the global
    // entry entirely.
    if (projectServerNames.has(e.name)) continue;
    if (e.state !== "connected") continue;
    for (const t of e.bridged) {
      if (seenToolNames.has(t.name)) continue;
      seenToolNames.add(t.name);
      out.push(t);
    }
  }
  return out;
}

export interface ServerStatus {
  scope: "global" | "project";
  projectId?: string;
  name: string;
  url: string;
  enabled: boolean;
  state: ConnectionState;
  toolCount: number;
  /**
   * Per-tool detail surfaced for the Settings → Tools view (and
   * any other UI that wants to enumerate tools). Each entry's
   * `name` is the BRIDGED name pi sees on the wire
   * (`<server>__<tool>`); `shortName` is the unprefixed name the
   * MCP server itself reports. Empty when the connection isn't in
   * `connected` state — there's nothing to enumerate yet.
   */
  tools: { name: string; shortName: string; description: string }[];
  lastError?: string;
  /** Resolved transport — populated once a connection succeeds.
   *  Useful for UI display when the user picked `auto`. */
  transport?: McpTransport;
}

export function getStatus(opts?: { projectId?: string }): ServerStatus[] {
  const out: ServerStatus[] = [];
  for (const e of pool.values()) {
    if (e.scope !== "global") {
      if (opts?.projectId !== undefined && e.scope.project !== opts.projectId) continue;
      if (opts?.projectId === undefined) continue; // omit project entries from global view
    }
    // Pair each raw `entry.tools[i]` with the bridged tool sitting
    // at the same index — `connectEntry` builds them in lockstep, so
    // index alignment is the load-bearing invariant. Surfacing both
    // names lets the UI key toggles by the bridged name (which pi
    // sees) while still showing the operator the human-friendlier
    // unprefixed form.
    const tools = e.tools.map((t, i) => ({
      name: e.bridged[i]?.name ?? `${e.name}__${t.name}`,
      shortName: t.name,
      description: t.description,
    }));
    const status: ServerStatus = {
      scope: e.scope === "global" ? "global" : "project",
      name: e.name,
      url: e.config.url,
      enabled: e.config.enabled !== false,
      state: e.state,
      toolCount: e.tools.length,
      tools,
    };
    if (e.scope !== "global") status.projectId = e.scope.project;
    if (e.lastError !== undefined) status.lastError = e.lastError;
    if (e.config.transport !== undefined) status.transport = e.config.transport;
    out.push(status);
  }
  return out;
}

/**
 * Force a connection attempt (or reconnection) for the named server.
 * Returns the resulting status entry. Useful for the "Probe" button
 * in Settings.
 */
export async function probe(scope: Scope, name: string): Promise<ServerStatus | undefined> {
  const entry = pool.get(entryKey(scope, name));
  if (entry === undefined) return undefined;
  await disconnectEntry(entry);
  await connectEntry(entry);
  const opts = scope === "global" ? undefined : { projectId: scope.project };
  return getStatus(opts).find(
    (s) => s.name === name && s.scope === (scope === "global" ? "global" : "project"),
  );
}

export async function disposeAll(): Promise<void> {
  await Promise.allSettled(Array.from(pool.values()).map((entry) => disconnectEntry(entry)));
  pool.clear();
  loadedProjects.clear();
}

/* ----------------------------- internals ----------------------------- */

async function syncScope(scope: Scope, configs: Record<string, McpServerConfig>): Promise<void> {
  // Disconnect + drop entries that no longer exist in the config (or
  // moved scope). Mutating during iteration is fine because we take a
  // snapshot of keys first.
  const wantNames = new Set(Object.keys(configs));
  for (const [key, entry] of Array.from(pool.entries())) {
    if (entryScopeMatches(entry.scope, scope) && !wantNames.has(entry.name)) {
      await disconnectEntry(entry);
      pool.delete(key);
    }
  }
  // Add / update each declared server.
  for (const [name, cfg] of Object.entries(configs)) {
    const key = entryKey(scope, name);
    const existing = pool.get(key);
    if (existing !== undefined) {
      const sameUrl = existing.config.url === cfg.url;
      const sameTransport = existing.config.transport === cfg.transport;
      const sameEnabled = (existing.config.enabled !== false) === (cfg.enabled !== false);
      const sameHeaders =
        JSON.stringify(existing.config.headers ?? {}) === JSON.stringify(cfg.headers ?? {});
      existing.config = cfg;
      if (sameUrl && sameTransport && sameEnabled && sameHeaders) {
        // Nothing meaningful changed; skip the disconnect/reconnect dance.
        continue;
      }
      await disconnectEntry(existing);
      if (cfg.enabled === false) {
        existing.state = "disabled";
        continue;
      }
      void connectEntry(existing);
      continue;
    }
    const entry: PoolEntry = {
      scope,
      name,
      config: cfg,
      state: cfg.enabled === false ? "disabled" : "idle",
      tools: [],
      bridged: [],
    };
    pool.set(key, entry);
    if (cfg.enabled !== false) {
      void connectEntry(entry);
    }
  }
}

function entryScopeMatches(a: Scope, b: Scope): boolean {
  if (a === "global" && b === "global") return true;
  if (a !== "global" && b !== "global") return a.project === b.project;
  return false;
}

async function connectEntry(entry: PoolEntry): Promise<void> {
  entry.state = "connecting";
  delete entry.lastError;
  try {
    const { client, transport, resolvedTransport } = await openConnection(entry.config);
    entry.client = client;
    entry.transport = transport;
    entry.config.transport = resolvedTransport;
    const list = await client.listTools();
    entry.tools = (list.tools ?? []).map((t) => ({
      name: t.name,
      description: typeof t.description === "string" ? t.description : "",
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));
    entry.bridged = entry.tools.map((t) =>
      bridgeMcpTool({
        serverName: entry.name,
        toolName: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
        getClient: () => pool.get(entryKey(entry.scope, entry.name))?.client,
      }),
    );
    entry.state = "connected";
  } catch (err) {
    delete entry.client;
    delete entry.transport;
    entry.tools = [];
    entry.bridged = [];
    entry.state = "error";
    entry.lastError = err instanceof Error ? err.message : String(err);
  }
}

async function disconnectEntry(entry: PoolEntry): Promise<void> {
  const client = entry.client;
  const transport = entry.transport;
  delete entry.client;
  delete entry.transport;
  entry.tools = [];
  entry.bridged = [];
  if (entry.state !== "disabled") entry.state = "idle";
  // Best-effort close. The MCP SDK's Client.close() also closes the
  // transport, but we belt-and-suspender the transport too in case
  // the client never finished handshaking.
  // close() can be sync (void) or async (Promise<void>) depending on
  // the transport — Promise.resolve normalizes either to a thenable.
  await Promise.resolve(client?.close()).catch(() => undefined);
  await Promise.resolve(transport?.close()).catch(() => undefined);
}

interface OpenedConnection {
  client: Client;
  transport: ClosableTransport;
  resolvedTransport: McpTransport;
}

/**
 * Open a connection using the requested transport. `auto` (default)
 * attempts StreamableHTTP first, then falls back to SSE on failure —
 * covers fastmcp servers regardless of which transport they expose.
 */
async function openConnection(cfg: McpServerConfig): Promise<OpenedConnection> {
  const url = new URL(cfg.url);
  const requested: McpTransport = cfg.transport ?? "auto";
  if (requested === "streamable-http") {
    return await openStreamableHttp(url, cfg.headers);
  }
  if (requested === "sse") {
    return await openSse(url, cfg.headers);
  }
  // auto: try streamable-http, fall back to sse
  try {
    return await openStreamableHttp(url, cfg.headers);
  } catch {
    return await openSse(url, cfg.headers);
  }
}

// The MCP SDK's Transport interface and its concrete classes disagree
// about whether `sessionId` is optional. Cast the concrete instances at
// the connect boundary so we don't propagate that union mismatch into
// our own types — runtime behavior is unaffected.
type SdkTransport = Parameters<Client["connect"]>[0];

async function openStreamableHttp(
  url: URL,
  headers: Record<string, string> | undefined,
): Promise<OpenedConnection> {
  const transport = new StreamableHTTPClientTransport(
    url,
    headers !== undefined ? { requestInit: { headers } } : undefined,
  );
  const client = new Client({ name: "pi-forge", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport as unknown as SdkTransport);
  return { client, transport, resolvedTransport: "streamable-http" };
}

async function openSse(
  url: URL,
  headers: Record<string, string> | undefined,
): Promise<OpenedConnection> {
  // Build options inline — exactOptionalPropertyTypes refuses to
  // accept explicit `undefined` for optional properties, so the
  // header-bearing variant builds the full options literal in one
  // shot rather than composing it field-by-field.
  const transport =
    headers !== undefined
      ? new SSEClientTransport(url, {
          requestInit: { headers },
          // Custom EventSource fetch factory so the SSE GET also
          // carries the Authorization header. Browsers' native
          // EventSource doesn't accept headers, but the MCP SDK's
          // bundled eventsource shim does, via this factory hook.
          eventSourceInit: {
            fetch: (input: string | URL, init?: RequestInit) =>
              fetch(input, {
                ...init,
                headers: { ...((init?.headers as Record<string, string>) ?? {}), ...headers },
              }),
          } as unknown as EventSourceInit,
        })
      : new SSEClientTransport(url);
  const client = new Client({ name: "pi-forge", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport, resolvedTransport: "sse" };
}

/* -------------------------- project-scope read -------------------------- */

async function readProjectMcpJson(projectPath: string): Promise<Record<string, McpServerConfig>> {
  const path = join(projectPath, PROJECT_MCP_FILE);
  try {
    const raw = await readFile(path, "utf8");
    if (raw.trim().length === 0) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    // Accept both `{ servers: {...} }` (pi-forge shape) and
    // `{ mcpServers: {...} }` (Claude Desktop / pi-mcp-adapter shape)
    // so a project that already speaks the standard MCP file format
    // works without rewriting.
    const servers =
      (parsed as { servers?: unknown }).servers ?? (parsed as { mcpServers?: unknown }).mcpServers;
    if (typeof servers !== "object" || servers === null) return {};
    return servers as Record<string, McpServerConfig>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
}

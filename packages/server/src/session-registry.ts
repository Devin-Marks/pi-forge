import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  SessionManager,
  SettingsManager,
  type SessionInfo,
} from "@mariozechner/pi-coding-agent";
import { buildForgeResourceLoader } from "./agent-resource-loader.js";
import { config } from "./config.js";
import { makeDedupe, makeLock } from "./concurrency.js";
import { effectiveSkillsForProject } from "./config-manager.js";
import { readProjects } from "./project-manager.js";
import { filterEnabledTools, readToolOverrides } from "./tool-overrides.js";
import { discoverExtensionResources } from "./extensions-discovery.js";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import {
  customToolsForProject as mcpCustomToolsForProject,
  ensureProjectLoaded as mcpEnsureProjectLoaded,
  isGloballyEnabled as mcpIsGloballyEnabled,
} from "./mcp/manager.js";

/**
 * Minimal SSE client contract used by the registry to fan out events.
 * Phase 5 (sse-bridge.ts) provides the concrete implementation; Phase 4
 * only needs the interface so LiveSession.clients typechecks.
 *
 * The send() signature is intentionally `unknown` for `event` so Phase 5 can
 * widen the union with webui-specific types (SnapshotEvent, etc.) without
 * forcing a dependency cycle through this module.
 */
export interface SSEClient {
  readonly id: string;
  send(event: AgentSessionEvent | { type: string; [k: string]: unknown }): void;
  close(): void;
}

export interface LiveSession {
  session: AgentSession;
  sessionId: string;
  projectId: string;
  workspacePath: string;
  clients: Set<SSEClient>;
  createdAt: Date;
  lastActivityAt: Date;
  /**
   * `messages.length` captured at the most recent `agent_start` event,
   * i.e. the index of the FIRST message that belongs to the latest agent
   * turn. Used by `turn-diff-builder` to bound "the latest turn" exactly,
   * instead of approximating with "everything since the most recent user
   * message" (which misclassifies turns that contain intermediate
   * user-shaped messages from compaction or steering).
   *
   * Undefined for cold-loaded sessions until the next `agent_start`.
   * Callers should fall back to the user-message heuristic in that case.
   */
  lastAgentStartIndex: number | undefined;
  /** Internal — call to detach the registry's own subscription on dispose. */
  unsubscribe: () => void;
}

export interface DiscoveredSession {
  sessionId: string;
  /** Full path to the .jsonl file on disk. */
  path: string;
  /** Working directory the session was created with. */
  cwd: string;
  /** User-defined session name from the latest session_info entry, if any. */
  name?: string;
  createdAt: Date;
  modifiedAt: Date;
  messageCount: number;
  /** First user message text (truncated by the SDK). */
  firstMessage: string;
  /**
   * When this is a sub-agent session (i.e. its JSONL lives one level
   * deeper than the project session dir), the parent session's id.
   * pi-subagents writes child sessions to
   * `<sessionDir>/<parentId>/<runId>/<childId>.jsonl` — we surface the
   * `parentId` and `runId` segments so the client can group children
   * under their parent in the sidebar.
   */
  parentSessionId?: string;
  /** The pi-subagents run id (the directory between parent and child). */
  runId?: string;
}

/**
 * Unified session view that merges the in-memory live registry with the
 * on-disk session list. Sorted by recency (lastActivityAt for live sessions,
 * modifiedAt for disk-only sessions). De-duplicated by sessionId so a live
 * session never appears twice.
 *
 * This is the shape the Phase 6 sidebar list endpoint should return.
 */
export interface UnifiedSession {
  sessionId: string;
  projectId: string;
  /** True when the session is in the in-memory registry (subscribable). */
  isLive: boolean;
  name: string | undefined;
  workspacePath: string;
  /** Last activity timestamp (live: lastActivityAt; disk: modifiedAt). */
  lastActivityAt: Date;
  createdAt: Date;
  messageCount: number;
  firstMessage: string;
  /** Parent session id when this is a pi-subagents child session. */
  parentSessionId?: string;
  /** pi-subagents run id when this is a child session. */
  runId?: string;
}

export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Thrown by `forkSession` and `navigateTree` route helpers when an entryId
 * doesn't resolve to a real entry on the session tree. Typed so routes can
 * map it to a stable 400 response (instead of leaking the raw SDK message).
 */
export class EntryNotFoundError extends Error {
  constructor(id: string) {
    super(`entry not found: ${id}`);
    this.name = "EntryNotFoundError";
  }
}

const registry = new Map<string, LiveSession>();

/**
 * Built-in pi tools we activate on every session. Pi's SDK ships
 * seven `read | bash | edit | write | grep | find | ls` (see
 * `node_modules/@mariozechner/pi-coding-agent/dist/core/tools/index.d.ts`),
 * but only the first four are activated when `tools` is left
 * undefined. We enable all seven so the agent gets first-class
 * filesystem-read affordances (grep / find / ls) instead of
 * shelling out via bash for every directory listing or content
 * search — same UX the pi TUI ships with.
 *
 * Passing `tools: [...]` to `createAgentSession` ALSO filters
 * customTools (MCP) by name (see agent-session.js
 * `_refreshToolRegistry`), so each callsite below extends this
 * list with the names of its MCP customTools before passing it
 * through. Without that union, enabling the read-only set would
 * silently disable MCP.
 */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

/**
 * Build the `tools` allowlist passed to `createAgentSession` for this
 * session, applying both global and per-project overrides from
 * `${FORGE_DATA_DIR}/tool-overrides.json`. Allow-by-default: a
 * tool is enabled unless either the global disabled set OR the
 * project's tri-state override says otherwise (project explicit
 * enable / disable wins; absent = inherit global).
 *
 * The overrides file is read FRESH per session create (not cached)
 * so toggling a tool in Settings takes effect on the next new
 * session without a server restart. Live sessions keep the tool
 * list they were created with — same caveat as every settings
 * change today.
 */
async function buildToolsAllowlist(
  customTools: readonly ToolDefinition[],
  projectId: string,
  workspacePath: string,
): Promise<string[]> {
  const overrides = await readToolOverrides();
  // Pi extensions register tools programmatically — those names are
  // invisible to BUILTIN_TOOL_NAMES and to `customTools` (which only
  // covers our MCP shim). Without enumerating them here, the
  // strict-allowlist semantics in the SDK's `_refreshToolRegistry`
  // would silently drop every extension-contributed tool. See
  // packages/server/src/extensions-discovery.ts for the discovery
  // contract.
  const extensionResources = await discoverExtensionResources(workspacePath);
  const candidates = [
    ...BUILTIN_TOOL_NAMES.map((name) => ({ family: "builtin" as const, name })),
    ...customTools.map((t) => ({ family: "mcp" as const, name: t.name })),
    ...extensionResources.tools.map((t) => ({ family: "extension" as const, name: t.name })),
  ];
  return filterEnabledTools(overrides, projectId, candidates);
}

/** Match the project-manager UUID shape; defends against ad-hoc project IDs. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-project session directory: ${SESSION_DIR}/<projectId>/. */
function sessionDirFor(projectId: string): string {
  if (
    projectId.length === 0 ||
    projectId.includes("/") ||
    projectId.includes("\\") ||
    projectId === ".." ||
    projectId.startsWith(".")
  ) {
    throw new Error(`session-registry: refusing path-traversal projectId: ${projectId}`);
  }
  // Test rigs use synthetic projectIds (e.g. `proj-<base36>`); accept those too,
  // but ensure the value can't escape the session dir. UUIDs from project-manager
  // satisfy UUID_RE; everything else must be a simple alphanumeric+dash token.
  if (!UUID_RE.test(projectId) && !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error(`session-registry: invalid projectId shape: ${projectId}`);
  }
  return join(config.sessionDir, projectId);
}

async function ensureSessionDir(projectId: string): Promise<string> {
  const dir = sessionDirFor(projectId);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Wire a registry-owned subscription onto a live session. Updates
 * lastActivityAt on every event and fans out to all currently connected
 * clients. Each client's send() is wrapped so a misbehaving client cannot
 * kill the whole fan-out — it gets dropped from the set instead.
 *
 * Note on Set mutation during iteration: ECMAScript explicitly defines
 * `for...of` over a Set as safe under deletes (the iterator advances past
 * removed entries without revisiting them). No copy needed.
 */
function logAgentEvent(level: "info" | "warn", payload: Record<string, unknown>): void {
  // Bypass pino entirely — write directly to stderr. Pino's redact
  // config + log-level filtering can drop these messages on operators
  // who only set LOG_LEVEL=warn, and the SDK error path is exactly
  // the surface that can't afford to be invisible. JSON-line format
  // so `docker logs | jq` still works.
  process.stderr.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), ...payload })}\n`,
  );
}

function makeSubscribeHandler(live: LiveSession): () => void {
  const verbose = process.env.DEBUG_AGENT_EVENTS === "1";
  return live.session.subscribe((event: AgentSessionEvent) => {
    live.lastActivityAt = new Date();
    if (event.type === "agent_start") {
      // Capture BEFORE the SDK appends turn messages, so the index points
      // at the first message of the new turn (the user prompt or the
      // steered/follow-up entry).
      live.lastAgentStartIndex = live.session.messages.length;
    }

    // Surface SDK-level provider errors to stderr. The pi SDK swallows
    // upstream HTTP failures into events rather than throwing — so a 401
    // from a bad apiKey, a network reset, an invalid endpoint, etc.
    // surface only via these events and are otherwise invisible to
    // operators. The TUI renders this directly in chat; the pi-forge
    // did not, leaving "no response" as the only signal.
    //
    // We hook every event the SDK emits when something goes wrong,
    // because the failure path varies by provider and stage:
    //   - openai-completions catches → message_end with stopReason="error"
    //   - retryable errors → auto_retry_start (with errorMessage)
    //   - retry exhaustion → auto_retry_end with success=false
    //   - agent_end always fires; live.session.errorMessage is the
    //     authoritative "what just happened" field per the SDK types.
    const e = event as unknown as {
      type: string;
      message?: {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
        provider?: string;
        modelId?: string;
        model?: { provider?: string; id?: string } | string;
      };
      attempt?: number;
      maxAttempts?: number;
      delayMs?: number;
      success?: boolean;
      finalError?: string;
      errorMessage?: string;
    };

    if (verbose) {
      logAgentEvent("info", {
        msg: "agent_event",
        sessionId: live.sessionId,
        type: e.type,
      });
    }

    if (e.type === "message_end") {
      const msg = e.message;
      if (
        msg?.role === "assistant" &&
        (msg.stopReason === "error" || msg.stopReason === "aborted")
      ) {
        const modelInfo = typeof msg.model === "object" ? msg.model : undefined;
        logAgentEvent("warn", {
          msg: "agent turn ended with error stopReason",
          sessionId: live.sessionId,
          projectId: live.projectId,
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage,
          provider: msg.provider ?? modelInfo?.provider,
          modelId: msg.modelId ?? modelInfo?.id,
        });
      }
    }
    if (e.type === "auto_retry_start") {
      logAgentEvent("warn", {
        msg: "SDK auto-retrying after provider error",
        sessionId: live.sessionId,
        attempt: e.attempt,
        maxAttempts: e.maxAttempts,
        delayMs: e.delayMs,
        errorMessage: e.errorMessage,
      });
    }
    if (e.type === "auto_retry_end" && e.success === false) {
      logAgentEvent("warn", {
        msg: "SDK auto-retry exhausted",
        sessionId: live.sessionId,
        attempt: e.attempt,
        finalError: e.finalError,
      });
    }
    // Enrich `agent_end` with the session's authoritative
    // errorMessage BEFORE fan-out. The SDK's native `agent_end` event
    // carries no error field — the failure detail lives on
    // `live.session.errorMessage` (per the SDK type). Without this
    // enrichment, a context-overflow / 401 / 5xx ends up emitting an
    // `agent_end` with no detail, the chat UI hides its spinner with
    // no error banner, and the user sees an empty assistant message.
    let outboundEvent: AgentSessionEvent = event;
    if (e.type === "agent_end") {
      const errMsg = (live.session as unknown as { errorMessage?: string }).errorMessage;
      if (errMsg !== undefined && errMsg !== "") {
        logAgentEvent("warn", {
          msg: "agent_end with session.errorMessage",
          sessionId: live.sessionId,
          errorMessage: errMsg,
        });
        // Forward a merged event that includes the error detail. Cast
        // through unknown — the SDK's union doesn't declare an
        // errorMessage field on agent_end (it expects callers to read
        // session.errorMessage themselves), but the wire shape is what
        // the browser consumes and it tolerates the extra field.
        outboundEvent = {
          ...(event as object),
          errorMessage: errMsg,
        } as unknown as AgentSessionEvent;
      } else if (verbose) {
        logAgentEvent("info", {
          msg: "agent_end (no error)",
          sessionId: live.sessionId,
        });
      }
    }

    for (const client of live.clients) {
      try {
        client.send(outboundEvent);
      } catch {
        // Drop the client on send failure — Phase 5's SSE adapter will
        // also call disposeClient on its socket close hook.
        live.clients.delete(client);
      }
    }
  });
}

export async function createSession(
  projectId: string,
  workspacePath: string,
): Promise<LiveSession> {
  const dir = await ensureSessionDir(projectId);
  const sessionManager = SessionManager.create(workspacePath, dir);
  // No model is passed — validation happens at prompt() time. This means a
  // session can be created without any LLM credentials configured, which is
  // important for the Phase 4 test to run in CI without secrets.
  //
  // agentDir IS passed: without it, the SDK falls back to ~/.pi/agent and
  // ignores PI_CONFIG_DIR entirely, breaking auth.json/models.json wiring
  // for Phase 6's prompt route.
  const customTools = await resolveMcpCustomTools(projectId, workspacePath);
  const settingsManager = await buildSessionSettingsManager(workspacePath, projectId);
  const resourceLoader = await buildForgeResourceLoader(
    workspacePath,
    config.piConfigDir,
    settingsManager,
    projectId,
  );
  const { session } = await createAgentSession({
    cwd: workspacePath,
    sessionManager,
    settingsManager,
    resourceLoader,
    agentDir: config.piConfigDir,
    customTools,
    tools: await buildToolsAllowlist(customTools, projectId, workspacePath),
  });

  const now = new Date();
  // Build the LiveSession in two passes so unsubscribe is the real handle by
  // the time the object is observable elsewhere — kills the M3 race window
  // (where a synchronous concurrent dispose could see the no-op unsubscribe).
  const live: LiveSession = {
    session,
    sessionId: session.sessionId,
    projectId,
    workspacePath,
    clients: new Set(),
    createdAt: now,
    lastActivityAt: now,
    lastAgentStartIndex: undefined,
    unsubscribe: () => undefined,
  };
  live.unsubscribe = makeSubscribeHandler(live);
  registry.set(live.sessionId, live);

  // Set a meaningful default name on the new session so the sidebar
  // doesn't show every fresh-create as the indistinguishable
  // "session abc1234" fallback. Pattern: "New session" with a numeric
  // suffix to disambiguate against existing siblings in this project.
  // Best-effort — the session is fully usable regardless. The user
  // can rename via the sidebar's inline rename at any time.
  try {
    const siblings = await listSessionsForProject(projectId, workspacePath);
    const existingNames = new Set(
      siblings
        .filter((s) => s.sessionId !== live.sessionId)
        .map((s) => s.name)
        .filter((n): n is string => typeof n === "string"),
    );
    let candidate = "New session";
    let n = 2;
    while (existingNames.has(candidate)) {
      candidate = `New session (${n})`;
      n += 1;
    }
    session.setSessionName(candidate);
  } catch {
    // Naming failure is non-fatal; leave the SDK default and let the
    // sidebar fall back to "session <id>" if needed.
  }

  return live;
}

export function getSession(sessionId: string): LiveSession | undefined {
  return registry.get(sessionId);
}

/**
 * Return the live sessions, optionally filtered by project. Order is the
 * registry's Map insertion order — caller is responsible for sorting if a
 * particular order is wanted. Use `listSessionsForProject` if you want a
 * recency-sorted unified view across live and disk.
 */
export function listSessions(projectId?: string): LiveSession[] {
  const all = Array.from(registry.values());
  return projectId === undefined ? all : all.filter((s) => s.projectId === projectId);
}

/**
 * Update lastActivityAt on a live session. Routes should call this when a
 * user "views" a session (opens the panel) so the sidebar's recency ordering
 * reflects view activity, not just events from the agent loop. No-op if the
 * session isn't live.
 */
export function touchSession(sessionId: string): void {
  const live = registry.get(sessionId);
  if (live !== undefined) live.lastActivityAt = new Date();
}

/**
 * In-flight dedupe for concurrent resumeSession calls on the same id.
 * Without this, two near-simultaneous SSE connects (or the three concurrent
 * resumes triggered by the client opening a session — /messages, /tree,
 * /context) each call createAgentSession and end up creating two
 * AgentSession instances backing the same JSONL file. The second
 * registry.set() wins, leaking the first session and any clients that
 * landed on it; both then write to the same file concurrently.
 */
const resumeInflight = makeDedupe<string, LiveSession>();

/**
 * Sessions that were just disposed and should NOT be re-resumed for a
 * brief grace window. Without this, a polling SSE client (e.g. a stale
 * tab still trying to reconnect) can win the race against
 * `deleteColdSession`'s "is it live?" check by re-resuming the session
 * between the dispose and the file unlink — leaving the user's UI
 * showing "Failed to delete" while the session keeps consuming tokens.
 *
 * Maps sessionId → setTimeout handle so we can clear the tombstone if
 * the session legitimately needs to come back (e.g. a different code
 * path explicitly resumes after dispose, which is rare).
 */
const TOMBSTONE_MS = 1500;
const disposeTombstones = new Map<string, NodeJS.Timeout>();

export class SessionTombstonedError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} was just disposed`);
    this.name = "SessionTombstonedError";
  }
}

/**
 * Per-source-session locks for forkSession. Concurrent forks from the
 * same source race on the SDK's destructive in-place mutation pattern
 * (`createBranchedSession` rewrites the source's sessionFile pointer);
 * if two forks interleave, the second captures the FIRST fork's path
 * as `originalSourceFile` and "restores" the source to the first
 * fork's file — corrupting the source's identity until restart. The
 * lock keeps forks from the same source serialised; forks from
 * different sources still parallelise.
 */
type Lock = ReturnType<typeof makeLock>;
const forkLocks = new Map<string, Lock>();
function getForkLock(sessionId: string): Lock {
  let lock = forkLocks.get(sessionId);
  if (lock === undefined) {
    lock = makeLock();
    forkLocks.set(sessionId, lock);
  }
  return lock;
}

/**
 * Resume a session from disk into the registry. If `sessionId` is already
 * live, returns the existing LiveSession unchanged. Otherwise locates the
 * .jsonl file via SessionManager.list, opens it, and wires it into the
 * registry. Throws SessionNotFoundError if the file isn't on disk.
 *
 * Concurrent calls for the same sessionId share a single in-flight
 * AgentSession creation — see resumeInflight.
 */
export async function resumeSession(
  sessionId: string,
  projectId: string,
  workspacePath: string,
): Promise<LiveSession> {
  const existing = registry.get(sessionId);
  if (existing) return existing;

  // Tombstone check: a session that was just disposed should not be
  // re-resumed by a polling client racing against the operator's delete.
  if (disposeTombstones.has(sessionId)) {
    throw new SessionTombstonedError(sessionId);
  }

  return resumeInflight(sessionId, async () => {
    // Re-check after lock acquisition: another resume may have raced
    // ahead and populated the registry while we were queued.
    const raced = registry.get(sessionId);
    if (raced) return raced;

    const dir = sessionDirFor(projectId);
    // Use our own discovery (not SessionManager.list directly) so
    // pi-subagents child sessions, which live one level deeper at
    // `<dir>/<parentId>/<runId>/<childId>.jsonl`, are also resolvable
    // by id. Top-level sessions are returned alongside children.
    const discovered = await discoverSessionsOnDisk(projectId, workspacePath);
    const match = discovered.find((s) => s.sessionId === sessionId);
    if (match === undefined) throw new SessionNotFoundError(sessionId);

    // For child sessions, hand SessionManager.open the *child's* run
    // dir as the sessionDir so any subsequent file operations the SDK
    // performs land alongside the existing JSONL rather than in the
    // project's top-level dir. For top-level sessions, the run dir
    // collapses to the project session dir.
    const childSessionDir = match.parentSessionId !== undefined ? join(match.path, "..") : dir;
    const sessionManager = SessionManager.open(match.path, childSessionDir, workspacePath);
    const customTools = await resolveMcpCustomTools(projectId, workspacePath);
    const settingsManager = await buildSessionSettingsManager(workspacePath, projectId);
    const resourceLoader = await buildForgeResourceLoader(
      workspacePath,
      config.piConfigDir,
      settingsManager,
      projectId,
    );
    const { session } = await createAgentSession({
      cwd: workspacePath,
      sessionManager,
      settingsManager,
      resourceLoader,
      agentDir: config.piConfigDir,
      customTools,
      tools: await buildToolsAllowlist(customTools, projectId, workspacePath),
    });

    const now = new Date();
    const live: LiveSession = {
      session,
      sessionId: session.sessionId,
      projectId,
      workspacePath,
      clients: new Set(),
      createdAt: match.createdAt,
      lastActivityAt: now,
      lastAgentStartIndex: undefined,
      unsubscribe: () => undefined,
    };
    live.unsubscribe = makeSubscribeHandler(live);
    registry.set(live.sessionId, live);
    return live;
  });
}

/**
 * Delete a cold (on-disk-only) session's JSONL file from disk. Refuses
 * if the session is currently live in the registry — the caller should
 * dispose first. Returns:
 *   - "deleted" when the file was found and removed.
 *   - "live" when the session is in the registry (caller must dispose
 *      first; we don't auto-dispose because that would race the SSE
 *      clients with no chance to close cleanly).
 *   - "not_found" when no project owns a session with that id on disk.
 */
export async function deleteColdSession(
  sessionId: string,
): Promise<"deleted" | "live" | "not_found"> {
  if (registry.has(sessionId)) return "live";
  const projects = await readProjects();
  for (const project of projects) {
    let infos: DiscoveredSession[];
    try {
      // Use our discovery (includes child sessions) so deleting a
      // pi-subagents child by id also works.
      infos = await discoverSessionsOnDisk(project.id, project.path);
    } catch {
      // Project's session dir errored out (perms, missing, malformed
      // JSONL). Skip this project and try the next one — the cold
      // session may be in another project's dir. (findSessionLocation
      // logs the same case via stderr; this caller doesn't because
      // deleteColdSession's outer surface already reports
      // not_found vs deleted clearly.)
      continue;
    }
    const match = infos.find((s) => s.sessionId === sessionId);
    if (match !== undefined) {
      try {
        await rm(match.path, { force: true });
      } catch (err) {
        // ENOENT (vanished mid-flight) is fine — collapse to
        // "deleted" since the file is now gone, which is what the
        // caller asked for. Any other error (permissions, IO) is a
        // real failure and should NOT silently look like
        // "not_found" to the operator. Surface via thrown so the
        // route can map to 500.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return "deleted";
        throw err;
      }
      return "deleted";
    }
  }
  return "not_found";
}

export async function disposeSession(sessionId: string): Promise<boolean> {
  const live = registry.get(sessionId);
  if (live === undefined) return false;
  // Abort any in-flight prompt FIRST so the SDK's LLM call can stop
  // cleanly before we tear down. Without this, a prompt that was
  // mid-LLM-call when the session is deleted continues server-side
  // (still racking up tokens) and the eventual response either drops
  // silently or throws inside the SDK trying to write to the
  // disposed SessionManager. Best-effort: if abort itself rejects,
  // log and fall through to dispose.
  //
  // Bounded race: a hung SDK abort would otherwise block the dispose
  // forever, which means `disposeAllSessions` (the shutdown path)
  // hangs the server on `docker compose down` until SIGKILL. 5s is
  // well above any reasonable abort latency; the dispose path below
  // still runs after the race resolves.
  try {
    const ABORT_TIMEOUT_MS = 5_000;
    await Promise.race([
      live.session.abort(),
      new Promise<void>((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS).unref()),
    ]);
  } catch (err) {
    // SDK doesn't currently throw from abort, but defend against
    // future versions. The dispose path below still runs.
    void err;
  }
  // Always delete from the registry regardless of whether teardown throws,
  // so a misbehaving SDK update can't leak entries.
  try {
    try {
      // session.dispose() also clears all listeners internally (verified at
      // agent-session.js); calling unsubscribe first is defensive in case a
      // future SDK rev decouples the two.
      live.unsubscribe();
    } catch {
      // ignore
    }
    for (const client of live.clients) {
      try {
        client.close();
      } catch {
        // ignore
      }
    }
    live.clients.clear();
    try {
      live.session.dispose();
    } catch {
      // ignore — SDK doesn't currently throw, but H2-defensive
    }
  } finally {
    registry.delete(sessionId);
    // Tombstone the id so a polling SSE client can't re-resume the
    // session before deleteColdSession's file unlink runs. The
    // tombstone clears itself after TOMBSTONE_MS — long enough for
    // the typical hard-delete path (DELETE handler runs dispose then
    // immediately unlink), short enough that an explicit user action
    // a few seconds later can re-open the session normally.
    const existing = disposeTombstones.get(sessionId);
    if (existing !== undefined) clearTimeout(existing);
    disposeTombstones.set(
      sessionId,
      setTimeout(() => {
        disposeTombstones.delete(sessionId);
      }, TOMBSTONE_MS).unref(),
    );
  }
  return true;
}

/**
 * Scan the project's session dir on disk WITHOUT loading sessions into the
 * registry. Used by the sidebar list. Backed by the SDK's SessionManager.list
 * which parses each file's first-line header and a few message previews.
 *
 * In addition to the project's own top-level JSONLs, this also scans one
 * level deeper for **pi-subagents child sessions**. The plugin's
 * `getSubagentSessionRoot` helper names the child dir after the parent
 * file's full basename (timestamp + id), so we look up the basename
 * against the top-level session list to recover the actual parent
 * sessionId — without that mapping the child would inherit the dir name
 * verbatim and grouping in the sidebar would silently fail.
 *
 * Returns an empty array (not throws) when the per-project dir doesn't exist
 * yet — e.g. a project that has never had a session.
 */
export async function discoverSessionsOnDisk(
  projectId: string,
  workspacePath: string,
): Promise<DiscoveredSession[]> {
  const dir = sessionDirFor(projectId);
  // SDK's list() guards `existsSync(dir)` and returns [] for missing dirs,
  // so we don't need an outer ENOENT catch.
  const infos: SessionInfo[] = await SessionManager.list(workspacePath, dir);
  const out: DiscoveredSession[] = infos.map((info) => {
    const ds: DiscoveredSession = {
      sessionId: info.id,
      path: info.path,
      cwd: info.cwd,
      createdAt: info.created,
      modifiedAt: info.modified,
      messageCount: info.messageCount,
      firstMessage: info.firstMessage,
    };
    if (info.name !== undefined) ds.name = info.name;
    return ds;
  });
  // Build a basename → sessionId map from the top-level scan so the
  // child-discovery pass can resolve dir names like
  // `2026-05-07T12-34-56-000Z_abc123` back to the parent's actual
  // sessionId `abc123`. Without this, child grouping in the SessionList
  // never matches because the dir name and the parent's sessionId differ.
  const basenameToParentId = new Map<string, string>();
  for (const info of infos) {
    const base = basenameNoExt(info.path);
    if (base !== undefined) basenameToParentId.set(base, info.id);
  }
  const children = await discoverSubagentChildSessions(workspacePath, dir, basenameToParentId);
  for (const child of children) out.push(child);
  return out;
}

/** `/path/to/2026-05-07_abc.jsonl` → `2026-05-07_abc`; undefined for any non-jsonl. */
function basenameNoExt(filePath: string): string | undefined {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? filePath.slice(lastSlash + 1) : filePath;
  if (!base.endsWith(".jsonl")) return undefined;
  return base.slice(0, -".jsonl".length);
}

/**
 * Walk one level deeper than the project's session dir to surface
 * pi-subagents child sessions.
 *
 * Two layouts to support:
 *
 *   1. Nested with runId:    <dir>/<parentBasename>/<runId>/<child>.jsonl
 *   2. Flat under parent:    <dir>/<parentBasename>/<child>.jsonl
 *
 * The plugin's `getSubagentSessionRoot(parentSessionFile)` returns
 * `<dirname(parentSessionFile)>/<basename(parentSessionFile, ".jsonl")>`,
 * which collides with neither (it's a directory NAMED after the parent
 * basename). Whether a runId subdir exists depends on the plugin's run
 * mode — both shapes are observed in the wild.
 *
 * `basenameToParentId` maps the directory name back to the parent's
 * actual sessionId (since the dir name is the parent's full basename
 * including timestamp prefix, NOT the bare sessionId). When the dir
 * name doesn't map to a known parent (e.g. the parent JSONL was
 * deleted), we fall back to using the dir name verbatim so the
 * children still appear (the SessionList will treat them as orphans
 * and render them at top level).
 *
 * Errors from individual subdirs are swallowed — a corrupted child
 * session must not block the rest of the sidebar listing.
 */
async function discoverSubagentChildSessions(
  workspacePath: string,
  dir: string,
  basenameToParentId: Map<string, string>,
): Promise<DiscoveredSession[]> {
  const out: DiscoveredSession[] = [];
  let topEntries: { name: string; isDirectory: boolean }[];
  try {
    const direntList = await readdir(dir, { withFileTypes: true });
    topEntries = direntList.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch {
    // dir missing or unreadable — caller already handles the empty case.
    return out;
  }
  for (const top of topEntries) {
    if (!top.isDirectory) continue;
    const dirName = top.name;
    // Resolve the dir name to the parent's actual sessionId via the
    // basename map. Fall back to the dir name when no match (the
    // SessionList will render unmatched children as orphans at top
    // level — never silently lost).
    const parentSessionId = basenameToParentId.get(dirName) ?? dirName;
    const parentDir = join(dir, dirName);

    // Layout 2 (flat): collect any .jsonl files directly under the
    // parent dir before descending into runId subdirs.
    let parentDirEntries: { name: string; isDirectory: boolean }[];
    try {
      const entries = await readdir(parentDir, { withFileTypes: true });
      parentDirEntries = entries.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
    } catch {
      continue;
    }

    const hasFlatJsonls = parentDirEntries.some((e) => !e.isDirectory && e.name.endsWith(".jsonl"));
    if (hasFlatJsonls) {
      // Flat layout: SessionManager.list reads .jsonl files directly
      // in parentDir. No runId.
      let infos: SessionInfo[];
      try {
        infos = await SessionManager.list(workspacePath, parentDir);
      } catch {
        infos = [];
      }
      for (const info of infos) {
        const ds: DiscoveredSession = {
          sessionId: info.id,
          path: info.path,
          cwd: info.cwd,
          createdAt: info.created,
          modifiedAt: info.modified,
          messageCount: info.messageCount,
          firstMessage: info.firstMessage,
          parentSessionId,
        };
        if (info.name !== undefined) ds.name = info.name;
        out.push(ds);
      }
    }

    // Layout 1 (nested with runId): each subdirectory of parentDir is
    // a runId, holding the actual child JSONLs.
    const runDirNames = parentDirEntries.filter((e) => e.isDirectory).map((e) => e.name);
    for (const runId of runDirNames) {
      const runDir = join(parentDir, runId);
      let infos: SessionInfo[];
      try {
        infos = await SessionManager.list(workspacePath, runDir);
      } catch {
        continue;
      }
      for (const info of infos) {
        const ds: DiscoveredSession = {
          sessionId: info.id,
          path: info.path,
          cwd: info.cwd,
          createdAt: info.created,
          modifiedAt: info.modified,
          messageCount: info.messageCount,
          firstMessage: info.firstMessage,
          parentSessionId,
          runId,
        };
        if (info.name !== undefined) ds.name = info.name;
        out.push(ds);
      }
    }
  }
  return out;
}

/**
 * Unified, recency-sorted view of sessions for a project: merges live
 * registry entries with on-disk discovery, dedupes by sessionId.
 *
 * Field precedence when a session appears in both live and disk:
 *   - `lastActivityAt`, `createdAt`, `name`, `isLive` — LIVE wins (freshest).
 *   - `messageCount`, `firstMessage` — DISK wins. The SDK's
 *     `SessionInfo.messageCount` counts user-visible messages; the live
 *     session's `messages.length` includes BashExecutionMessage and other
 *     internal types, so the two would disagree. Disk values are the ones
 *     the sidebar should display.
 *
 * For a live-only session that hasn't flushed to disk yet (no assistant
 * message), `firstMessage` is `""` and `messageCount` falls back to
 * `session.messages.length`.
 *
 * This is the canonical surface for the Phase 6 sidebar list — call sites
 * should not implement their own merge.
 */
export async function listSessionsForProject(
  projectId: string,
  workspacePath: string,
): Promise<UnifiedSession[]> {
  const live = listSessions(projectId);
  const liveById = new Map<string, UnifiedSession>(
    live.map((l) => [
      l.sessionId,
      {
        sessionId: l.sessionId,
        projectId: l.projectId,
        isLive: true,
        name: l.session.sessionName,
        workspacePath: l.workspacePath,
        lastActivityAt: l.lastActivityAt,
        createdAt: l.createdAt,
        messageCount: l.session.messages.length,
        firstMessage: "",
      },
    ]),
  );

  const disk = await discoverSessionsOnDisk(projectId, workspacePath);
  for (const d of disk) {
    const merged = liveById.get(d.sessionId);
    if (merged !== undefined) {
      // Disk wins for messageCount and firstMessage (see precedence in
      // function doc); everything else stays as the live value. Sub-agent
      // linkage fields are disk-side only — children are typically not
      // live-resident.
      merged.messageCount = d.messageCount;
      merged.firstMessage = d.firstMessage;
      if (d.parentSessionId !== undefined) merged.parentSessionId = d.parentSessionId;
      if (d.runId !== undefined) merged.runId = d.runId;
      continue;
    }
    const u: UnifiedSession = {
      sessionId: d.sessionId,
      projectId,
      isLive: false,
      name: d.name,
      workspacePath,
      lastActivityAt: d.modifiedAt,
      createdAt: d.createdAt,
      messageCount: d.messageCount,
      firstMessage: d.firstMessage,
    };
    if (d.parentSessionId !== undefined) u.parentSessionId = d.parentSessionId;
    if (d.runId !== undefined) u.runId = d.runId;
    liveById.set(d.sessionId, u);
  }
  return Array.from(liveById.values()).sort(
    (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime(),
  );
}

/**
 * Resolve a sessionId to its (projectId, workspacePath) pair without resuming.
 * Walks every registered project's session dir and matches by id. Returns
 * undefined if the session is not on disk.
 *
 * Used by routes that need to attach to a session known only by id (e.g. the
 * SSE stream route auto-resume path). Single-tenant + small project counts
 * means this is fast in practice; if the project count ever explodes we'd
 * cache a sessionId → location index, but not today.
 */
export async function findSessionLocation(
  sessionId: string,
): Promise<{ projectId: string; workspacePath: string } | undefined> {
  const live = registry.get(sessionId);
  if (live !== undefined) {
    return { projectId: live.projectId, workspacePath: live.workspacePath };
  }
  const projects = await readProjects();
  for (const project of projects) {
    let discovered: DiscoveredSession[];
    try {
      // discoverSessionsOnDisk includes pi-subagents child sessions, so
      // a child's UUID resolves to its parent project the same as a
      // top-level session.
      discovered = await discoverSessionsOnDisk(project.id, project.path);
    } catch (err) {
      // Don't fail the whole search just because one project's session
      // dir is corrupted, but DO log so the operator can see when a
      // project's storage went bad — the previous silent skip meant
      // a permissions/JSONL issue could persist undetected.
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          msg: "findSessionLocation: skipping project due to discoverSessionsOnDisk error",
          projectId: project.id,
          err: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
      continue;
    }
    if (discovered.some((s) => s.sessionId === sessionId)) {
      return { projectId: project.id, workspacePath: project.path };
    }
  }
  return undefined;
}

/**
 * Resume a session by id alone — looks up its project via findSessionLocation,
 * then delegates to resumeSession. Convenience wrapper for routes that don't
 * receive projectId in the URL (the stream route specifically).
 */
export async function resumeSessionById(sessionId: string): Promise<LiveSession> {
  const existing = registry.get(sessionId);
  if (existing) return existing;
  const loc = await findSessionLocation(sessionId);
  if (loc === undefined) throw new SessionNotFoundError(sessionId);
  return resumeSession(sessionId, loc.projectId, loc.workspacePath);
}

/**
 * Fork a live session from an entry. Calls
 * `sessionManager.createBranchedSession(entryId)` which produces a new
 * .jsonl on disk containing the path-to-leaf, then loads that new file as
 * a fresh LiveSession in the same project.
 *
 * The source session remains live and untouched; callers may dispose it
 * explicitly if the fork supersedes it. Both sessions appear in the
 * registry until disposed.
 *
 * Throws:
 *   - SessionNotFoundError — source isn't live
 *   - EntryNotFoundError — entryId doesn't resolve on the source tree
 *   - Error("fork_failed") — source has no on-disk persistence (in-memory
 *     sessions can't be forked because there's no path to branch from)
 */
export async function forkSession(sessionId: string, entryId: string): Promise<LiveSession> {
  // Per-source serialisation: see forkLocks comment. Two near-
  // simultaneous forks from the same source would otherwise stomp on
  // each other's `originalSourceFile` snapshot via the SDK's
  // destructive in-place mutation, leaving the source pointing at the
  // wrong file in memory.
  return getForkLock(sessionId)(async () => {
    return forkSessionLocked(sessionId, entryId);
  });
}

async function forkSessionLocked(sessionId: string, entryId: string): Promise<LiveSession> {
  const source = registry.get(sessionId);
  if (source === undefined) throw new SessionNotFoundError(sessionId);
  // CRITICAL: capture the source's session file BEFORE calling
  // createBranchedSession. The SDK's implementation MUTATES the
  // source SessionManager in place — it sets `this.sessionId`,
  // `this.sessionFile`, and `this.fileEntries` to the new
  // session's values, so after the call `source.session.sessionManager`
  // points at the fork instead of the original. The original
  // .jsonl file on disk is untouched, but the in-memory source
  // LiveSession is hijacked and would return the fork's messages
  // to anyone subsequently reading from it. We re-open the source
  // from its original file at the end of this function to undo the
  // hijack.
  const originalSourceFile = source.session.sessionManager.getSessionFile();
  let newPath: string | undefined;
  try {
    newPath = source.session.sessionManager.createBranchedSession(entryId);
  } catch (err) {
    // SDK throws `Error("Entry <id> not found")` when entryId doesn't resolve
    // to a tree node. Translate to a typed error so the route returns a stable
    // 400 instead of leaking the raw SDK message.
    if (err instanceof Error && /entry .* not found/i.test(err.message)) {
      throw new EntryNotFoundError(entryId);
    }
    throw err;
  }
  // Return is undefined for in-memory (non-persisted) sessions, which can't
  // be forked. Map separately from entry-not-found so callers can distinguish.
  if (newPath === undefined) throw new Error("fork_failed");

  const dir = sessionDirFor(source.projectId);
  const sessionManager = SessionManager.open(newPath, dir, source.workspacePath);
  const customTools = await resolveMcpCustomTools(source.projectId, source.workspacePath);
  const settingsManager = await buildSessionSettingsManager(source.workspacePath, source.projectId);
  const resourceLoader = await buildForgeResourceLoader(
    source.workspacePath,
    config.piConfigDir,
    settingsManager,
    source.projectId,
  );
  const { session } = await createAgentSession({
    cwd: source.workspacePath,
    sessionManager,
    settingsManager,
    resourceLoader,
    agentDir: config.piConfigDir,
    customTools,
    tools: await buildToolsAllowlist(customTools, source.projectId, source.workspacePath),
  });

  const now = new Date();
  const live: LiveSession = {
    session,
    sessionId: session.sessionId,
    projectId: source.projectId,
    workspacePath: source.workspacePath,
    clients: new Set(),
    createdAt: now,
    lastActivityAt: now,
    lastAgentStartIndex: undefined,
    unsubscribe: () => undefined,
  };
  live.unsubscribe = makeSubscribeHandler(live);
  registry.set(live.sessionId, live);

  // Disambiguate the fork's display name from its source. The SDK
  // copies session_info entries forward when forking, so the new
  // session has the same `sessionName` as the source — making it
  // hard to tell them apart in the sidebar. Rename to "<source>
  // (clone)", or "<source> (clone N)" if other clones already exist
  // in this project. Plain "(clone)" is used when the source has no
  // explicit name. Failures are non-fatal (the fork is otherwise
  // fully usable).
  try {
    const sourceName = source.session.sessionName;
    const baseName =
      sourceName !== undefined && sourceName.length > 0 ? `${sourceName} (clone)` : "(clone)";
    const siblings = await listSessionsForProject(source.projectId, source.workspacePath);
    const existingNames = new Set(
      siblings
        .filter((s) => s.sessionId !== live.sessionId)
        .map((s) => s.name)
        .filter((n): n is string => typeof n === "string"),
    );
    let candidate = baseName;
    let n = 2;
    while (existingNames.has(candidate)) {
      candidate = `${baseName} ${n}`;
      n += 1;
    }
    session.setSessionName(candidate);
  } catch {
    // Naming is best-effort; the new session still works without it.
  }

  // Undo the SDK's in-place mutation on the source LiveSession by
  // reopening the original .jsonl with a fresh SessionManager +
  // AgentSession. Without this, the source's sessionId field still
  // says oldId but its session.sessionManager points at the fork —
  // every read after fork returns fork data, every write is appended
  // to the fork's file. The disk side is fine (original file
  // untouched); only the in-memory state needs the patch.
  if (originalSourceFile !== undefined) {
    try {
      source.unsubscribe();
      const restoredManager = SessionManager.open(originalSourceFile, dir, source.workspacePath);
      const restoredCustomTools = await resolveMcpCustomTools(
        source.projectId,
        source.workspacePath,
      );
      const restoredSettingsManager = await buildSessionSettingsManager(
        source.workspacePath,
        source.projectId,
      );
      const restoredResourceLoader = await buildForgeResourceLoader(
        source.workspacePath,
        config.piConfigDir,
        restoredSettingsManager,
        source.projectId,
      );
      const { session: restoredSession } = await createAgentSession({
        cwd: source.workspacePath,
        sessionManager: restoredManager,
        settingsManager: restoredSettingsManager,
        resourceLoader: restoredResourceLoader,
        agentDir: config.piConfigDir,
        customTools: restoredCustomTools,
        tools: await buildToolsAllowlist(
          restoredCustomTools,
          source.projectId,
          source.workspacePath,
        ),
      });
      // Mutate the existing LiveSession in place rather than
      // replacing the registry entry — any SSE client holding a
      // reference would otherwise lose its connection. Same
      // sessionId, fresh AgentSession underneath.
      source.session = restoredSession;
      source.lastActivityAt = new Date();
      source.lastAgentStartIndex = undefined;
      source.unsubscribe = makeSubscribeHandler(source);
    } catch (err) {
      // Log but don't fail the fork — the new session is fine.
      // The source is corrupted in memory; surface as a server log
      // so it shows up in diagnostics.
      //
      // Using a structured object on stderr (rather than the prior
      // bare console.error template string) so log shippers parse
      // it as a single JSON-shaped event instead of a 2-line garbled
      // log entry. We don't have access to a fastify request logger
      // here (forkSession is a registry-level helper), so this is
      // the best stand-in.
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "forkSession: failed to restore source session",
          sessionId,
          originalSourceFile,
          err: err instanceof Error ? err.message : String(err),
        }) + "\n",
      );
    }
  }

  return live;
}

/** Number of currently-live sessions across all projects. Used by /health. */
export function sessionCount(): number {
  return registry.size;
}

/** Test/teardown helper — disposes every live session. */
export async function disposeAllSessions(): Promise<void> {
  await Promise.all(
    Array.from(registry.keys()).map((id) =>
      disposeSession(id).catch(() => {
        // best-effort during shutdown; never fail the teardown loop
      }),
    ),
  );
}

/**
 * Build a SettingsManager whose `getGlobalSettings()` and
 * `getProjectSettings()` return augmented `skills` patterns reflecting
 * the pi-forge's per-project overrides.
 *
 * Why we don't use `applyOverrides({ skills })`: pi's package-manager
 * (the thing that auto-discovers and filters skills) reads
 * `getGlobalSettings()` and `getProjectSettings()` SEPARATELY when
 * resolving which skills the agent sees. `applyOverrides` only mutates
 * the merged `this.settings` view — `getGlobalSettings`/`getProjectSettings`
 * still return the un-merged on-disk values, so any skill patterns we
 * push through `applyOverrides` are silently ignored by skill loading.
 *
 * Why monkey-patching instead of subclassing or Proxy: pi internals
 * use `instanceof SettingsManager` checks in a few places, which a
 * Proxy breaks. Subclassing would require reaching into private fields
 * to hand the constructor what it needs. Direct method substitution on
 * the instance is the smallest change that survives across SDK
 * upgrades — both methods are public, both return their backing field
 * via `structuredClone`, both have stable signatures.
 *
 * Patterns get injected into BOTH reads because pi applies global
 * patterns to the user skills dir and project patterns to the project
 * skills dir; injecting into one would only filter half the discovery.
 */
async function buildSessionSettingsManager(
  workspacePath: string,
  projectId: string,
): Promise<SettingsManager> {
  const sm = SettingsManager.create(workspacePath, config.piConfigDir);
  const patterns = await effectiveSkillsForProject(projectId);
  if (patterns.length === 0) return sm;
  const origGlobal = sm.getGlobalSettings.bind(sm);
  const origProject = sm.getProjectSettings.bind(sm);
  const merge = (existing: string[] | undefined): string[] =>
    Array.from(new Set([...(existing ?? []), ...patterns]));
  sm.getGlobalSettings = (): ReturnType<typeof origGlobal> => {
    const s = origGlobal();
    return { ...s, skills: merge(s.skills) };
  };
  sm.getProjectSettings = (): ReturnType<typeof origProject> => {
    const s = origProject();
    return { ...s, skills: merge(s.skills) };
  };
  return sm;
}

/**
 * Resolve the `customTools` array passed to `createAgentSession`.
 *
 * Returns the union of every connected, enabled MCP server's tools —
 * global servers (from ${FORGE_DATA_DIR}/mcp.json) plus the
 * project-scoped servers (from <projectPath>/.mcp.json), with
 * project entries winning on name collisions.
 *
 * Honors the master `disabled` toggle in mcp.json: if MCP is globally
 * off, returns an empty array regardless of per-server state. Boot-
 * time `loadGlobal()` is called in index.ts; project-scope is loaded
 * lazily here on first session-create per project.
 */
async function resolveMcpCustomTools(
  projectId: string,
  workspacePath: string,
): Promise<ReturnType<typeof mcpCustomToolsForProject>> {
  if (!mcpIsGloballyEnabled()) return [];
  await mcpEnsureProjectLoaded(projectId, workspacePath).catch(() => undefined);
  return mcpCustomToolsForProject(projectId);
}

import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  SessionManager,
  SettingsManager,
  type ExtensionCommandContextActions,
  type ExtensionUIContext,
  type PackageSource,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { buildForgeResourceLoader } from "./agent-resource-loader.js";
import { createSandboxedToolDefinitions } from "./agent-tool-overrides.js";
import { config } from "./config.js";
import { makeDedupe, makeLock } from "./concurrency.js";
import {
  effectivePromptsForProject,
  effectiveSkillsForProject,
  migrateLegacyModelsJsonIfNeeded,
} from "./config-manager.js";
import { readProjects } from "./project-manager.js";
import { filterEnabledTools, readToolOverrides } from "./tool-overrides.js";
import { discoverExtensionResources } from "./extensions-discovery.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  customToolsForProject as mcpCustomToolsForProject,
  ensureGlobalLoaded as mcpEnsureGlobalLoaded,
  ensureProjectLoaded as mcpEnsureProjectLoaded,
  isGloballyEnabled as mcpIsGloballyEnabled,
} from "./mcp/manager.js";
import { createAskUserQuestionTool } from "./ask-user-question/tool.js";
import { createTodoTool } from "./todo/tool.js";
import {
  clearForSession as clearTodoForSession,
  refreshFromBranch as refreshTodoFromBranch,
} from "./todo/store.js";
import { createProcessTool } from "./processes/tool.js";
import { processManager } from "./processes/manager.js";
import { bridgeAgentSessionEvent, bridgeSessionCreated } from "./webhooks/event-bridge.js";
import { isOrchestrationEnabled } from "./orchestration/config.js";
import { isSupervisor, readStore } from "./orchestration/store.js";
import { createOrchestrationTools, ORCHESTRATION_TOOL_NAMES } from "./orchestration/tools.js";
import { bridgeWorkerAgentEvent } from "./orchestration/event-bridge.js";
import { notifySupervisorDisposed, notifySupervisorIdle } from "./orchestration/inbox.js";
import { archiveSessionFiles } from "./session-archive.js";
import { generateSessionTitleFromPrompt, isGenericSessionName } from "./session-title.js";
import { getExternalSubagentStatusForSession } from "./subagents-external.js";
import { readSandboxSettings } from "./sandbox-settings.js";

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
  /** True when pi-subagents authoritative status says this child is queued/running externally. */
  isExternalLive?: boolean;
  /** Authoritative pi-subagents async status state when known. */
  externalState?: "queued" | "running" | "complete" | "failed" | "paused";
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
  /** Parent session id when this is a nested child session (pi-subagents or orchestration). */
  parentSessionId?: string;
  /** pi-subagents run id when this is a child session. */
  runId?: string;
  /** True when pi-subagents authoritative status says this child is queued/running externally. */
  isExternalLive?: boolean;
  /** Authoritative pi-subagents async status state when known. */
  externalState?: "queued" | "running" | "complete" | "failed" | "paused";
  /**
   * Absolute path to the session JSONL on disk. Surfaced so the
   * client can resolve a `sessionFile` reference (e.g. from a
   * pi-subagents tool result) back to the canonical sessionId — the
   * filename alone is unreliable since pi-subagents writes its
   * children as a literal `session.jsonl` rather than `<uuid>.jsonl`.
   * Only set for disk-discovered sessions; undefined for live-only
   * sessions that haven't flushed to disk yet.
   */
  path?: string;
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

export class ExternalSubagentActiveError extends Error {
  constructor(id: string) {
    super(`external subagent is active: ${id}`);
    this.name = "ExternalSubagentActiveError";
  }
}

const registry = new Map<string, LiveSession>();

/**
 * Built-in pi tools we activate on every session. Pi's SDK ships
 * seven `read | bash | edit | write | grep | find | ls` (see
 * `node_modules/@earendil-works/pi-coding-agent/dist/core/tools/index.d.ts`),
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
  // ask_user_question is implemented in pi-forge (see ask-user-question/),
  // not in the pi SDK. Listed here so the Tools settings tab surfaces it
  // under "Built-in tools" — disabling it filters it out of the allowlist
  // passed to createAgentSession, so the agent never sees the tool.
  "ask_user_question",
  // todo is implemented in pi-forge (see todo/), contract-compatible with
  // @juicesharp/rpiv-todo. Same disable-via-settings semantics as
  // ask_user_question.
  "todo",
  // process is implemented in pi-forge (see processes/), contract-
  // compatible with @aliou/pi-processes. Manages background processes
  // the agent spawns (dev servers, watchers, etc.) — separate spawn
  // surface from bash, with lifecycle management + log capture +
  // regex watches. Disable here to filter out of the allowlist.
  "process",
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
  // invisible to BUILTIN_TOOL_NAMES and to `customTools` (which covers
  // MCP plus forge-native custom tools like ask_user_question, process,
  // todo, and supervisor-only orchestrate_*). Without enumerating
  // extensions here, the strict-allowlist semantics in the SDK's
  // `_refreshToolRegistry` would silently drop every extension-
  // contributed tool. See packages/server/src/extensions-discovery.ts
  // for the discovery contract.
  const extensionResources = await discoverExtensionResources(workspacePath);
  const forgeNativeCustomToolNames = new Set<string>([
    ...BUILTIN_TOOL_NAMES,
    ...ORCHESTRATION_TOOL_NAMES,
  ]);
  const candidates = [
    ...BUILTIN_TOOL_NAMES.map((name) => ({ family: "builtin" as const, name })),
    ...customTools.map((t) => ({
      family: forgeNativeCustomToolNames.has(t.name) ? ("builtin" as const) : ("mcp" as const),
      name: t.name,
    })),
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

function isCodexProvider(provider: string | undefined): boolean {
  return provider === "openai-codex";
}

export function shouldSuppressCodexProviderErrorFromWebUi(
  provider: string | undefined,
  errorMessage: string | undefined,
): boolean {
  if (!isCodexProvider(provider)) return false;
  if (errorMessage === undefined || errorMessage === "") return false;
  return /provider_transport_failure|websocket.*1006|1006.*websocket/i.test(errorMessage);
}

/**
 * Walk the session's messages newest-to-oldest and return the first
 * assistant message that ended with `stopReason="error"` (capturing
 * its `errorMessage`). Used by the `agent_end` enrichment as a
 * fallback when `session.errorMessage` is empty but a provider
 * failure landed on a message earlier in the turn.
 *
 * Provider-error messages have `stopReason === "error"` per the
 * SDK's openai-completions catch path; we scope the scan to those
 * to avoid surfacing a stale errorMessage from a previous turn.
 */
export function findLastAssistantErrorMessage(
  messages: readonly unknown[],
  startIndex = 0,
): string | undefined {
  const from = Math.max(0, Math.min(startIndex, messages.length));
  for (let i = messages.length - 1; i >= from; i--) {
    const m = messages[i] as {
      role?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    if (m?.role !== "assistant") continue;
    if (m.stopReason !== "error") continue;
    if (typeof m.errorMessage === "string" && m.errorMessage.length > 0) return m.errorMessage;
    // Found an errored assistant but no message text — stop here
    // rather than picking up an older one from a previous turn.
    return undefined;
  }
  return undefined;
}

const EXTENSION_UI_NOTIFICATION_MAX_LENGTH = 4_000;

function emitExtensionUiNotification(
  live: LiveSession,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  const text = message.trim().slice(0, EXTENSION_UI_NOTIFICATION_MAX_LENGTH);
  if (text.length === 0) return;
  const event = {
    type: "extension_ui_notification" as const,
    sessionId: live.sessionId,
    message: text,
    level,
  };
  for (const client of live.clients) {
    try {
      client.send(event);
    } catch {
      live.clients.delete(client);
    }
  }
}

/**
 * Bind the SDK extension command context to Pi Forge's authenticated SSE
 * session. Browser clients can show notifications, while terminal-only dialogs
 * fail safely and explain their unsupported state to the user.
 */
async function bindWebExtensionContext(live: LiveSession): Promise<void> {
  const unsupportedDialog = (): void => {
    emitExtensionUiNotification(
      live,
      "This extension requested an interactive dialog, which Pi Forge does not support.",
      "warning",
    );
  };
  const uiContext = {
    select: async () => {
      unsupportedDialog();
      return undefined;
    },
    confirm: async () => {
      unsupportedDialog();
      return false;
    },
    input: async () => {
      unsupportedDialog();
      return undefined;
    },
    notify: (message: string, level?: "info" | "warning" | "error") => {
      emitExtensionUiNotification(live, message, level);
    },
    onTerminalInput: () => () => undefined,
    setStatus: () => undefined,
    setWorkingMessage: () => undefined,
    setWorkingVisible: () => undefined,
    setWorkingIndicator: () => undefined,
    setHiddenThinkingLabel: () => undefined,
    setWidget: () => undefined,
    setFooter: () => undefined,
    setHeader: () => undefined,
    setTitle: () => undefined,
    custom: async <T>() => {
      unsupportedDialog();
      return undefined as T;
    },
    pasteToEditor: () => undefined,
    setEditorText: () => undefined,
    getEditorText: () => "",
    editor: async () => {
      unsupportedDialog();
      return undefined;
    },
    addAutocompleteProvider: () => undefined,
    setEditorComponent: () => undefined,
    getEditorComponent: () => undefined,
    theme: {} as ExtensionUIContext["theme"],
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "UI not available in Pi Forge" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => undefined,
  } satisfies ExtensionUIContext;
  const commandContextActions = {
    waitForIdle: () => live.session.waitForIdle(),
    newSession: async () => ({ cancelled: true }),
    fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }),
    switchSession: async () => ({ cancelled: true }),
    reload: async () => undefined,
  } satisfies ExtensionCommandContextActions;

  await live.session.bindExtensions({
    uiContext,
    mode: "rpc",
    commandContextActions,
  });
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
      // The SDK may leave `session.errorMessage` populated after a failed
      // turn. A follow-up prompt starts a new run, so acknowledge the stale
      // session-level error here; if this new run fails, the SDK will set a
      // fresh value before `agent_end` and the banner still appears.
      try {
        (live.session as unknown as { errorMessage: string | undefined }).errorMessage = undefined;
      } catch {
        // Best-effort only — never let error clearing break event fan-out.
      }
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
      name?: string;
    };

    if (verbose) {
      logAgentEvent("info", {
        msg: "agent_event",
        sessionId: live.sessionId,
        type: e.type,
      });
    }

    let outboundEvent: AgentSessionEvent = event;
    if (e.type === "message_end") {
      const msg = e.message;
      if (
        msg?.role === "assistant" &&
        (msg.stopReason === "error" || msg.stopReason === "aborted")
      ) {
        const modelInfo = typeof msg.model === "object" ? msg.model : undefined;
        const provider = msg.provider ?? modelInfo?.provider ?? live.session.model?.provider;
        logAgentEvent("warn", {
          msg: "agent turn ended with error stopReason",
          sessionId: live.sessionId,
          projectId: live.projectId,
          stopReason: msg.stopReason,
          errorMessage: msg.errorMessage,
          provider,
          modelId: msg.modelId ?? modelInfo?.id ?? live.session.model?.id,
        });
        if (shouldSuppressCodexProviderErrorFromWebUi(provider, msg.errorMessage)) {
          outboundEvent = {
            ...(event as object),
            message: { ...msg, errorMessage: undefined },
          } as unknown as AgentSessionEvent;
        }
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
    // Preserve the SDK event for registry subscribers, while also emitting
    // the forge-native frame that the SSE bridge exposes to the UI.
    const renamedEvent =
      e.type === "session_info_changed"
        ? {
            type: "session_renamed" as const,
            sessionId: live.sessionId,
            projectId: live.projectId,
            name: typeof e.name === "string" ? e.name : undefined,
          }
        : undefined;
    if (e.type === "agent_end") {
      // Primary: session-level `errorMessage` — the SDK's
      // documented authoritative field. Most failure modes set
      // this (auth failures, validation, etc.).
      let errMsg = (live.session as unknown as { errorMessage?: string }).errorMessage;
      // Fallback: a provider-side failure (openai-completions catch
      // path, openrouter 4xx, etc.) finalises the assistant message
      // with `stopReason="error"` and `errorMessage` on the MESSAGE
      // but does NOT always promote it to `session.errorMessage`.
      // Without this fallback, agent_end goes out empty, the client
      // shows neither a banner nor any per-message indicator, and
      // the user just sees a blank assistant turn (or a frozen
      // spinner mid-tool-chain). Scan the post-turn messages for the
      // most-recent assistant with an error and surface that.
      if (errMsg === undefined || errMsg === "") {
        const fromMessage = findLastAssistantErrorMessage(
          live.session.messages,
          live.lastAgentStartIndex ?? 0,
        );
        if (fromMessage !== undefined && fromMessage !== "") {
          errMsg = fromMessage;
          logAgentEvent("warn", {
            msg: "agent_end without session.errorMessage — surfacing message-level error",
            sessionId: live.sessionId,
            errorMessage: errMsg,
          });
        }
      } else {
        logAgentEvent("warn", {
          msg: "agent_end with session.errorMessage",
          sessionId: live.sessionId,
          errorMessage: errMsg,
        });
      }
      const provider = live.session.model?.provider;
      if (errMsg !== undefined && errMsg !== "") {
        if (shouldSuppressCodexProviderErrorFromWebUi(provider, errMsg)) {
          logAgentEvent("warn", {
            msg: "suppressing Codex provider error from web UI",
            sessionId: live.sessionId,
            projectId: live.projectId,
            provider,
            errorMessage: errMsg,
          });
        } else {
          // Forward a merged event that includes the error detail. Cast
          // through unknown — the SDK's union doesn't declare an
          // errorMessage field on agent_end (it expects callers to read
          // session.errorMessage themselves), but the wire shape is what
          // the browser consumes and it tolerates the extra field.
          outboundEvent = {
            ...(event as object),
            errorMessage: errMsg,
          } as unknown as AgentSessionEvent;
        }
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
    if (renamedEvent !== undefined) {
      for (const client of live.clients) {
        try {
          client.send(renamedEvent);
        } catch {
          live.clients.delete(client);
        }
      }
    }

    // Tools that create new sessions in this project: push a
    // `session_list_changed` event so the sidebar picks up the new
    // session without the user reloading. Covers two cases:
    //
    //   - pi-subagents `subagent` tool fires on `tool_execution_start`
    //     because the plugin writes the child .jsonl in the first
    //     second of the tool call (the run itself can take minutes,
    //     and waiting until tool_execution_end means the child only
    //     appears in the sidebar after the entire subagent run
    //     completes — by which time the user usually already hit
    //     reload).
    //   - Same tool name also handled on `tool_execution_end` as a
    //     race fallback: if the start-side push raced ahead of the
    //     plugin's .jsonl write, the end-side push picks up the now-
    //     existing child.
    //
    // orchestration's `orchestrate_spawn_worker` pushes
    // session_list_changed itself from inside execute() — sync with
    // the actual createSession call, no need to wait for SDK lifecycle
    // events.
    const toolEv = event as unknown as { type?: string; toolName?: string };
    if (
      (toolEv.type === "tool_execution_start" || toolEv.type === "tool_execution_end") &&
      toolEv.toolName === "subagent"
    ) {
      const refresh = {
        type: "session_list_changed" as const,
        reason: toolEv.type === "tool_execution_start" ? "subagent_start" : "subagent_end",
        projectId: live.projectId,
      };
      for (const client of live.clients) {
        try {
          client.send(refresh);
        } catch {
          // SSE client already gone; safe to ignore — its entry
          // gets cleaned up on the next event.
        }
      }
    }

    // Webhook fan-out. Filters internally for the 3 SDK events
    // it cares about (agent_end, auto_retry_end failures,
    // compaction_end success). Fire-and-forget — webhook
    // dispatch returns immediately after queueing the per-target
    // POSTs and retries happen in the background.
    bridgeAgentSessionEvent(
      { sessionId: live.sessionId, projectId: live.projectId, session: live.session },
      event,
    );

    // Orchestration fan-out. Filters internally for worker lifecycle
    // events and routes them to the owning supervisor as custom
    // notifications (no-op for non-worker sessions). Separate call
    // from the webhook bridge so the two systems stay independent —
    // disabling one doesn't affect the other.
    void bridgeWorkerAgentEvent({ sessionId: live.sessionId, session: live.session }, event);

    // Supervisor-side notification recovery: when a supervisor's own
    // agent_end fires (i.e. it just became idle), check whether any
    // important worker updates piled up during the just-finished turn
    // and re-fire the notification nudge if needed.
    if (e.type === "agent_end") {
      void (async () => {
        try {
          if (await isSupervisor(live.sessionId)) {
            await notifySupervisorIdle(live.sessionId);
          }
        } catch {
          // Best-effort recovery; never surface to the SSE caller.
        }
      })();
    }
  });
}

/**
 * Resolve the orchestration tools for a given session. Returns the
 * empty array when:
 *   - instance-level orchestration is disabled (config or
 *     MINIMAL_UI gate), OR
 *   - the session isn't a registered supervisor.
 *
 * Read fresh per session create/resume so toggling supervisor mode
 * in the UI and then re-resuming the session picks up the new
 * tools (same recompute-on-create posture MCP / tool-overrides
 * already use).
 */
async function resolveOrchestrationTools(sessionId: string): Promise<ToolDefinition[]> {
  if (!isOrchestrationEnabled()) return [];
  try {
    if (!(await isSupervisor(sessionId))) return [];
  } catch {
    // If the store is unreadable, skip — orchestration is
    // feature-gated; a missing/corrupt file should not
    // break session creation.
    return [];
  }
  return createOrchestrationTools(sessionId);
}

function applyAgentToolSandbox(
  workspacePath: string,
  customTools: readonly ToolDefinition[],
  toolEnv: Record<string, string>,
): ToolDefinition[] {
  if (!config.agentToolSandbox.enabled) return [...customTools];
  return [...customTools, ...createSandboxedToolDefinitions(workspacePath, toolEnv)];
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
  const mcpTools = await resolveMcpCustomTools(projectId, workspacePath);
  // SessionManager.getSessionId() is synchronous and stable from
  // create() onward — read it BEFORE createAgentSession so the
  // forge-native ask_user_question tool can bind to the right
  // session in its execute() closure.
  const toolEnv = (await readSandboxSettings()).toolEnv;
  const askTool = createAskUserQuestionTool(sessionManager.getSessionId());
  const todoTool = createTodoTool(sessionManager.getSessionId(), sessionManager);
  const processTool = createProcessTool(sessionManager.getSessionId(), workspacePath, toolEnv);
  const orchestrationTools = await resolveOrchestrationTools(sessionManager.getSessionId());
  const customTools: ToolDefinition[] = [
    ...mcpTools,
    askTool,
    todoTool,
    processTool,
    ...orchestrationTools,
  ];
  const effectiveCustomTools = applyAgentToolSandbox(workspacePath, customTools, toolEnv);
  const settingsManager = await buildSessionSettingsManager(workspacePath, projectId);
  const resourceLoader = await buildForgeResourceLoader(
    workspacePath,
    config.piConfigDir,
    settingsManager,
    projectId,
  );
  await migrateLegacyModelsJsonIfNeeded();
  const { session } = await createAgentSession({
    cwd: workspacePath,
    sessionManager,
    settingsManager,
    resourceLoader,
    agentDir: config.piConfigDir,
    customTools: effectiveCustomTools,
    tools: await buildToolsAllowlist(effectiveCustomTools, projectId, workspacePath),
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
  await bindWebExtensionContext(live);

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

  bridgeSessionCreated({
    sessionId: live.sessionId,
    projectId: live.projectId,
    workspacePath: live.workspacePath,
  });
  return live;
}

export function getSession(sessionId: string): LiveSession | undefined {
  return registry.get(sessionId);
}

/**
 * Registered SDK extension commands for a live session. Command names omit
 * the slash because that is the SDK's canonical invocation-name format.
 */
export interface ExtensionCommandSummary {
  name: string;
  description?: string;
}

export function listExtensionCommands(sessionId: string): ExtensionCommandSummary[] | undefined {
  const live = registry.get(sessionId);
  if (live === undefined) return undefined;
  return live.session.extensionRunner.getRegisteredCommands().map((command) => {
    const summary: ExtensionCommandSummary = { name: command.invocationName };
    if (command.description !== undefined) summary.description = command.description;
    return summary;
  });
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

export function maybeNameSessionFromFirstPrompt(
  live: LiveSession,
  promptText: string,
): string | undefined {
  if (!isGenericSessionName(live.session.sessionName)) return undefined;
  if (live.session.messages.some((message) => message.role === "user")) return undefined;

  const title = generateSessionTitleFromPrompt(promptText);
  if (title === undefined) return undefined;

  try {
    live.session.setSessionName(title);
  } catch (err) {
    logAgentEvent("warn", {
      msg: "failed to set automatic session name",
      sessionId: live.sessionId,
      projectId: live.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return undefined;
  }

  live.lastActivityAt = new Date();
  // setSessionName emits the SDK's session_info_changed event. The registry
  // subscription translates that event into the UI's session_renamed SSE
  // frame, which also covers extension-initiated renames.
  return title;
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
async function externallyActiveDiscoveredSession(
  sessionId: string,
  projectId: string,
  workspacePath: string,
): Promise<DiscoveredSession | undefined> {
  const discovered = await discoverSessionsOnDisk(projectId, workspacePath);
  const match = discovered.find((s) => s.sessionId === sessionId);
  if (match === undefined) return undefined;
  const external = await getExternalSubagentStatusForSession({
    runId: match.runId,
    path: match.path,
  });
  return external?.isExternalLive === true ? match : undefined;
}

function detachExternallyActiveLiveSession(sessionId: string): void {
  const live = registry.get(sessionId);
  if (live === undefined) return;

  // Do NOT call disposeSession(), AgentSession.abort(), AgentSession.dispose(),
  // or processManager.disposeSession() here. If pi-subagents is already running
  // this child externally, pi-forge must stop managing its in-memory view without
  // sending any lifecycle signal that could abort/kill the external execution.
  try {
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
  registry.delete(sessionId);
}

export async function rejectOrDisposeExternallyActiveSession(
  sessionId: string,
  projectId: string,
  workspacePath: string,
): Promise<void> {
  const match = await externallyActiveDiscoveredSession(sessionId, projectId, workspacePath);
  if (match === undefined) return;
  detachExternallyActiveLiveSession(sessionId);
  throw new ExternalSubagentActiveError(sessionId);
}

export async function resumeSession(
  sessionId: string,
  projectId: string,
  workspacePath: string,
): Promise<LiveSession> {
  await rejectOrDisposeExternallyActiveSession(sessionId, projectId, workspacePath);
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
    await rejectOrDisposeExternallyActiveSession(sessionId, projectId, workspacePath);
    const raced = registry.get(sessionId);
    if (raced) return raced;

    const dir = sessionDirFor(projectId);
    // Use our own discovery (not SessionManager.list directly) so
    // pi-subagents child sessions, which live one level deeper at
    // `<dir>/<parentId>/<runId>/<childId>.jsonl`, are also resolvable
    // by id. Top-level sessions are returned alongside children.
    const discovered = await discoverSessionsOnDisk(projectId, workspacePath);
    const match = discovered.find((s) => s.sessionId === sessionId);
    if (match === undefined) {
      // Diagnostic log so a missing-session resume failure is
      // explicit in stderr (the client just sees a 404 SSE
      // disconnect, which doesn't tell us WHICH discovery missed).
      process.stderr.write(
        JSON.stringify({
          level: "warn",
          time: new Date().toISOString(),
          msg: "resume-session-not-found",
          projectId,
          sessionId,
          discoveredIds: discovered.map((s) => s.sessionId),
        }) + "\n",
      );
      throw new SessionNotFoundError(sessionId);
    }
    process.stderr.write(
      JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        msg: "resume-session-found",
        projectId,
        sessionId,
        path: match.path,
        parentSessionId: match.parentSessionId,
      }) + "\n",
    );

    const external = await getExternalSubagentStatusForSession({
      runId: match.runId,
      path: match.path,
    });
    if (external?.isExternalLive === true) {
      throw new ExternalSubagentActiveError(sessionId);
    }

    // For child sessions, hand SessionManager.open the *child's* run
    // dir as the sessionDir so any subsequent file operations the SDK
    // performs land alongside the existing JSONL rather than in the
    // project's top-level dir. For top-level sessions, the run dir
    // collapses to the project session dir.
    const childSessionDir = match.parentSessionId !== undefined ? join(match.path, "..") : dir;
    const sessionManager = SessionManager.open(match.path, childSessionDir, workspacePath);
    const mcpTools = await resolveMcpCustomTools(projectId, workspacePath);
    const toolEnv = (await readSandboxSettings()).toolEnv;
    const askTool = createAskUserQuestionTool(sessionManager.getSessionId());
    const todoTool = createTodoTool(sessionManager.getSessionId(), sessionManager);
    const processTool = createProcessTool(sessionManager.getSessionId(), workspacePath, toolEnv);
    const orchestrationTools = await resolveOrchestrationTools(sessionManager.getSessionId());
    const customTools: ToolDefinition[] = [
      ...mcpTools,
      askTool,
      todoTool,
      processTool,
      ...orchestrationTools,
    ];
    const effectiveCustomTools = applyAgentToolSandbox(workspacePath, customTools, toolEnv);
    // Resumed session — refresh the todo cache from the branch so
    // the UI panel sees the persisted state on first SSE connect,
    // not an empty list.
    refreshTodoFromBranch(sessionManager.getSessionId(), sessionManager);
    const settingsManager = await buildSessionSettingsManager(workspacePath, projectId);
    const resourceLoader = await buildForgeResourceLoader(
      workspacePath,
      config.piConfigDir,
      settingsManager,
      projectId,
    );
    await migrateLegacyModelsJsonIfNeeded();
    const { session } = await createAgentSession({
      cwd: workspacePath,
      sessionManager,
      settingsManager,
      resourceLoader,
      agentDir: config.piConfigDir,
      customTools: effectiveCustomTools,
      tools: await buildToolsAllowlist(effectiveCustomTools, projectId, workspacePath),
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
    await bindWebExtensionContext(live);
    return live;
  });
}

/**
 * Soft-delete a cold (on-disk-only) session by moving its JSONL into the
 * 7-day archive. Refuses if the session is currently live in the registry —
 * the caller should dispose first. Returns:
 *   - "deleted" when the file was found and archived.
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
      let siblingDir: string | undefined;
      // Archive the pi-subagents sibling directory if this was a top-level
      // parent session. The plugin's `getSubagentSessionRoot(parentSessionFile)`
      // lays children at `<dirname(parentFile)>/<basename(parentFile, ".jsonl")>/...`.
      // Moving the directory with the parent keeps the archive self-contained and
      // removes child sessions from live discovery immediately.
      if (match.parentSessionId === undefined) {
        const stem = basename(match.path, ".jsonl");
        siblingDir = join(dirname(match.path), stem);
        // Dispose any LIVE children before moving their JSONLs out from under
        // them. Otherwise they become zombie sessions pointing at archived files.
        const liveChildIds = infos
          .filter((s) => s.parentSessionId === sessionId && registry.has(s.sessionId))
          .map((s) => s.sessionId);
        if (liveChildIds.length > 0) {
          await Promise.all(liveChildIds.map((id) => disposeSession(id)));
        }
      }
      try {
        await archiveSessionFiles({
          sessionId,
          projectId: project.id,
          sessionPath: match.path,
          ...(siblingDir !== undefined ? { subagentDir: siblingDir } : {}),
        });
      } catch (err) {
        // ENOENT (vanished mid-flight) is fine — collapse to "deleted" since
        // the file is now gone from live discovery, which is what the caller
        // asked for. Any other error (permissions, IO) is a real failure and
        // should NOT silently look like "not_found" to the operator.
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return "deleted";
        throw err;
      }
      return "deleted";
    }
  }
  return "not_found";
}

/**
 * Look up the projectId a session belongs to without resuming it.
 * Used by the DELETE route to fire `session_deleted` webhooks with
 * the project context. Scans projects.json + each project's
 * session dir; returns undefined if no project owns the id.
 */
export async function findProjectIdForSession(sessionId: string): Promise<string | undefined> {
  const live = registry.get(sessionId);
  if (live !== undefined) return live.projectId;
  const projects = await readProjects();
  for (const project of projects) {
    try {
      const infos = await discoverSessionsOnDisk(project.id, project.path);
      if (infos.some((s) => s.sessionId === sessionId)) return project.id;
    } catch {
      // Skip this project's dir on error — caller treats undefined
      // as "no project context for this delete."
      continue;
    }
  }
  return undefined;
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
    // Drop the todo cache for this session. The cache is a fast
    // path; even without this, a future session with the same id
    // would recover via replay-on-miss. Cleaner to be explicit.
    clearTodoForSession(sessionId);
    // Clear the orchestration in-memory dedupe state. Cheap
    // (Set/Map delete) and idempotent on non-supervisors, so call
    // unconditionally rather than gating on `isSupervisor` (which
    // would mean an extra disk read inside the dispose hot path).
    notifySupervisorDisposed(sessionId);
    // Terminate every live process owned by this session (SIGTERM,
    // brief grace, SIGKILL) and remove the per-session log dir.
    // Best-effort + bounded — disposeSession itself can take up to
    // GRACE_MS but no longer; the outer disposeAllSessions caller
    // doesn't block on this beyond its own ABORT_TIMEOUT_MS race
    // because we await it last.
    await processManager.disposeSession(sessionId).catch(() => undefined);
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
  // Diagnostic log when sub-agent discovery fires — keep this so
  // future reports of "children aren't grouped" can be triaged from
  // server stderr alone (no client-side debugging needed). One line
  // per call, JSON-shaped for log shippers.
  if (children.length > 0 || basenameToParentId.size > 0) {
    process.stderr.write(
      JSON.stringify({
        level: "info",
        time: new Date().toISOString(),
        msg: "subagent-discovery",
        projectId,
        topLevelSessions: infos.length,
        basenameMapSize: basenameToParentId.size,
        childrenFound: children.length,
        children: children.map((c) => ({
          childId: c.sessionId,
          parentSessionId: c.parentSessionId,
          runId: c.runId,
          path: c.path,
        })),
      }) + "\n",
    );
  }
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
 * Walk under each `<projectId>/<parentBasename>/` to surface
 * pi-subagents child sessions, regardless of how deep the plugin
 * nests them.
 *
 * The plugin's `getSubagentSessionRoot(parentSessionFile)` always
 * returns `<dirname(parentSessionFile)>/<basename(parentSessionFile, ".jsonl")>`
 * — a directory NAMED after the parent's full basename. WHAT goes
 * underneath varies by plugin run mode; observed in the wild:
 *
 *   - <basename>/<child>.jsonl                       (flat — rare)
 *   - <basename>/<runId>/<child>.jsonl               (single-mode)
 *   - <basename>/<runId>/run-<N>/session.jsonl       (parallel/chain)
 *
 * Rather than enumerating every layout, we recursively walk under
 * `<basename>/` (capped at depth 4 for safety) and treat any
 * directory containing `.jsonl` files as a candidate sessions dir.
 * `runId` is reconstructed from the path segments between
 * `<basename>` and the JSONL's containing dir.
 *
 * `basenameToParentId` maps the basename dir back to the parent's
 * actual sessionId (since the dir name includes the timestamp prefix,
 * NOT the bare sessionId). Without this mapping the sidebar grouping
 * silently fails because the dir name and sessionId never compare equal.
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
    // Skip well-known sibling dirs the plugin creates at the same
    // level for unrelated reasons (artifacts, etc.) — these aren't
    // parent-named child roots.
    if (dirName === "subagent-artifacts") continue;

    const parentSessionId = basenameToParentId.get(dirName) ?? dirName;
    const parentDir = join(dir, dirName);

    // Recursively find every dir containing .jsonl files under
    // <parentDir>, capped at depth 4 (the deepest layout observed
    // is <basename>/<runId>/run-N/session.jsonl, which is depth 3 —
    // depth 4 leaves headroom for one more level the plugin might
    // add in future versions). Depth cap also protects against
    // symlink loops without needing a visited-set.
    const sessionDirs = await collectJsonlDirs(parentDir, 0, 4);
    for (const sd of sessionDirs) {
      let infos: SessionInfo[];
      try {
        infos = await SessionManager.list(workspacePath, sd);
      } catch {
        continue;
      }
      // Reconstruct runId from path segments between parentDir and sd.
      // Single segment → that's the runId. Multiple segments
      // (e.g. <runId>/run-0) → join with '/' so the sidebar can show
      // the full run identity in its title attribute.
      const rel = sd.slice(parentDir.length).replace(/^[/\\]+/, "");
      const runId = rel.length > 0 ? rel : undefined;
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
        if (runId !== undefined) ds.runId = runId;
        out.push(ds);
      }
    }
  }
  return out;
}

/**
 * Recursively find every directory under `root` (inclusive) that
 * contains at least one `.jsonl` file. Bounded by `maxDepth` to
 * cap the worst case and defend against symlink loops.
 */
async function collectJsonlDirs(root: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth > maxDepth) return [];
  let entries: { name: string; isDirectory: boolean; isFile: boolean }[];
  try {
    const list = await readdir(root, { withFileTypes: true });
    entries = list.map((d) => ({
      name: d.name,
      isDirectory: d.isDirectory(),
      isFile: d.isFile(),
    }));
  } catch {
    return [];
  }
  const out: string[] = [];
  if (entries.some((e) => e.isFile && e.name.endsWith(".jsonl"))) out.push(root);
  for (const e of entries) {
    if (!e.isDirectory) continue;
    const child = join(root, e.name);
    out.push(...(await collectJsonlDirs(child, depth + 1, maxDepth)));
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
      const external = await getExternalSubagentStatusForSession({ runId: d.runId, path: d.path });
      if (external !== undefined) {
        merged.externalState = external.state;
        merged.isExternalLive = external.isExternalLive;
      }
      merged.path = d.path;
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
      path: d.path,
    };
    if (d.parentSessionId !== undefined) u.parentSessionId = d.parentSessionId;
    if (d.runId !== undefined) u.runId = d.runId;
    const external = await getExternalSubagentStatusForSession({ runId: d.runId, path: d.path });
    if (external !== undefined) {
      u.externalState = external.state;
      u.isExternalLive = external.isExternalLive;
    }
    liveById.set(d.sessionId, u);
  }

  // Orchestration workers are ordinary top-level pi sessions on disk, with
  // their supervisor link stored in FORGE_DATA_DIR rather than in the JSONL
  // path. Overlay that topology onto the unified list so the sidebar can
  // render worker sessions beneath their supervisor the same way it nests
  // pi-subagents child sessions. Existing disk-derived parentSessionId wins
  // because those are true child JSONLs whose resume/delete semantics depend
  // on the subdirectory layout.
  try {
    const orchestrationStore = await readStore();
    for (const [workerId, rec] of Object.entries(orchestrationStore.workers)) {
      const worker = liveById.get(workerId);
      if (worker === undefined) continue;
      if (worker.parentSessionId !== undefined) continue;
      worker.parentSessionId = rec.supervisorId;
    }
  } catch (err) {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        time: new Date().toISOString(),
        msg: "listSessionsForProject: failed to overlay orchestration worker links",
        projectId,
        err: err instanceof Error ? err.message : String(err),
      }) + "\n",
    );
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
  const loc = await findSessionLocation(sessionId);
  if (loc === undefined) throw new SessionNotFoundError(sessionId);
  await rejectOrDisposeExternallyActiveSession(sessionId, loc.projectId, loc.workspacePath);
  const existing = registry.get(sessionId);
  if (existing) return existing;
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
  const mcpTools = await resolveMcpCustomTools(source.projectId, source.workspacePath);
  const toolEnv = (await readSandboxSettings()).toolEnv;
  const askTool = createAskUserQuestionTool(sessionManager.getSessionId());
  const todoTool = createTodoTool(sessionManager.getSessionId(), sessionManager);
  const processTool = createProcessTool(
    sessionManager.getSessionId(),
    source.workspacePath,
    toolEnv,
  );
  const orchestrationTools = await resolveOrchestrationTools(sessionManager.getSessionId());
  const customTools: ToolDefinition[] = [
    ...mcpTools,
    askTool,
    todoTool,
    processTool,
    ...orchestrationTools,
  ];
  const effectiveCustomTools = applyAgentToolSandbox(source.workspacePath, customTools, toolEnv);
  // Forked session — replay the branch (which now belongs to the
  // fork) so the new session's todo cache reflects the inherited
  // state, not the parent's stale entry.
  refreshTodoFromBranch(sessionManager.getSessionId(), sessionManager);
  const settingsManager = await buildSessionSettingsManager(source.workspacePath, source.projectId);
  const resourceLoader = await buildForgeResourceLoader(
    source.workspacePath,
    config.piConfigDir,
    settingsManager,
    source.projectId,
  );
  await migrateLegacyModelsJsonIfNeeded();
  const { session } = await createAgentSession({
    cwd: source.workspacePath,
    sessionManager,
    settingsManager,
    resourceLoader,
    agentDir: config.piConfigDir,
    customTools: effectiveCustomTools,
    tools: await buildToolsAllowlist(effectiveCustomTools, source.projectId, source.workspacePath),
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
  await bindWebExtensionContext(live);

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
      const restoredMcpTools = await resolveMcpCustomTools(source.projectId, source.workspacePath);
      const restoredToolEnv = (await readSandboxSettings()).toolEnv;
      const restoredAskTool = createAskUserQuestionTool(restoredManager.getSessionId());
      const restoredTodoTool = createTodoTool(restoredManager.getSessionId(), restoredManager);
      const restoredProcessTool = createProcessTool(
        restoredManager.getSessionId(),
        source.workspacePath,
        restoredToolEnv,
      );
      const restoredOrchestrationTools = await resolveOrchestrationTools(
        restoredManager.getSessionId(),
      );
      const restoredCustomTools: ToolDefinition[] = [
        ...restoredMcpTools,
        restoredAskTool,
        restoredTodoTool,
        restoredProcessTool,
        ...restoredOrchestrationTools,
      ];
      const restoredEffectiveCustomTools = applyAgentToolSandbox(
        source.workspacePath,
        restoredCustomTools,
        restoredToolEnv,
      );
      // Re-derive the original source's todo cache from the (now
      // un-mutated) source JSONL — the SDK's fork machinery left
      // the cache pointing at fork state.
      refreshTodoFromBranch(restoredManager.getSessionId(), restoredManager);
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
      await migrateLegacyModelsJsonIfNeeded();
      const { session: restoredSession } = await createAgentSession({
        cwd: source.workspacePath,
        sessionManager: restoredManager,
        settingsManager: restoredSettingsManager,
        resourceLoader: restoredResourceLoader,
        agentDir: config.piConfigDir,
        customTools: restoredEffectiveCustomTools,
        tools: await buildToolsAllowlist(
          restoredEffectiveCustomTools,
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
      await bindWebExtensionContext(source);
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

/**
 * Rebuild the live AgentSession in-place — same SessionManager, fresh
 * `customTools` list. Used by the orchestration enable/disable route
 * to make the orchestrate_* tools appear (or disappear) immediately
 * without disposing the session (and triggering all the SSE-disconnect
 * + tombstone + cold-session race fallout that comes with dispose).
 *
 * Pattern mirrors the source-restore branch of `forkSession`:
 * unsubscribe the old AgentSession, instantiate a new one against
 * the same SessionManager, mutate `live.session` in place, re-wire
 * the registry's own subscribe handler against the new instance.
 * The LiveSession entry stays in the registry, attached SSE clients
 * stay connected, the live.clients Set is reused so events from the
 * new AgentSession fan out to the same browsers without a reconnect.
 *
 * Aborts any in-flight turn first (best-effort, bounded at 5s) so a
 * mid-stream rebuild doesn't leave the old AgentSession's LLM call
 * orphaned. No-op when the session isn't live.
 *
 * Why not dispose + let SSE reconnect:
 *   1. Pre-prompt sessions have no .jsonl on disk yet — `resumeSession`
 *      throws `SessionNotFoundError`, the client's SSE error handler
 *      maps the 404 to "session was deleted elsewhere" and removes
 *      the session from local state. The session vanishes from the
 *      sidebar with no warning.
 *   2. Post-prompt sessions hit the dispose tombstone — the
 *      `disposeTombstones` map blocks resume for `TOMBSTONE_MS` (1.5s)
 *      to prevent a polling SSE client from racing a hard-delete.
 *      The orchestration enable doesn't have a hard-delete intent, but
 *      it still sets the tombstone, so the SSE reconnect attempts
 *      get 410 `stream_open_failed` until it expires.
 */
export async function rebuildAgentSessionForTools(
  sessionId: string,
): Promise<LiveSession | undefined> {
  const live = registry.get(sessionId);
  if (live === undefined) return undefined;
  // Bound the abort race so a hung LLM call can't block the rebuild
  // (and therefore the operator's UI click) forever. Best-effort —
  // the SDK doesn't currently throw from abort, but defend against
  // future versions same as disposeSession does.
  try {
    await Promise.race([
      live.session.abort(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000).unref()),
    ]);
  } catch (err) {
    void err;
  }
  try {
    live.unsubscribe();
  } catch {
    // ignore
  }
  // Reuse the SessionManager so the underlying .jsonl identity
  // doesn't shift. For pre-prompt sessions this is the in-memory
  // SessionManager from SessionManager.create — no file on disk
  // yet, the SDK rehydrates an empty session from it. For sessions
  // with prior turns, the SDK reads the existing messages from the
  // file the SessionManager points at.
  const sessionManager = live.session.sessionManager;
  const mcpTools = await resolveMcpCustomTools(live.projectId, live.workspacePath);
  const toolEnv = (await readSandboxSettings()).toolEnv;
  const askTool = createAskUserQuestionTool(sessionManager.getSessionId());
  const todoTool = createTodoTool(sessionManager.getSessionId(), sessionManager);
  const processTool = createProcessTool(sessionManager.getSessionId(), live.workspacePath, toolEnv);
  const orchestrationTools = await resolveOrchestrationTools(sessionManager.getSessionId());
  const customTools: ToolDefinition[] = [
    ...mcpTools,
    askTool,
    todoTool,
    processTool,
    ...orchestrationTools,
  ];
  const effectiveCustomTools = applyAgentToolSandbox(live.workspacePath, customTools, toolEnv);
  const settingsManager = await buildSessionSettingsManager(live.workspacePath, live.projectId);
  const resourceLoader = await buildForgeResourceLoader(
    live.workspacePath,
    config.piConfigDir,
    settingsManager,
    live.projectId,
  );
  await migrateLegacyModelsJsonIfNeeded();
  const { session: newSession } = await createAgentSession({
    cwd: live.workspacePath,
    sessionManager,
    settingsManager,
    resourceLoader,
    agentDir: config.piConfigDir,
    customTools: effectiveCustomTools,
    tools: await buildToolsAllowlist(effectiveCustomTools, live.projectId, live.workspacePath),
  });
  // Drop the old AgentSession only AFTER the new one is constructed
  // — if createAgentSession throws, we still have a working session.
  try {
    live.session.dispose();
  } catch {
    // ignore — SDK doesn't currently throw, H2-defensive
  }
  // Swap in place. Same sessionId, same projectId, same SSE clients
  // — the browser side notices nothing beyond the new tools showing
  // up on the next agent turn.
  live.session = newSession;
  live.lastActivityAt = new Date();
  live.lastAgentStartIndex = undefined;
  live.unsubscribe = makeSubscribeHandler(live);
  await bindWebExtensionContext(live);
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
function isPiSubagentsPackageSource(source: string): boolean {
  return source.includes("pi-subagents");
}

function packageSourceValue(pkg: PackageSource): string {
  return typeof pkg === "string" ? pkg : pkg.source;
}

function filterSandboxDisabledPackages(packages: PackageSource[] | undefined): PackageSource[] {
  const current = packages ?? [];
  if (!config.agentToolSandbox.enabled) return current;
  return current.filter((pkg) => !isPiSubagentsPackageSource(packageSourceValue(pkg)));
}

function filterSandboxDisabledExtensions(extensions: string[] | undefined): string[] {
  const current = extensions ?? [];
  if (!config.agentToolSandbox.enabled) return current;
  return current.filter((ext) => !isPiSubagentsPackageSource(ext));
}

async function buildSessionSettingsManager(
  workspacePath: string,
  projectId: string,
): Promise<SettingsManager> {
  const sm = SettingsManager.create(workspacePath, config.piConfigDir);
  const [skillPatterns, promptPatterns] = await Promise.all([
    effectiveSkillsForProject(projectId),
    effectivePromptsForProject(projectId),
  ]);
  const shouldPatch =
    skillPatterns.length > 0 || promptPatterns.length > 0 || config.agentToolSandbox.enabled;
  if (!shouldPatch) return sm;
  const origGlobal = sm.getGlobalSettings.bind(sm);
  const origProject = sm.getProjectSettings.bind(sm);
  const mergeSkills = (existing: string[] | undefined): string[] =>
    skillPatterns.length === 0
      ? (existing ?? [])
      : Array.from(new Set([...(existing ?? []), ...skillPatterns]));
  const mergePrompts = (existing: string[] | undefined): string[] =>
    promptPatterns.length === 0
      ? (existing ?? [])
      : Array.from(new Set([...(existing ?? []), ...promptPatterns]));
  const applySandboxPackageFilters = <T extends ReturnType<typeof origGlobal>>(s: T): T => ({
    ...s,
    packages: filterSandboxDisabledPackages(s.packages),
    extensions: filterSandboxDisabledExtensions(s.extensions),
  });
  sm.getGlobalSettings = (): ReturnType<typeof origGlobal> => {
    const s = applySandboxPackageFilters(origGlobal());
    return { ...s, skills: mergeSkills(s.skills), prompts: mergePrompts(s.prompts) };
  };
  sm.getProjectSettings = (): ReturnType<typeof origProject> => {
    const s = applySandboxPackageFilters(origProject());
    return { ...s, skills: mergeSkills(s.skills), prompts: mergePrompts(s.prompts) };
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
 * time `loadGlobal()` is called in index.ts, but session creation also
 * awaits the manager's global load/restart gate so a fast browser
 * reconnect after container recreation does not create an AgentSession
 * before persisted stdio MCP servers have respawned.
 */
async function resolveMcpCustomTools(
  projectId: string,
  workspacePath: string,
): Promise<ReturnType<typeof mcpCustomToolsForProject>> {
  await mcpEnsureGlobalLoaded().catch(() => undefined);
  if (!mcpIsGloballyEnabled()) return [];
  await mcpEnsureProjectLoaded(projectId, workspacePath).catch(() => undefined);
  return mcpCustomToolsForProject(projectId);
}

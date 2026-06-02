/**
 * Session orchestration — types + constants.
 *
 * A "supervisor" session has the `orchestrate_*` tool group enabled
 * and can spawn / observe / message / interrupt / kill / detach a set
 * of "worker" sessions. Workers are real first-class sessions (same
 * .jsonl on disk, same browser visibility) — the link is purely
 * forge-side metadata in `${FORGE_DATA_DIR}/session-orchestration.json`.
 *
 * Topology is strict hub-and-spoke: workers don't get the orchestrate
 * tools and have no way to enumerate or message other workers.
 * Enforcement is by tool-surface (the tools simply aren't there),
 * not by permission check at the registry layer.
 *
 * Depth is limited to 1: a worker cannot become a supervisor. Keeps
 * the worst case bounded against fork-bomb runaway prompts.
 */

export const ORCHESTRATION_VERSION = 1 as const;

/**
 * Inbox events the supervisor's LLM sees when it calls
 * `orchestrate_read_inbox`. All carry the workerId; the `data`
 * shape is event-specific and intentionally small — the supervisor
 * can call `orchestrate_read_worker` to fetch full detail.
 */
export const INBOX_EVENT_TYPES = [
  "worker.ended",
  "worker.ask_user",
  "worker.execution_stopped_without_agent_end",
  // Legacy inbox history can contain this from older builds. New
  // retry failures are intentionally not enqueued; final agent_end
  // or explicit stop-without-agent_end carries the authoritative outcome.
  "worker.auto_retry_failed",
  "worker.process_alert",
  "worker.deleted",
] as const;

export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

export function isInboxEventType(v: unknown): v is InboxEventType {
  return typeof v === "string" && (INBOX_EVENT_TYPES as readonly string[]).includes(v);
}

export interface InboxItem {
  /** UUID assigned at enqueue. */
  id: string;
  type: InboxEventType;
  workerId: string;
  /** ISO timestamp. */
  occurredAt: string;
  /** Event-specific small payload. The supervisor calls
   *  `orchestrate_read_worker` for full transcript context. */
  data: Record<string, unknown>;
  /** True once `read_inbox` has surfaced this item to the supervisor's
   *  LLM. Items stay in the file for one more drain cycle (so the user
   *  can audit recent activity via the REST UI) then evict via cap. */
  delivered: boolean;
}

export interface SupervisorRecord {
  /** ISO timestamp the supervisor mode was enabled. */
  enabledAt: string;
  /** Live worker session IDs spawned (or attached) under this
   *  supervisor. Authoritative — the per-worker `supervisorId` is a
   *  back-pointer. Kept in sync via the same store-level lock. */
  workerIds: string[];
}

export type WorkerLifecycleState =
  | "idle"
  | "running"
  | "ended"
  | "errored"
  | "stopped"
  | "deleted"
  | "awaiting_question";

export interface WorkerRecord {
  supervisorId: string;
  spawnedAt: string;
  /** Best-effort: how the worker was created. Helps the UI badge
   *  "↳ handoff from <id>" without round-tripping the supervisor. */
  spawnedFrom?: {
    sessionId: string;
    mode: "fresh" | "summary";
  };
  /**
   * Last authoritative lifecycle state observed for this worker.
   * Updated only from explicit signals (agent_start/agent_end,
   * ask_user_question, delete/kill/dispose), never timeouts.
   */
  state?: WorkerLifecycleState;
  /** True after agent_start until agent_end or an explicit stop/delete. */
  turnOpen?: boolean;
  lastStateAt?: string;
  lastAgentStartAt?: string;
  lastAgentEndAt?: string;
  stopReason?: string | null;
  errorMessage?: string | null;
}

/**
 * Persisted store shape — written to `session-orchestration.json`.
 * Two maps so a worker→supervisor lookup is O(1) without iterating
 * every supervisor's worker list. supervisors[id].workerIds is the
 * source of truth for the fanout cap; workers[id].supervisorId is
 * the back-pointer used by the event bridge.
 */
export interface OrchestrationStore {
  version: typeof ORCHESTRATION_VERSION;
  supervisors: Record<string, SupervisorRecord>;
  workers: Record<string, WorkerRecord>;
}

export function emptyStore(): OrchestrationStore {
  return { version: ORCHESTRATION_VERSION, supervisors: {}, workers: {} };
}

export interface InboxStore {
  version: typeof ORCHESTRATION_VERSION;
  /** supervisorId → FIFO-capped item list, oldest first. */
  inboxes: Record<string, InboxItem[]>;
}

export function emptyInboxStore(): InboxStore {
  return { version: ORCHESTRATION_VERSION, inboxes: {} };
}

/**
 * Per-supervisor inbox cap. Items beyond this evict from the FIFO
 * front. 200 is enough headroom for a supervisor that goes offline
 * for an hour while 20 workers run; the supervisor can still see the
 * last few hundred events on resume. Bumping this is cheap (small
 * JSON blob); shrinking risks an inattentive supervisor missing
 * events that fired before its next wake-up.
 */
export const MAX_INBOX_ITEMS = 200;

/** Default per-supervisor concurrent worker cap. Configurable via
 *  `ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR`. */
export const DEFAULT_MAX_WORKERS_PER_SUPERVISOR = 8;

/** Depth limit — workers cannot themselves be supervisors. Phase 1
 *  ships at depth=1 only. Reconsider once real usage clarifies what
 *  the worst-case prompt loops look like. */
export const MAX_DEPTH = 1;

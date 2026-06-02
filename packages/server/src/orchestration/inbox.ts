/**
 * Worker notification surface — the bridge between worker events and
 * supervisor custom messages. The persisted inbox store remains as UI
 * history/audit data, but the supervisor LLM no longer needs a separate
 * read-inbox tool: each `orchestration-notify` message carries the
 * actionable event payload directly.
 *
 * Delivery policy:
 *   - If the supervisor is active, every worker update is delivered as
 *     `steer` so it can enter the current run at the next model step.
 *   - If the supervisor is idle, every update except delete/unregister
 *     starts a new turn; delete/unregister only appends a visible card.
 */
import { sendCustomLifecycleMessage } from "../lifecycle-notifications.js";
import { getSession } from "../session-registry.js";
import { enqueueInboxItem, getSupervisorIdForWorker, readPendingInbox } from "./store.js";
import type { InboxEventType, InboxItem } from "./types.js";

/**
 * Per-supervisor sequence number for wake-up prompts. Surfaces in
 * stderr logs to make it possible to grep "how many times have we
 * pushed to supervisor X today" without parsing timestamps.
 */
const wakeCounters = new Map<string, number>();

function nextWakeCounter(supervisorId: string): number {
  const n = (wakeCounters.get(supervisorId) ?? 0) + 1;
  wakeCounters.set(supervisorId, n);
  return n;
}

function logInbox(level: "info" | "warn", payload: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), ...payload })}\n`,
  );
}

/**
 * Build the supervisor notification text. The content is intentionally
 * actionable on its own so the supervisor does not need a separate
 * read-inbox call before deciding what to do.
 */
export const ORCHESTRATION_WAKE_PREFIX = "[orchestration]";
export const ORCHESTRATION_NOTIFY_TYPE = "orchestration-notify";

export function shouldTriggerWorkerTurn(type: InboxEventType): boolean {
  return type !== "worker.deleted";
}

function workerStateForInboxType(type: InboxEventType): string {
  if (type === "worker.ended") return "ended";
  if (type === "worker.execution_stopped_without_agent_end") return "failed";
  if (type === "worker.deleted") return "deleted";
  if (type === "worker.ask_user") return "awaiting_question";
  if (type === "worker.process_alert") return "process_alert";
  return type.replace(/^worker\./, "");
}

function buildNotificationText(
  type: InboxEventType,
  workerId: string,
  data: Record<string, unknown>,
): string {
  const state = workerStateForInboxType(type);
  const lines = [`Worker ${workerId} reported ${state}.`];
  const detail = summarizeWorkerEventData(type, data);
  if (detail !== "") lines.push(detail);
  return lines.join("\n\n");
}

function summarizeWorkerEventData(type: InboxEventType, data: Record<string, unknown>): string {
  if (type === "worker.ended") {
    const stop = typeof data.stopReason === "string" ? data.stopReason : "unknown";
    const err =
      typeof data.errorMessage === "string" && data.errorMessage.length > 0
        ? data.errorMessage
        : "";
    const text =
      typeof data.assistantText === "string" && data.assistantText.length > 0
        ? data.assistantText
        : "";
    const parts = [`stopReason: ${stop}`];
    if (err !== "") parts.push(`errorMessage:\n${err}`);
    if (text !== "") parts.push(`finalMessage:\n${text}`);
    return parts.join("\n\n");
  }
  if (type === "worker.ask_user") {
    const count = typeof data.questionCount === "number" ? data.questionCount : 1;
    const header = typeof data.firstQuestionHeader === "string" ? data.firstQuestionHeader : "";
    const text = typeof data.firstQuestionText === "string" ? data.firstQuestionText : "";
    return [
      `questionCount: ${count}`,
      header !== "" ? `firstQuestionHeader: ${header}` : "",
      text !== "" ? `firstQuestionText:\n${text}` : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
  }
  if (type === "worker.execution_stopped_without_agent_end") {
    const reason = typeof data.reason === "string" ? data.reason : "stopped";
    const lastStart = typeof data.lastAgentStartAt === "string" ? data.lastAgentStartAt : "";
    return `reason: ${reason}${lastStart !== "" ? `\nlastAgentStartAt: ${lastStart}` : ""}`;
  }
  if (type === "worker.deleted") {
    return `wasLive: ${data.wasLive === true ? "true" : "false"}`;
  }
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return "";
  }
}

/**
 * Deliver a worker notification to the supervisor. No-op if the
 * supervisor is offline, or if this exact inbox item was already
 * surfaced as a durable custom message.
 */
async function tryWakeSupervisor(
  supervisorId: string,
  event?: { type: InboxEventType; workerId: string; itemId: string; data: Record<string, unknown> },
): Promise<boolean> {
  const live = getSession(supervisorId);
  if (live === undefined) return false;
  const pendingItems = await readPendingInbox(supervisorId);
  const pending = pendingItems.length;
  const fallbackItem =
    pendingItems.find((it) => shouldTriggerWorkerTurn(it.type)) ?? pendingItems[0];
  const effectiveEvent =
    event ??
    (fallbackItem === undefined
      ? undefined
      : {
          type: fallbackItem.type,
          workerId: fallbackItem.workerId,
          itemId: fallbackItem.id,
          data: fallbackItem.data,
        });
  if (effectiveEvent === undefined) return false;
  const triggerTurn = shouldTriggerWorkerTurn(effectiveEvent.type);
  const seq = nextWakeCounter(supervisorId);
  const type = effectiveEvent.type;
  const workerId = effectiveEvent.workerId;
  const text = buildNotificationText(type, workerId, effectiveEvent.data);
  // Fire-and-forget. The SDK's sendCustomMessage is async; we let it
  // run in the background so the event-bridge caller (often the
  // hot path of an AgentSessionEvent subscriber) returns immediately.
  // Errors are surfaced via stderr — most likely cause is "session was
  // disposed between enqueue and wake" or no model configured when a
  // triggering notification starts a turn.
  sendCustomLifecycleMessage(
    live.session,
    {
      customType: ORCHESTRATION_NOTIFY_TYPE,
      content: text,
      display: true,
      details: {
        source: "orchestration",
        state: workerStateForInboxType(type),
        eventType: type,
        workerId,
        inboxItemId: effectiveEvent.itemId,
        pendingCount: pending,
        data: effectiveEvent.data,
      },
    },
    {
      triggerTurn,
      dedupe: { detailKey: "inboxItemId", detailValue: effectiveEvent.itemId },
      onError: (err: unknown) => {
        logInbox("warn", {
          msg: "orchestration-wake-failed",
          supervisorId,
          workerId,
          type,
          pending,
          seq,
          triggerTurn,
          err: err instanceof Error ? err.message : String(err),
        });
      },
    },
  );
  logInbox("info", {
    msg: "orchestration-wake-delivered",
    supervisorId,
    workerId,
    type,
    pending,
    seq,
    triggerTurn,
  });
  return true;
}

/**
 * Public entry point: a worker session emitted an interesting
 * event, store it for UI history and notify the supervisor.
 *
 * Silently skips when the worker isn't linked to a supervisor —
 * happens transiently when a worker is being detached/disposed,
 * and is the expected steady-state for non-orchestrated sessions
 * (the event bridge currently calls this for every session's
 * events, then filters here).
 */
export async function bridgeWorkerEvent(
  workerId: string,
  type: InboxEventType,
  data: Record<string, unknown>,
): Promise<InboxItem | undefined> {
  const supervisorId = await getSupervisorIdForWorker(workerId);
  if (supervisorId === undefined) return undefined;
  const item = await enqueueInboxItem(supervisorId, {
    type,
    workerId,
    occurredAt: new Date().toISOString(),
    data,
    delivered: true,
  });
  logInbox("info", {
    msg: "orchestration-inbox-enqueued",
    supervisorId,
    workerId,
    type,
    itemId: item.id,
  });
  // Best-effort wake-up/status append. We DON'T await — the worker event
  // handler that called us shouldn't block on the supervisor's LLM round-trip.
  void tryWakeSupervisor(supervisorId, { type, workerId, itemId: item.id, data });
  return item;
}

/**
 * Called from session-registry when a supervisor's own session emits
 * `agent_end` — i.e., the supervisor just became idle. Compatibility
 * recovery for any older undelivered history items.
 */
export async function notifySupervisorIdle(supervisorId: string): Promise<void> {
  void tryWakeSupervisor(supervisorId);
}

/** Called from session-registry when a supervisor session is disposed. */
export function notifySupervisorDisposed(supervisorId: string): void {
  wakeCounters.delete(supervisorId);
}

/**
 * Drain a supervisor's pending history items and mark them delivered.
 * Retained for REST/UI history compatibility; no agent-facing inbox tool
 * is registered.
 */
export async function drainInbox(supervisorId: string): Promise<InboxItem[]> {
  return readPendingInbox(supervisorId, { markDelivered: true });
}

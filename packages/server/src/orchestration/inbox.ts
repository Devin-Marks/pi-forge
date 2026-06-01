/**
 * Inbox surface — the bridge between worker events and supervisor
 * wake-up. Wraps the raw inbox queue (in `store.ts`) with the
 * "fire a prompt at an idle supervisor" mechanism that makes
 * "session A watches session B" actually work without polling.
 *
 * Design:
 *   1. PULL primary: supervisor's LLM calls `orchestrate_read_inbox`
 *      to drain pending items. Items stay in the file (cap-evicted)
 *      so the REST UI can show recent activity even after the LLM
 *      consumed them.
 *   2. PUSH secondary: when an event enqueues AND the supervisor
 *      session is live AND idle (not currently streaming), we fire
 *      a tiny `[orchestration]` prompt at the supervisor so it
 *      starts a new turn that surfaces the items. If the supervisor
 *      is busy, the push skips — the items wait on the queue, and
 *      the supervisor's next prompt will see them via
 *      `orchestrate_read_inbox`.
 *   3. Recovery: when the supervisor's own `agent_end` fires (i.e.
 *      it just became idle), we check for pending items and PUSH
 *      again if any. Closes the "supervisor finished a turn but
 *      didn't call read_inbox" gap.
 *
 * All PUSH paths are best-effort: the queue is the source of truth.
 * A missed wake-up means the supervisor sees the items on its next
 * turn, not that the items vanish.
 */
import { getSession } from "../session-registry.js";
import {
  enqueueInboxItem,
  getSupervisorIdForWorker,
  pendingInboxCount,
  readPendingInbox,
} from "./store.js";
import type { InboxEventType, InboxItem } from "./types.js";

/**
 * Per-supervisor "already pushed once for this idle window" flag.
 * Without this, every inbox enqueue while the supervisor is briefly
 * idle would fire a fresh `prompt()` — the supervisor's first push
 * starts a turn, but the SDK may not flip isStreaming to true
 * immediately (it's set after the first message_start event), so a
 * second enqueue 1ms later would still see "idle" and fire a
 * duplicate prompt. The flag is cleared in two places:
 *   - On the supervisor's own `agent_end` (handled in
 *     `notifySupervisorIdle` below) — the supervisor's turn finished
 *     and the next idle window is a new wake-up opportunity.
 *   - On supervisor dispose (handled in session-registry) — clear
 *     so a re-resumed session can wake again.
 */
const pendingWakePush = new Map<string, number>();

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

function clearPendingWakeIfCurrent(supervisorId: string, seq: number): boolean {
  if (pendingWakePush.get(supervisorId) !== seq) return false;
  pendingWakePush.delete(supervisorId);
  return true;
}

/**
 * Diagnostic/test helper: true when a supervisor already has a wake-up
 * prompt in flight for the current idle window.
 */
export function hasPendingWakePush(supervisorId: string): boolean {
  return pendingWakePush.has(supervisorId);
}

function logInbox(level: "info" | "warn", payload: Record<string, unknown>): void {
  process.stderr.write(
    `${JSON.stringify({ level, time: new Date().toISOString(), ...payload })}\n`,
  );
}

/**
 * Decide whether the live supervisor session is "idle" — i.e.,
 * not currently mid-turn. The SDK exposes `isStreaming`; that's a
 * stable proxy for "the agent loop is producing output right now."
 * A session that has never prompted is also idle.
 */
function isSupervisorIdle(supervisorId: string): boolean {
  const live = getSession(supervisorId);
  if (live === undefined) return false; // not live → no idle to push to
  // SDK exposes isStreaming as a getter on AgentSession.
  return live.session.isStreaming === false;
}

/**
 * Build the wake-up prompt text. Kept short — the prompt's only job
 * is to nudge the supervisor LLM to call `orchestrate_read_inbox`.
 * The bracket marker is also what the client UI uses to style the
 * message distinctly from a user message (recognised by the
 * `OrchestrationWakePrefix` constant exported below).
 */
export const ORCHESTRATION_WAKE_PREFIX = "[orchestration]";

function buildWakeText(pendingCount: number): string {
  return (
    `${ORCHESTRATION_WAKE_PREFIX} ${pendingCount} pending worker event(s). ` +
    `Call \`orchestrate_read_inbox\` to inspect, then decide whether to ` +
    `\`orchestrate_read_worker\`, \`orchestrate_send_to_worker\`, or take no action.`
  );
}

/**
 * Attempt to wake the supervisor with a tiny system-style prompt.
 * No-op if the supervisor is offline, busy, or already has an
 * in-flight push for this idle window.
 *
 * Returns true if a prompt was actually fired (used by tests).
 */
async function tryWakeSupervisor(supervisorId: string): Promise<boolean> {
  const live = getSession(supervisorId);
  if (live === undefined) return false;
  if (!isSupervisorIdle(supervisorId)) return false;
  if (pendingWakePush.has(supervisorId)) return false;
  const pending = await pendingInboxCount(supervisorId);
  if (pending === 0) return false;

  const seq = nextWakeCounter(supervisorId);
  pendingWakePush.set(supervisorId, seq);
  const text = buildWakeText(pending);
  logInbox("info", {
    msg: "orchestration-wake-started",
    supervisorId,
    pending,
    seq,
  });
  // Fire-and-forget. The SDK's session.prompt is async; we let it
  // run in the background so the event-bridge caller (often the
  // hot path of an AgentSessionEvent subscriber) returns
  // immediately. Errors are surfaced via stderr — most likely
  // cause is "no model configured on the supervisor session," in
  // which case the supervisor is unusable for orchestration
  // regardless and the operator needs to see why.
  live.session
    .prompt(text)
    .then(() => {
      const cleared = clearPendingWakeIfCurrent(supervisorId, seq);
      logInbox("info", {
        msg: "orchestration-wake-delivered",
        supervisorId,
        pending,
        seq,
        clearedPendingWake: cleared,
      });
      // Defense in depth: agent_end normally calls notifySupervisorIdle,
      // clears the same marker, and re-wakes when pending items remain.
      // Some SDK/extension failure paths can resolve/reject prompt()
      // without an agent_end; re-run the idle check here so async worker
      // completions do not get stranded behind a stale dedupe marker.
      void tryWakeSupervisor(supervisorId);
    })
    .catch((err: unknown) => {
      const cleared = clearPendingWakeIfCurrent(supervisorId, seq);
      logInbox("warn", {
        msg: "orchestration-wake-failed",
        supervisorId,
        pending,
        seq,
        clearedPendingWake: cleared,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  return true;
}

/**
 * Public entry point: a worker session emitted an interesting
 * event, route it to the right supervisor's inbox and try to
 * wake the supervisor.
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
  });
  logInbox("info", {
    msg: "orchestration-inbox-enqueued",
    supervisorId,
    workerId,
    type,
    itemId: item.id,
  });
  // Best-effort wake-up. tryWake handles its own debounce + offline
  // checks. We DON'T await — the worker event handler that called
  // us shouldn't block on the supervisor's LLM round-trip.
  void tryWakeSupervisor(supervisorId);
  return item;
}

/**
 * Called from session-registry when a supervisor's own session
 * emits `agent_end` — i.e., the supervisor just became idle.
 * Clears the per-idle-window dedupe flag and re-pushes if pending
 * items accumulated during the just-finished turn.
 *
 * This closes the "supervisor finished a turn without reading the
 * inbox" gap: if the supervisor's LLM ignored a prior wake-up (or
 * the wake-up arrived after the supervisor was already mid-turn),
 * this gives it one more nudge before going truly idle.
 */
export async function notifySupervisorIdle(supervisorId: string): Promise<void> {
  pendingWakePush.delete(supervisorId);
  void tryWakeSupervisor(supervisorId);
}

/**
 * Called from session-registry when a supervisor session is
 * disposed. Drops the dedupe flag so a future re-resume of the
 * same id can wake again from scratch.
 */
export function notifySupervisorDisposed(supervisorId: string): void {
  pendingWakePush.delete(supervisorId);
  wakeCounters.delete(supervisorId);
}

/**
 * Drain a supervisor's pending inbox items and mark them delivered.
 * The tool-side wrapper for `orchestrate_read_inbox`.
 */
export async function drainInbox(supervisorId: string): Promise<InboxItem[]> {
  return readPendingInbox(supervisorId, { markDelivered: true });
}

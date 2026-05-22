import { randomUUID } from "node:crypto";
import type { AskUserQuestionResult, Question } from "./types.js";

/**
 * In-memory registry of `ask_user_question` requests waiting on a
 * browser answer. The tool factory registers a pending entry, the
 * answer route resolves it, and the SSE bridge re-emits open
 * entries on snapshot so reconnect resurfaces the modal.
 *
 * Single-process state — pi-forge is single-tenant by design, no
 * cross-process synchronisation needed. The Map is keyed by
 * requestId (uuid). A secondary index by sessionId keeps the
 * "list pending for this session" lookup O(1).
 */

export interface PendingAskUserQuestion {
  requestId: string;
  sessionId: string;
  questions: Question[];
  createdAt: Date;
}

interface Entry extends PendingAskUserQuestion {
  resolve: (result: AskUserQuestionResult) => void;
}

const byRequestId = new Map<string, Entry>();
const bySessionId = new Map<string, Set<string>>();

/**
 * Listener fanout. SSE bridge registers a listener so it can
 * forward `ask_user_question` / `ask_user_question_cancelled`
 * frames to every live client of the affected session.
 *
 * Per-session fanout is implemented at the SSE bridge layer — this
 * module just notifies "something changed for this session, here's
 * what." Keeps the registry decoupled from FastifyReply/socket
 * concerns.
 */
type Listener = (event: AskQuestionEvent) => void;
const listeners = new Set<Listener>();

export type AskQuestionEvent =
  | { type: "ask_user_question"; sessionId: string; requestId: string; questions: Question[] }
  | { type: "ask_user_question_cancelled"; sessionId: string; requestId: string; reason: string };

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(event: AskQuestionEvent): void {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // listener errors must not break the registry — best-effort fanout
    }
  }
}

/**
 * Register a pending request. The returned promise resolves when
 * the browser answers, or when the caller's `signal` aborts (in
 * which case the tool result will be a cancelled envelope built by
 * the caller).
 *
 * `signal` is honored: if the agent is aborted (e.g. user hit Stop)
 * the entry is dropped and the promise rejects with an
 * `AbortError`. The caller catches that and returns the cancelled
 * envelope so the agent sees a clean tool result.
 */
export function registerPending(args: {
  sessionId: string;
  questions: Question[];
  signal?: AbortSignal;
}): { requestId: string; result: Promise<AskUserQuestionResult> } {
  const requestId = randomUUID();
  let resolveFn!: (r: AskUserQuestionResult) => void;
  let rejectFn!: (err: Error) => void;
  const result = new Promise<AskUserQuestionResult>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  const entry: Entry = {
    requestId,
    sessionId: args.sessionId,
    questions: args.questions,
    createdAt: new Date(),
    resolve: resolveFn,
  };
  byRequestId.set(requestId, entry);
  const set = bySessionId.get(args.sessionId) ?? new Set<string>();
  set.add(requestId);
  bySessionId.set(args.sessionId, set);

  if (args.signal !== undefined) {
    const onAbort = (): void => {
      // Drop the entry and tell SSE clients to close the modal.
      // The tool's execute() catches the rejection and returns a
      // cancelled envelope to the agent.
      if (byRequestId.has(requestId)) {
        removeEntry(requestId);
        notify({
          type: "ask_user_question_cancelled",
          sessionId: args.sessionId,
          requestId,
          reason: "aborted",
        });
        rejectFn(new Error("aborted"));
      }
    };
    if (args.signal.aborted) onAbort();
    else args.signal.addEventListener("abort", onAbort, { once: true });
  }

  notify({
    type: "ask_user_question",
    sessionId: args.sessionId,
    requestId,
    questions: args.questions,
  });
  return { requestId, result };
}

function removeEntry(requestId: string): void {
  const e = byRequestId.get(requestId);
  if (e === undefined) return;
  byRequestId.delete(requestId);
  const set = bySessionId.get(e.sessionId);
  if (set !== undefined) {
    set.delete(requestId);
    if (set.size === 0) bySessionId.delete(e.sessionId);
  }
}

/**
 * Resolve the pending entry with the user's answers. Idempotent —
 * if the entry was already resolved (e.g. concurrent answer +
 * abort race), this returns `false` rather than throwing so the
 * route layer can decide whether to 200 or 404.
 */
export function answerPending(
  requestId: string,
  expectedSessionId: string,
  result: AskUserQuestionResult,
): boolean {
  const e = byRequestId.get(requestId);
  if (e === undefined) return false;
  if (e.sessionId !== expectedSessionId) return false;
  removeEntry(requestId);
  // SSE clients listen for "the modal should now close" — emit a
  // cancelled event with reason "answered" so the modal tears down
  // on every other browser tab watching the same session.
  notify({
    type: "ask_user_question_cancelled",
    sessionId: e.sessionId,
    requestId,
    reason: "answered",
  });
  e.resolve(result);
  return true;
}

/**
 * Explicit cancel from the client side (user clicked "Chat about
 * this" or closed the modal). Same shape as answer, but the
 * caller-supplied envelope carries `cancelled: true` and an
 * empty `answers` array — or partial answers if the user filled
 * some tabs before bailing.
 */
export function cancelPending(
  requestId: string,
  expectedSessionId: string,
  result: AskUserQuestionResult,
): boolean {
  // Same path as answerPending — the distinction is in the envelope
  // shape, not the registry mechanics.
  return answerPending(requestId, expectedSessionId, result);
}

export function getPendingForSession(sessionId: string): PendingAskUserQuestion[] {
  const ids = bySessionId.get(sessionId);
  if (ids === undefined) return [];
  const out: PendingAskUserQuestion[] = [];
  for (const id of ids) {
    const e = byRequestId.get(id);
    if (e !== undefined) {
      out.push({
        requestId: e.requestId,
        sessionId: e.sessionId,
        questions: e.questions,
        createdAt: e.createdAt,
      });
    }
  }
  return out;
}

/**
 * Test-only reset. Clears all pending state without notifying
 * listeners — call between integration test cases to avoid
 * cross-contamination.
 */
export function _resetForTests(): void {
  byRequestId.clear();
  bySessionId.clear();
  listeners.clear();
}

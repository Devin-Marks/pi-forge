import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { replayFromBranch } from "./replay.js";
import { EMPTY_STATE, type TaskState } from "./types.js";

/**
 * Per-session in-memory cache of the latest committed TaskState.
 * The branch IS the source of truth (see replay.ts) — this cache
 * is a fast-path for read-heavy consumers (SSE snapshots, the UI
 * panel's initial fetch). On any cache miss we recompute from the
 * branch, so a stale or evicted cache cannot lie.
 *
 * Keyed by sessionId. Cleared on dispose by `clearForSession`
 * (called from session-registry's dispose path).
 */
const cacheBySession = new Map<string, TaskState>();

/**
 * Per-session change-listener fanout. SSE bridge subscribes once at
 * boot; on every `todo` tool call we notify with `{sessionId, state}`
 * so live clients of that session get a `todo_update` event.
 */
type Listener = (event: { sessionId: string; state: TaskState }) => void;
const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notify(sessionId: string, state: TaskState): void {
  for (const fn of listeners) {
    try {
      fn({ sessionId, state });
    } catch {
      // Listener errors must not break the registry — best-effort fanout.
    }
  }
}

/**
 * Get the current state for a session. Cache-first; on miss we
 * replay the branch and populate the cache. Always returns a
 * defensive copy so callers can't mutate the cached tasks array.
 */
export function getState(sessionId: string, sessionManager: SessionManager): TaskState {
  const cached = cacheBySession.get(sessionId);
  if (cached !== undefined) {
    return { tasks: cached.tasks.map((t) => ({ ...t })), nextId: cached.nextId };
  }
  const replayed = replayFromBranch(sessionManager);
  cacheBySession.set(sessionId, replayed);
  return { tasks: replayed.tasks.map((t) => ({ ...t })), nextId: replayed.nextId };
}

/**
 * Commit a new state for a session and fan out the change. The
 * reducer is pure; persistence happens via two channels:
 *  1. The agent's tool-result envelope (carries `details.tasks`)
 *     becomes part of the session JSONL, which is what `replay.ts`
 *     reads on restart / fork / compaction.
 *  2. This cache, for fast SSE / route reads between tool calls.
 */
export function commitState(sessionId: string, state: TaskState): void {
  cacheBySession.set(sessionId, state);
  notify(sessionId, state);
}

/**
 * Force a re-read from the branch and update the cache. Called by
 * lifecycle hooks (resume, fork, compact) so the cache reflects the
 * authoritative source after the message tree changes. Also called
 * by GET /todos on cache miss.
 */
export function refreshFromBranch(sessionId: string, sessionManager: SessionManager): TaskState {
  const fresh = replayFromBranch(sessionManager);
  cacheBySession.set(sessionId, fresh);
  notify(sessionId, fresh);
  return fresh;
}

export function clearForSession(sessionId: string): void {
  cacheBySession.delete(sessionId);
}

/**
 * Read-only peek for the SSE bridge's snapshot path. Returns the
 * cached state if present, or EMPTY_STATE if not — the snapshot
 * caller doesn't have a sessionManager handy and a cache miss just
 * means "no todos to re-deliver." Routes that NEED accuracy go
 * through `getState` (which replays from the branch).
 */
export function peekCached(sessionId: string): TaskState {
  const cached = cacheBySession.get(sessionId);
  if (cached === undefined) return EMPTY_STATE;
  return { tasks: cached.tasks.map((t) => ({ ...t })), nextId: cached.nextId };
}

/**
 * Test-only: drop everything. Listeners are NOT cleared (the SSE
 * bridge's subscription is process-lifetime).
 */
export function _resetForTests(): void {
  cacheBySession.clear();
}

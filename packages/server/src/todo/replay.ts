import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { EMPTY_STATE, TOOL_NAME, type TaskDetails, type TaskState } from "./types.js";

/**
 * Discriminator for `details` envelopes that match the persisted
 * `TaskDetails` shape. Defensive — branch entries from older or
 * corrupt sessions are skipped silently rather than crashing the
 * replay walk.
 */
export function isTaskDetails(value: unknown): value is TaskDetails {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.tasks) && typeof v.nextId === "number";
}

/**
 * Walk the session's current branch in chronological order; the
 * LAST `toolResult` whose `toolName === TOOL_NAME` and whose
 * `details` matches `TaskDetails` wins (last-write-wins). When no
 * matching entry exists, returns EMPTY_STATE.
 *
 * This is the SOURCE OF TRUTH for state across server restarts,
 * forks, and compaction. The in-memory store cache is just a
 * fast-path; resume always re-derives from the branch so a stale
 * cache cannot lie to the user.
 *
 * Pure — does not touch the store cell. Callers commit the
 * returned snapshot themselves.
 */
export function replayFromBranch(sessionManager: SessionManager): TaskState {
  let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
  for (const entry of sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message as { role?: string; toolName?: string; details?: unknown };
    if (msg.role !== "toolResult" || msg.toolName !== TOOL_NAME) continue;
    if (!isTaskDetails(msg.details)) continue;
    result = {
      tasks: msg.details.tasks.map((t) => ({ ...t })),
      nextId: msg.details.nextId,
    };
  }
  return result;
}

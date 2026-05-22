import type { TaskStatus } from "./types.js";

/**
 * Allowed forward transitions per source status. `completed` is
 * one-way to `deleted` (never back to `in_progress` or `pending`)
 * because re-opening a finished task with the same id loses the
 * semantic that "done means done"; `deleted` is terminal (tombstone).
 *
 * Idempotent same→same transitions are accepted in
 * `isTransitionValid` so this table only enumerates actual moves.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  pending: new Set(["in_progress", "completed", "deleted"]),
  in_progress: new Set(["pending", "completed", "deleted"]),
  completed: new Set(["deleted"]),
  deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from].has(to);
}

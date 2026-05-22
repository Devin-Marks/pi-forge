import { create } from "zustand";

/**
 * Client-side mirror of the server's todo state, keyed by sessionId.
 * Populated two ways:
 *   - SSE `todo_update` event (live, after every successful tool call)
 *   - Initial `GET /sessions/:id/todos` fetch (cold load, before the
 *     SSE snapshot lands)
 *
 * Both paths produce the same wire shape `{tasks, nextId}`.
 */

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

export interface TodoState {
  tasks: Task[];
  nextId: number;
}

const EMPTY: TodoState = { tasks: [], nextId: 1 };

interface TodoStoreState {
  byId: Record<string, TodoState>;
  set: (sessionId: string, state: TodoState) => void;
  clear: (sessionId: string) => void;
}

export const useTodoStore = create<TodoStoreState>((set) => ({
  byId: {},
  set: (sessionId, state) => set((s) => ({ byId: { ...s.byId, [sessionId]: state } })),
  clear: (sessionId) =>
    set((s) => {
      const next = { ...s.byId };
      delete next[sessionId];
      return { byId: next };
    }),
}));

/**
 * Selector — returns EMPTY (stable module-level constant) for sessions
 * without a tracked state. Components can use this without worrying
 * about useSyncExternalStore stability checks.
 */
export function selectTodoState(state: TodoStoreState, sessionId: string | undefined): TodoState {
  if (sessionId === undefined) return EMPTY;
  return state.byId[sessionId] ?? EMPTY;
}

/**
 * Returns counts of visible (non-deleted) tasks. The toggle icon
 * uses this for its progress badge.
 */
export interface TodoCounts {
  pending: number;
  inProgress: number;
  completed: number;
  total: number;
}

export function deriveCounts(state: TodoState): TodoCounts {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of state.tasks) {
    if (t.status === "pending") pending += 1;
    else if (t.status === "in_progress") inProgress += 1;
    else if (t.status === "completed") completed += 1;
  }
  return {
    pending,
    inProgress,
    completed,
    total: pending + inProgress + completed,
  };
}

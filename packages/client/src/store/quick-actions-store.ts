import { create } from "zustand";
import { api, ApiError } from "../lib/api-client";
import type { QuickAction, QuickActionRunResult } from "../lib/api-client";

/**
 * Global quick-action registry — fetched once on app boot and on
 * settings-panel save. List order from the server = display order
 * in the chip dropdown.
 *
 * Run results are NOT held here: they're owned by `runs-store` so
 * the chat-view inline card can mount/unmount independently of
 * whether the menu is open.
 */
interface QuickActionsState {
  loaded: boolean;
  actions: QuickAction[];
  error: string | undefined;
  load: () => Promise<void>;
  create: (body: Omit<QuickAction, "id">) => Promise<QuickAction>;
  update: (id: string, body: Omit<QuickAction, "id">) => Promise<QuickAction>;
  remove: (id: string) => Promise<void>;
}

export const useQuickActionsStore = create<QuickActionsState>((set, get) => ({
  loaded: false,
  actions: [],
  error: undefined,
  load: async () => {
    try {
      const { actions } = await api.listQuickActions();
      set({ loaded: true, actions, error: undefined });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      if (typeof console !== "undefined") {
        console.warn("[quick-actions] load failed:", code);
      }
      // Failure leaves loaded=false so the menu never appears — better
      // than showing an empty Actions chip that can't be acted on.
      set({ error: code });
    }
  },
  create: async (body) => {
    const created = await api.createQuickAction(body);
    set({ actions: [...get().actions, created] });
    return created;
  },
  update: async (id, body) => {
    const updated = await api.updateQuickAction(id, body);
    set({ actions: get().actions.map((a) => (a.id === id ? updated : a)) });
    return updated;
  },
  remove: async (id) => {
    await api.deleteQuickAction(id);
    set({ actions: get().actions.filter((a) => a.id !== id) });
  },
}));

/**
 * In-flight + completed runs for the chat view's inline cards. Keyed
 * by a per-click `runId` (uuid) — NOT by the action id — so two
 * concurrent clicks of the same chip each get their own card.
 *
 * Runs are scoped to a session: switching to a different session
 * removes the runs from view (still in the store; harmless). The
 * chat view filters by `sessionId`.
 */
export interface QuickActionRun {
  runId: string;
  sessionId: string;
  actionId: string;
  actionName: string;
  startedAt: number;
  /** Monotonic tie-breaker for runs started in the same millisecond. */
  timelineOrder: number;
  status: "running" | "done" | "aborted";
  result?: QuickActionRunResult;
  error?: string;
  abort: () => void;
}

interface RunsState {
  runs: QuickActionRun[];
  addRun: (run: QuickActionRun) => void;
  updateRun: (runId: string, patch: Partial<QuickActionRun>) => void;
  removeRun: (runId: string) => void;
  /** All runs for a session, oldest first (matches scroll order). */
  runsForSession: (sessionId: string) => QuickActionRun[];
}

export const useQuickActionRunsStore = create<RunsState>((set, get) => ({
  runs: [],
  addRun: (run) => set({ runs: [...get().runs, run] }),
  updateRun: (runId, patch) =>
    set({ runs: get().runs.map((r) => (r.runId === runId ? { ...r, ...patch } : r)) }),
  removeRun: (runId) => set({ runs: get().runs.filter((r) => r.runId !== runId) }),
  runsForSession: (sessionId) => get().runs.filter((r) => r.sessionId === sessionId),
}));

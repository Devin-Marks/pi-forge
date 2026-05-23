import { create } from "zustand";

/**
 * Client-side mirror of the server's per-session processes list.
 * Populated two ways:
 *   - SSE `process_update` event (full snapshot on every
 *     lifecycle change + re-emit on snapshot connect)
 *   - Initial `GET /sessions/:id/processes` (cold-load fallback)
 *
 * `process_output` SSE event signals "this process's tail
 * changed" — the panel's "view recent output" disclosure refetches
 * on a debounce when it's the focused process. We don't push the
 * output payload over SSE to avoid flooding for chatty processes.
 *
 * `process_watch` SSE event carries log-watch match metadata; the
 * panel surfaces a small alert badge per process when a watch
 * fires (single-fire watches show one badge; repeat watches
 * increment a count). Match-event log is in-memory only.
 */

export type ProcessStatus = "running" | "terminating" | "terminate_timeout" | "exited" | "killed";

export interface ProcessInfo {
  id: string;
  name: string;
  pid: number;
  command: string;
  cwd: string;
  startTime: number;
  endTime: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  success: boolean | null;
  stdoutFile: string;
  stderrFile: string;
  alertOnSuccess: boolean;
  alertOnFailure: boolean;
  alertOnKill: boolean;
}

export const LIVE_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  "running",
  "terminating",
  "terminate_timeout",
]);

export interface WatchMatch {
  processId: string;
  processName: string;
  source: "stdout" | "stderr";
  line: string;
  pattern: string;
  /** Receive-side timestamp; the server doesn't send one. */
  at: number;
}

interface StoreState {
  /** Keyed by sessionId. */
  bySession: Record<string, ProcessInfo[]>;
  /** Keyed by sessionId; oldest evicted at WATCH_LOG_CAP. */
  watchesBySession: Record<string, WatchMatch[]>;
  setProcesses: (sessionId: string, processes: ProcessInfo[]) => void;
  pushWatch: (sessionId: string, match: WatchMatch) => void;
  clearWatches: (sessionId: string) => void;
}

const WATCH_LOG_CAP = 50;
const EMPTY_PROCESSES: ProcessInfo[] = [];
const EMPTY_WATCHES: WatchMatch[] = [];

export const useProcessesStore = create<StoreState>((set) => ({
  bySession: {},
  watchesBySession: {},
  setProcesses: (sessionId, processes) =>
    set((s) => ({ bySession: { ...s.bySession, [sessionId]: processes } })),
  pushWatch: (sessionId, match) =>
    set((s) => {
      const existing = s.watchesBySession[sessionId] ?? [];
      const next = [...existing, match];
      if (next.length > WATCH_LOG_CAP) next.splice(0, next.length - WATCH_LOG_CAP);
      return { watchesBySession: { ...s.watchesBySession, [sessionId]: next } };
    }),
  clearWatches: (sessionId) =>
    set((s) => {
      const next = { ...s.watchesBySession };
      delete next[sessionId];
      return { watchesBySession: next };
    }),
}));

export function selectProcesses(state: StoreState, sessionId: string | undefined): ProcessInfo[] {
  if (sessionId === undefined) return EMPTY_PROCESSES;
  return state.bySession[sessionId] ?? EMPTY_PROCESSES;
}

export function selectWatches(state: StoreState, sessionId: string | undefined): WatchMatch[] {
  if (sessionId === undefined) return EMPTY_WATCHES;
  return state.watchesBySession[sessionId] ?? EMPTY_WATCHES;
}

export function countRunning(processes: readonly ProcessInfo[]): number {
  let n = 0;
  for (const p of processes) if (LIVE_STATUSES.has(p.status)) n += 1;
  return n;
}

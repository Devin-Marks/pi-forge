import { create } from "zustand";

/**
 * Client-side state for the `ask_user_question` tool.
 *
 * Server emits `ask_user_question` over SSE when the agent invokes
 * the tool; the modal mounts. On answer / cancel / abort the server
 * emits `ask_user_question_cancelled` (any reason) and the modal
 * tears down. One pending entry per session — the plugin's tool
 * contract bans back-to-back invocations, and the SDK serialises
 * tool calls per session, so we never see more than one
 * outstanding at a time.
 */

export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface PendingAskQuestion {
  requestId: string;
  sessionId: string;
  questions: AskQuestion[];
}

interface AskUserQuestionState {
  /** Keyed by sessionId. Only one pending per session at a time. */
  pendingBySession: Record<string, PendingAskQuestion | undefined>;
  setPending: (pending: PendingAskQuestion) => void;
  clearPending: (sessionId: string, requestId?: string) => void;
}

export const useAskUserQuestionStore = create<AskUserQuestionState>((set, get) => ({
  pendingBySession: {},
  setPending: (pending) =>
    set((s) => ({ pendingBySession: { ...s.pendingBySession, [pending.sessionId]: pending } })),
  clearPending: (sessionId, requestId) => {
    const cur = get().pendingBySession[sessionId];
    // No-op if the stored entry is for a different requestId — the
    // server may have already advanced to a new question and a stale
    // cancel arriving late shouldn't blank it.
    if (cur === undefined) return;
    if (requestId !== undefined && cur.requestId !== requestId) return;
    set((s) => ({ pendingBySession: { ...s.pendingBySession, [sessionId]: undefined } }));
  },
}));

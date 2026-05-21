import { create } from "zustand";

/**
 * One-shot bridge from "something else" (quick-action prompt chips,
 * the "Use as context" button on run cards, …) into the chat
 * composer. The `ChatInput` component subscribes via effect: when
 * `pendingInsert` flips to a non-null value, it appends to its
 * textarea, focuses, then calls `consumePendingInsert()` so the
 * same value isn't reinserted on re-render.
 *
 * Scoped by sessionId so a stale insert from session A doesn't land
 * in session B when the user switches tabs before the composer mount
 * fires.
 */
interface PendingInsert {
  sessionId: string;
  text: string;
}

interface ComposerState {
  pendingInsert: PendingInsert | undefined;
  setPendingInsert: (sessionId: string, text: string) => void;
  consumePendingInsert: () => void;
}

export const useComposerStore = create<ComposerState>((set) => ({
  pendingInsert: undefined,
  setPendingInsert: (sessionId, text) => set({ pendingInsert: { sessionId, text } }),
  consumePendingInsert: () => set({ pendingInsert: undefined }),
}));

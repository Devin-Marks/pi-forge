import { create } from "zustand";

/**
 * Ephemeral client-side UI state shared across components that don't
 * have a direct parent/child relationship. Today this is just the
 * Settings-panel open-and-target-tab signal — the chat input's `/`
 * commands need to ask App.tsx to open Settings to a specific tab,
 * and the McpStatusBadge wants the same opening affordance. A
 * dedicated store keeps the contract narrow: every consumer reads
 * `settingsRequest` and clears it after handling.
 *
 * Distinct from `ui-config-store` (server-driven, MINIMAL_UI etc.)
 * and from `auth-store` (auth/session lifecycle). Future runtime UI
 * state belongs here too.
 */

export type SettingsTab = "providers" | "agent" | "mcp" | "skills" | "appearance";

interface SettingsRequest {
  /** Optional tab to switch to on open. Undefined = leave the
   *  panel's last tab alone. */
  tab?: SettingsTab;
  /** Monotonic counter so the SAME open-to-tab call can fire twice
   *  in a row. Without this, requesting the already-open tab would
   *  produce no state change and the panel listener wouldn't react.
   *  The listener tracks the last seen seq and reacts on any
   *  increment. */
  seq: number;
}

/** Cross-component request to append text into the active chat input.
 *  Today only `Add as @ context` from the file-browser context menu
 *  uses it; future quick-actions (slash commands from elsewhere, etc.)
 *  can ride the same channel. The chat input listens, appends on every
 *  seq increment, and calls `clearChatInsertRequest` to reset. */
interface ChatInsertRequest {
  /** Text to append; `@<path>` for the current consumer. */
  text: string;
  /** Monotonic counter so two consecutive requests with the same text
   *  still fire (matches the SettingsRequest seq pattern). */
  seq: number;
}

interface UiState {
  settingsRequest: SettingsRequest | undefined;
  /** Open the Settings panel; optionally jump to a specific tab. */
  openSettings: (tab?: SettingsTab) => void;
  clearSettingsRequest: () => void;
  chatInsertRequest: ChatInsertRequest | undefined;
  /** Ask the chat input to append text (no leading newline; the input
   *  decides spacing based on its current contents). */
  requestChatInsert: (text: string) => void;
  clearChatInsertRequest: () => void;
  /**
   * Monotonic counters feeding the `seq` field on cross-component
   * requests. These NEVER reset on `clear*` — that's the whole point.
   *
   * Why they exist: an earlier version derived the next seq as
   * `prev = currentRequest?.seq ?? 0; next = prev + 1`. After a
   * consumer cleared the request slot to `undefined`, that read
   * snapped back to 0, so the second request also got `seq = 1` and
   * the consumer's `lastSeenSeq` ratchet (also at 1) silently
   * dropped it. Symptom: "Add as @ context sometimes doesn't work."
   * The ratchet now lives on the producer side and survives clears.
   *
   * Underscore prefix is convention for "internal state — don't read
   * from components." Per-channel counters (rather than a single
   * shared one) keep each consumer's local lastSeen monotonic
   * without surprising jumps when an unrelated channel fires.
   */
  _settingsSeq: number;
  _chatInsertSeq: number;
}

export const useUiStore = create<UiState>((set, get) => ({
  settingsRequest: undefined,
  _settingsSeq: 0,
  openSettings: (tab) => {
    const seq = get()._settingsSeq + 1;
    const req: SettingsRequest = { seq };
    if (tab !== undefined) req.tab = tab;
    set({ _settingsSeq: seq, settingsRequest: req });
  },
  clearSettingsRequest: () => {
    set({ settingsRequest: undefined });
  },
  chatInsertRequest: undefined,
  _chatInsertSeq: 0,
  requestChatInsert: (text) => {
    const seq = get()._chatInsertSeq + 1;
    set({ _chatInsertSeq: seq, chatInsertRequest: { text, seq } });
  },
  clearChatInsertRequest: () => {
    set({ chatInsertRequest: undefined });
  },
}));

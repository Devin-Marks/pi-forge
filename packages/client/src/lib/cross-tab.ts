/**
 * Typed BroadcastChannel wrapper for cross-browser-tab signals.
 *
 * Use case: tab A mutates shared state (creates a session, deletes
 * one, renames one) and tabs B/C need to reflect that immediately
 * without polling the server. Server-side state IS the source of
 * truth — broadcasts are pure UI hints that "something you cached
 * changed; reflect it." A tab that misses a broadcast (e.g. because
 * the user opened it after the broadcast fired) recovers on the
 * next natural refetch path (session list reload, SSE 404 catch,
 * etc.). Don't depend on broadcasts for correctness.
 *
 * Single channel per origin — `pi-forge`. Senders include
 * `from` (a per-tab id generated at module load) so a tab can ignore
 * its own broadcasts: BroadcastChannel delivers to every listener
 * INCLUDING other listeners in the same tab, but NOT back to the
 * sending channel — except some browsers / contexts do echo. Belt
 * and suspenders.
 */

import { createClientId } from "./client-id";

const CHANNEL_NAME = "pi-forge";

/**
 * A serializable UnifiedSession-shaped payload. Kept structural here
 * (`Record<string, unknown>`) rather than importing the full
 * UnifiedSession type so cross-tab.ts stays a leaf dependency. The
 * subscriber re-validates fields it cares about.
 */
type SessionPayload = Record<string, unknown>;

export type CrossTabMessage =
  | { type: "session_created"; projectId: string; session: SessionPayload }
  | { type: "session_deleted"; projectId: string; sessionId: string }
  | { type: "session_renamed"; sessionId: string; name: string | undefined };

interface Envelope {
  /** Per-tab id so a tab can drop echoes of its own broadcasts. */
  from: string;
  msg: CrossTabMessage;
}

const TAB_ID = createClientId("tab");

let channel: BroadcastChannel | undefined;
function getChannel(): BroadcastChannel | undefined {
  if (channel !== undefined) return channel;
  // BroadcastChannel is in all modern browsers but absent in some
  // test environments and very old Safari. Skip silently rather
  // than crashing — losing cross-tab updates is graceful degradation.
  if (typeof BroadcastChannel === "undefined") return undefined;
  channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

/** Post a message to every other browser tab on this origin. */
export function postCrossTab(msg: CrossTabMessage): void {
  const ch = getChannel();
  if (ch === undefined) return;
  const env: Envelope = { from: TAB_ID, msg };
  try {
    ch.postMessage(env);
  } catch {
    // Channel closed or unavailable — recovery happens on next
    // natural refetch path.
  }
}

/**
 * Subscribe to cross-tab messages. Returns an unsubscribe function.
 * Drops messages from the current tab (echoes) so the same handler
 * can publish + subscribe without re-processing its own actions.
 */
export function subscribeCrossTab(handler: (msg: CrossTabMessage) => void): () => void {
  const ch = getChannel();
  if (ch === undefined) return () => undefined;
  const listener = (event: MessageEvent<Envelope>): void => {
    const env = event.data;
    if (env === null || typeof env !== "object") return;
    if (env.from === TAB_ID) return; // echo
    if (typeof env.msg !== "object" || env.msg === null) return;
    handler(env.msg);
  };
  ch.addEventListener("message", listener);
  return () => ch.removeEventListener("message", listener);
}

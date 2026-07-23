export interface ChatTimelinePosition {
  /** Unix epoch ms captured when this transient item entered the chat. */
  timestamp: number;
  /** Monotonic in-browser tie-breaker for items received in the same millisecond. */
  order: number;
}

let nextTimelineOrder = 0;

/**
 * Give transient chat items a stable position without changing Pi's canonical
 * transcript. `order` makes same-millisecond SSE events deterministic.
 */
export function createChatTimelinePosition(timestamp = Date.now()): ChatTimelinePosition {
  return { timestamp, order: nextTimelineOrder++ };
}

type TimestampedMessage = Record<string, unknown>;

/**
 * Place transient items between canonical messages using their receipt time.
 * Canonical messages remain in transcript order; items with equal timestamps
 * follow the canonical message, matching the order in which SSE delivers it.
 */
export function placeChatTimelineItems<T>(
  messages: readonly TimestampedMessage[],
  items: readonly { item: T; position: ChatTimelinePosition }[],
): T[][] {
  const slots = Array.from({ length: messages.length + 1 }, () => [] as T[]);
  const sorted = items
    .map((entry, inputOrder) => ({ ...entry, inputOrder }))
    .sort(
      (a, b) =>
        a.position.timestamp - b.position.timestamp ||
        a.position.order - b.position.order ||
        a.inputOrder - b.inputOrder,
    );

  for (const entry of sorted) {
    const nextMessageIndex = messages.findIndex((message) => {
      const timestamp = message.timestamp;
      return typeof timestamp === "number" && timestamp > entry.position.timestamp;
    });
    slots[nextMessageIndex === -1 ? messages.length : nextMessageIndex]!.push(entry.item);
  }
  return slots;
}

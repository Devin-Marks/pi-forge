export {};

const values = new Map<string, string>();
// session-store subscribes to cross-tab updates at module load. Disable Node's
// BroadcastChannel so its open MessagePort cannot keep this focused test alive.
Object.defineProperty(globalThis, "BroadcastChannel", { configurable: true, value: undefined });
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
    removeItem: (key: string): void => {
      values.delete(key);
    },
  },
});

const { useSessionStore } = await import("../packages/client/src/store/session-store");
const { placeChatTimelineItems } = await import("../packages/client/src/lib/chat-timeline");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

const sessionId = "extension-notification-session";
const canonicalMessages = [
  { role: "user", content: "Canonical Pi transcript entry one", timestamp: 1_000 },
  { role: "assistant", content: "Canonical Pi transcript entry two", timestamp: 3_000 },
];
useSessionStore.setState({
  bannerBySession: { [sessionId]: "Retrying (attempt 1)" },
  messagesBySession: { [sessionId]: canonicalMessages },
});

const store = useSessionStore.getState();
const realDateNow = Date.now;
let receivedAt = 2_000;
Date.now = () => receivedAt;
try {
  store.enqueueExtensionUiNotification(sessionId, {
    message: "**Interactive dialog unavailable.** Use the [attachment button](#upload).",
    level: "warning",
  });
  receivedAt = 2_500;
  store.enqueueExtensionUiNotification(sessionId, {
    message: "Command feedback: normal",
    level: "info",
  });
  receivedAt = 2_750;
  store.enqueueExtensionUiNotification(sessionId, {
    message: "Command feedback: failed",
    level: "error",
  });
} finally {
  Date.now = realDateNow;
}

let notifications = useSessionStore.getState().extensionNotificationsBySession[sessionId] ?? [];
assert(
  "keeps info, warning, and error extension feedback in arrival order",
  notifications.length === 3 &&
    notifications[0]?.level === "warning" &&
    notifications[0]?.receivedAt === 2_000 &&
    notifications[0]?.message.includes("**Interactive dialog unavailable.**") &&
    notifications[1]?.level === "info" &&
    notifications[1]?.receivedAt === 2_500 &&
    notifications[1]?.arrivalOrder > (notifications[0]?.arrivalOrder ?? Number.MAX_SAFE_INTEGER) &&
    notifications[1]?.message === "Command feedback: normal" &&
    notifications[2]?.level === "error" &&
    notifications[2]?.receivedAt === 2_750 &&
    notifications[2]?.arrivalOrder > (notifications[1]?.arrivalOrder ?? Number.MAX_SAFE_INTEGER) &&
    notifications[2]?.message === "Command feedback: failed",
  JSON.stringify(notifications),
);
assert(
  "does not overwrite the existing session banner",
  useSessionStore.getState().bannerBySession[sessionId] === "Retrying (attempt 1)",
);
assert(
  "places extension feedback received between canonical entries between those entries",
  placeChatTimelineItems(
    canonicalMessages,
    notifications.map((notification) => ({
      item: notification.message,
      position: { timestamp: notification.receivedAt, order: notification.arrivalOrder },
    })),
  )[1]?.join(" | ") ===
    "**Interactive dialog unavailable.** Use the [attachment button](#upload). | Command feedback: normal | Command feedback: failed",
);
assert(
  "orders extension feedback with streaming, queued, and quick-action entries",
  placeChatTimelineItems(canonicalMessages, [
    { item: "streaming", position: { timestamp: 1_500, order: 1 } },
    {
      item: "extension",
      position: {
        timestamp: notifications[0]?.receivedAt ?? 0,
        order: notifications[0]?.arrivalOrder ?? 0,
      },
    },
    { item: "queued", position: { timestamp: 2_250, order: 3 } },
    { item: "quick-action", position: { timestamp: 2_900, order: 4 } },
  ])[1]?.join(" | ") === "streaming | extension | queued | quick-action",
);
assert(
  "does not add transient extension feedback to the canonical Pi transcript",
  useSessionStore.getState().messagesBySession[sessionId] === canonicalMessages &&
    useSessionStore.getState().messagesBySession[sessionId]?.length === 2,
  JSON.stringify(useSessionStore.getState().messagesBySession[sessionId]),
);

useSessionStore.getState().dismissExtensionUiNotification(sessionId, notifications[0]?.id);
notifications = useSessionStore.getState().extensionNotificationsBySession[sessionId] ?? [];
assert(
  "dismissing one notification preserves the remaining feedback",
  notifications.length === 2 &&
    notifications[0]?.message === "Command feedback: normal" &&
    notifications[1]?.message === "Command feedback: failed",
  JSON.stringify(notifications),
);

useSessionStore.getState().dismissExtensionUiNotification(sessionId, notifications[0]?.id);
notifications = useSessionStore.getState().extensionNotificationsBySession[sessionId] ?? [];
assert(
  "dismissing the next notification preserves later feedback",
  notifications.length === 1 && notifications[0]?.message === "Command feedback: failed",
  JSON.stringify(notifications),
);

useSessionStore.getState().dismissExtensionUiNotification(sessionId, notifications[0]?.id);
assert(
  "explicitly dismissing the final notification clears its queue",
  useSessionStore.getState().extensionNotificationsBySession[sessionId] === undefined,
);

if (failures > 0) process.exit(1);
console.log("[test-extension-ui-notifications] PASS");

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

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`PASS ${label}`);
  else {
    failures += 1;
    console.error(`FAIL ${label}${detail === undefined ? "" : `: ${detail}`}`);
  }
}

const sessionId = "extension-notification-session";
useSessionStore.setState({ bannerBySession: { [sessionId]: "Retrying (attempt 1)" } });

const store = useSessionStore.getState();
store.enqueueExtensionUiNotification(sessionId, {
  message: "This extension requested an interactive dialog, which Pi Forge does not support.",
  level: "warning",
});
store.enqueueExtensionUiNotification(sessionId, {
  message: "Command feedback: normal",
  level: "info",
});

let notifications = useSessionStore.getState().extensionNotificationsBySession[sessionId] ?? [];
assert(
  "queues consecutive extension notifications in arrival order",
  notifications.length === 2 &&
    notifications[0]?.level === "warning" &&
    notifications[1]?.message === "Command feedback: normal",
  JSON.stringify(notifications),
);
assert(
  "does not overwrite the existing session banner",
  useSessionStore.getState().bannerBySession[sessionId] === "Retrying (attempt 1)",
);

useSessionStore.getState().dismissExtensionUiNotification(sessionId);
notifications = useSessionStore.getState().extensionNotificationsBySession[sessionId] ?? [];
assert(
  "dismissing the visible notification advances to the next notification",
  notifications.length === 1 && notifications[0]?.message === "Command feedback: normal",
  JSON.stringify(notifications),
);

useSessionStore.getState().dismissExtensionUiNotification(sessionId);
assert(
  "dismissing the final notification clears its queue",
  useSessionStore.getState().extensionNotificationsBySession[sessionId] === undefined,
);

if (failures > 0) process.exit(1);
console.log("[test-extension-ui-notifications] PASS");

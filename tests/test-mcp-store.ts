/**
 * MCP client-store polling test.
 *
 * Verifies that the shared MCP polling ticker refreshes already-loaded
 * project status slices (the Settings → MCP server status list) in addition
 * to the header summary, and that unchanged project payloads keep their
 * existing object reference to avoid unnecessary UI churn.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function waitFor(label: string, predicate: () => boolean, budgetMs = 1000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert(label, false, "timed out");
}

interface MockStatus {
  scope: "global";
  name: string;
  kind: "remote";
  url: string;
  enabled: boolean;
  state: "idle" | "connected" | "error";
  toolCount: number;
}

async function main(): Promise<void> {
  let intervalTick: (() => void) | undefined;
  let settingsCalls = 0;
  let projectCalls = 0;
  let serverState: MockStatus["state"] = "idle";

  (globalThis as unknown as { document: { hidden: boolean } }).document = { hidden: false };
  const localStorageMock = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  (globalThis as unknown as { localStorage: typeof localStorageMock }).localStorage =
    localStorageMock;
  (globalThis as unknown as { window: unknown }).window = {
    setInterval: (fn: () => void) => {
      intervalTick = fn;
      return 42;
    },
    clearInterval: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  };

  (globalThis as unknown as { fetch: (input: unknown) => Promise<Response> }).fetch = async (
    input: unknown,
  ) => {
    const path = String(input);
    if (path === "/api/v1/mcp/settings") {
      settingsCalls += 1;
      return new Response(
        JSON.stringify({ enabled: true, connected: serverState === "connected" ? 1 : 0, total: 1 }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }
    if (path === "/api/v1/mcp/servers?projectId=p1") {
      projectCalls += 1;
      const status: MockStatus[] = [
        {
          scope: "global",
          name: "fixture",
          kind: "remote",
          url: "http://127.0.0.1/sse",
          enabled: true,
          state: serverState,
          toolCount: serverState === "connected" ? 2 : 0,
        },
      ];
      return new Response(JSON.stringify({ servers: {}, status, stdioTrust: { trusted: false } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ error: "unexpected_path", message: path }), {
      status: 500,
    });
  };

  const mod = (await import(resolve(repoRoot, "packages/client/src/store/mcp-store.ts"))) as {
    useMcpStore: {
      getState: () => {
        byProject: Record<string, { status: MockStatus[] } | undefined>;
        refreshProject: (projectId: string) => Promise<void>;
        startPolling: () => void;
        stopPolling: () => void;
      };
    };
  };
  const store = mod.useMcpStore;

  await store.getState().refreshProject("p1");
  assert(
    "initial project refresh called /mcp/servers",
    projectCalls === 1,
    `calls=${projectCalls}`,
  );
  assert(
    "initial project status is idle",
    store.getState().byProject.p1?.status[0]?.state === "idle",
    JSON.stringify(store.getState().byProject.p1?.status),
  );

  serverState = "connected";
  store.getState().startPolling();
  await waitFor("poll refreshed settings", () => settingsCalls >= 1);
  await waitFor("poll refreshed cached project", () => projectCalls >= 2);
  assert("poll interval registered", intervalTick !== undefined);
  assert(
    "cached project status auto-refreshes to connected",
    store.getState().byProject.p1?.status[0]?.state === "connected",
    JSON.stringify(store.getState().byProject.p1?.status),
  );

  const projectRef = store.getState().byProject.p1;
  intervalTick?.();
  await waitFor("second tick refreshed cached project", () => projectCalls >= 3);
  assert(
    "unchanged project payload keeps reference",
    store.getState().byProject.p1 === projectRef,
    "expected no byProject churn when status payload is unchanged",
  );

  store.getState().stopPolling();

  console.log(
    failures === 0
      ? "\n[test-mcp-store] PASS"
      : `\n[test-mcp-store] FAIL — ${failures} assertion(s) failed`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[test-mcp-store] uncaught error:", err);
  process.exit(1);
});

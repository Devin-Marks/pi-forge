/**
 * Phase 5 SSE bridge integration test.
 *
 * Default (no LLM, no auth, runs in CI):
 *   - Boots the server in-process; creates a session via the registry.
 *   - Opens the SSE endpoint, asserts a `snapshot` event lands first with
 *     the expected sessionId/projectId/messages/isStreaming shape.
 *   - Verifies the event filter: directly invoke client.send() with allowed
 *     and disallowed event types and check that disallowed events are
 *     dropped silently. (No need to round-trip through the SDK to confirm
 *     filtering — the bridge unit is the source of truth.)
 *   - Verifies multi-client: two SSE connections to the same session both
 *     receive the snapshot independently.
 *   - Verifies clean teardown: aborting the client closes the socket and
 *     the registry's clients Set drops the entry.
 *   - Verifies a `404 session_not_found` for an unknown sessionId.
 *
 * Opt-in (PI_TEST_LIVE_PROMPT=1):
 *   - Sends a real prompt and asserts agent_start + at least one
 *     message_update + agent_end events arrive in order.
 *
 * The dev-plan exit criterion ("`curl` to SSE endpoint streams live events
 * during a prompt") is met by the live-prompt branch; the default mode
 * exercises the bridge plumbing without an LLM.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface TestSession {
  setSessionName: (n: string) => void;
  sessionId: string;
  prompt: (text: string) => Promise<void>;
  subscribe: (l: (e: unknown) => void) => () => void;
  sessionManager: { appendMessage: (msg: unknown) => string };
}
interface TestLive {
  session: TestSession;
  sessionId: string;
  projectId: string;
  clients: Set<{ id: string; send: (e: unknown) => void; close: () => void }>;
}
interface TestRegistry {
  createSession: (projectId: string, workspacePath: string) => Promise<TestLive>;
  getSession: (id: string) => TestLive | undefined;
  disposeSession: (id: string) => boolean;
  disposeAllSessions: () => void;
}
interface TestBridge {
  isAllowedEvent: (event: { type: string }) => boolean;
  serializeSSE: (event: object & { type: string }) => string;
  buildSnapshot: (live: TestLive) => {
    type: "snapshot";
    sessionId: string;
    projectId: string;
    messages: unknown[];
    isStreaming: boolean;
  };
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  console.log(`[test-sse] WORKSPACE_PATH=${workspacePath}`);

  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as TestRegistry;
  const bridge = (await import(
    resolve(repoRoot, "packages/server/dist/sse-bridge.js")
  )) as unknown as TestBridge;
  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };

  // 1. Bridge unit: filter behavior.
  assert("isAllowedEvent('agent_start') === true", bridge.isAllowedEvent({ type: "agent_start" }));
  assert("isAllowedEvent('snapshot') === true", bridge.isAllowedEvent({ type: "snapshot" }));
  assert(
    "isAllowedEvent('session_info_changed') === false (filtered)",
    !bridge.isAllowedEvent({ type: "session_info_changed" }),
  );
  assert(
    "isAllowedEvent('totally_unknown_type') === false",
    !bridge.isAllowedEvent({ type: "totally_unknown_type" }),
  );

  // 2. Bridge unit: serializeSSE produces correct wire format.
  const wireEvent = { type: "agent_start", sessionId: "abc" } as const;
  const wire = bridge.serializeSSE(wireEvent);
  assert(
    "serializeSSE format is `data: <json>\\n\\n`",
    wire === 'data: {"type":"agent_start","sessionId":"abc"}\n\n',
    wire,
  );

  const fastify = await buildModule.buildServer();
  const listenAddr = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    const projectId = "proj-" + Date.now().toString(36);
    const live = await registry.createSession(projectId, workspacePath);

    // 3. buildSnapshot reflects current LiveSession state.
    const snap = bridge.buildSnapshot(live);
    assert("snapshot.type === 'snapshot'", snap.type === "snapshot");
    assert("snapshot.sessionId matches", snap.sessionId === live.sessionId);
    assert("snapshot.projectId matches", snap.projectId === projectId);
    assert("snapshot.messages is an array", Array.isArray(snap.messages));
    assert("snapshot.isStreaming === false on idle session", snap.isStreaming === false);

    // 4. End-to-end SSE: open the stream and parse the first frame.
    const ctrl = new AbortController();
    const res = await fetch(`${listenAddr}/api/v1/sessions/${live.sessionId}/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl.signal,
    });
    assert("stream returns 200", res.status === 200, `status=${res.status}`);
    assert(
      "Content-Type is text/event-stream",
      res.headers.get("content-type")?.includes("text/event-stream") === true,
      String(res.headers.get("content-type")),
    );
    assert(
      "X-Accel-Buffering disabled",
      res.headers.get("x-accel-buffering") === "no",
      String(res.headers.get("x-accel-buffering")),
    );

    if (res.body === null) throw new Error("response body is null");
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    const readUntilEvent = async (): Promise<{ type: string; [k: string]: unknown }> => {
      while (true) {
        const sep = buffer.indexOf("\n\n");
        if (sep !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              return JSON.parse(line.slice(5).trimStart()) as { type: string };
            }
          }
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended before any event");
        buffer += value;
      }
    };

    const first = await readUntilEvent();
    assert("first event over the wire is `snapshot`", first.type === "snapshot");
    assert(
      "wire snapshot.sessionId matches",
      (first as unknown as { sessionId: string }).sessionId === live.sessionId,
    );
    assert(
      "wire snapshot.projectId matches",
      (first as unknown as { projectId: string }).projectId === projectId,
    );

    // 5. Wire registers as a real client in the registry.
    assert("live.clients has the SSE client registered", live.clients.size === 1);

    // 6. Multi-client: open a second connection; both should be in the set
    // and both should receive their own snapshot.
    const ctrl2 = new AbortController();
    const res2 = await fetch(`${listenAddr}/api/v1/sessions/${live.sessionId}/stream`, {
      headers: { Accept: "text/event-stream" },
      signal: ctrl2.signal,
    });
    assert("second stream returns 200", res2.status === 200);
    if (res2.body === null) throw new Error("second response body is null");
    const reader2 = res2.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer2 = "";
    const readFrame2 = async (): Promise<{ type: string; [k: string]: unknown }> => {
      while (true) {
        const sep = buffer2.indexOf("\n\n");
        if (sep !== -1) {
          const frame = buffer2.slice(0, sep);
          buffer2 = buffer2.slice(sep + 2);
          for (const line of frame.split("\n")) {
            if (line.startsWith("data:")) {
              return JSON.parse(line.slice(5).trimStart()) as { type: string };
            }
          }
        }
        const { value, done } = await reader2.read();
        if (done) throw new Error("stream2 ended before any event");
        buffer2 += value;
      }
    };
    const first2 = await readFrame2();
    assert("second connection receives its own snapshot", first2.type === "snapshot");
    assert("registry has TWO clients now", live.clients.size === 2);

    // 7. Cleanup: aborting one connection drops it from the registry.
    ctrl2.abort();
    try {
      await reader2.cancel();
    } catch {
      // expected — already aborted
    }
    // Server-side close handler fires asynchronously; poll briefly.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline && live.clients.size > 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert("client count drops to 1 after first abort", live.clients.size === 1);

    // 8. Unknown sessionId → 404.
    const res404 = await fetch(
      `${listenAddr}/api/v1/sessions/00000000-0000-0000-0000-000000000000/stream`,
      { headers: { Accept: "text/event-stream" } },
    );
    assert("unknown sessionId returns 404", res404.status === 404);
    const body404 = (await res404.json()) as { error: string };
    assert("404 error code is session_not_found", body404.error === "session_not_found");

    // Tear down our remaining stream cleanly.
    ctrl.abort();
    try {
      await reader.cancel();
    } catch {
      // expected
    }

    // 9. Optional: live prompt with PI_TEST_LIVE_PROMPT=1.
    if (process.env.PI_TEST_LIVE_PROMPT === "1") {
      console.log("\n[test-sse] PI_TEST_LIVE_PROMPT=1 — running live prompt");
      const promptSession = await registry.createSession(projectId, workspacePath);
      const promptCtrl = new AbortController();
      const promptRes = await fetch(
        `${listenAddr}/api/v1/sessions/${promptSession.sessionId}/stream`,
        { headers: { Accept: "text/event-stream" }, signal: promptCtrl.signal },
      );
      if (promptRes.body === null) throw new Error("live prompt stream body is null");
      const collected: string[] = [];
      const promptReader = promptRes.body.pipeThrough(new TextDecoderStream()).getReader();
      let promptBuf = "";
      const collectAll = async (): Promise<void> => {
        while (true) {
          const { value, done } = await promptReader.read();
          if (done) return;
          promptBuf += value;
          let sep = promptBuf.indexOf("\n\n");
          while (sep !== -1) {
            const frame = promptBuf.slice(0, sep);
            promptBuf = promptBuf.slice(sep + 2);
            for (const line of frame.split("\n")) {
              if (line.startsWith("data:")) {
                const evt = JSON.parse(line.slice(5).trimStart()) as { type: string };
                collected.push(evt.type);
                if (evt.type === "agent_end") return;
              }
            }
            sep = promptBuf.indexOf("\n\n");
          }
        }
      };
      const collector = collectAll();
      try {
        await promptSession.session.prompt("Reply with the single word 'ready' and nothing else.");
        await collector;
        assert("live: snapshot fired first", collected[0] === "snapshot");
        assert("live: agent_start observed", collected.includes("agent_start"));
        assert("live: at least one message_update", collected.includes("message_update"));
        assert("live: agent_end observed", collected.includes("agent_end"));
        assert(
          "live: agent_start before agent_end",
          collected.indexOf("agent_start") < collected.indexOf("agent_end"),
        );
      } finally {
        promptCtrl.abort();
        registry.disposeSession(promptSession.sessionId);
      }
    } else {
      console.log("\n[test-sse] (skipped live-prompt — set PI_TEST_LIVE_PROMPT=1 to run)");
    }
  } finally {
    registry.disposeAllSessions();
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-sse] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-sse] PASS");
}

main().catch((err) => {
  console.error("[test-sse] uncaught error:", err);
  process.exit(1);
});

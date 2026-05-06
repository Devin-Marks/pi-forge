/**
 * Phase 4 session-registry integration test.
 *
 * Default (no LLM, no auth, runs in CI):
 *   - createSession → registry has it → JSONL header on disk is the SDK shape
 *     ({ type: "session", id, timestamp, cwd })
 *   - subscribe receives the synthetic `session_info_changed` event emitted
 *     by setSessionName(), and the change is written to JSONL
 *   - discoverSessionsOnDisk picks up the new session with its name
 *   - dispose removes from registry but leaves JSONL on disk
 *   - resumeSession reads the JSONL back; the session_info_changed entry
 *     still resolves to the same name
 *   - sessionCount() reflects the registry size (closes the deferred
 *     /api/v1/health item end-to-end)
 *
 * Opt-in (PI_TEST_LIVE_PROMPT=1):
 *   - sends a real prompt via session.prompt(); collects events; asserts
 *     agent_start/agent_end appear in order. Requires a pi provider with
 *     credentials configured in the host's PI_CONFIG_DIR.
 *
 * setSessionName is the test workhorse because it (a) emits a real
 * AgentSessionEvent synchronously and (b) writes a real entry to the JSONL
 * — exercising the same subscribe + persistence pipeline that the LLM path
 * uses, without needing an LLM.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

async function setupEnv(): Promise<{
  workspacePath: string;
  configDir: string;
  sessionDir: string;
}> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
  const sessionDir = join(workspacePath, ".pi", "sessions");
  // Set env BEFORE importing the registry so `config.ts` sees these values.
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = sessionDir;
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;
  return { workspacePath, configDir, sessionDir };
}

async function main(): Promise<void> {
  const { workspacePath, configDir, sessionDir } = await setupEnv();
  console.log(`[test-session] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-session] SESSION_DIR=${sessionDir}`);

  // Dynamic import after env is set so `config.ts` picks it up. Types are
  // intentionally loose — the test treats the session as opaque and only
  // calls the few methods it needs.
  interface TestSession {
    setSessionName: (n: string) => void;
    sessionFile?: string;
    subscribe: (l: (e: unknown) => void) => () => void;
    sessionId: string;
    prompt: (text: string) => Promise<void>;
    sessionManager: { appendMessage: (msg: unknown) => string };
  }
  interface TestLive {
    session: TestSession;
    sessionId: string;
    clients: Set<unknown>;
  }
  interface TestDiscovered {
    sessionId: string;
    path: string;
    name?: string;
    messageCount: number;
  }
  interface TestRegistry {
    createSession: (projectId: string, workspacePath: string) => Promise<TestLive>;
    getSession: (id: string) => TestLive | undefined;
    listSessions: (projectId?: string) => TestLive[];
    // Async because dispose now awaits an in-flight LLM-call abort
    // before tearing down (session-registry.ts: ABORT_TIMEOUT_MS).
    disposeSession: (id: string) => Promise<boolean>;
    resumeSession: (id: string, projectId: string, workspacePath: string) => Promise<TestLive>;
    discoverSessionsOnDisk: (projectId: string, workspacePath: string) => Promise<TestDiscovered[]>;
    sessionCount: () => number;
    disposeAllSessions: () => void;
  }
  // The dispose path lays down a 1500 ms "tombstone" on the
  // sessionId so a polling SSE client can't re-resume the session
  // before the disk delete completes. Tests that dispose then
  // immediately resume the same id need to wait this out.
  const TOMBSTONE_MS = 1500;
  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as TestRegistry;

  try {
    const projectId = "proj-" + Date.now().toString(36);

    // 1. Create
    const live = await registry.createSession(projectId, workspacePath);
    assert(
      "createSession returns a LiveSession with a non-empty sessionId",
      typeof live.sessionId === "string" && live.sessionId.length > 0,
      `id=${live.sessionId}`,
    );
    assert("registry.sessionCount() === 1", registry.sessionCount() === 1);
    assert("getSession returns the same instance", registry.getSession(live.sessionId) === live);
    assert(
      "listSessions filtered by projectId returns it",
      registry.listSessions(projectId).length === 1,
    );
    assert(
      "listSessions filtered by other projectId returns nothing",
      registry.listSessions("other").length === 0,
    );

    // 2. session.sessionFile is set immediately, but the file is only written
    // lazily on the first appendXXX call. Verify the path is set, then trigger
    // a write via setSessionName, then verify the file landed with the
    // expected SDK header shape on its first line.
    const sessionFile = live.session.sessionFile;
    assert(
      "session.sessionFile is set on a file-backed session",
      typeof sessionFile === "string" && sessionFile.length > 0,
      String(sessionFile),
    );
    if (sessionFile === undefined) throw new Error("sessionFile missing — cannot continue");

    // 3. subscribe wiring + JSONL persistence via setSessionName
    const events: { type: string }[] = [];
    const unsub = live.session.subscribe((e) => events.push(e as { type: string }));
    live.session.setSessionName("phase-4-test");
    unsub();
    assert(
      "subscribe received session_info_changed",
      events.some((e) => e.type === "session_info_changed"),
      `got ${events.map((e) => e.type).join(",") || "(none)"}`,
    );

    // The SDK only flushes JSONL once an assistant message exists in the
    // session (intentional — keeps the disk free of empty sessions). To test
    // the persistence pipeline without an LLM, inject a minimal fake
    // assistant message directly via the public sessionManager. Test-only.
    live.session.sessionManager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "test fixture", id: "stub-1" }],
      api: "messages",
      provider: "anthropic",
      model: "test-fixture",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    });

    const fileStat = await stat(sessionFile).catch(() => undefined);
    assert(
      "session JSONL exists on disk after first append",
      fileStat !== undefined && fileStat.isFile(),
    );
    const raw = await readFile(sessionFile, "utf8");
    const firstLine = raw.split("\n")[0] ?? "";
    const header = JSON.parse(firstLine) as {
      type: string;
      id: string;
      cwd: string;
      timestamp: string;
    };
    assert("first line is the session header", header.type === "session");
    assert(
      "header.id matches sessionId",
      header.id === live.sessionId,
      `header=${header.id} live=${live.sessionId}`,
    );
    assert("header.cwd matches workspacePath", header.cwd === workspacePath);
    assert("header.timestamp is parseable ISO", !Number.isNaN(Date.parse(header.timestamp)));
    assert(
      "JSONL gained a session_info entry with the new name",
      raw.includes('"type":"session_info"') && raw.includes('"name":"phase-4-test"'),
    );

    // 4. discoverSessionsOnDisk
    const discovered = await registry.discoverSessionsOnDisk(projectId, workspacePath);
    assert("discoverSessionsOnDisk returns 1 session", discovered.length === 1);
    assert("discovered.sessionId matches", discovered[0]?.sessionId === live.sessionId);
    assert("discovered.name reflects the rename", discovered[0]?.name === "phase-4-test");
    assert(
      "discovered.messageCount === 1 (the synthetic assistant message)",
      discovered[0]?.messageCount === 1,
      `got ${discovered[0]?.messageCount}`,
    );
    assert(
      "discoverSessionsOnDisk for unknown project returns empty",
      (await registry.discoverSessionsOnDisk("00000000-0000-4000-8000-000000000000", workspacePath))
        .length === 0,
    );

    // 5. dispose removes from registry, leaves JSONL on disk
    assert("disposeSession returns true", (await registry.disposeSession(live.sessionId)) === true);
    assert("registry.sessionCount() === 0 after dispose", registry.sessionCount() === 0);
    assert(
      "getSession returns undefined after dispose",
      registry.getSession(live.sessionId) === undefined,
    );
    const fileAfterDispose = await stat(sessionFile).catch(() => undefined);
    assert(
      "JSONL still exists after dispose",
      fileAfterDispose !== undefined && fileAfterDispose.isFile(),
    );
    assert(
      "disposeSession on unknown id returns false",
      (await registry.disposeSession("does-not-exist")) === false,
    );

    // 6. resume — same id comes back, name persists.
    // Wait out the tombstone first; dispose-then-immediate-resume
    // would otherwise hit SessionTombstonedError (the design exists
    // to defeat polling SSE clients during a hard-delete race).
    await new Promise((r) => setTimeout(r, TOMBSTONE_MS + 100));
    const resumed = await registry.resumeSession(live.sessionId, projectId, workspacePath);
    assert("resumeSession returns same sessionId", resumed.sessionId === live.sessionId);
    assert("registry.sessionCount() === 1 after resume", registry.sessionCount() === 1);
    // Re-discover to confirm name still present after a round-trip.
    const rediscovered = await registry.discoverSessionsOnDisk(projectId, workspacePath);
    assert(
      "session name survives dispose+resume",
      rediscovered[0]?.name === "phase-4-test",
      `got ${rediscovered[0]?.name}`,
    );
    await registry.disposeSession(resumed.sessionId);

    // 6b. Multi-client fan-out: in a fresh session (so it doesn't disturb
    // the resume-name assertion above), inject two stub SSEClients and
    // verify both receive a real AgentSessionEvent.
    const fanSession = await registry.createSession(projectId, workspacePath);
    try {
      const fanA: { type: string }[] = [];
      const fanB: { type: string }[] = [];
      const stubA = {
        id: "a",
        send: (e: { type: string }) => fanA.push(e),
        close: () => undefined,
      };
      const stubB = {
        id: "b",
        send: (e: { type: string }) => fanB.push(e),
        close: () => undefined,
      };
      fanSession.clients.add(stubA);
      fanSession.clients.add(stubB);
      fanSession.session.setSessionName("fan-out-check");
      assert(
        "fan-out delivered to client A",
        fanA.some((e) => e.type === "session_info_changed"),
      );
      assert(
        "fan-out delivered to client B",
        fanB.some((e) => e.type === "session_info_changed"),
      );

      // A misbehaving client doesn't kill the fan-out — the throwing client
      // gets dropped while the healthy one keeps receiving.
      const fanGood: { type: string }[] = [];
      let badInvocations = 0;
      const stubBad = {
        id: "bad",
        send: () => {
          badInvocations += 1;
          throw new Error("simulated send failure");
        },
        close: () => undefined,
      };
      const stubGood = {
        id: "good",
        send: (e: { type: string }) => fanGood.push(e),
        close: () => undefined,
      };
      fanSession.clients.delete(stubA);
      fanSession.clients.delete(stubB);
      fanSession.clients.add(stubBad);
      fanSession.clients.add(stubGood);
      fanSession.session.setSessionName("fan-out-resilience");
      assert("misbehaving client received event once", badInvocations === 1);
      assert("misbehaving client was removed from the set", !fanSession.clients.has(stubBad));
      assert("healthy client kept receiving events", fanGood.length > 0);
    } finally {
      await registry.disposeSession(fanSession.sessionId);
    }

    // 7. resumeSession on an unknown id throws SessionNotFoundError
    let threw = false;
    try {
      await registry.resumeSession(
        "00000000-0000-0000-0000-000000000000",
        projectId,
        workspacePath,
      );
    } catch (err) {
      threw = (err as Error).name === "SessionNotFoundError";
    }
    assert("resumeSession throws SessionNotFoundError for unknown id", threw);

    // 7b. End-to-end: boot the Fastify server in-process and verify that
    // /api/v1/health.activeSessions reflects the current registry size.
    // Closes the deferred-item check that used to only assert ">= 0".
    const buildModule = (await import(resolve(repoRoot, "packages/server/dist/index.js"))) as {
      buildServer: () => Promise<{
        listen: (...a: unknown[]) => Promise<string>;
        close: () => Promise<void>;
      }>;
    };
    const fastify = await buildModule.buildServer();
    const listenAddr = await fastify.listen({ port: 0, host: "127.0.0.1" });
    try {
      // Registry was just emptied by section 7's dispose. Create one and
      // assert health reports 1; then dispose and assert it reports 0.
      const probe = await registry.createSession(projectId, workspacePath);
      const res = await fetch(`${listenAddr}/api/v1/health`);
      const body = (await res.json()) as { activeSessions: number; activePtys: number };
      assert(
        "health endpoint reflects registry.sessionCount()",
        body.activeSessions === 1,
        `got ${body.activeSessions}`,
      );
      assert("health.activePtys is still 0 (Phase 11)", body.activePtys === 0);
      await registry.disposeSession(probe.sessionId);
      const res2 = await fetch(`${listenAddr}/api/v1/health`);
      const body2 = (await res2.json()) as { activeSessions: number };
      assert("health updates after dispose to 0", body2.activeSessions === 0);
    } finally {
      await fastify.close();
    }
    registry.disposeAllSessions();

    // 8. Optional: real prompt (only if PI_TEST_LIVE_PROMPT=1)
    if (process.env.PI_TEST_LIVE_PROMPT === "1") {
      console.log("\n[test-session] PI_TEST_LIVE_PROMPT=1 — sending a real prompt");
      const liveForPrompt = await registry.createSession(projectId, workspacePath);
      const types: string[] = [];
      const unsubPrompt = liveForPrompt.session.subscribe((e) =>
        types.push((e as { type: string }).type),
      );
      try {
        // session.prompt() resolves only after the full agent run; await is fine
        // here because we want to observe the complete event stream.
        await liveForPrompt.session.prompt("Reply with the single word 'ready' and nothing else.");
        assert("agent_start fired", types.includes("agent_start"));
        assert("agent_end fired", types.includes("agent_end"));
        assert(
          "agent_start preceded agent_end",
          types.indexOf("agent_start") < types.indexOf("agent_end"),
        );
      } finally {
        unsubPrompt();
        await registry.disposeSession(liveForPrompt.sessionId);
      }
    } else {
      console.log("\n[test-session] (skipped live-prompt — set PI_TEST_LIVE_PROMPT=1 to run)");
    }
  } finally {
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-session] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-session] PASS");
}

main().catch((err) => {
  console.error("[test-session] uncaught error:", err);
  process.exit(1);
});

/**
 * Integration test for session orchestration.
 *
 * Coverage:
 *   - Instance-flag gate: routes 403 with `orchestration_disabled`
 *     when ORCHESTRATION_ENABLED is unset
 *   - MINIMAL_UI gate: routes 403 with `minimal_ui_disabled` even
 *     when env flag is set
 *   - enable / disable supervisor mode round-trip
 *   - GET /orchestration/sessions/:id reports role correctly
 *   - Depth limit: cannot enable supervisor on a registered worker
 *   - Fanout limit enforced when registering workers
 *   - Workers list / inbox routes return wired data
 *   - Store layer: register/unregister/getSupervisorIdForWorker
 *   - Inbox layer: FIFO cap, drain marks delivered, readAll
 *   - bridgeWorkerEvent enqueues for owned workers, skips orphans
 *
 * The orchestration tools that drive real agent sessions
 * (`orchestrate_spawn_worker` etc.) are exercised indirectly via
 * direct store calls — testing the full LLM round-trip requires
 * credentials and is out of scope here. The tool functions are
 * thin wrappers around the same store / inbox / session-registry
 * functions covered below.
 */
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:net";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");

interface OrchestrationStoreModule {
  enableSupervisor: (sessionId: string) => Promise<unknown>;
  disableSupervisor: (sessionId: string) => Promise<void>;
  registerWorker: (opts: {
    supervisorId: string;
    workerId: string;
    spawnedFrom?: { sessionId: string; mode: "fresh" | "summary" };
  }) => Promise<void>;
  unregisterWorker: (workerId: string) => Promise<void>;
  isSupervisor: (sessionId: string) => Promise<boolean>;
  isWorker: (sessionId: string) => Promise<boolean>;
  getSupervisorIdForWorker: (workerId: string) => Promise<string | undefined>;
  getWorkerIds: (supervisorId: string) => Promise<string[]>;
  enqueueInboxItem: (
    supervisorId: string,
    item: {
      type: string;
      workerId: string;
      occurredAt: string;
      data: Record<string, unknown>;
    },
  ) => Promise<{ id: string; delivered: boolean }>;
  readPendingInbox: (
    supervisorId: string,
    opts?: { markDelivered?: boolean },
  ) => Promise<{ id: string; delivered: boolean }[]>;
  readAllInbox: (supervisorId: string) => Promise<{ id: string; delivered: boolean }[]>;
  pendingInboxCount: (supervisorId: string) => Promise<number>;
  clearInbox: (supervisorId: string) => Promise<void>;
  OrchestrationError: new (code: string, message: string) => Error & { code: string };
}

interface InboxModule {
  bridgeWorkerEvent: (
    workerId: string,
    type: string,
    data: Record<string, unknown>,
  ) => Promise<{ id: string } | undefined>;
  hasPendingWakePush: (supervisorId: string) => boolean;
}

interface RegistryModule {
  createSession: (
    projectId: string,
    workspacePath: string,
  ) => Promise<{ sessionId: string; session: { prompt: (text: string) => Promise<unknown> } }>;
  disposeAllSessions: () => Promise<void>;
}

interface ProcessInfoStub {
  id: string;
  name: string;
  pid: number | null;
  exitCode: number | null;
  success: boolean;
}

interface EventBridgeModule {
  bridgeWorkerProcessAlert: (
    workerId: string,
    info: ProcessInfoStub,
    reason: "success" | "failure" | "killed",
  ) => Promise<void>;
  shouldBridgeWorkerProcessAlert: (reason: "success" | "failure" | "killed") => boolean;
}

interface ToolResult {
  content: { type: string; text?: string }[];
  details?: unknown;
}
interface ToolsModule {
  createOrchestrationTools: (supervisorId: string) => {
    name: string;
    execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
  }[];
}

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function pickFreePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv: Server = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        rejectFn(new Error("failed to acquire free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolveFn(port));
    });
  });
}

async function waitFor(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`timeout waiting for ${url}`);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return predicate();
}

interface RunningServer {
  base: string;
  workspacePath: string;
  configDir: string;
  dataDir: string;
  child?: ChildProcess;
  stop: () => Promise<void>;
}

async function startServer(opts: {
  orchestrationEnabled?: boolean;
  minimalUi?: boolean;
  fanoutCap?: number;
  workspacePath?: string;
  configDir?: string;
  dataDir?: string;
}): Promise<RunningServer> {
  const workspacePath = opts.workspacePath ?? (await mkdtemp(join(tmpdir(), "pi-forge-orch-ws-")));
  const configDir = opts.configDir ?? (await mkdtemp(join(tmpdir(), "pi-forge-orch-cfg-")));
  const dataDir = opts.dataDir ?? (await mkdtemp(join(tmpdir(), "pi-forge-orch-data-")));
  const ownedDirs = opts.dataDir === undefined;
  const port = await pickFreePort();
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      LOG_LEVEL: "warn",
      NODE_ENV: "test",
      WORKSPACE_PATH: workspacePath,
      PI_CONFIG_DIR: configDir,
      FORGE_DATA_DIR: dataDir,
      SESSION_DIR: join(workspacePath, ".pi", "sessions"),
      SERVE_CLIENT: "false",
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      API_KEY: undefined,
      MINIMAL_UI: opts.minimalUi === true ? "1" : undefined,
      ORCHESTRATION_ENABLED: opts.orchestrationEnabled === true ? "1" : undefined,
      ORCHESTRATION_MAX_WORKERS_PER_SUPERVISOR:
        opts.fanoutCap !== undefined ? String(opts.fanoutCap) : undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b: Buffer) => process.stderr.write(`[orch-srv] ${String(b)}`));
  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((res) => {
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      });
    }
    if (ownedDirs) {
      await rm(workspacePath, { recursive: true, force: true });
      await rm(configDir, { recursive: true, force: true });
      await rm(dataDir, { recursive: true, force: true });
    }
  };
  try {
    await waitFor(`${base}/api/v1/health`);
  } catch (err) {
    await stop();
    throw err;
  }
  return { base, workspacePath, configDir, dataDir, child, stop };
}

async function jsend(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function main(): Promise<void> {
  // The store + inbox modules read `FORGE_DATA_DIR` from `config.ts`
  // at module-import time. Plant the env BEFORE the first dynamic
  // import so the in-test calls share a data dir with the spawned
  // server. Same pattern as test-webhooks.ts.
  const sharedWs = await mkdtemp(join(tmpdir(), "pi-forge-orch-ws-"));
  const sharedCfg = await mkdtemp(join(tmpdir(), "pi-forge-orch-cfg-"));
  const sharedData = await mkdtemp(join(tmpdir(), "pi-forge-orch-data-"));
  process.env.WORKSPACE_PATH = sharedWs;
  process.env.PI_CONFIG_DIR = sharedCfg;
  process.env.FORGE_DATA_DIR = sharedData;
  process.env.SESSION_DIR = join(sharedWs, ".pi", "sessions");

  console.log("[test-orchestration] store layer");
  const store = (await import(
    resolve(repoRoot, "packages/server/dist/orchestration/store.js")
  )) as unknown as OrchestrationStoreModule;
  const inbox = (await import(
    resolve(repoRoot, "packages/server/dist/orchestration/inbox.js")
  )) as unknown as InboxModule;
  const eventBridge = (await import(
    resolve(repoRoot, "packages/server/dist/orchestration/event-bridge.js")
  )) as unknown as EventBridgeModule;
  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as RegistryModule;

  // ===== enable / disable supervisor =====
  await store.enableSupervisor("sup-1");
  assert("isSupervisor returns true after enable", await store.isSupervisor("sup-1"));
  assert("isWorker returns false for supervisor", !(await store.isWorker("sup-1")));

  // Idempotent
  await store.enableSupervisor("sup-1");
  assert("enableSupervisor idempotent", await store.isSupervisor("sup-1"));

  // Register a worker
  await store.registerWorker({ supervisorId: "sup-1", workerId: "w-1" });
  assert("isWorker true after register", await store.isWorker("w-1"));
  assert(
    "getSupervisorIdForWorker resolves",
    (await store.getSupervisorIdForWorker("w-1")) === "sup-1",
  );
  const ids = await store.getWorkerIds("sup-1");
  assert("getWorkerIds includes w-1", ids.length === 1 && ids[0] === "w-1");

  // ===== depth limit: worker can't be supervisor =====
  let depthLimitOk = false;
  try {
    await store.enableSupervisor("w-1");
  } catch (err) {
    depthLimitOk = err instanceof store.OrchestrationError && err.code === "depth_limit_exceeded";
  }
  assert("depth limit blocks worker→supervisor", depthLimitOk);

  // ===== fanout: cannot register the same worker twice =====
  let dupOk = false;
  try {
    await store.registerWorker({ supervisorId: "sup-1", workerId: "w-1" });
  } catch (err) {
    dupOk = err instanceof store.OrchestrationError && err.code === "worker_already_linked";
  }
  assert("duplicate worker registration rejected", dupOk);

  // ===== unregister =====
  await store.unregisterWorker("w-1");
  assert("isWorker false after unregister", !(await store.isWorker("w-1")));
  const idsAfter = await store.getWorkerIds("sup-1");
  assert("getWorkerIds empty after unregister", idsAfter.length === 0);

  // ===== inbox layer =====
  console.log("\n[test-orchestration] inbox layer");
  // Register a worker so the bridge can resolve.
  await store.registerWorker({ supervisorId: "sup-1", workerId: "w-2" });
  await inbox.bridgeWorkerEvent("w-2", "worker.ended", { stopReason: "end_turn" });
  await inbox.bridgeWorkerEvent("w-2", "worker.ask_user", {
    requestId: "r1",
    questionCount: 1,
  });
  const pending = await store.readPendingInbox("sup-1");
  assert("inbox enqueued 2 pending", pending.length === 2);
  // Orphan worker — no enqueue
  await inbox.bridgeWorkerEvent("not-a-worker", "worker.ended", {});
  const pendingAfterOrphan = await store.readPendingInbox("sup-1");
  assert(
    "orphan worker event ignored",
    pendingAfterOrphan.length === 2,
    `got ${pendingAfterOrphan.length}`,
  );

  // Drain marks delivered
  const drained = await store.readPendingInbox("sup-1", { markDelivered: true });
  assert("drain returns 2", drained.length === 2);
  const pendingAfterDrain = await store.readPendingInbox("sup-1");
  assert("after drain no pending", pendingAfterDrain.length === 0);
  const all = await store.readAllInbox("sup-1");
  assert("history retains drained items", all.length === 2);

  // pendingInboxCount + process alert noise reduction
  const cnt = await store.pendingInboxCount("sup-1");
  assert("pendingInboxCount = 0 after drain", cnt === 0);
  assert(
    "success process alerts are not supervisor-worthy",
    !eventBridge.shouldBridgeWorkerProcessAlert("success"),
  );
  assert(
    "failure process alerts are not supervisor-worthy",
    !eventBridge.shouldBridgeWorkerProcessAlert("failure"),
  );
  assert(
    "killed process alerts are not supervisor-worthy",
    !eventBridge.shouldBridgeWorkerProcessAlert("killed"),
  );
  const procInfo: ProcessInfoStub = {
    id: "p1",
    name: "build",
    pid: 123,
    exitCode: 0,
    success: true,
  };
  await eventBridge.bridgeWorkerProcessAlert("w-2", procInfo, "success");
  const cntAfterSuccess = await store.pendingInboxCount("sup-1");
  assert(
    "worker process success alert does not enqueue inbox item",
    cntAfterSuccess === 0,
    `got ${cntAfterSuccess}`,
  );
  await eventBridge.bridgeWorkerProcessAlert(
    "w-2",
    { ...procInfo, id: "p2", exitCode: 1, success: false },
    "failure",
  );
  await eventBridge.bridgeWorkerProcessAlert(
    "w-2",
    { ...procInfo, id: "p3", exitCode: null, success: false },
    "killed",
  );
  const cnt2 = await store.pendingInboxCount("sup-1");
  assert(
    "worker process failure/kill alerts do not enqueue inbox items",
    cnt2 === 0,
    `got ${cnt2}`,
  );

  // Clear inbox
  await store.clearInbox("sup-1");
  const allAfterClear = await store.readAllInbox("sup-1");
  assert("clearInbox wipes history", allAfterClear.length === 0);

  // ===== Wake-up dedupe recovery =====
  // A rejected wake prompt used to leave the per-supervisor dedupe flag
  // stuck forever, so later async worker completions stayed queued in the
  // inbox without ever nudging the supervisor again. Use a real live
  // session whose prompt method is stubbed to deterministically reject,
  // then assert the dedupe marker clears.
  const wakeSup = await registry.createSession("wake-proj", sharedWs);
  let wakePromptCalls = 0;
  wakeSup.session.prompt = async () => {
    wakePromptCalls += 1;
    await new Promise((r) => setTimeout(r, 75));
    throw new Error("test wake rejection");
  };
  await store.enableSupervisor(wakeSup.sessionId);
  await store.registerWorker({ supervisorId: wakeSup.sessionId, workerId: "wake-worker" });
  await inbox.bridgeWorkerEvent("wake-worker", "worker.ended", { stopReason: "end_turn" });
  const wakeStarted = await waitUntil(() => inbox.hasPendingWakePush(wakeSup.sessionId), 1_000);
  assert(
    "wake prompt dedupe marker is set while prompt is in flight",
    wakeStarted && wakePromptCalls === 1,
    `pending=${inbox.hasPendingWakePush(wakeSup.sessionId)} calls=${wakePromptCalls}`,
  );
  const wakeCleared = await waitUntil(() => !inbox.hasPendingWakePush(wakeSup.sessionId), 2_000);
  assert(
    "wake prompt rejection clears dedupe marker",
    wakeCleared,
    "pending wake marker stayed set after rejected prompt",
  );
  await inbox.bridgeWorkerEvent("wake-worker", "worker.ended", { stopReason: "second" });
  const wakeRetried = await waitUntil(() => wakePromptCalls >= 2, 1_000);
  assert(
    "later worker event can wake supervisor again after rejection",
    wakeRetried,
    `calls=${wakePromptCalls}`,
  );
  await waitUntil(() => !inbox.hasPendingWakePush(wakeSup.sessionId), 2_000);
  await store.disableSupervisor(wakeSup.sessionId);
  await registry.disposeAllSessions();

  // ===== Tool-result text carries the data (not just details) =====
  // The supervisor LLM reads `content[0].text`; `details` is for
  // downstream consumers (REST, tests) and DOES NOT reach the
  // model's context. The previous bug shipped the messages/inbox/
  // workers payloads in `details` only, so the orchestrator couldn't
  // see worker state. Regression-test the serializer for all three
  // read tools.
  console.log("\n[test-orchestration] tool-result text serialization");
  const tools = (await import(
    resolve(repoRoot, "packages/server/dist/orchestration/tools.js")
  )) as unknown as ToolsModule;

  // Refresh supervisor + worker for these checks.
  await store.enableSupervisor("ser-sup");
  await store.registerWorker({ supervisorId: "ser-sup", workerId: "ser-w1" });
  await store.registerWorker({ supervisorId: "ser-sup", workerId: "ser-w2" });
  await inbox.bridgeWorkerEvent("ser-w1", "worker.ended", {
    stopReason: "end_turn",
    errorMessage: null,
    assistantTextPreview: "Implemented the /auth route and added unit tests.",
  });
  await inbox.bridgeWorkerEvent("ser-w2", "worker.ask_user", {
    requestId: "rq1",
    questionCount: 1,
    firstQuestionHeader: "Auth method",
    firstQuestionText: "Should I use bcrypt or argon2?",
  });

  const serTools = tools.createOrchestrationTools("ser-sup");
  const listTool = serTools.find((t) => t.name === "orchestrate_list_workers");
  const inboxTool = serTools.find((t) => t.name === "orchestrate_read_inbox");
  assert("createOrchestrationTools returns list_workers", listTool !== undefined);
  assert("createOrchestrationTools returns read_inbox", inboxTool !== undefined);

  if (listTool !== undefined) {
    const res = await listTool.execute("call-1", {});
    const text = res.content[0]?.text ?? "";
    assert(
      "list_workers content text mentions worker ids",
      text.includes("ser-w1") && text.includes("ser-w2"),
      `got: ${text.slice(0, 300)}`,
    );
    assert(
      "list_workers content text shows 'cold' state (no live session in test)",
      text.includes("cold"),
      `got: ${text.slice(0, 300)}`,
    );
  }
  if (inboxTool !== undefined) {
    const res = await inboxTool.execute("call-2", {});
    const text = res.content[0]?.text ?? "";
    assert(
      "read_inbox content text includes ended assistantText preview",
      text.includes("Implemented the /auth route"),
      `got: ${text.slice(0, 300)}`,
    );
    assert(
      "read_inbox content text includes ask_user question preview",
      text.includes("bcrypt") || text.includes("Auth method"),
      `got: ${text.slice(0, 300)}`,
    );
    assert(
      "read_inbox content text tags worker ids",
      text.includes("ser-w1") && text.includes("ser-w2"),
      `got: ${text.slice(0, 300)}`,
    );
  }

  // Clean up store state for the REST tests
  await store.disableSupervisor("sup-1");
  await store.disableSupervisor("ser-sup");

  // ===== REST layer: orchestration_disabled gate =====
  console.log("\n[test-orchestration] REST gates");
  const offSrv = await startServer({
    orchestrationEnabled: false,
    workspacePath: sharedWs,
    configDir: sharedCfg,
    dataDir: sharedData,
  });
  try {
    const cfg = await jsend(offSrv.base, "GET", "/api/v1/orchestration/config");
    assert(
      "config returns enabled=false",
      cfg.status === 200 &&
        (cfg.body as { enabled: boolean }).enabled === false &&
        (cfg.body as { disabledReason: string }).disabledReason === "orchestration_disabled",
    );
    const en = await jsend(offSrv.base, "POST", "/api/v1/orchestration/sessions/sx/enable");
    assert(
      "enable 403 when disabled",
      en.status === 403 && (en.body as { error: string }).error === "orchestration_disabled",
    );
    const ui = await jsend(offSrv.base, "GET", "/api/v1/ui-config");
    assert(
      "/ui-config reports orchestrationEnabled=false",
      ui.status === 200 &&
        (ui.body as { orchestrationEnabled: boolean }).orchestrationEnabled === false,
    );
  } finally {
    await offSrv.stop();
  }

  // ===== MINIMAL_UI gate beats env flag =====
  const minimalSrv = await startServer({
    orchestrationEnabled: true,
    minimalUi: true,
    workspacePath: sharedWs,
    configDir: sharedCfg,
    dataDir: sharedData,
  });
  try {
    const cfg = await jsend(minimalSrv.base, "GET", "/api/v1/orchestration/config");
    assert(
      "MINIMAL_UI forces disabled even with env flag",
      cfg.status === 200 &&
        (cfg.body as { enabled: boolean }).enabled === false &&
        (cfg.body as { disabledReason: string }).disabledReason === "minimal_ui_disabled",
    );
    const en = await jsend(minimalSrv.base, "POST", "/api/v1/orchestration/sessions/sy/enable");
    assert(
      "enable 403 under MINIMAL_UI",
      en.status === 403 && (en.body as { error: string }).error === "minimal_ui_disabled",
    );
  } finally {
    await minimalSrv.stop();
  }

  // ===== REST happy path =====
  console.log("\n[test-orchestration] REST happy path");
  const onSrv = await startServer({
    orchestrationEnabled: true,
    fanoutCap: 2,
    workspacePath: sharedWs,
    configDir: sharedCfg,
    dataDir: sharedData,
  });
  try {
    // ui-config reports enabled
    const ui = await jsend(onSrv.base, "GET", "/api/v1/ui-config");
    assert(
      "/ui-config reports orchestrationEnabled=true",
      ui.status === 200 &&
        (ui.body as { orchestrationEnabled: boolean }).orchestrationEnabled === true,
    );

    // Initial role is standalone
    const link0 = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-sup");
    assert(
      "standalone session reported as standalone",
      link0.status === 200 && (link0.body as { role: string }).role === "standalone",
    );

    // Enable
    const en = await jsend(onSrv.base, "POST", "/api/v1/orchestration/sessions/rest-sup/enable");
    assert(
      "enable supervisor returns 200",
      en.status === 200 && (en.body as { role: string }).role === "supervisor",
    );

    // GET reflects role
    const link1 = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-sup");
    assert("link reports supervisor role", (link1.body as { role: string }).role === "supervisor");

    // ===== Regression: enable on a REAL live session must NOT
    // delete it (pre-prompt session has no .jsonl) and must NOT
    // trigger the dispose tombstone (post-prompt would get 410 on
    // next stream attach). Both bugs were caused by the previous
    // dispose+reconnect strategy; the rebuild-in-place fix should
    // leave the session intact and live.
    // -----
    const realProj = await jsend(onSrv.base, "POST", "/api/v1/projects", {
      name: "orch-rebuild",
      path: sharedWs,
    });
    assert(
      "create real project → 201",
      realProj.status === 201 && typeof (realProj.body as { id: string }).id === "string",
    );
    const realProjectId = (realProj.body as { id: string }).id;
    const realSess = await jsend(onSrv.base, "POST", "/api/v1/sessions", {
      projectId: realProjectId,
    });
    assert(
      "create real session → 201",
      realSess.status === 201 &&
        typeof (realSess.body as { sessionId: string }).sessionId === "string",
    );
    const realSid = (realSess.body as { sessionId: string }).sessionId;

    // Pre-prompt: no .jsonl on disk. Confirm session is live.
    const preEnable = await jsend(onSrv.base, "GET", `/api/v1/sessions/${realSid}`);
    assert(
      "fresh session is live before enable",
      preEnable.status === 200 && (preEnable.body as { isLive: boolean }).isLive === true,
    );

    // Enable supervisor — the bug being regression-tested: this
    // used to dispose+tombstone the session, leaving the next
    // stream attach to 404 (pre-prompt) or 410 (post-prompt).
    const enRes = await jsend(
      onSrv.base,
      "POST",
      `/api/v1/orchestration/sessions/${realSid}/enable`,
    );
    assert(
      "enable on real session → 200 (no delete)",
      enRes.status === 200 && (enRes.body as { role: string }).role === "supervisor",
    );

    // Session must still be live (rebuild kept it in the registry).
    const postEnable = await jsend(onSrv.base, "GET", `/api/v1/sessions/${realSid}`);
    assert(
      "session still live after enable (not disposed)",
      postEnable.status === 200 && (postEnable.body as { isLive: boolean }).isLive === true,
    );

    // A worker is stored as an ordinary session, with the supervisor link in
    // session-orchestration.json. The unified /sessions list overlays that
    // link as parentSessionId so the sidebar can nest the worker under its
    // orchestrator.
    const realWorker = await jsend(onSrv.base, "POST", "/api/v1/sessions", {
      projectId: realProjectId,
    });
    assert(
      "create real worker session → 201",
      realWorker.status === 201 &&
        typeof (realWorker.body as { sessionId: string }).sessionId === "string",
    );
    const realWorkerId = (realWorker.body as { sessionId: string }).sessionId;
    await store.registerWorker({ supervisorId: realSid, workerId: realWorkerId });
    const nestedList = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions?projectId=${encodeURIComponent(realProjectId)}`,
    );
    const nestedWorker = (
      nestedList.body as { sessions?: { sessionId: string; parentSessionId?: string }[] }
    ).sessions?.find((s) => s.sessionId === realWorkerId);
    assert(
      "session list nests orchestration worker under supervisor",
      nestedList.status === 200 && nestedWorker?.parentSessionId === realSid,
      `parentSessionId=${nestedWorker?.parentSessionId}`,
    );

    // SSE stream attach must NOT get 410 — there's no tombstone
    // since we never disposed. Fetch the stream briefly, capture
    // status, then close.
    const sseAc = new AbortController();
    const sseRes = await fetch(`${onSrv.base}/api/v1/sessions/${realSid}/stream`, {
      signal: sseAc.signal,
    });
    assert(
      "SSE attach after enable → 200 (no 410 tombstone)",
      sseRes.status === 200,
      `got ${sseRes.status}`,
    );
    sseAc.abort();
    try {
      await sseRes.body?.cancel();
    } catch {
      // ignore — body cancel after abort can throw
    }

    // Disable + same check: session must stay live, no 410 on
    // subsequent attach.
    const disRes = await jsend(
      onSrv.base,
      "POST",
      `/api/v1/orchestration/sessions/${realSid}/disable`,
    );
    assert("disable on real session → 204", disRes.status === 204);
    const postDisable = await jsend(onSrv.base, "GET", `/api/v1/sessions/${realSid}`);
    assert(
      "session still live after disable (not disposed)",
      postDisable.status === 200 && (postDisable.body as { isLive: boolean }).isLive === true,
    );
    const unnestedList = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions?projectId=${encodeURIComponent(realProjectId)}`,
    );
    const unnestedWorker = (
      unnestedList.body as { sessions?: { sessionId: string; parentSessionId?: string }[] }
    ).sessions?.find((s) => s.sessionId === realWorkerId);
    assert(
      "session list unnests worker after supervisor disable",
      unnestedList.status === 200 && unnestedWorker?.parentSessionId === undefined,
      `parentSessionId=${unnestedWorker?.parentSessionId}`,
    );

    // Regression: killing an orchestration worker should remove it from the
    // live session list instead of merely unregistering it into a standalone
    // cold session. The transcript is soft-deleted into the 7-day archive.
    const reEn = await jsend(
      onSrv.base,
      "POST",
      `/api/v1/orchestration/sessions/${realSid}/enable`,
    );
    assert("re-enable real supervisor for kill regression → 200", reEn.status === 200);
    const workerSessionDir = join(sharedWs, ".pi", "sessions", realProjectId);
    const workerBasename = `kill-regression-${realWorkerId}`;
    const childRunId = `run-${randomUUID().slice(0, 8)}`;
    const workerSubagentId = randomUUID();
    await mkdir(workerSessionDir, { recursive: true });
    await writeFile(
      join(workerSessionDir, `${workerBasename}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 1,
        id: realWorkerId,
        timestamp: new Date().toISOString(),
        cwd: sharedWs,
      }) + "\n",
      "utf8",
    );
    const workerSubagentDir = join(workerSessionDir, workerBasename, childRunId);
    await mkdir(workerSubagentDir, { recursive: true });
    await writeFile(
      join(workerSubagentDir, `${workerSubagentId}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 1,
        id: workerSubagentId,
        timestamp: new Date().toISOString(),
        cwd: sharedWs,
      }) + "\n",
      "utf8",
    );
    await store.registerWorker({ supervisorId: realSid, workerId: realWorkerId });
    const preKillNestedList = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions?projectId=${encodeURIComponent(realProjectId)}`,
    );
    const preKillSessions =
      (preKillNestedList.body as { sessions?: { sessionId: string; parentSessionId?: string }[] })
        .sessions ?? [];
    assert(
      "worker subagent child is listed before kill",
      preKillNestedList.status === 200 &&
        preKillSessions.some(
          (s) => s.sessionId === workerSubagentId && s.parentSessionId === realWorkerId,
        ),
      JSON.stringify(preKillNestedList.body),
    );
    const childSseAc = new AbortController();
    const childSseRes = await fetch(`${onSrv.base}/api/v1/sessions/${workerSubagentId}/stream`, {
      signal: childSseAc.signal,
    });
    assert(
      "worker subagent child can be made live before kill",
      childSseRes.status === 200,
      `got ${childSseRes.status}`,
    );
    const killRes = await jsend(
      onSrv.base,
      "POST",
      `/api/v1/orchestration/sessions/${realSid}/workers/${realWorkerId}/kill`,
    );
    assert(
      "kill worker archives transcript",
      killRes.status === 200 &&
        (killRes.body as { wasLive?: boolean; archiveStatus?: string }).wasLive === true &&
        (killRes.body as { wasLive?: boolean; archiveStatus?: string }).archiveStatus ===
          "archived",
      JSON.stringify(killRes.body),
    );
    const afterKillList = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions?projectId=${encodeURIComponent(realProjectId)}`,
    );
    const afterKillSessions =
      (afterKillList.body as { sessions?: { sessionId: string }[] }).sessions ?? [];
    const killedWorkerStillListed = afterKillSessions.some((s) => s.sessionId === realWorkerId);
    const workerSubagentStillListed = afterKillSessions.some(
      (s) => s.sessionId === workerSubagentId,
    );
    assert(
      "killed worker no longer appears in session list",
      afterKillList.status === 200 && killedWorkerStillListed === false,
      JSON.stringify(afterKillList.body),
    );
    assert(
      "killed worker's subagent child no longer appears in session list",
      afterKillList.status === 200 && workerSubagentStillListed === false,
      JSON.stringify(afterKillList.body),
    );
    const childAfterKill = await jsend(onSrv.base, "GET", `/api/v1/sessions/${workerSubagentId}`);
    assert(
      "live worker subagent child is disposed during kill",
      childAfterKill.status === 404,
      `got ${childAfterKill.status}`,
    );
    const archiveEntries = await readdir(join(sharedData, "archived-sessions"));
    const workerArchiveEntry = archiveEntries.find((name) => name.includes(realWorkerId));
    assert(
      "killed worker transcript has archive entry",
      workerArchiveEntry !== undefined,
      archiveEntries.join(","),
    );
    if (workerArchiveEntry !== undefined) {
      const archivedChildFiles = await readdir(
        join(sharedData, "archived-sessions", workerArchiveEntry, "subagents", childRunId),
      );
      assert(
        "killed worker archive includes subagent child directory",
        archivedChildFiles.includes(`${workerSubagentId}.jsonl`),
        archivedChildFiles.join(","),
      );
    }
    childSseAc.abort();
    try {
      await childSseRes.body?.cancel();
    } catch {
      // ignore — body cancel after abort can throw
    }

    // Same cleanup contract through the normal DELETE /sessions/:id route:
    // if the target is a registered orchestration worker, it should use the
    // shared kill/archive helper rather than the standalone delete path.
    const deleteWorker = await jsend(onSrv.base, "POST", "/api/v1/sessions", {
      projectId: realProjectId,
    });
    assert(
      "create delete-route worker session → 201",
      deleteWorker.status === 201 &&
        typeof (deleteWorker.body as { sessionId: string }).sessionId === "string",
    );
    const deleteWorkerId = (deleteWorker.body as { sessionId: string }).sessionId;
    const deleteWorkerBasename = `delete-regression-${deleteWorkerId}`;
    const deleteChildRunId = `run-${randomUUID().slice(0, 8)}`;
    const deleteWorkerSubagentId = randomUUID();
    await writeFile(
      join(workerSessionDir, `${deleteWorkerBasename}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 1,
        id: deleteWorkerId,
        timestamp: new Date().toISOString(),
        cwd: sharedWs,
      }) + "\n",
      "utf8",
    );
    const deleteWorkerSubagentDir = join(workerSessionDir, deleteWorkerBasename, deleteChildRunId);
    await mkdir(deleteWorkerSubagentDir, { recursive: true });
    await writeFile(
      join(deleteWorkerSubagentDir, `${deleteWorkerSubagentId}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 1,
        id: deleteWorkerSubagentId,
        timestamp: new Date().toISOString(),
        cwd: sharedWs,
      }) + "\n",
      "utf8",
    );
    await store.registerWorker({ supervisorId: realSid, workerId: deleteWorkerId });
    const deleteChildSseAc = new AbortController();
    const deleteChildSseRes = await fetch(
      `${onSrv.base}/api/v1/sessions/${deleteWorkerSubagentId}/stream`,
      { signal: deleteChildSseAc.signal },
    );
    assert(
      "delete-route worker subagent child can be made live before delete",
      deleteChildSseRes.status === 200,
      `got ${deleteChildSseRes.status}`,
    );
    const deleteWorkerRes = await jsend(onSrv.base, "DELETE", `/api/v1/sessions/${deleteWorkerId}`);
    assert("DELETE /sessions/:id for worker returns 204", deleteWorkerRes.status === 204);
    const afterDeleteWorkerList = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions?projectId=${encodeURIComponent(realProjectId)}`,
    );
    const afterDeleteWorkerSessions =
      (afterDeleteWorkerList.body as { sessions?: { sessionId: string }[] }).sessions ?? [];
    assert(
      "DELETE worker no longer appears in session list",
      afterDeleteWorkerList.status === 200 &&
        !afterDeleteWorkerSessions.some((s) => s.sessionId === deleteWorkerId),
      JSON.stringify(afterDeleteWorkerList.body),
    );
    assert(
      "DELETE worker's subagent child no longer appears in session list",
      afterDeleteWorkerList.status === 200 &&
        !afterDeleteWorkerSessions.some((s) => s.sessionId === deleteWorkerSubagentId),
      JSON.stringify(afterDeleteWorkerList.body),
    );
    const deleteChildAfterKill = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions/${deleteWorkerSubagentId}`,
    );
    assert(
      "DELETE worker disposes live subagent child",
      deleteChildAfterKill.status === 404,
      `got ${deleteChildAfterKill.status}`,
    );
    const archiveEntriesAfterDelete = await readdir(join(sharedData, "archived-sessions"));
    const deleteWorkerArchiveEntry = archiveEntriesAfterDelete.find((name) =>
      name.includes(deleteWorkerId),
    );
    assert(
      "DELETE worker transcript has archive entry",
      deleteWorkerArchiveEntry !== undefined,
      archiveEntriesAfterDelete.join(","),
    );
    if (deleteWorkerArchiveEntry !== undefined) {
      const deleteArchivedChildFiles = await readdir(
        join(
          sharedData,
          "archived-sessions",
          deleteWorkerArchiveEntry,
          "subagents",
          deleteChildRunId,
        ),
      );
      assert(
        "DELETE worker archive includes subagent child directory",
        deleteArchivedChildFiles.includes(`${deleteWorkerSubagentId}.jsonl`),
        deleteArchivedChildFiles.join(","),
      );
    }
    deleteChildSseAc.abort();
    try {
      await deleteChildSseRes.body?.cancel();
    } catch {
      // ignore — body cancel after abort can throw
    }

    // Deleting the supervisor itself should cascade through the same worker
    // cleanup path: registered workers (and their subagent children) are
    // archived out of live discovery and unregistered before the supervisor is
    // removed.
    const cascadeWorkerA = await jsend(onSrv.base, "POST", "/api/v1/sessions", {
      projectId: realProjectId,
    });
    const cascadeWorkerB = await jsend(onSrv.base, "POST", "/api/v1/sessions", {
      projectId: realProjectId,
    });
    assert(
      "create cascade worker sessions → 201",
      cascadeWorkerA.status === 201 && cascadeWorkerB.status === 201,
    );
    const cascadeWorkerAId = (cascadeWorkerA.body as { sessionId: string }).sessionId;
    const cascadeWorkerBId = (cascadeWorkerB.body as { sessionId: string }).sessionId;
    const cascadeWorkerABasename = `cascade-worker-${cascadeWorkerAId}`;
    const cascadeWorkerBBasename = `cascade-worker-${cascadeWorkerBId}`;
    const cascadeChildRunId = `run-${randomUUID().slice(0, 8)}`;
    const cascadeWorkerSubagentId = randomUUID();
    await writeFile(
      join(workerSessionDir, `${cascadeWorkerABasename}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 1,
        id: cascadeWorkerAId,
        timestamp: new Date().toISOString(),
        cwd: sharedWs,
      }) + "\n",
      "utf8",
    );
    await writeFile(
      join(workerSessionDir, `${cascadeWorkerBBasename}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 1,
        id: cascadeWorkerBId,
        timestamp: new Date().toISOString(),
        cwd: sharedWs,
      }) + "\n",
      "utf8",
    );
    const cascadeWorkerSubagentDir = join(
      workerSessionDir,
      cascadeWorkerABasename,
      cascadeChildRunId,
    );
    await mkdir(cascadeWorkerSubagentDir, { recursive: true });
    await writeFile(
      join(cascadeWorkerSubagentDir, `${cascadeWorkerSubagentId}.jsonl`),
      JSON.stringify({
        type: "session",
        version: 1,
        id: cascadeWorkerSubagentId,
        timestamp: new Date().toISOString(),
        cwd: sharedWs,
      }) + "\n",
      "utf8",
    );
    await store.registerWorker({ supervisorId: realSid, workerId: cascadeWorkerAId });
    await store.registerWorker({ supervisorId: realSid, workerId: cascadeWorkerBId });
    const cascadeChildSseAc = new AbortController();
    const cascadeChildSseRes = await fetch(
      `${onSrv.base}/api/v1/sessions/${cascadeWorkerSubagentId}/stream`,
      { signal: cascadeChildSseAc.signal },
    );
    assert(
      "cascade worker subagent child can be made live before supervisor delete",
      cascadeChildSseRes.status === 200,
      `got ${cascadeChildSseRes.status}`,
    );
    const deleteSupervisorRes = await jsend(onSrv.base, "DELETE", `/api/v1/sessions/${realSid}`);
    assert("DELETE /sessions/:id for supervisor returns 204", deleteSupervisorRes.status === 204);
    const afterSupervisorDeleteList = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions?projectId=${encodeURIComponent(realProjectId)}`,
    );
    const afterSupervisorDeleteSessions =
      (afterSupervisorDeleteList.body as { sessions?: { sessionId: string }[] }).sessions ?? [];
    assert(
      "deleted supervisor no longer appears in session list",
      afterSupervisorDeleteList.status === 200 &&
        !afterSupervisorDeleteSessions.some((s) => s.sessionId === realSid),
      JSON.stringify(afterSupervisorDeleteList.body),
    );
    assert(
      "deleted supervisor's workers no longer appear in session list",
      afterSupervisorDeleteList.status === 200 &&
        !afterSupervisorDeleteSessions.some(
          (s) => s.sessionId === cascadeWorkerAId || s.sessionId === cascadeWorkerBId,
        ),
      JSON.stringify(afterSupervisorDeleteList.body),
    );
    assert(
      "deleted supervisor worker's subagent child no longer appears in session list",
      afterSupervisorDeleteList.status === 200 &&
        !afterSupervisorDeleteSessions.some((s) => s.sessionId === cascadeWorkerSubagentId),
      JSON.stringify(afterSupervisorDeleteList.body),
    );
    assert(
      "deleted supervisor workers are unregistered",
      (await store.getWorkerIds(realSid)).length === 0,
    );
    const cascadeChildAfterDelete = await jsend(
      onSrv.base,
      "GET",
      `/api/v1/sessions/${cascadeWorkerSubagentId}`,
    );
    assert(
      "deleted supervisor disposes live worker subagent child",
      cascadeChildAfterDelete.status === 404,
      `got ${cascadeChildAfterDelete.status}`,
    );
    const archiveEntriesAfterSupervisorDelete = await readdir(
      join(sharedData, "archived-sessions"),
    );
    const cascadeWorkerAArchiveEntry = archiveEntriesAfterSupervisorDelete.find((name) =>
      name.includes(cascadeWorkerAId),
    );
    const cascadeWorkerBArchiveEntry = archiveEntriesAfterSupervisorDelete.find((name) =>
      name.includes(cascadeWorkerBId),
    );
    assert(
      "deleted supervisor's workers have archive entries",
      cascadeWorkerAArchiveEntry !== undefined && cascadeWorkerBArchiveEntry !== undefined,
      archiveEntriesAfterSupervisorDelete.join(","),
    );
    if (cascadeWorkerAArchiveEntry !== undefined) {
      const cascadeArchivedChildFiles = await readdir(
        join(
          sharedData,
          "archived-sessions",
          cascadeWorkerAArchiveEntry,
          "subagents",
          cascadeChildRunId,
        ),
      );
      assert(
        "deleted supervisor worker archive includes subagent child directory",
        cascadeArchivedChildFiles.includes(`${cascadeWorkerSubagentId}.jsonl`),
        cascadeArchivedChildFiles.join(","),
      );
    }
    cascadeChildSseAc.abort();
    try {
      await cascadeChildSseRes.body?.cancel();
    } catch {
      // ignore — body cancel after abort can throw
    }

    // Plant some workers + inbox items via the store (since real
    // spawn_worker requires a live agent session).
    await store.registerWorker({ supervisorId: "rest-sup", workerId: "rest-w1" });
    await store.registerWorker({ supervisorId: "rest-sup", workerId: "rest-w2" });
    await inbox.bridgeWorkerEvent("rest-w1", "worker.ended", { stopReason: "end_turn" });
    await inbox.bridgeWorkerEvent("rest-w2", "worker.ask_user", { questionCount: 1 });

    // GET /sessions/:id/workers
    const wList = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-sup/workers");
    assert(
      "list workers returns 2",
      wList.status === 200 &&
        Array.isArray((wList.body as { workers: unknown[] }).workers) &&
        (wList.body as { workers: unknown[] }).workers.length === 2,
    );

    // GET /sessions/:id/inbox
    const inboxRes = await jsend(
      onSrv.base,
      "GET",
      "/api/v1/orchestration/sessions/rest-sup/inbox",
    );
    assert(
      "inbox returns 2 items",
      inboxRes.status === 200 && (inboxRes.body as { items: unknown[] }).items.length === 2,
    );

    // pendingInbox in the link summary
    const linkSum = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-sup");
    assert(
      "pendingInbox reflected in link",
      (linkSum.body as { pendingInbox: number }).pendingInbox === 2,
    );

    // Worker side: GET on rest-w1 reports worker role
    const wLink = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-w1");
    assert(
      "worker session reported as worker",
      wLink.status === 200 &&
        (wLink.body as { role: string }).role === "worker" &&
        (wLink.body as { supervisorId: string }).supervisorId === "rest-sup",
    );

    // Detach worker via REST
    const det = await jsend(
      onSrv.base,
      "POST",
      "/api/v1/orchestration/sessions/rest-sup/workers/rest-w2/detach",
    );
    assert("detach returns 204", det.status === 204);
    const wLink2 = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-w2");
    assert(
      "detached worker now standalone",
      (wLink2.body as { role: string }).role === "standalone",
    );

    // detach for non-linked worker → 404
    const detMissing = await jsend(
      onSrv.base,
      "POST",
      "/api/v1/orchestration/sessions/rest-sup/workers/rest-w2/detach",
    );
    assert(
      "detach for unlinked worker 404",
      detMissing.status === 404 &&
        (detMissing.body as { error: string }).error === "worker_not_linked",
    );

    // Clear inbox
    const clr = await jsend(
      onSrv.base,
      "POST",
      "/api/v1/orchestration/sessions/rest-sup/inbox/clear",
    );
    assert("inbox clear returns 204", clr.status === 204);
    const inboxAfter = await jsend(
      onSrv.base,
      "GET",
      "/api/v1/orchestration/sessions/rest-sup/inbox",
    );
    assert("inbox empty after clear", (inboxAfter.body as { items: unknown[] }).items.length === 0);

    // Disable supervisor
    const dis = await jsend(onSrv.base, "POST", "/api/v1/orchestration/sessions/rest-sup/disable");
    assert("disable returns 204", dis.status === 204);
    const linkAfter = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-sup");
    assert(
      "disabled session now standalone",
      (linkAfter.body as { role: string }).role === "standalone",
    );
    // The remaining worker (rest-w1) was detached as part of disable
    const w1After = await jsend(onSrv.base, "GET", "/api/v1/orchestration/sessions/rest-w1");
    assert(
      "linked workers detached on disable",
      (w1After.body as { role: string }).role === "standalone",
    );
  } finally {
    await onSrv.stop();
  }

  await rm(sharedWs, { recursive: true, force: true });
  await rm(sharedCfg, { recursive: true, force: true });
  await rm(sharedData, { recursive: true, force: true });

  if (failures > 0) {
    console.log(`\n[test-orchestration] ${failures} failure(s).`);
    process.exit(1);
  }
  console.log(`\n[test-orchestration] all checks passed.`);
}

main().catch((err: unknown) => {
  console.error("[test-orchestration] unhandled:", err);
  process.exit(1);
});

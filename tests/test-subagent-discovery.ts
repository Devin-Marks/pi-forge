/**
 * Integration test for pi-subagents child-session discovery in the
 * server's session-registry.
 *
 * pi-subagents writes child sessions to
 * `<sessionDir>/<parentSessionId>/<runId>/<childId>.jsonl`. The
 * registry has to:
 *   1. Surface those children via `discoverSessionsOnDisk` with
 *      `parentSessionId` + `runId` set (so the sidebar can render
 *      a chevron dropdown grouping children under their parent).
 *   2. Resolve a child by its UUID via `findSessionLocation` (so
 *      cross-project resume-by-id works).
 *   3. Resume a child as a normal LiveSession via `resumeSession`
 *      (so clicking a SubagentResultCard's "Open" button hydrates the
 *      child's chat view).
 *   4. Continue to surface top-level (non-child) sessions alongside
 *      children — no regression on the existing happy path.
 *
 * The test fakes a child JSONL by hand with a minimal SDK-shaped
 * header. We don't need the pi-subagents plugin actually installed;
 * the registry treats any JSONL nested one level deeper than the
 * project session dir as a child.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

function piSubagentsTempRoot(): string {
  if (typeof process.getuid === "function")
    return join(tmpdir(), `pi-subagents-uid-${process.getuid()}`);
  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = process.env[key];
    if (value) return join(tmpdir(), `pi-subagents-user-${sanitizeTempScopeSegment(value)}`);
  }
  try {
    const username = userInfo().username;
    if (username) return join(tmpdir(), `pi-subagents-user-${sanitizeTempScopeSegment(username)}`);
  } catch {
    // Fall through to HOME-based scoping.
  }
  const envHomedir = process.env.USERPROFILE ?? process.env.HOME;
  if (envHomedir)
    return join(tmpdir(), `pi-subagents-home-${sanitizeTempScopeSegment(envHomedir)}`);
  try {
    const fallbackHomedir = homedir();
    if (fallbackHomedir)
      return join(tmpdir(), `pi-subagents-home-${sanitizeTempScopeSegment(fallbackHomedir)}`);
  } catch {
    // Fall through to shared last-resort scope.
  }
  return join(tmpdir(), "pi-subagents-shared");
}

function piSubagentsResultsDir(): string {
  return join(piSubagentsTempRoot(), "async-subagent-results");
}

function piSubagentsAsyncRunsDir(): string {
  return join(piSubagentsTempRoot(), "async-subagent-runs");
}

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
  dataDir: string;
  sessionDir: string;
}> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
  const sessionDir = join(workspacePath, ".pi", "sessions");
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = sessionDir;
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;
  return { workspacePath, configDir, dataDir, sessionDir };
}

/** Write a minimal SDK-shaped session JSONL header file at `path`. */
async function writeChildSessionFile(path: string, sessionId: string, cwd: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const header = {
    type: "session",
    version: 1,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  };
  await writeFile(path, JSON.stringify(header) + "\n", "utf8");
}

interface TestLive {
  session: {
    sessionId: string;
    sessionFile?: string;
    messages: unknown[];
    sessionManager: { appendMessage: (msg: unknown) => string };
    _emit?: (event: unknown) => void;
  };
  sessionId: string;
  clients: Set<{ id: string; send: (event: unknown) => void; close: () => void }>;
}
interface TestDiscovered {
  sessionId: string;
  path: string;
  parentSessionId?: string;
  runId?: string;
}
interface TestUnifiedSession {
  sessionId: string;
  parentSessionId?: string;
  runId?: string;
  isExternalLive?: boolean;
}
interface TestRegistry {
  createSession: (projectId: string, workspacePath: string) => Promise<TestLive>;
  disposeSession: (id: string) => Promise<boolean>;
  disposeAllSessions: () => Promise<void>;
  resumeSession: (id: string, projectId: string, workspacePath: string) => Promise<TestLive>;
  resumeSessionById: (id: string) => Promise<TestLive>;
  markActiveSubagentParent: (parentSessionId: string, runId?: string) => void;
  clearActiveSubagentParent: (parentSessionId: string) => void;
  discoverSessionsOnDisk: (projectId: string, workspacePath: string) => Promise<TestDiscovered[]>;
  listSessionsForProject: (
    projectId: string,
    workspacePath: string,
  ) => Promise<TestUnifiedSession[]>;
  findSessionLocation: (
    id: string,
  ) => Promise<{ projectId: string; workspacePath: string } | undefined>;
  deleteColdSession: (id: string) => Promise<"deleted" | "live" | "not_found">;
  getSession: (id: string) => TestLive | undefined;
  sessionCount: () => number;
}
interface TestProjectManager {
  createProject: (name: string, path: string) => Promise<{ id: string; path: string }>;
}
interface TestOrchestrationStore {
  enableSupervisor: (sessionId: string) => Promise<unknown>;
  registerWorker: (opts: { supervisorId: string; workerId: string }) => Promise<void>;
}

async function waitFor(condition: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function appendFixtureMessage(live: TestLive, text: string): void {
  live.session.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text, id: "stub-1" }],
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
}

async function main(): Promise<void> {
  const { workspacePath, sessionDir } = await setupEnv();
  console.log(`[test-subagent-discovery] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-subagent-discovery] SESSION_DIR=${sessionDir}`);

  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as TestRegistry;
  const pm = (await import(
    resolve(repoRoot, "packages/server/dist/project-manager.js")
  )) as unknown as TestProjectManager;
  const orchestrationStore = (await import(
    resolve(repoRoot, "packages/server/dist/orchestration/store.js")
  )) as unknown as TestOrchestrationStore;
  const buildModule = (await import(resolve(repoRoot, "packages/server/dist/index.js"))) as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };
  const fastify = await buildModule.buildServer();
  const listenAddr = await fastify.listen({ port: 0, host: "127.0.0.1" });

  // Register the project so findSessionLocation can locate children.
  const project = await pm.createProject("test-subagent-project", workspacePath);

  try {
    // 1. Parent session — created via the registry like any normal session.
    const parent = await registry.createSession(project.id, project.path);
    assert(
      "createSession returns a parent session with a sessionId",
      typeof parent.sessionId === "string" && parent.sessionId.length > 0,
    );
    // The SDK only flushes JSONL once a message is appended (matches
    // the live-test pattern in tests/test-session.ts). Inject a
    // minimal assistant message so the parent's JSONL header lands on
    // disk and `discoverSessionsOnDisk` can see it.
    appendFixtureMessage(parent, "test fixture");

    // 2. Fake a pi-subagents child JSONL nested under the parent's id.
    //    Layout: <sessionDir>/<projectId>/<parentId>/<runId>/<childId>.jsonl
    const runId = "run-" + randomUUID().slice(0, 8);
    const childA = randomUUID();
    const childB = randomUUID();
    const projectSessionDir = join(sessionDir, project.id);
    const childAPath = join(projectSessionDir, parent.sessionId, runId, `${childA}.jsonl`);
    const childBPath = join(projectSessionDir, parent.sessionId, runId, `${childB}.jsonl`);
    await writeChildSessionFile(childAPath, childA, project.path);
    await writeChildSessionFile(childBPath, childB, project.path);

    // 3. discoverSessionsOnDisk surfaces the parent AND both children.
    const discovered = await registry.discoverSessionsOnDisk(project.id, project.path);
    const ids = discovered.map((d) => d.sessionId).sort();
    const expectedIds = [parent.sessionId, childA, childB].sort();
    assert(
      "discoverSessionsOnDisk includes parent + 2 children",
      JSON.stringify(ids) === JSON.stringify(expectedIds),
      `got ${ids.join(",")} expected ${expectedIds.join(",")}`,
    );

    const childAEntry = discovered.find((d) => d.sessionId === childA);
    assert(
      "child A is tagged with parentSessionId",
      childAEntry?.parentSessionId === parent.sessionId,
      `parentSessionId=${childAEntry?.parentSessionId}`,
    );
    assert(
      "child A is tagged with the runId",
      childAEntry?.runId === runId,
      `runId=${childAEntry?.runId}`,
    );

    const parentEntry = discovered.find((d) => d.sessionId === parent.sessionId);
    assert(
      "parent session has no parentSessionId / runId tagging",
      parentEntry?.parentSessionId === undefined && parentEntry?.runId === undefined,
    );

    // 3b. Mixed hierarchy regression: orchestration workers are top-level
    // sessions whose supervisor link is overlaid from session-orchestration.json,
    // while pi-subagents children are discovered from disk below their parent.
    // When a worker uses a subagent, both links must coexist so the sidebar can
    // render: orchestrator -> worker -> subagent.
    const orchestrator = await registry.createSession(project.id, project.path);
    appendFixtureMessage(orchestrator, "orchestrator fixture");
    const worker = await registry.createSession(project.id, project.path);
    appendFixtureMessage(worker, "worker fixture");
    await orchestrationStore.enableSupervisor(orchestrator.sessionId);
    await orchestrationStore.registerWorker({
      supervisorId: orchestrator.sessionId,
      workerId: worker.sessionId,
    });
    const workerSubagentId = randomUUID();
    const workerSubagentRunId = "run-" + randomUUID().slice(0, 8);
    await writeChildSessionFile(
      join(projectSessionDir, worker.sessionId, workerSubagentRunId, `${workerSubagentId}.jsonl`),
      workerSubagentId,
      project.path,
    );
    const mixedList = await registry.listSessionsForProject(project.id, project.path);
    const workerRow = mixedList.find((s) => s.sessionId === worker.sessionId);
    const workerSubagentRow = mixedList.find((s) => s.sessionId === workerSubagentId);
    assert(
      "orchestration worker is nested under orchestrator in unified list",
      workerRow?.parentSessionId === orchestrator.sessionId,
      `parentSessionId=${workerRow?.parentSessionId}`,
    );
    assert(
      "worker subagent remains nested under the worker in unified list",
      workerSubagentRow?.parentSessionId === worker.sessionId &&
        workerSubagentRow?.runId === workerSubagentRunId,
      `parentSessionId=${workerSubagentRow?.parentSessionId} runId=${workerSubagentRow?.runId}`,
    );

    // 4. findSessionLocation resolves the child to its project.
    const loc = await registry.findSessionLocation(childA);
    assert(
      "findSessionLocation finds the child's project",
      loc?.projectId === project.id && loc?.workspacePath === project.path,
      `loc=${JSON.stringify(loc)}`,
    );

    // 5. Externally-active child safety: opening a child while the
    //    pi-subagents-owned process is still writing it must NOT
    //    create a pi-forge AgentSession for the same JSONL. The stream
    //    route blocks live SSE resume with 409, while /messages offers
    //    a read-only snapshot for the chat view.
    registry.markActiveSubagentParent(parent.sessionId);
    const activeList = await registry.listSessionsForProject(project.id, project.path);
    const activeChild = activeList.find((s) => s.sessionId === childB);
    assert(
      "externally active child is marked isExternalLive in unified list",
      activeChild?.isExternalLive === true,
      `isExternalLive=${activeChild?.isExternalLive}`,
    );
    let blockedResume = false;
    try {
      await registry.resumeSessionById(childB);
    } catch (err) {
      blockedResume = err instanceof Error && err.name === "ExternallyActiveSubagentChildError";
    }
    assert("resumeSessionById blocks externally active child", blockedResume);
    assert(
      "blocked externally active child was not inserted into live registry",
      registry.getSession(childB) === undefined,
    );
    const streamBlocked = await fetch(`${listenAddr}/api/v1/sessions/${childB}/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    assert(
      "stream route returns 409 for externally active child",
      streamBlocked.status === 409,
      `status=${streamBlocked.status}`,
    );
    const streamBody = (await streamBlocked.json()) as { error?: string };
    assert(
      "stream 409 explains external subagent ownership",
      streamBody.error === "subagent_child_externally_active",
      `body=${JSON.stringify(streamBody)}`,
    );
    const messagesSnapshot = await fetch(`${listenAddr}/api/v1/sessions/${childB}/messages`);
    assert(
      "messages route returns read-only snapshot for externally active child",
      messagesSnapshot.status === 200,
      `status=${messagesSnapshot.status}`,
    );
    const messagesBody = (await messagesSnapshot.json()) as { messages?: unknown };
    assert("read-only snapshot has messages array", Array.isArray(messagesBody.messages));
    assert(
      "read-only snapshot did not live-resume the child",
      registry.getSession(childB) === undefined,
    );

    const resultsDir = piSubagentsResultsDir();
    await mkdir(resultsDir, { recursive: true });
    await writeFile(
      join(resultsDir, `${runId}.json`),
      `${JSON.stringify({
        id: runId,
        runId,
        sessionId: parent.sessionId,
        success: true,
        summary: "done",
        results: [{ agent: "worker", success: true, output: "done", sessionFile: childBPath }],
      })}\n`,
    );
    const parentGotNotify = await waitFor(() =>
      parent.session.messages.some((message) => {
        if (typeof message !== "object" || message === null) return false;
        const m = message as { role?: unknown; customType?: unknown; content?: unknown };
        return (
          m.role === "custom" &&
          m.customType === "subagent-notify" &&
          typeof m.content === "string" &&
          m.content.includes("Background task completed")
        );
      }),
    );
    assert("async result file is bridged into parent custom notification", parentGotNotify);
    const completedList = await registry.listSessionsForProject(project.id, project.path);
    const completedChild = completedList.find((s) => s.sessionId === childB);
    assert(
      "authoritative result file clears external-live child state",
      completedChild?.isExternalLive !== true,
      `isExternalLive=${completedChild?.isExternalLive}`,
    );
    const streamAfterComplete = await fetch(`${listenAddr}/api/v1/sessions/${childB}/stream`, {
      headers: { Accept: "text/event-stream" },
    });
    assert(
      "stream route no longer blocks after authoritative result file",
      streamAfterComplete.status === 200,
      `status=${streamAfterComplete.status}`,
    );
    await streamAfterComplete.body?.cancel();
    assert(
      "stream after completion resumes the child normally",
      registry.getSession(childB) !== undefined,
    );
    await registry.disposeSession(childB);

    const statusOnlyRunId = "run-" + randomUUID().slice(0, 8);
    const statusOnlyChildId = randomUUID();
    const statusOnlyChildPath = join(
      projectSessionDir,
      parent.sessionId,
      statusOnlyRunId,
      `${statusOnlyChildId}.jsonl`,
    );
    await writeChildSessionFile(statusOnlyChildPath, statusOnlyChildId, project.path);
    const statusOnlyDir = join(piSubagentsAsyncRunsDir(), statusOnlyRunId);
    await mkdir(statusOnlyDir, { recursive: true });
    await writeFile(
      join(statusOnlyDir, "status.json"),
      `${JSON.stringify({
        runId: statusOnlyRunId,
        sessionId: parent.sessionId,
        state: "running",
        summary: "status-only running",
        sessionFile: statusOnlyChildPath,
        steps: [{ agent: "worker", status: "running", sessionFile: statusOnlyChildPath }],
      })}\n`,
    );
    const statusOnlyActiveList = await registry.listSessionsForProject(project.id, project.path);
    const statusOnlyActiveChild = statusOnlyActiveList.find(
      (s) => s.sessionId === statusOnlyChildId,
    );
    assert(
      "running status.json marks child externally live without in-memory parent state",
      statusOnlyActiveChild?.isExternalLive === true,
      `isExternalLive=${statusOnlyActiveChild?.isExternalLive}`,
    );
    const statusOnlySummary = (await (
      await fetch(`${listenAddr}/api/v1/sessions/${statusOnlyChildId}`)
    ).json()) as { isExternalLive?: boolean; isLive?: boolean };
    assert(
      "session metadata exposes status-only external live child",
      statusOnlySummary.isExternalLive === true && statusOnlySummary.isLive === false,
      `summary=${JSON.stringify(statusOnlySummary)}`,
    );
    const statusOnlySessionCount = registry.sessionCount();
    assert(
      "session metadata does not live-resume status-only child",
      registry.getSession(statusOnlyChildId) === undefined &&
        registry.sessionCount() === statusOnlySessionCount,
      `sessionCount=${registry.sessionCount()} before=${statusOnlySessionCount}`,
    );
    let directResumeBlocked = false;
    try {
      await registry.resumeSession(statusOnlyChildId, project.id, project.path);
    } catch (err) {
      directResumeBlocked =
        err instanceof Error && err.name === "ExternallyActiveSubagentChildError";
    }
    assert(
      "direct resumeSession blocks status-only externally active child",
      directResumeBlocked && registry.getSession(statusOnlyChildId) === undefined,
      `sessionCount=${registry.sessionCount()} before=${statusOnlySessionCount}`,
    );
    const statusOnlyStreamBlocked = await fetch(
      `${listenAddr}/api/v1/sessions/${statusOnlyChildId}/stream`,
      { headers: { Accept: "text/event-stream" } },
    );
    assert(
      "stream route returns 409 for status-only externally active child",
      statusOnlyStreamBlocked.status === 409,
      `status=${statusOnlyStreamBlocked.status}`,
    );
    await statusOnlyStreamBlocked.body?.cancel();
    const statusOnlyMessages = await fetch(
      `${listenAddr}/api/v1/sessions/${statusOnlyChildId}/messages`,
    );
    assert(
      "messages route returns read-only snapshot for status-only active child",
      statusOnlyMessages.status === 200,
      `status=${statusOnlyMessages.status}`,
    );
    const statusOnlyTree = await fetch(`${listenAddr}/api/v1/sessions/${statusOnlyChildId}/tree`);
    assert(
      "tree route rejects status-only active child without live-resume",
      statusOnlyTree.status === 409,
      `status=${statusOnlyTree.status}`,
    );
    const statusOnlyContext = await fetch(
      `${listenAddr}/api/v1/sessions/${statusOnlyChildId}/context`,
    );
    assert(
      "context route rejects status-only active child without live-resume",
      statusOnlyContext.status === 409,
      `status=${statusOnlyContext.status}`,
    );
    const statusOnlyCompactions = await fetch(
      `${listenAddr}/api/v1/sessions/${statusOnlyChildId}/compactions`,
    );
    assert(
      "compactions route rejects status-only active child without live-resume",
      statusOnlyCompactions.status === 409,
      `status=${statusOnlyCompactions.status}`,
    );
    const statusOnlyTurnDiff = await fetch(
      `${listenAddr}/api/v1/sessions/${statusOnlyChildId}/turn-diff`,
    );
    assert(
      "turn-diff route rejects status-only active child without live-resume",
      statusOnlyTurnDiff.status === 409,
      `status=${statusOnlyTurnDiff.status}`,
    );
    const statusOnlyAfterViewList = await registry.listSessionsForProject(project.id, project.path);
    const statusOnlyAfterViewChild = statusOnlyAfterViewList.find(
      (s) => s.sessionId === statusOnlyChildId,
    );
    assert(
      "status-only UI view routes did not live-resume child",
      registry.getSession(statusOnlyChildId) === undefined &&
        registry.sessionCount() === statusOnlySessionCount &&
        statusOnlyAfterViewChild?.isExternalLive === true,
      `sessionCount=${registry.sessionCount()} before=${statusOnlySessionCount} isExternalLive=${statusOnlyAfterViewChild?.isExternalLive}`,
    );
    await writeFile(
      join(statusOnlyDir, "status.json"),
      `${JSON.stringify({
        runId: statusOnlyRunId,
        sessionId: parent.sessionId,
        state: "complete",
        summary: "status-only done",
        sessionFile: statusOnlyChildPath,
        steps: [{ agent: "worker", status: "completed", sessionFile: statusOnlyChildPath }],
      })}\n`,
    );
    const statusOnlyCompletedList = await registry.listSessionsForProject(project.id, project.path);
    const statusOnlyCompletedChild = statusOnlyCompletedList.find(
      (s) => s.sessionId === statusOnlyChildId,
    );
    assert(
      "terminal status.json clears status-only external-live child state",
      statusOnlyCompletedChild?.isExternalLive !== true,
      `isExternalLive=${statusOnlyCompletedChild?.isExternalLive}`,
    );
    const statusOnlyStreamAfterComplete = await fetch(
      `${listenAddr}/api/v1/sessions/${statusOnlyChildId}/stream`,
      { headers: { Accept: "text/event-stream" } },
    );
    assert(
      "stream route allows status-only child after terminal status.json",
      statusOnlyStreamAfterComplete.status === 200,
      `status=${statusOnlyStreamAfterComplete.status}`,
    );
    await statusOnlyStreamAfterComplete.body?.cancel();
    await registry.disposeSession(statusOnlyChildId);

    const statusRunId = "run-" + randomUUID().slice(0, 8);
    const statusChildId = randomUUID();
    const statusChildPath = join(
      projectSessionDir,
      parent.sessionId,
      statusRunId,
      `${statusChildId}.jsonl`,
    );
    await writeChildSessionFile(statusChildPath, statusChildId, project.path);
    registry.markActiveSubagentParent(parent.sessionId, statusRunId);
    const statusActiveList = await registry.listSessionsForProject(project.id, project.path);
    const statusActiveChild = statusActiveList.find((s) => s.sessionId === statusChildId);
    assert(
      "status-tracked async child is marked externally live",
      statusActiveChild?.isExternalLive === true,
      `isExternalLive=${statusActiveChild?.isExternalLive}`,
    );
    const statusDir = join(piSubagentsAsyncRunsDir(), statusRunId);
    await mkdir(statusDir, { recursive: true });
    await writeFile(
      join(statusDir, "status.json"),
      `${JSON.stringify({
        runId: statusRunId,
        sessionId: parent.sessionId,
        state: "complete",
        summary: "status done",
        sessionFile: statusChildPath,
        steps: [{ agent: "worker", status: "completed", sessionFile: statusChildPath }],
      })}\n`,
    );
    const parentGotStatusNotify = await waitFor(() =>
      parent.session.messages.some((message) => {
        if (typeof message !== "object" || message === null) return false;
        const m = message as { role?: unknown; customType?: unknown; content?: unknown };
        return (
          m.role === "custom" &&
          m.customType === "subagent-notify" &&
          typeof m.content === "string" &&
          m.content.includes("status done")
        );
      }),
    );
    assert(
      "terminal status.json is bridged into parent custom notification",
      parentGotStatusNotify,
    );
    const statusCompletedList = await registry.listSessionsForProject(project.id, project.path);
    const statusCompletedChild = statusCompletedList.find((s) => s.sessionId === statusChildId);
    assert(
      "terminal status.json clears external-live child state",
      statusCompletedChild?.isExternalLive !== true,
      `isExternalLive=${statusCompletedChild?.isExternalLive}`,
    );

    const parentSseEvents: unknown[] = [];
    const parentSseClient = {
      id: "test-parent-sse",
      send: (event: unknown) => parentSseEvents.push(event),
      close: () => undefined,
    };
    parent.clients.add(parentSseClient);
    const toolResultRunId = "run-" + randomUUID().slice(0, 8);
    const toolResultChildId = randomUUID();
    const toolResultChildPath = join(
      projectSessionDir,
      parent.sessionId,
      toolResultRunId,
      `${toolResultChildId}.jsonl`,
    );
    await writeChildSessionFile(toolResultChildPath, toolResultChildId, project.path);
    parent.session._emit?.({
      type: "tool_result",
      toolName: "subagent",
      toolCallId: "call-subagent-async",
      input: {},
      content: [{ type: "text", text: "Async started" }],
      isError: false,
      details: {
        mode: "single",
        runId: toolResultRunId,
        asyncId: toolResultRunId,
        asyncDir: join(piSubagentsAsyncRunsDir(), toolResultRunId),
        results: [],
      },
    });
    const toolResultStatusDir = join(piSubagentsAsyncRunsDir(), toolResultRunId);
    await mkdir(toolResultStatusDir, { recursive: true });
    await writeFile(
      join(toolResultStatusDir, "status.json"),
      `${JSON.stringify({
        runId: toolResultRunId,
        sessionId: parent.sessionId,
        state: "complete",
        summary: "tool_result parent delivery done",
        sessionFile: toolResultChildPath,
        steps: [{ agent: "worker", status: "completed", sessionFile: toolResultChildPath }],
      })}\n`,
    );
    const parentGotSseNotify = await waitFor(() =>
      parentSseEvents.some((event) => {
        if (typeof event !== "object" || event === null) return false;
        const e = event as {
          type?: unknown;
          message?: { customType?: unknown; content?: unknown };
        };
        return (
          e.type === "message_end" &&
          e.message?.customType === "subagent-notify" &&
          typeof e.message.content === "string" &&
          e.message.content.includes("tool_result parent delivery done")
        );
      }),
    );
    assert("async tool_result terminal status is delivered to parent SSE chat", parentGotSseNotify);
    parent.clients.delete(parentSseClient);
    await rm(resultsDir, { recursive: true, force: true });
    await rm(piSubagentsAsyncRunsDir(), { recursive: true, force: true });

    // 6. resumeSession opens the child as a LiveSession (registry hit)
    //    once called directly for a child that is not under test for
    //    external ownership.
    const resumed = await registry.resumeSession(childA, project.id, project.path);
    assert(
      "resumeSession returns a LiveSession for the child",
      resumed.sessionId === childA,
      `got ${resumed.sessionId}`,
    );

    // 7. REALISTIC pi-subagents layout: the plugin's
    // `getSubagentSessionRoot` names the child dir using the parent
    // FILE's full basename (timestamp + id), not the bare parent id.
    // The discovery has to map basename → parent's actual sessionId
    // via the top-level scan, otherwise the child's `parentSessionId`
    // ends up as the timestamped string and SessionList grouping
    // silently fails. This is the regression that motivated the
    // basenameToParentId map; without it, this assertion would tag
    // the child with `2026-...-realistic-parent` instead of
    // `realistic-parent`.
    const realisticParentId = "realistic-parent-" + randomUUID().slice(0, 6);
    const realisticBasename = "2026-05-07T12-34-56-000Z_" + realisticParentId;
    const realisticParentPath = join(projectSessionDir, `${realisticBasename}.jsonl`);
    await writeChildSessionFile(realisticParentPath, realisticParentId, project.path);
    const realisticRunId = "run-" + randomUUID().slice(0, 6);
    const realisticChildId = randomUUID();
    const realisticChildPath = join(
      projectSessionDir,
      realisticBasename, // dir named after parent's full basename, NOT just the id
      realisticRunId,
      `${realisticChildId}.jsonl`,
    );
    await writeChildSessionFile(realisticChildPath, realisticChildId, project.path);
    const rediscovered = await registry.discoverSessionsOnDisk(project.id, project.path);
    const realisticChildEntry = rediscovered.find((d) => d.sessionId === realisticChildId);
    assert(
      "realistic-layout child was discovered",
      realisticChildEntry !== undefined,
      `child id=${realisticChildId} not in ${rediscovered.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "realistic-layout child's parentSessionId resolves via basename map",
      realisticChildEntry?.parentSessionId === realisticParentId,
      `got parentSessionId=${realisticChildEntry?.parentSessionId} expected=${realisticParentId}`,
    );

    // 8a. DEEP layout (parallel/chain mode):
    //     <basename>/<runId>/run-N/session.jsonl. Three dir levels
    //     under the parent — observed in the wild on real
    //     pi-subagents installs. Discovery has to walk past the runId
    //     dir to find the actual session.jsonl.
    const deepParentId = "deep-parent-" + randomUUID().slice(0, 6);
    const deepBasename = "2026-05-07T14-00-00-000Z_" + deepParentId;
    const deepParentPath = join(projectSessionDir, `${deepBasename}.jsonl`);
    await writeChildSessionFile(deepParentPath, deepParentId, project.path);
    const deepRunId = randomUUID().slice(0, 8);
    const deepChildId = randomUUID();
    const deepChildPath = join(
      projectSessionDir,
      deepBasename,
      deepRunId,
      "run-0",
      `${deepChildId}.jsonl`,
    );
    await writeChildSessionFile(deepChildPath, deepChildId, project.path);
    const reDeep = await registry.discoverSessionsOnDisk(project.id, project.path);
    const deepChildEntry = reDeep.find((d) => d.sessionId === deepChildId);
    assert(
      "deep-layout child (basename/runId/run-N/session.jsonl) was discovered",
      deepChildEntry !== undefined,
      `child id=${deepChildId} not in ${reDeep.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "deep-layout child's parentSessionId resolves via basename map",
      deepChildEntry?.parentSessionId === deepParentId,
      `got parentSessionId=${deepChildEntry?.parentSessionId} expected=${deepParentId}`,
    );
    assert(
      "deep-layout child's runId reflects the full intermediate path",
      deepChildEntry?.runId === `${deepRunId}/run-0` ||
        deepChildEntry?.runId === `${deepRunId}\\run-0`,
      `got runId=${deepChildEntry?.runId}`,
    );

    // 8b. FLAT layout (no runId subdir): some pi-subagents run modes
    // write children directly under <parentBasename>/, not under
    // <parentBasename>/<runId>/. Discovery must surface these too.
    const flatParentId = "flat-parent-" + randomUUID().slice(0, 6);
    const flatBasename = "2026-05-07T13-00-00-000Z_" + flatParentId;
    const flatParentPath = join(projectSessionDir, `${flatBasename}.jsonl`);
    await writeChildSessionFile(flatParentPath, flatParentId, project.path);
    const flatChildId = randomUUID();
    const flatChildPath = join(projectSessionDir, flatBasename, `${flatChildId}.jsonl`);
    await writeChildSessionFile(flatChildPath, flatChildId, project.path);
    const reFlat = await registry.discoverSessionsOnDisk(project.id, project.path);
    const flatChildEntry = reFlat.find((d) => d.sessionId === flatChildId);
    assert(
      "flat-layout child (no runId subdir) was discovered",
      flatChildEntry !== undefined,
      `child id=${flatChildId} not in ${reFlat.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "flat-layout child's parentSessionId resolves and runId is undefined",
      flatChildEntry?.parentSessionId === flatParentId && flatChildEntry?.runId === undefined,
      `parentSessionId=${flatChildEntry?.parentSessionId} runId=${flatChildEntry?.runId}`,
    );

    // 9. Cascade-delete: deleting a parent session also wipes its
    // pi-subagents sibling directory and any nested children, so the
    // sidebar doesn't accumulate orphan child sessions whose parent
    // is gone. We use the deep-layout fixture because it exercises
    // the full <basename>/<runId>/run-N/<child>.jsonl tree the
    // recursive rm has to clear.
    //
    // We ALSO resume the deep child first so it's a live registry
    // entry (matching the bug case: user opened a sub-agent session
    // in the UI, then deleted its parent). The cascade has to dispose
    // the live LiveSession AND remove the JSONL — without the
    // dispose, the registry holds a zombie pointing at a deleted
    // file and any attached SSE clients keep emitting events that
    // can't be persisted.
    await registry.resumeSession(deepChildId, project.id, project.path);
    assert(
      "deep child is live in the registry before cascade",
      registry.getSession(deepChildId) !== undefined,
    );
    const cascadeStatus = await registry.deleteColdSession(deepParentId);
    assert("deleteColdSession on the deep parent returns 'deleted'", cascadeStatus === "deleted");
    assert(
      "deep child's LiveSession was disposed by the cascade",
      registry.getSession(deepChildId) === undefined,
    );
    const reAfterCascade = await registry.discoverSessionsOnDisk(project.id, project.path);
    assert(
      "deep-layout child is gone after parent delete (cascade)",
      reAfterCascade.find((d) => d.sessionId === deepChildId) === undefined,
      `child still discovered: ${reAfterCascade.map((d) => d.sessionId).join(",")}`,
    );
    assert(
      "deep-layout parent is gone after parent delete",
      reAfterCascade.find((d) => d.sessionId === deepParentId) === undefined,
    );
  } finally {
    await registry.disposeAllSessions();
    await fastify.close();
    // Clean every temp dir we created. Safe to ignore failures —
    // mkdtemp dirs are isolated per test run.
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-subagent-discovery] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-subagent-discovery] PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

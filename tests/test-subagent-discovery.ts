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
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

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
    sessionManager: { appendMessage: (msg: unknown) => string };
  };
  sessionId: string;
}
interface TestDiscovered {
  sessionId: string;
  path: string;
  parentSessionId?: string;
  runId?: string;
}
interface TestRegistry {
  createSession: (projectId: string, workspacePath: string) => Promise<TestLive>;
  disposeSession: (id: string) => Promise<boolean>;
  disposeAllSessions: () => Promise<void>;
  resumeSession: (id: string, projectId: string, workspacePath: string) => Promise<TestLive>;
  discoverSessionsOnDisk: (projectId: string, workspacePath: string) => Promise<TestDiscovered[]>;
  findSessionLocation: (
    id: string,
  ) => Promise<{ projectId: string; workspacePath: string } | undefined>;
}
interface TestProjectManager {
  createProject: (name: string, path: string) => Promise<{ id: string; path: string }>;
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
    parent.session.sessionManager.appendMessage({
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

    // 4. findSessionLocation resolves the child to its project.
    const loc = await registry.findSessionLocation(childA);
    assert(
      "findSessionLocation finds the child's project",
      loc?.projectId === project.id && loc?.workspacePath === project.path,
      `loc=${JSON.stringify(loc)}`,
    );

    // 5. resumeSession opens the child as a LiveSession (registry hit).
    const resumed = await registry.resumeSession(childA, project.id, project.path);
    assert(
      "resumeSession returns a LiveSession for the child",
      resumed.sessionId === childA,
      `got ${resumed.sessionId}`,
    );
  } finally {
    await registry.disposeAllSessions();
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

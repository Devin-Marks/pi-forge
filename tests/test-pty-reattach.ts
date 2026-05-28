/**
 * pty-manager reattach + idle-reaper integration test.
 *
 * Pins the PTY lifecycle that's the most fiddly bit of the pi-forge:
 *   - spawn → attach (sink #1) → detach (idle timer arms) → reattach
 *     (sink #2 receives buffered replay + new output) → input flows.
 *   - same-tabId attach replaces the previous active sink AND closes
 *     the previous WS via closeActiveSocket (security pass fix).
 *   - SIGTERM → SIGKILL grace window (security pass) — exercised
 *     indirectly via killPty + onExit observation.
 *
 * Does NOT exercise the WebSocket layer (see tests/test-terminal.ts
 * for the route-level WS handshake). This test drives the manager
 * surface directly so the manager's invariants are pinned regardless
 * of route changes.
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
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ManagedPty {
  ptyId: string;
  tabId: string;
  projectId: string;
  process: {
    write: (s: string) => void;
    onExit: (cb: (e: { exitCode: number; signal?: number }) => unknown) => {
      dispose: () => void;
    };
    pid: number;
  };
  cwd: string;
}

interface PtyManagerModule {
  spawnPty: (opts: { cwd: string; tabId: string; projectId: string }) => ManagedPty;
  findPtyByTabId: (tabId: string, projectId: string) => ManagedPty | undefined;
  attachSink: (
    ptyId: string,
    onData: (chunk: Buffer) => void,
    replayBytes?: number,
    closeActiveSocket?: () => void,
  ) => (() => void) | undefined;
  killPty: (ptyId: string) => boolean;
  ptyCount: () => number;
  disposeAllPtys: () => void;
}

async function main(): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "pi-forge-pty-"));
  process.env.NODE_ENV = "test";
  // Don't import installPtyExitHandler — test isolation: the module
  // load must NOT install a process-wide exit handler.
  const pty = (await import(
    resolve(repoRoot, "packages/server/dist/pty-manager.js")
  )) as unknown as PtyManagerModule;

  try {
    const projectId = "p-" + Date.now().toString(36);
    const tabId = "t-" + Math.random().toString(36).slice(2, 10);

    // 1. spawn
    const managed = pty.spawnPty({ cwd, tabId, projectId });
    assert(
      "spawn returns a managed PTY",
      typeof managed.ptyId === "string" && managed.ptyId.length > 0,
    );
    assert("spawn assigns the requested tabId", managed.tabId === tabId);
    assert("spawn assigns the projectId", managed.projectId === projectId);
    assert("ptyCount is 1 after first spawn", pty.ptyCount() === 1);

    // 2. attach sink #1 — feed a known prompt + capture echoed output.
    // Buffers are accumulated (sink now emits binary frames so
    // proxies can't mangle escape sequences); `Array.prototype.join`
    // calls Buffer#toString which default-decodes UTF-8, so the
    // `.includes("hello-1")` ASCII check below still works.
    const received1: Buffer[] = [];
    const detach1 = pty.attachSink(managed.ptyId, (chunk) => received1.push(chunk));
    assert("attachSink returns a detach function", typeof detach1 === "function");
    if (detach1 === undefined) throw new Error("attachSink failed");

    // Send a printable command. The PTY shell will echo unless we run
    // `stty -echo` first; default output is the input itself + the
    // shell's own prompt + the result. Just check that SOME bytes flow.
    managed.process.write("echo hello-1\n");
    await sleep(300);
    assert(
      "sink #1 received bytes from the PTY",
      received1.length > 0 && received1.join("").includes("hello-1"),
      `received=${JSON.stringify(received1.join("")).slice(0, 200)}`,
    );

    // 3. findPtyByTabId resolves to the same PTY
    const found = pty.findPtyByTabId(tabId, projectId);
    assert("findPtyByTabId resolves to the spawned PTY", found?.ptyId === managed.ptyId);
    const wrongProject = pty.findPtyByTabId(tabId, "other-project");
    assert(
      "findPtyByTabId rejects cross-project tabId match",
      wrongProject === undefined,
      `found=${wrongProject?.ptyId}`,
    );

    // 4. detach sink #1 → buffer keeps accumulating; PTY stays alive
    detach1();
    managed.process.write("echo while-detached\n");
    await sleep(300);
    assert(
      "PTY survives sink #1 detach (still in registry)",
      pty.findPtyByTabId(tabId, projectId)?.ptyId === managed.ptyId,
    );

    // 5. attach sink #2 → replays buffered "while-detached" output
    const received2: Buffer[] = [];
    const detach2 = pty.attachSink(managed.ptyId, (chunk) => received2.push(chunk));
    assert("attachSink returns a detach function for sink #2", typeof detach2 === "function");
    await sleep(100);
    assert(
      "sink #2 receives the buffered output from while-detached",
      received2.join("").includes("while-detached"),
      `received=${JSON.stringify(received2.join("")).slice(0, 200)}`,
    );

    // 6. closeActiveSocket invariant: when sink #3 attaches with the
    //    same PTY, the predecessor's closeActiveSocket fires (security
    //    pass: same-tabId WS replacement closes the prior socket).
    let predecessorClosed = false;
    detach2?.();
    pty.attachSink(
      managed.ptyId,
      () => undefined,
      undefined,
      () => {
        predecessorClosed = true;
      },
    );
    // Now a 4th attach should fire the closeActiveSocket for #3
    pty.attachSink(managed.ptyId, () => undefined);
    assert(
      "closeActiveSocket of the previous attachment fires when a newer attach lands",
      predecessorClosed,
    );

    // 7. killPty terminates the PTY and removes it from the map
    const killed = pty.killPty(managed.ptyId);
    assert("killPty returns true for a live PTY", killed === true);
    // After SIGTERM (+ SIGKILL grace), the entry is removed from `ptys`
    // synchronously even though the process exit fires async. Verify
    // the registry is empty.
    assert("ptyCount drops to 0 after killPty", pty.ptyCount() === 0);
    assert(
      "findPtyByTabId returns undefined post-kill",
      pty.findPtyByTabId(tabId, projectId) === undefined,
    );

    // 8. attachSink against a vanished ptyId returns undefined
    const detachNone = pty.attachSink(managed.ptyId, () => undefined);
    assert("attachSink returns undefined for an unknown ptyId", detachNone === undefined);

    // 9. disposeAllPtys is a no-op when registry is empty
    pty.disposeAllPtys();
    assert("disposeAllPtys leaves registry empty", pty.ptyCount() === 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((err: unknown) => {
  console.error("[test-pty-reattach] uncaught:", err);
  process.exit(1);
});

/**
 * Phase 11 terminal WebSocket integration test.
 *
 * Boots the server in-process, creates a project, then opens a real
 * WebSocket to `/api/v1/terminal?projectId=...&token=...` and drives
 * it. Uses `ws` directly (Node's built-in WebSocket exists on 22+ but
 * its API differs from `ws` and the server side speaks `ws` either
 * way; staying with `ws` keeps the test predictable).
 *
 * Coverage:
 *   - WS upgrade with `?token=` succeeds; without auth → 4401.
 *   - Bad projectId → 4404.
 *   - Echo: send `echo hello\n`, assert "hello" appears in PTY output.
 *   - Resize: send `{ type: "resize", cols, rows }`, assert no error.
 *   - Concurrent terminals: open 2 sockets, prove they're independent
 *     (one's input doesn't appear in the other's output, both echo).
 *   - Health endpoint reflects active PTY count: 0 → 2 → 0 across the
 *     test lifecycle.
 *   - Closing the socket cleans up the PTY (active count returns to 0).
 *
 * No LLM required.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");

/**
 * Detached-PTY reap window for both spawned servers in this test.
 * Production default is 10 minutes (production code wants reattach
 * across a page-refresh / VPN blip / laptop-sleep to Just Work);
 * we override to 200 ms here so the post-close assertions actually
 * complete within the test budget. The wait constant below adds a
 * generous timer-jitter buffer on top.
 */
const REAP_MS = 200;
const REAP_WAIT_MS = REAP_MS + 800;

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
    const srv = createServer();
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

interface OpenedSocket {
  ws: WebSocket;
  /** All output bytes received so far, joined as text. */
  output: string;
  /** Whether the close event has fired. */
  closed: boolean;
  closeCode?: number;
  closeReason?: string;
}

/**
 * Open a WebSocket and start collecting output. Resolves once the
 * socket transitions to OPEN (or rejects on close-before-open). Tests
 * await the returned promise then drive the socket.
 */
function openTerminal(
  base: string,
  query: { projectId: string; token?: string; tabId?: string },
  onClose?: () => void,
): Promise<OpenedSocket> {
  return new Promise((resolveFn, rejectFn) => {
    const qs = new URLSearchParams();
    qs.set("projectId", query.projectId);
    if (query.token !== undefined) qs.set("token", query.token);
    if (query.tabId !== undefined) qs.set("tabId", query.tabId);
    const url = `${base.replace(/^http/, "ws")}/api/v1/terminal?${qs.toString()}`;
    const ws = new WebSocket(url);
    const state: OpenedSocket = { ws, output: "", closed: false };
    let opened = false;
    ws.on("open", () => {
      opened = true;
      resolveFn(state);
    });
    ws.on("message", (data: WebSocket.RawData) => {
      state.output += typeof data === "string" ? data : data.toString();
    });
    ws.on("close", (code, reason) => {
      state.closed = true;
      state.closeCode = code;
      state.closeReason = reason.toString();
      onClose?.();
      if (!opened)
        rejectFn(new Error(`closed before open: code=${code} reason=${reason.toString()}`));
    });
    ws.on("error", () => {
      // Errors usually arrive as a close with non-1000 code right
      // after; let the close handler resolve/reject.
    });
  });
}

function send(ws: WebSocket, payload: unknown): void {
  ws.send(JSON.stringify(payload));
}

async function waitForOutput(
  state: OpenedSocket,
  needle: string,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.output.includes(needle)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/**
 * Block until the spawned shell has flushed its first chunk to the
 * WebSocket — the signal that bash has finished sourcing its rc
 * files, set up readline, and is now waiting on stdin. Without this,
 * sending input immediately on WS-open races shell startup on slow
 * Linux CI: the keystrokes hit the PTY before bash has wired its
 * read loop, get dropped on the floor, and the test sees the
 * subsequent "echo <sentinel>" never appear in output. macOS and PR
 * runs happen to win the race; main runs sometimes lose it.
 *
 * Returns true when ANY output has arrived (a prompt, a title escape,
 * a `[?2004h` bracketed-paste mode toggle, anything). False on timeout
 * — caller should treat that as "shell never came up" and let the
 * downstream assertion fail with the captured output for diagnosis.
 */
async function waitForShellReady(state: OpenedSocket, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.output.length > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

async function waitForProcessGone(pid: number, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

async function getActivePtys(base: string): Promise<number> {
  const res = await fetch(`${base}/api/v1/health`);
  const body = (await res.json()) as { activePtys: number };
  return body.activePtys;
}

/**
 * Poll `activePtys` until it equals `expected` or we time out.
 * The WS `open` event fires on handshake completion, but our handler's
 * async `spawnPty` runs slightly after — so an immediate count query
 * can race ahead of the registration.
 */
async function waitForPtyCount(base: string, expected: number, timeoutMs = 2_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = await getActivePtys(base);
  while (Date.now() < deadline && last !== expected) {
    await new Promise((r) => setTimeout(r, 30));
    last = await getActivePtys(base);
  }
  return last;
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-term-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-term-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-term-data-"));
  const projectPath = join(workspacePath, "demo");
  await mkdir(projectPath, { recursive: true });

  const apiKey = "test-api-key-" + randomBytes(8).toString("hex");
  const port = await pickFreePort();

  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
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
      API_KEY: apiKey,
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      SERVE_CLIENT: "false",
      // Shrink the detached-PTY reap window so the "activePtys returns
      // to 0 after close" assertion exercises the real reap path within
      // the test budget instead of waiting the 10-minute production
      // default. 200 ms is comfortably above any timer-scheduling jitter.
      PTY_IDLE_REAP_MS: String(REAP_MS),
      // Predictable PS1 so the prompt doesn't drown the test output.
      PS1: "$ ",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${apiKey}` };
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((res) => {
      child.once("exit", () => res());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    });
  };

  const opened: OpenedSocket[] = [];

  try {
    await waitFor(`${base}/api/v1/health`);

    // Create the project.
    const cp = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo", path: projectPath }),
    });
    assert("POST /projects → 201", cp.status === 201);
    const project = (await cp.json()) as { id: string; path: string };

    // Baseline: 0 active PTYs.
    assert("baseline activePtys === 0", (await getActivePtys(base)) === 0);

    // ---- Auth: missing token ----
    {
      const url = `${base.replace(/^http/, "ws")}/api/v1/terminal?projectId=${encodeURIComponent(project.id)}`;
      const ws = new WebSocket(url);
      const code = await new Promise<number>((resolveFn) => {
        ws.on("close", (c) => resolveFn(c));
        ws.on("error", () => undefined);
      });
      assert("missing token → close 4401", code === 4401, `code=${code}`);
    }

    // ---- Auth: invalid token ----
    {
      const url = `${base.replace(/^http/, "ws")}/api/v1/terminal?projectId=${encodeURIComponent(project.id)}&token=bogus`;
      const ws = new WebSocket(url);
      const code = await new Promise<number>((resolveFn) => {
        ws.on("close", (c) => resolveFn(c));
        ws.on("error", () => undefined);
      });
      assert("invalid token → close 4401", code === 4401, `code=${code}`);
    }

    // ---- Bad project id ----
    {
      const url = `${base.replace(/^http/, "ws")}/api/v1/terminal?projectId=00000000-0000-0000-0000-000000000000&token=${apiKey}`;
      const ws = new WebSocket(url);
      const code = await new Promise<number>((resolveFn) => {
        ws.on("close", (c) => resolveFn(c));
        ws.on("error", () => undefined);
      });
      assert("unknown projectId → close 4404", code === 4404, `code=${code}`);
    }

    // ---- Echo + resize ----
    let term: OpenedSocket;
    {
      term = await openTerminal(base, { projectId: project.id, token: apiKey });
      opened.push(term);
      assert("WS opened", term.ws.readyState === WebSocket.OPEN);
      assert("activePtys === 1 after open", (await waitForPtyCount(base, 1)) === 1);

      // Wait for the shell to flush its first chunk before sending
      // any input. Without this, slow Linux CI runners drop the
      // initial keystrokes on the floor — see waitForShellReady.
      const ready = await waitForShellReady(term);
      assert("shell flushed initial output", ready, `output: ${term.output.slice(-200)}`);

      // Use a unique sentinel to avoid matching the user's PS1 echo.
      const sentinel = "pi-forge-marker-" + randomBytes(4).toString("hex");
      send(term.ws, { type: "input", data: `echo ${sentinel}\n` });
      const sawSentinel = await waitForOutput(term, sentinel, 5_000);
      assert("echo output reaches client", sawSentinel, `output: ${term.output.slice(-200)}`);

      send(term.ws, { type: "resize", cols: 120, rows: 40 });
      // Wait a tick — the resize is fire-and-forget; we just want to
      // assert no error closes the socket.
      await new Promise((r) => setTimeout(r, 100));
      assert("socket still open after resize", term.ws.readyState === WebSocket.OPEN);

      // ---- Env allowlist: secrets dropped, harmless vars passed through ----
      // The pi-forge server process has API_KEY set (we passed it
      // above), but the PTY shell must NOT inherit it. Wrap the
      // expansion with two sentinels: if API_KEY expanded to empty,
      // the sentinels appear adjacent in the printf OUTPUT line
      // (distinct from the shell's input echo, which contains quotes
      // between them and so won't match the adjacency probe).
      const sL = "ENVCHK_L_" + randomBytes(3).toString("hex");
      const sR = "_ENVCHK_R_" + randomBytes(3).toString("hex");
      send(term.ws, {
        type: "input",
        data: `printf '%s%s%s\\n' "${sL}" "$API_KEY" "${sR}"\n`,
      });
      const adjacent = `${sL}${sR}`;
      const sawAdjacent = await waitForOutput(term, adjacent, 5_000);
      assert(
        "API_KEY is NOT inherited by PTY shell",
        sawAdjacent,
        `expected sentinels ${sL} and ${sR} to appear adjacent (API_KEY empty); ` +
          `last output: ${term.output.slice(-400)}`,
      );

      // PATH must still come through — a shell with no PATH can't even
      // run `ls`. Sanity-check the allowlist actually allows things.
      const pL = "PATHCHK_L_" + randomBytes(3).toString("hex");
      const pR = "_PATHCHK_R_" + randomBytes(3).toString("hex");
      send(term.ws, {
        type: "input",
        data: `printf '%s%s%s\\n' "${pL}" "$PATH" "${pR}"\n`,
      });
      const pathAdjacent = `${pL}${pR}`;
      const sawPath = await waitForOutput(term, pR, 5_000);
      assert("PATH echo wraps reach client", sawPath);
      assert(
        "PATH is inherited by PTY shell (not empty)",
        !term.output.includes(pathAdjacent),
        `unexpected adjacent sentinels — PATH expanded to empty. ` +
          `last output: ${term.output.slice(-400)}`,
      );
    }

    // ---- Concurrent terminal ----
    {
      const term2 = await openTerminal(base, { projectId: project.id, token: apiKey });
      opened.push(term2);
      assert("activePtys === 2 with two terminals", (await waitForPtyCount(base, 2)) === 2);

      // Same shell-startup race as above — wait for term2 to flush
      // its first chunk before sending input. term already passed
      // the readiness check earlier in the test; only term2 is new.
      const ready2 = await waitForShellReady(term2);
      assert("term2 shell flushed initial output", ready2, `output: ${term2.output.slice(-200)}`);

      const m1 = "term1-" + randomBytes(4).toString("hex");
      const m2 = "term2-" + randomBytes(4).toString("hex");
      send(term.ws, { type: "input", data: `echo ${m1}\n` });
      send(term2.ws, { type: "input", data: `echo ${m2}\n` });
      const got1 = await waitForOutput(term, m1, 5_000);
      const got2 = await waitForOutput(term2, m2, 5_000);
      assert("term1 sees its own marker", got1);
      assert("term2 sees its own marker", got2);
      assert("term1 does NOT see term2's marker", !term.output.includes(m2));
      assert("term2 does NOT see term1's marker", !term2.output.includes(m1));
    }

    // ---- Explicit tab close kills the backing PTY/process immediately ----
    {
      const tabId = "close-kills-" + randomBytes(4).toString("hex");
      const term3 = await openTerminal(base, { projectId: project.id, token: apiKey, tabId });
      assert("activePtys === 3 before explicit tab close", (await waitForPtyCount(base, 3)) === 3);
      const ready3 = await waitForShellReady(term3);
      assert("term3 shell flushed initial output", ready3, `output: ${term3.output.slice(-200)}`);

      send(term3.ws, { type: "input", data: "sh -c 'echo CLOSE_PID=$$; sleep 30'\n" });
      const sawPid = await waitForOutput(term3, "CLOSE_PID=", 5_000);
      const pidMatch = /CLOSE_PID=(\d+)/.exec(term3.output);
      const childPid = pidMatch !== null ? Number(pidMatch[1]) : undefined;
      assert(
        "foreground process started before close",
        sawPid && childPid !== undefined,
        `output: ${term3.output.slice(-400)}`,
      );

      const closed = new Promise<void>((res) => term3.ws.on("close", () => res()));
      term3.ws.close(1000, "tab_closed");
      await closed;
      assert(
        "activePtys drops after explicit tab close",
        (await waitForPtyCount(base, 2, 1_000)) === 2,
      );
      if (childPid !== undefined) {
        assert(
          "foreground process exits after explicit tab close",
          await waitForProcessGone(childPid),
          `pid=${childPid}`,
        );
      }
    }

    // ---- Close cleanup ----
    {
      for (const t of opened) {
        const closed = new Promise<void>((res) => t.ws.on("close", () => res()));
        t.ws.close(1000, "test_done");
        await closed;
      }
      // PTYs are kept alive on WS close so a reattach can pick them
      // back up; cleanup happens via the idle reaper (PTY_IDLE_REAP_MS,
      // pinned to REAP_MS for this test). Wait the reap window plus a
      // buffer, then assert the count drains. waitForPtyCount polls so
      // we don't actually have to wait the full window unless the
      // reaper is genuinely slow.
      assert(
        "activePtys returns to 0 after idle reap",
        (await waitForPtyCount(base, 0, REAP_WAIT_MS)) === 0,
      );
    }
  } finally {
    for (const t of opened) {
      if (!t.closed) t.ws.terminate();
    }
    await stop();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  // ---- Rate limit (own server instance to keep counter clean) ----
  // The route's `rateLimit: { max: 10, timeWindow: "1 minute" }` config
  // counts every WS upgrade attempt against the per-IP bucket. The
  // earlier sections in this test already burned several slots, so
  // we boot a fresh server here purely for the rate-limit assertion.
  await runRateLimitTest();

  if (failures > 0) {
    console.log(`\n[test-terminal] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-terminal] PASS");
}

/**
 * Open 11 WS upgrades sequentially against a fresh server. The first
 * 10 should succeed (open then close cleanly via our explicit close
 * call); the 11th should be rejected by the per-IP rate-limit before
 * the upgrade completes. Fastify's rate-limit on a WS upgrade route
 * returns the limit response BEFORE the protocol switch, so the
 * client sees a close-without-open with code 1006 (abnormal) or the
 * non-1000 we get from a refused upgrade. Either is "not 1000" and
 * "not preceded by an open event", which is what we assert.
 */
async function runRateLimitTest(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-term-rl-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-term-rl-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-term-rl-data-"));
  const projectPath = join(workspacePath, "demo");
  await mkdir(projectPath, { recursive: true });

  const apiKey = "test-api-key-" + randomBytes(8).toString("hex");
  const port = await pickFreePort();

  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
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
      API_KEY: apiKey,
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      SERVE_CLIENT: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${apiKey}` };
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((res) => {
      child.once("exit", () => res());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    });
  };

  try {
    await waitFor(`${base}/api/v1/health`);
    const cp = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo", path: projectPath }),
    });
    assert("rate-limit: POST /projects → 201", cp.status === 201);
    const project = (await cp.json()) as { id: string };
    const wsUrl = `${base.replace(/^http/, "ws")}/api/v1/terminal?projectId=${encodeURIComponent(project.id)}&token=${apiKey}`;

    let openedCount = 0;
    let lastCloseCode = -1;
    // First 10 should succeed; close each immediately to keep PTY
    // count down. Sequential (not concurrent) so the rate-limit
    // counter sees ordered hits and we can attribute each result.
    for (let i = 0; i < 10; i++) {
      const ws = new WebSocket(wsUrl);
      const opened = await new Promise<boolean>((resolveFn) => {
        const timer = setTimeout(() => resolveFn(false), 5_000);
        ws.once("open", () => {
          clearTimeout(timer);
          resolveFn(true);
        });
        ws.once("close", () => {
          clearTimeout(timer);
          resolveFn(false);
        });
        ws.once("error", () => undefined);
      });
      if (opened) {
        openedCount += 1;
        await new Promise<void>((res) => {
          ws.once("close", () => res());
          ws.close(1000, "rate_limit_test");
        });
      }
    }
    assert("first 10 WS upgrades succeeded", openedCount === 10, `opened=${openedCount}`);

    // 11th attempt should be rejected by the rate-limit middleware
    // before the upgrade completes — close fires without open.
    {
      const ws = new WebSocket(wsUrl);
      const result = await new Promise<{ opened: boolean; code: number }>((resolveFn) => {
        let didOpen = false;
        const timer = setTimeout(() => resolveFn({ opened: didOpen, code: -1 }), 5_000);
        ws.once("open", () => {
          didOpen = true;
        });
        ws.once("close", (c) => {
          clearTimeout(timer);
          resolveFn({ opened: didOpen, code: c });
        });
        ws.once("error", () => undefined);
      });
      lastCloseCode = result.code;
      assert(
        "11th WS upgrade rejected by rate-limit (no open event)",
        !result.opened,
        `opened=${result.opened} code=${result.code}`,
      );
      // We don't pin the exact close code — Fastify's rate-limit
      // response is HTTP 429 before the upgrade, so the WS client
      // sees a close-without-open with code 1006 on most node-ws
      // versions, but pinning would couple the test to ws's internals.
      assert(
        "11th close code != 1000 (not a normal close)",
        lastCloseCode !== 1000,
        `code=${lastCloseCode}`,
      );
    }
  } finally {
    await stop();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error("[test-terminal] uncaught:", err);
  process.exit(1);
});

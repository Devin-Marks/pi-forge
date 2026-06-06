import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sandboxSpawnIdentity } from "../agent-bash-operations.js";
import { config } from "../config.js";
import { scrubbedEnv } from "../pty-manager.js";
import { mergeToolEnv } from "../sandbox-settings.js";
import { LogChannel, processLogDir } from "./log-store.js";
import { buildMatchEvent, compileWatches, evaluateWatches, type CompiledWatch } from "./watches.js";
import {
  LIVE_STATUSES,
  type KillResult,
  type ManagerEvent,
  type ProcessInfo,
  type ProcessStatus,
  type StartOptions,
  type WriteResult,
} from "./types.js";

/**
 * Per-session background process manager. One instance per
 * sessionId; `createManagerForSession` lazily constructs and
 * registers. On session dispose the registry calls
 * `disposeManagerForSession` which SIGTERMs every live process,
 * waits briefly for graceful exit, escalates to SIGKILL, then
 * removes the session's log directory.
 *
 * State is in-memory only by deliberate choice (matches
 * `@aliou/pi-processes`): a server restart drops everything;
 * the OS may leak the actual children if pi-forge crashes mid-
 * lifecycle, same as the plugin.
 */

const GRACE_MS = 5_000;
const SIGKILL_TIMEOUT_MS = 2_000;

interface ManagedProcess {
  info: ProcessInfo;
  child: ChildProcessWithoutNullStreams;
  stdout: LogChannel;
  stderr: LogChannel;
  watches: CompiledWatch[];
  /** Set when we initiate kill so the close handler can pick the
   *  right terminal status. */
  killSent: "SIGTERM" | "SIGKILL" | null;
  /** Cleared on close — fires SIGKILL if SIGTERM was sent but the
   *  process didn't exit in time. */
  killTimer: NodeJS.Timeout | null;
}

interface SessionState {
  sessionId: string;
  processes: Map<string, ManagedProcess>;
}

type Listener = (event: ManagerEvent) => void;

class ProcessManagerRegistry {
  private readonly bySession = new Map<string, SessionState>();
  private readonly listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  private notify(event: ManagerEvent): void {
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        // best-effort fanout — listener errors must not break the manager
      }
    }
  }

  private getOrCreateSession(sessionId: string): SessionState {
    let s = this.bySession.get(sessionId);
    if (s === undefined) {
      s = { sessionId, processes: new Map() };
      this.bySession.set(sessionId, s);
    }
    return s;
  }

  /** Spawn a new process bound to this session. */
  start(
    sessionId: string,
    name: string,
    command: string,
    cwd: string,
    opts: StartOptions,
  ): ProcessInfo {
    const session = this.getOrCreateSession(sessionId);
    const id = randomBytes(4).toString("hex");
    const logDir = processLogDir(config.forgeDataDir, sessionId, id);
    const stdoutFile = join(logDir, "stdout.log");
    const stderrFile = join(logDir, "stderr.log");

    // Spawn under `/bin/sh -c` so the command can use shell
    // features (pipes, &&, env expansion). Scrubbed env matches
    // the terminal + quick-actions posture: no pi-forge / provider
    // secrets leak to the child.
    const child = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: mergeToolEnv(scrubbedEnv(), opts.toolEnv ?? {}),
      stdio: ["pipe", "pipe", "pipe"],
      ...sandboxSpawnIdentity(),
      // Put each managed command in its own process group. The
      // tracked child is only the `/bin/sh -c` wrapper; npm scripts,
      // concurrently, Vite, test watchers, etc. commonly spawn
      // grandchildren that do not reliably receive signals sent to
      // the shell alone. A dedicated process group lets kill() and
      // disposeSession() signal the whole tree with `kill(-pid)`.
      detached: true,
    });

    const info: ProcessInfo = {
      id,
      name,
      pid: child.pid ?? -1,
      command,
      cwd,
      startTime: Date.now(),
      endTime: null,
      status: "running",
      exitCode: null,
      success: null,
      stdoutFile,
      stderrFile,
      alertOnSuccess: opts.alertOnSuccess === true,
      alertOnFailure: opts.alertOnFailure !== false, // default true
      alertOnKill: opts.alertOnKill === true,
    };

    const managed: ManagedProcess = {
      info,
      child,
      stdout: new LogChannel(stdoutFile),
      stderr: new LogChannel(stderrFile),
      watches: compileWatches(opts.logWatches),
      killSent: null,
      killTimer: null,
    };
    session.processes.set(id, managed);

    const wireUp = (source: "stdout" | "stderr"): void => {
      const stream = source === "stdout" ? child.stdout : child.stderr;
      const channel = source === "stdout" ? managed.stdout : managed.stderr;
      stream.on("data", (chunk: Buffer) => {
        channel.append(chunk, (line) => {
          const hits = evaluateWatches(managed.watches, source, line);
          for (const w of hits) {
            this.notify({
              type: "process_watch_matched",
              sessionId,
              match: buildMatchEvent(w, id, name, command, source, line),
            });
          }
        });
        this.notify({ type: "process_output_changed", sessionId, id });
      });
    };
    wireUp("stdout");
    wireUp("stderr");

    child.on("error", (err) => {
      // Spawn failure path — child never came up. Surface as a
      // failed exit so the agent gets a clean result.
      const text = `[spawn error] ${err.message}\n`;
      managed.stderr.append(Buffer.from(text, "utf8"));
      info.endTime = Date.now();
      info.exitCode = -1;
      info.success = false;
      info.status = "exited";
      // Notify BEFORE async log cleanup so the UI updates
      // immediately. Log dispose runs in the background.
      this.notify({ type: "process_ended", sessionId, info });
      this.notify({ type: "processes_changed", sessionId });
      void this.finalize(managed);
    });

    child.on("close", (code, signal) => {
      info.endTime = Date.now();
      info.exitCode = typeof code === "number" ? code : null;
      // `killSent` is set when WE called .kill() (via the `process
      // kill` tool); `signal` is non-null when the child died from
      // any signal (ours or external). Both contribute to "wasKilled"
      // for the status display, but only the EXTERNAL case (signal
      // present, killSent absent) triggers an `alertOnKill` —
      // alerting the agent that it killed something is redundant
      // and noisy.
      const killedByUs = managed.killSent !== null;
      const killedExternally = !killedByUs && signal !== null;
      const wasKilled = killedByUs || killedExternally;
      info.status = wasKilled ? "killed" : "exited";
      info.success = info.exitCode === 0 && !wasKilled;
      if (managed.killTimer !== null) {
        clearTimeout(managed.killTimer);
        managed.killTimer = null;
      }
      // Notify BEFORE flushing logs. The old order awaited
      // stdout.dispose() + stderr.dispose() FIRST and only
      // fanned out the status change after — for any process
      // with non-trivial output, that gated the UI update on
      // a multi-tick filesystem flush and made Kill feel
      // broken (status visibly stuck on "terminating" until
      // the flush finished). Status flip is what the user
      // needs to see; log cleanup is bookkeeping.
      this.notify({ type: "process_ended", sessionId, info });
      this.notify({ type: "processes_changed", sessionId });
      // Agent-alert events. The three alertOn* flags were captured
      // at start() time; honor them now. Order chosen so a single
      // outcome only fires one alert — a failure isn't ALSO a "non-
      // success" alert, etc.
      if (killedExternally && info.alertOnKill) {
        this.notify({ type: "process_alert", sessionId, info, reason: "killed" });
      } else if (!wasKilled && info.exitCode === 0 && info.alertOnSuccess) {
        this.notify({ type: "process_alert", sessionId, info, reason: "success" });
      } else if (!wasKilled && info.exitCode !== 0 && info.alertOnFailure) {
        this.notify({ type: "process_alert", sessionId, info, reason: "failure" });
      }
      void this.finalize(managed);
    });

    this.notify({ type: "process_started", sessionId, info });
    this.notify({ type: "processes_changed", sessionId });
    return cloneInfo(info);
  }

  /**
   * Async log-cleanup tail. Lifecycle notification fires
   * synchronously from the close/error handler that called this;
   * this method just flushes and closes the on-disk log streams
   * so a slow filesystem can't delay the UI update.
   */
  private async finalize(managed: ManagedProcess): Promise<void> {
    await managed.stdout.dispose();
    await managed.stderr.dispose();
  }

  /** List every process for this session, newest-first. */
  list(sessionId: string): ProcessInfo[] {
    const s = this.bySession.get(sessionId);
    if (s === undefined) return [];
    return [...s.processes.values()]
      .map((m) => cloneInfo(m.info))
      .sort((a, b) => b.startTime - a.startTime);
  }

  /** Recent tail of stdout/stderr for a single process. */
  output(
    sessionId: string,
    id: string,
    tail = 200,
  ): { stdout: string[]; stderr: string[]; status: ProcessStatus } | undefined {
    const m = this.getManaged(sessionId, id);
    if (m === undefined) return undefined;
    return {
      stdout: m.stdout.tail(tail),
      stderr: m.stderr.tail(tail),
      status: m.info.status,
    };
  }

  logFiles(sessionId: string, id: string): { stdoutFile: string; stderrFile: string } | undefined {
    const m = this.getManaged(sessionId, id);
    if (m === undefined) return undefined;
    return { stdoutFile: m.info.stdoutFile, stderrFile: m.info.stderrFile };
  }

  /**
   * Kill a process. SIGTERM, 5 s grace, then SIGKILL. Resolves
   * once we've initiated the signal — the `process_ended` event
   * fans out async when the OS reports close. The promise's
   * resolved value tells the caller what happened immediately
   * (process_already_dead, signal_sent, etc.).
   */
  async kill(sessionId: string, id: string): Promise<KillResult> {
    const m = this.getManaged(sessionId, id);
    if (m === undefined) {
      return { ok: false, info: undefined, reason: "not_found" };
    }
    if (!LIVE_STATUSES.has(m.info.status)) {
      // Already exited — return success with the final info so the
      // caller can render a clean result instead of an error.
      return { ok: true, info: cloneInfo(m.info) };
    }
    try {
      m.killSent = "SIGTERM";
      m.info.status = "terminating";
      this.notify({ type: "processes_changed", sessionId });
      const targets = await collectProcessTreeTargets(m.child.pid);
      signalProcessTree(m.child, "SIGTERM", targets);
      m.killTimer = setTimeout(() => {
        if (!LIVE_STATUSES.has(m.info.status)) return;
        m.info.status = "terminate_timeout";
        m.killSent = "SIGKILL";
        this.notify({ type: "processes_changed", sessionId });
        try {
          void collectProcessTreeTargets(m.child.pid).then((currentTargets) => {
            signalProcessTree(m.child, "SIGKILL", mergeKillTargets(targets, currentTargets));
          });
        } catch {
          // ignore
        }
        // Last-resort timeout — if SIGKILL still doesn't move the
        // process (zombie / kernel state), wait one more beat then
        // report timeout to the caller. The OS WILL eventually
        // close the streams; we just can't wait forever.
        setTimeout(() => {
          // no-op — the close handler will mark the final state
        }, SIGKILL_TIMEOUT_MS).unref();
      }, GRACE_MS);
      return { ok: true, info: cloneInfo(m.info) };
    } catch (err) {
      void err;
      return { ok: false, info: cloneInfo(m.info), reason: "error" };
    }
  }

  /** Pipe input to a live process's stdin. `end:true` closes the stream. */
  async write(sessionId: string, id: string, input: string, end: boolean): Promise<WriteResult> {
    const m = this.getManaged(sessionId, id);
    if (m === undefined) return { ok: false, reason: "not_found" };
    if (!LIVE_STATUSES.has(m.info.status)) {
      return { ok: false, reason: "process_exited" };
    }
    const stdin = m.child.stdin;
    if (stdin === null || stdin.writableEnded) {
      return { ok: false, reason: "stdin_closed" };
    }
    return await new Promise((resolve) => {
      stdin.write(input, (err) => {
        if (err !== null && err !== undefined) {
          resolve({ ok: false, reason: "write_error" });
          return;
        }
        if (end) {
          stdin.end(() => resolve({ ok: true }));
        } else {
          resolve({ ok: true });
        }
      });
    });
  }

  /** Drop all FINISHED processes for the session. Live ones stay. */
  clear(sessionId: string): number {
    const s = this.bySession.get(sessionId);
    if (s === undefined) return 0;
    let count = 0;
    for (const [id, m] of s.processes) {
      if (!LIVE_STATUSES.has(m.info.status)) {
        s.processes.delete(id);
        count += 1;
      }
    }
    if (count > 0) this.notify({ type: "processes_changed", sessionId });
    return count;
  }

  /**
   * Dispose every process for this session: SIGTERM, brief wait,
   * SIGKILL. Then unlink the session's entire log directory.
   * Called from session-registry.disposeSession.
   */
  async disposeSession(sessionId: string): Promise<void> {
    const s = this.bySession.get(sessionId);
    if (s === undefined) return;
    const live = [...s.processes.values()].filter((m) => LIVE_STATUSES.has(m.info.status));
    const targetsByPid = new Map<number, KillTargets>();
    for (const m of live) {
      try {
        m.killSent = "SIGTERM";
        const targets = await collectProcessTreeTargets(m.child.pid);
        if (m.child.pid !== undefined) targetsByPid.set(m.child.pid, targets);
        signalProcessTree(m.child, "SIGTERM", targets);
      } catch {
        // ignore
      }
    }
    if (live.length > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, GRACE_MS).unref());
      for (const m of live) {
        if (LIVE_STATUSES.has(m.info.status)) {
          try {
            const originalTargets =
              m.child.pid === undefined
                ? emptyKillTargets()
                : (targetsByPid.get(m.child.pid) ?? emptyKillTargets());
            const currentTargets = await collectProcessTreeTargets(m.child.pid);
            signalProcessTree(
              m.child,
              "SIGKILL",
              mergeKillTargets(originalTargets, currentTargets),
            );
          } catch {
            // ignore
          }
        }
      }
    }
    // Best-effort log cleanup. A failure here (e.g. EBUSY on
    // Windows) just leaves the files on disk — harmless, the
    // session dir will be cleaned up by deleteColdSession's
    // cascade.
    const logRoot = join(config.forgeDataDir, "processes", sessionId);
    await rm(logRoot, { recursive: true, force: true }).catch(() => undefined);
    this.bySession.delete(sessionId);
  }

  /**
   * Test-only: nuke everything WITHOUT signalling children. Use
   * between integration test cases that spawn real processes;
   * combine with explicit dispose for the cleanup of children
   * the test actually started.
   */
  _resetForTests(): void {
    this.bySession.clear();
    // listeners intentionally NOT cleared — the SSE bridge's
    // subscription is process-lifetime.
  }

  private getManaged(sessionId: string, id: string): ManagedProcess | undefined {
    return this.bySession.get(sessionId)?.processes.get(id);
  }
}

interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
}

interface KillTargets {
  pids: number[];
  pgids: number[];
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
  targets: KillTargets = emptyKillTargets(),
): void {
  const pid = child.pid;
  const pgids = new Set(targets.pgids);
  if (pid !== undefined) pgids.add(pid);

  // Signal process groups first, including any descendant-created
  // groups found by the ps snapshot. Then signal individual PIDs as
  // a fallback for processes that escaped/reparented between the
  // snapshot and the group signal.
  for (const pgid of pgids) {
    try {
      process.kill(-pgid, signal);
    } catch {
      // ignore
    }
  }

  if (pid !== undefined) {
    try {
      child.kill(signal);
    } catch {
      // ignore
    }
  }

  for (const targetPid of new Set(targets.pids)) {
    if (targetPid === pid) continue;
    try {
      process.kill(targetPid, signal);
    } catch {
      // ignore
    }
  }
}

async function collectProcessTreeTargets(pid: number | undefined): Promise<KillTargets> {
  if (pid === undefined) return emptyKillTargets();
  const rows = await listProcesses();
  const root = rows.find((row) => row.pid === pid);
  const childrenByParent = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const siblings = childrenByParent.get(row.ppid) ?? [];
    siblings.push(row);
    childrenByParent.set(row.ppid, siblings);
  }

  const targetRows: ProcessRow[] = [];
  const seen = new Set<number>();
  const stack = [...(childrenByParent.get(pid) ?? [])];
  while (stack.length > 0) {
    const child = stack.pop();
    if (child === undefined || seen.has(child.pid)) continue;
    seen.add(child.pid);
    targetRows.push(child);
    stack.push(...(childrenByParent.get(child.pid) ?? []));
  }

  // detached:true creates a fresh session for the managed shell.
  // Most npm/concurrently/vite descendants stay in that session even
  // if an intermediate shell exits and they are reparented to PID 1.
  // Include the whole session while the root row is still visible.
  if (root !== undefined) {
    for (const row of rows) {
      if (row.pid !== pid && row.sid === root.sid && !seen.has(row.pid)) {
        seen.add(row.pid);
        targetRows.push(row);
      }
    }
  }

  return {
    pids: targetRows.map((row) => row.pid),
    pgids: [...new Set(targetRows.map((row) => row.pgid))],
  };
}

function emptyKillTargets(): KillTargets {
  return { pids: [], pgids: [] };
}

function mergeKillTargets(...targets: KillTargets[]): KillTargets {
  return {
    pids: [...new Set(targets.flatMap((target) => target.pids))],
    pgids: [...new Set(targets.flatMap((target) => target.pgids))],
  };
}

async function listProcesses(): Promise<ProcessRow[]> {
  for (const args of [
    ["-eo", "pid=,ppid=,pgid=,sid="],
    ["-Ao", "pid=,ppid=,pgid=,sid="],
  ]) {
    const stdout = await execFileText("ps", args);
    if (stdout === "") continue;
    const rows: ProcessRow[] = [];
    for (const line of stdout.split("\n")) {
      const parts = line.trim().split(/\s+/).map(Number);
      const pid = parts[0];
      const ppid = parts[1];
      const pgid = parts[2];
      const sid = parts[3];
      if (
        pid !== undefined &&
        ppid !== undefined &&
        pgid !== undefined &&
        sid !== undefined &&
        Number.isInteger(pid) &&
        Number.isInteger(ppid) &&
        Number.isInteger(pgid) &&
        Number.isInteger(sid)
      ) {
        rows.push({ pid, ppid, pgid, sid });
      }
    }
    return rows;
  }
  return [];
}

function execFileText(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout) => {
      if (error !== null) {
        resolve("");
        return;
      }
      resolve(stdout);
    });
  });
}

function cloneInfo(info: ProcessInfo): ProcessInfo {
  return { ...info };
}

/** Singleton — one registry per process. */
export const processManager = new ProcessManagerRegistry();

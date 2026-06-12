import { randomUUID } from "node:crypto";
import * as nodePty from "node-pty";
import { config } from "./config.js";

/**
 * Per-project PTY tracking with reattach support.
 *
 * Each browser terminal tab opens its own WebSocket which spawns a
 * dedicated PTY here — never share PTY instances across distinct
 * tabs (mixed input streams break the shell's line-edit state in
 * ways users notice immediately).
 *
 * **Survival across page refresh.** On WS close the PTY is NOT
 * killed; it is detached and held for {@link IDLE_REAP_MS} so a
 * page reload (or a transient network blip) can reattach via
 * `tabId` and pick up where the user left off. A rolling output
 * buffer ({@link OUTPUT_BUFFER_BYTES}) is replayed on reattach so
 * the new xterm shows recent output instead of just a fresh prompt.
 *
 * After {@link IDLE_REAP_MS} with no socket attached, the PTY is
 * killed. This is the safety valve: a user who closed the browser
 * for the day shouldn't leave shells running indefinitely.
 *
 * The map key is a generated `ptyId` (server-trusted). The route
 * also indexes lookups by client-supplied `tabId` (constrained to
 * the same project for safety) so reconnects find the right PTY.
 */

export interface SpawnOptions {
  shell?: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /**
   * Stable client-side identifier for this terminal tab. Used to
   * index reconnects: the same tab id, after a WS drop, finds the
   * existing detached PTY instead of spawning a new one.
   */
  tabId: string;
  /**
   * Project id this PTY is scoped to. Reattach is only allowed for
   * the same project — defense-in-depth against the (unlikely)
   * scenario of one project's tabId colliding with another's.
   */
  projectId: string;
}

export interface ManagedPty {
  ptyId: string;
  tabId: string;
  projectId: string;
  process: nodePty.IPty;
  /** Snapshot of the cwd this PTY was spawned in, for diagnostics. */
  cwd: string;
}

/** Rolling output buffer cap per PTY (in bytes). 256 KB ≈ ~3000 lines of typical shell output. */
const OUTPUT_BUFFER_BYTES = 256 * 1024;
/**
 * Time a detached PTY (no WS attached) is held alive before being reaped.
 * Sourced from `config.terminalIdleReapMs` so operators in resource-
 * constrained deployments can shorten the window, AND so the integration
 * test can pin it down to ~200 ms to actually exercise the reap path
 * within a test budget.
 */
const IDLE_REAP_MS = config.terminalIdleReapMs;

interface Entry {
  managed: ManagedPty;
  /** onData disposable — replaced each time a new socket attaches. */
  dataDisposable: nodePty.IDisposable | undefined;
  /**
   * Callback the currently-attached socket gives us so we can close it
   * when a NEW socket attaches with the same tabId. Without this, two
   * browser windows sharing the same `tabId` (localStorage is per-origin,
   * so cross-window in the same origin is the common case) would both
   * stay connected to the same PTY: the second window steals the data
   * sink (so only it sees output), but the first window's keystroke
   * handler still writes to the shared `process.stdin`, producing
   * interleaved input that breaks the line-edit state at the shell.
   */
  closeActiveSocket: (() => void) | undefined;
  /** Idle reaper for the period when no socket is attached. */
  idleTimer: NodeJS.Timeout | undefined;
  /** Rolling output buffer; replayed in order to a reattaching client. */
  buffer: Buffer[];
  bufferBytes: number;
}

const ptys = new Map<string, Entry>();

function defaultShell(): string {
  return process.env.SHELL ?? "/bin/sh";
}

/**
 * Find an existing PTY for `tabId` within `projectId`. Returns
 * undefined if none exists (caller should spawn) or if a PTY with
 * that tabId belongs to a DIFFERENT project (caller should treat as
 * "no match" — never reattach across projects, that would expose
 * one project's shell to another).
 */
export function findPtyByTabId(tabId: string, projectId: string): ManagedPty | undefined {
  for (const entry of ptys.values()) {
    if (entry.managed.tabId !== tabId) continue;
    if (entry.managed.projectId !== projectId) continue;
    return entry.managed;
  }
  return undefined;
}

export function spawnPty(opts: SpawnOptions): ManagedPty {
  const shell = opts.shell ?? defaultShell();
  const cols = opts.cols ?? 80;
  const rows = opts.rows ?? 24;
  const env = opts.env ?? process.env;
  const identity = config.agentToolSandbox.enabled
    ? { uid: config.agentToolSandbox.uid, gid: config.agentToolSandbox.gid }
    : {};
  const proc = nodePty.spawn(shell, [], {
    name: "xterm-color",
    cols,
    rows,
    cwd: opts.cwd,
    env: toolShellEnv(env),
    ...identity,
  });
  const ptyId = randomUUID();
  const managed: ManagedPty = {
    ptyId,
    tabId: opts.tabId,
    projectId: opts.projectId,
    process: proc,
    cwd: opts.cwd,
  };
  const entry: Entry = {
    managed,
    dataDisposable: undefined,
    closeActiveSocket: undefined,
    idleTimer: undefined,
    buffer: [],
    bufferBytes: 0,
  };
  ptys.set(ptyId, entry);
  // Always-on output capture, independent of any attached socket —
  // that way disconnected periods still accumulate the rolling
  // buffer for the next reattach to replay.
  const captureDisposable = proc.onData((chunk) => {
    appendToBuffer(entry, chunk);
  });
  proc.onExit(() => {
    captureDisposable.dispose();
    ptys.delete(ptyId);
    if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  });
  return managed;
}

/**
 * Attach a socket-style sink to a managed PTY. Replays the rolling
 * output buffer immediately, then forwards every subsequent
 * `onData` chunk to `onData(chunk)`. Returns a detach function the
 * caller MUST invoke on socket close — without this, the prior
 * sink keeps receiving bytes and a reattach can't replace it.
 *
 * Cancels any pending idle reaper — the PTY is back in active use.
 *
 * `replayBytes` lets the caller request only the tail of the
 * buffer (e.g. xterm already has prior scrollback locally and only
 * wants the last ~16 KB). Pass `Infinity` (default) to replay all.
 *
 * `onData` receives raw bytes as `Buffer` — callers should forward
 * them through whatever transport they own without re-encoding. The
 * terminal WS route sends them as binary frames so reverse proxies
 * can't mangle ANSI escape sequences (see the comment on the
 * `socket.send(chunk)` call in `routes/terminal.ts`).
 */
export function attachSink(
  ptyId: string,
  onData: (chunk: Buffer) => void,
  replayBytes: number = OUTPUT_BUFFER_BYTES,
  closeActiveSocket?: () => void,
): (() => void) | undefined {
  const entry = ptys.get(ptyId);
  if (entry === undefined) return undefined;
  if (entry.idleTimer !== undefined) {
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }
  // Replace any existing data sink so a stale reconnect never
  // double-delivers chunks. The previous detach() the caller
  // captured still works (it disposes whatever disposable it
  // captured), but the route should always call the latest detach.
  if (entry.dataDisposable !== undefined) {
    entry.dataDisposable.dispose();
    entry.dataDisposable = undefined;
  }
  // Close the previously-attached WS, if any. Without this, two
  // browsers with the same tabId both keep their input handlers wired
  // up to write to the PTY; only the most recently attached one sees
  // output, but BOTH can send input — interleaved keystrokes corrupt
  // line-edit state. Closing the predecessor's WS lets the route's
  // close handler unwire the input listener cleanly.
  if (entry.closeActiveSocket !== undefined) {
    try {
      entry.closeActiveSocket();
    } catch {
      // socket already gone — fine
    }
    entry.closeActiveSocket = undefined;
  }
  entry.closeActiveSocket = closeActiveSocket;
  // Replay only the tail the caller asked for. The buffer is a
  // chunk array; flatten just enough from the right edge to hit
  // `replayBytes`. Edge case: replayBytes <= 0 → skip replay.
  if (replayBytes > 0 && entry.bufferBytes > 0) {
    let remaining = Math.min(replayBytes, entry.bufferBytes);
    const tail: Buffer[] = [];
    for (let i = entry.buffer.length - 1; i >= 0 && remaining > 0; i--) {
      const chunk = entry.buffer[i]!;
      if (chunk.byteLength <= remaining) {
        tail.unshift(chunk);
        remaining -= chunk.byteLength;
      } else {
        tail.unshift(chunk.subarray(chunk.byteLength - remaining));
        remaining = 0;
      }
    }
    for (const chunk of tail) onData(chunk);
  }
  // node-pty's onData callback delivers strings (UTF-8 decoded
  // already, with `\u{FFFD}` substitution on invalid bytes). Convert
  // back to a Buffer once here so downstream sinks get the raw byte
  // stream that proxies / xterm.js parse natively. The replay loop
  // above already operates on Buffer (the rolling buffer stores
  // Buffers directly), so this is the only re-encoding hop in the
  // pipeline.
  const live = entry.managed.process.onData((chunk: string) => {
    onData(Buffer.from(chunk, "utf8"));
  });
  entry.dataDisposable = live;
  return () => {
    if (entry.dataDisposable === live) {
      live.dispose();
      entry.dataDisposable = undefined;
      // Only clear closeActiveSocket if WE are still the active
      // attachment — a newer attachSink may have already swapped a
      // different socket in.
      if (entry.closeActiveSocket === closeActiveSocket) {
        entry.closeActiveSocket = undefined;
      }
    } else {
      // A newer attach replaced ours; nothing to do.
    }
    // Start the idle reaper. If a fresh attach arrives within
    // IDLE_REAP_MS the timer is cancelled in the next attachSink.
    if (entry.idleTimer === undefined && ptys.has(ptyId)) {
      entry.idleTimer = setTimeout(() => {
        entry.idleTimer = undefined;
        killPty(ptyId);
      }, IDLE_REAP_MS);
    }
  };
}

function appendToBuffer(entry: Entry, chunk: string): void {
  const buf = Buffer.from(chunk, "utf8");
  entry.buffer.push(buf);
  entry.bufferBytes += buf.byteLength;
  // Evict from the front until we're under cap. Keeps memory
  // bounded across multi-hour shells running noisy output (npm
  // install, pip install, etc.).
  while (entry.bufferBytes > OUTPUT_BUFFER_BYTES && entry.buffer.length > 0) {
    const head = entry.buffer.shift()!;
    entry.bufferBytes -= head.byteLength;
  }
}

export function getPty(ptyId: string): ManagedPty | undefined {
  return ptys.get(ptyId)?.managed;
}

/**
 * Grace window between SIGTERM and SIGKILL. Long enough for a
 * well-behaved shell to clean up (zsh trap, bash exit handler), short
 * enough that an unkillable shell doesn't linger past a deploy /
 * shutdown for noticeable time.
 */
const SIGKILL_GRACE_MS = 2_000;

export function killPty(ptyId: string): boolean {
  const entry = ptys.get(ptyId);
  if (entry === undefined) return false;
  ptys.delete(ptyId);
  if (entry.idleTimer !== undefined) clearTimeout(entry.idleTimer);
  if (entry.dataDisposable !== undefined) entry.dataDisposable.dispose();
  // Try SIGTERM first (gives the shell a chance to flush, run trap
  // handlers, release tty). Schedule a SIGKILL fallback for trapped
  // / unresponsive shells. Without the fallback, a `trap '' TERM`
  // bash leaves an orphan process holding the PTY fd.
  let killed = false;
  const exitDisposable = entry.managed.process.onExit(() => {
    killed = true;
  });
  try {
    entry.managed.process.kill("SIGTERM");
  } catch {
    // already exited between get + kill; nothing to do
    return true;
  }
  setTimeout(() => {
    exitDisposable.dispose();
    if (killed) return;
    try {
      entry.managed.process.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, SIGKILL_GRACE_MS).unref();
  return true;
}

export function ptyCount(): number {
  return ptys.size;
}

export function disposeAllPtys(): void {
  for (const ptyId of Array.from(ptys.keys())) {
    killPty(ptyId);
  }
}

let exitHandlerInstalled = false;
/**
 * Install a `process.on("exit")` last-resort SIGTERM-all handler.
 * Idempotent.
 *
 * The previous version of this module called `installExitHandler()`
 * at module load, which meant any unit test that imported the module
 * also installed the handler — and the handler couldn't be undone.
 * Tests that fork child processes ended up with the wrong handler
 * count and unpredictable shutdown behavior. The fix: require an
 * explicit `installPtyExitHandler()` call from `index.ts` (the
 * production entry point); tests that import `pty-manager` for unit
 * coverage skip the install.
 */
export function installPtyExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on("exit", () => {
    for (const entry of ptys.values()) {
      try {
        entry.managed.process.kill("SIGTERM");
      } catch {
        // Process already gone — fine. We're in the exit handler so
        // there's no point trying anything more aggressive.
      }
    }
    ptys.clear();
  });
}

/**
 * Allowlist of env-var names the PTY shell (and the `!` exec route)
 * may inherit from the pi-forge process. Everything else is dropped.
 *
 * Allowlist instead of denylist because the threat model is "any
 * secret an operator has in their host env leaks into the shell." A
 * denylist of named secrets is fail-open — every newly-named provider
 * key (`SOMEPROVIDER_API_KEY`), kube credential, cloud token, etc.
 * leaks until we add it by name. An allowlist is fail-safe: anything
 * not on this list is hidden by default; operators with a legitimate
 * need pass specific vars through via `TERMINAL_PASSTHROUGH_ENV`.
 *
 * What's on the list and why:
 *   PATH, HOME, USER, LOGNAME, SHELL — required for a usable shell
 *   PWD                              — the shell sets it but inheriting
 *                                      avoids a transient empty value
 *   TERM, COLORTERM                  — xterm rendering / 256-color
 *   TERMINFO                         — fallback terminfo lookup
 *   LANG, LC_*                       — locale (UTF-8, sorting, dates)
 *   TZ                               — timezone-aware tools (`date`)
 *   HOSTNAME                         — prompt customization (`\h` in PS1)
 *   EDITOR, PAGER, VISUAL            — interactive defaults (git
 *                                      commit, less, etc.)
 *
 * Conspicuously NOT on the list (must be opt-in via
 * `TERMINAL_PASSTHROUGH_ENV` if the operator wants them in-shell):
 *   - pi-forge secrets: JWT_SECRET, API_KEY, UI_PASSWORD
 *   - Provider keys:     ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
 *   - Cloud credentials: AWS_*, GOOGLE_APPLICATION_CREDENTIALS,
 *                        GH_TOKEN, GITHUB_TOKEN, KUBECONFIG, ...
 *   - Anything else      — assume it's sensitive until proven harmless.
 */
const TERMINAL_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TERM",
  "COLORTERM",
  "TERMINFO",
  "LANG",
  "TZ",
  "HOSTNAME",
  "EDITOR",
  "PAGER",
  "VISUAL",
]);

/**
 * Variable names matching this prefix-style pattern are also allowed
 * — covers the locale family (`LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, …)
 * without enumerating every variant.
 */
const TERMINAL_ENV_ALLOWLIST_PREFIXES: readonly string[] = ["LC_"];

function isAllowedByDefault(name: string): boolean {
  if (TERMINAL_ENV_ALLOWLIST.has(name)) return true;
  for (const prefix of TERMINAL_ENV_ALLOWLIST_PREFIXES) {
    if (name.startsWith(prefix)) return true;
  }
  return false;
}

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const passthrough = new Set(config.terminalPassthroughEnv);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v !== "string") continue;
    if (!isAllowedByDefault(k) && !passthrough.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function applySandboxToolHome(env: Record<string, string>): Record<string, string> {
  if (!config.agentToolSandbox.enabled) return env;
  return {
    ...env,
    HOME: config.agentToolSandbox.home,
    USER: "pi-tools",
    LOGNAME: "pi-tools",
  };
}

/**
 * Re-export so server-owned subprocess callers can get the same allowlist
 * without inheriting pi-forge / provider secrets. This does NOT rewrite HOME
 * for the sandbox tool identity; server-owned commands should keep the server
 * process identity/env semantics.
 */
export const scrubbedEnv = (): Record<string, string> => filterEnv(process.env);

/**
 * Env for shell-like user/model surfaces (PTY terminals, `!` exec,
 * quick actions, process tool, and agent bash). In sandbox mode these
 * surfaces also run as `AGENT_TOOL_UID:GID`, so HOME must point at the
 * sandbox tool user's writable home instead of the server user's home.
 */
export const toolShellEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> =>
  applySandboxToolHome(filterEnv(env));

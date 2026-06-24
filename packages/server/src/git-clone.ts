/**
 * `git clone` runner for the "Clone repository" project-setup flow.
 *
 * Why this exists separately from `git-runner.ts`: git-runner.ts wraps
 * the agent-/UI-facing `git status`/`diff`/`commit`/`push` surface for
 * an already-cloned repo. Clone is a one-shot, multi-second operation
 * that needs progress streaming and optional auth — different shape of
 * problem, so it gets its own module.
 *
 * Auth model: a user-supplied token (PAT, fine-grained PAT, GitHub
 * App installation token, etc.) is embedded into the clone URL as
 * `https://x-access-token:<TOKEN>@<host>/<path>`. The
 * `x-access-token:<TOKEN>` convention is GitHub's official
 * recommendation and works for GitHub.com, GitHub Enterprise, GitLab
 * (PAT-as-password), Bitbucket app passwords, and Gitea PATs. After
 * the clone completes, we rewrite `origin` to the original
 * token-free URL so the token doesn't persist in
 * `.git/config`. The token is never logged and never appears in
 * command args (it's part of the cloned URL, not a flag).
 *
 * Security notes for the threat model:
 *   - Single-tenant deploys only — the URL is visible to anyone with
 *     access to the spawned process (`ps`). Multi-tenant deploys would
 *     need to use `GIT_ASKPASS` or `credential.helper` instead.
 *   - The token is held in process memory for the lifetime of one
 *     clone. We don't log it. We don't write it to any pi-forge
 *     file.
 *   - If the clone fails partway, the URL with the embedded token may
 *     be in git's internal state (e.g. a partial `.git/config` if
 *     anything wrote a remote before the failure). We rm-rf the
 *     target directory on failure to make sure no leftover token
 *     bytes survive.
 */
import { spawn } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { scrubbedEnv } from "./pty-manager.js";
import { applySandboxTreeHandoff } from "./sandbox-permissions.js";
import { config } from "./config.js";
import { sandboxSpawnIdentity } from "./agent-bash-operations.js";

const MAX_PROGRESS_BUFFER_BYTES = 64 * 1024;
const CLONE_TIMEOUT_MS = 30 * 60 * 1000;

export interface CloneOptions {
  /** Repository URL — HTTPS only. SSH URLs would need a key on disk; out of scope for v1.3.0. */
  url: string;
  /** Absolute path where the clone will land. Must not exist or must be empty. */
  target: string;
  /** Optional branch / tag / sha to check out. Defaults to remote HEAD. */
  branch?: string;
  /**
   * Optional access token. Embedded into the clone URL as
   * `x-access-token:<token>` (GitHub-style) and stripped from the
   * stored `origin` URL after success.
   */
  token?: string;
  /**
   * When true, sets `GIT_SSL_NO_VERIFY=true` for the clone (and
   * for the post-clone `remote set-url` step that strips the token
   * from the stored remote — that one doesn't make a network call,
   * but we set it consistently in case a future change does).
   *
   * Same posture as the webhook `insecureTls` flag: necessary for
   * internal Git hosts with self-signed certs (corporate GHE, on-
   * prem GitLab with a private CA, etc.). Every clone with this
   * flag set logs a `git-clone-insecure-tls` line to stderr so the
   * relaxed security is visible in `docker logs`.
   *
   * Single-tenant assumption holds: a user who can configure a
   * project's clone URL can already point it anywhere, and the
   * agent's `bash` tool can already run arbitrary git commands.
   * Bypassing cert validation per-clone doesn't widen the attack
   * surface meaningfully beyond what's already there.
   */
  insecureTls?: boolean;
  /** Optional AbortSignal to cancel the clone mid-run. SIGTERM → SIGKILL after 5s grace. */
  signal?: AbortSignal;
}

export type CloneEvent =
  | { type: "started"; cloneUrlForDisplay: string }
  | { type: "progress"; phase: string; percent: number | null; raw: string }
  | { type: "stderr"; line: string }
  | { type: "done"; target: string }
  | { type: "error"; message: string };

export class GitCloneError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GitCloneError";
    this.code = code;
  }
}

/**
 * Validate a URL is suitable for `git clone`. Returns the parsed URL
 * on success. Accepts:
 *   - `https://` — the primary case. Token injection works.
 *   - `file://`  — local-repo clone (useful for testing and for
 *                 forking from a local mirror). No token, no auth.
 *
 * Rejects everything else (ssh:, http:, git:, ftp:, ...). Plain http
 * is explicitly out because we don't want to embed a token in a
 * cleartext URL even on private networks — operators expecting that
 * almost certainly want HTTPS.
 */
export function validateCloneUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GitCloneError("invalid_url", `Not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "file:") {
    throw new GitCloneError(
      "unsupported_protocol",
      `Only HTTPS and file:// clone URLs are supported (got ${parsed.protocol}).`,
    );
  }
  // HTTPS requires a host. file:// uses `parsed.pathname` and may
  // have an empty hostname ("file:///path/to/repo") — that's the
  // correct shape, not an error.
  if (parsed.protocol === "https:" && parsed.hostname.length === 0) {
    throw new GitCloneError("invalid_url", "URL is missing a host.");
  }
  return parsed;
}

/**
 * Inject `x-access-token:<token>` into the URL's userinfo. URL
 * encoding is handled by the URL API — tokens containing `:` / `@` /
 * `/` etc. are encoded correctly.
 */
function injectToken(url: URL, token: string): string {
  const withAuth = new URL(url.toString());
  withAuth.username = "x-access-token";
  withAuth.password = token;
  return withAuth.toString();
}

/**
 * Parse a git progress line. Git writes progress to stderr in lines
 * like "Receiving objects: 45% (450/1000), 1.23 MiB | 200 KiB/s" or
 * "Resolving deltas: 100% (123/123), done.". We pull out the phase
 * name ("Receiving objects") and the percent (45 or 100). Returns
 * undefined for non-progress lines (which are still surfaced via
 * `type: "stderr"` events).
 */
export function parseProgressLine(
  line: string,
): { phase: string; percent: number | null } | undefined {
  // Format: `<Phase>: <pct>% (...)` with the percent optional in some
  // phases (e.g. "Counting objects: 1234, done.").
  const match = /^([A-Z][A-Za-z ]+):\s+(\d+)%/.exec(line.trim());
  if (match !== null) {
    return { phase: match[1] ?? "", percent: Number(match[2]) };
  }
  // Some phases don't report percent (e.g. "Counting objects: 1234"
  // or "Cloning into '...'"). Surface them with percent=null so the
  // UI can still show the phase change.
  const phaseOnly = /^([A-Z][A-Za-z ]+):/.exec(line.trim());
  if (phaseOnly !== null) {
    return { phase: phaseOnly[1] ?? "", percent: null };
  }
  return undefined;
}

interface SpawnedClone {
  promise: Promise<void>;
  events: AsyncIterable<CloneEvent>;
}

/**
 * Run `git clone` with progress streaming. Yields CloneEvents in
 * real time. Resolves when the spawn settles (success or failure);
 * the caller iterates `events` to render progress as it happens.
 *
 * On error, the target directory is rm -rf'd to avoid leaving a
 * half-cloned tree (and any leftover token bytes in
 * `.git/config`).
 */
export function cloneRepository(opts: CloneOptions): SpawnedClone {
  const url = validateCloneUrl(opts.url);
  const target = resolve(opts.target);

  const cloneUrl = opts.token !== undefined ? injectToken(url, opts.token) : url.toString();
  const displayUrl = url.toString();

  // Build args. `--progress` forces git to emit progress to stderr
  // even when stdout isn't a tty (which it never is for us — we're
  // a child process). Without it, the operator sees no progress
  // until the clone completes.
  const args = ["clone", "--progress"];
  if (opts.branch !== undefined && opts.branch.length > 0) {
    args.push("--branch", opts.branch);
  }
  args.push(cloneUrl, target);

  // Bounded queue so a slow consumer can't drive memory to the moon.
  // 1024 events / 8s of typical progress lines is the cap; backpressure
  // is "drop oldest" since the user can survive missing a few
  // intermediate progress lines and the `done`/`error` event is
  // generated locally (not from the queue).
  const queue: CloneEvent[] = [];
  let pendingResolve: ((e: IteratorResult<CloneEvent>) => void) | undefined;
  let finished = false;
  let finishedReason: { type: "done"; target: string } | { type: "error"; message: string } | null =
    null;

  const push = (e: CloneEvent): void => {
    if (pendingResolve !== undefined) {
      const resolve = pendingResolve;
      pendingResolve = undefined;
      resolve({ value: e, done: false });
      return;
    }
    queue.push(e);
    while (queue.length > 1024) queue.shift();
  };

  const finish = (
    reason: { type: "done"; target: string } | { type: "error"; message: string },
  ): void => {
    if (finished) return;
    finished = true;
    finishedReason = reason;
    push({ ...reason });
    if (pendingResolve !== undefined) {
      const resolve = pendingResolve;
      pendingResolve = undefined;
      resolve({ value: undefined, done: true });
    }
  };

  const events: AsyncIterable<CloneEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<CloneEvent>> {
          if (queue.length > 0) {
            const e = queue.shift()!;
            return Promise.resolve({ value: e, done: false });
          }
          if (finished && finishedReason !== null && queue.length === 0) {
            // We already pushed the terminal event in finish(); subsequent
            // calls should report done.
            return Promise.resolve({ value: undefined, done: true });
          }
          return new Promise((resolve) => {
            pendingResolve = resolve;
          });
        },
      };
    },
  };

  push({ type: "started", cloneUrlForDisplay: displayUrl });

  const env = gitCloneEnv();

  if (opts.insecureTls === true) {
    // git's standard "skip cert validation" knob. Equivalent to
    // `-c http.sslVerify=false` on the command line, but as an env
    // var so the post-clone `remote set-url` step inherits it too.
    env.GIT_SSL_NO_VERIFY = "true";
    // Operator-visible log so the relaxed posture is recorded in
    // docker logs. Bypasses pino (same rationale as the
    // webhook-insecure-tls log) so a LOG_LEVEL=warn deploy still
    // surfaces it.
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        time: new Date().toISOString(),
        msg: "git-clone-insecure-tls",
        url: displayUrl,
        target,
      }) + "\n",
    );
  }

  const child = spawn("git", args, {
    cwd: dirname(target),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...sandboxSpawnIdentity(),
  });

  let stderrBuffer = "";
  let stderrBytes = 0;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrBytes += Buffer.byteLength(chunk, "utf8");
    // Cap the in-memory buffer — git progress lines come with `\r`
    // overwrites and can fill memory if something runs amok.
    if (stderrBytes > MAX_PROGRESS_BUFFER_BYTES) {
      stderrBuffer = stderrBuffer.slice(-MAX_PROGRESS_BUFFER_BYTES);
      stderrBytes = MAX_PROGRESS_BUFFER_BYTES;
    }
    // Git uses `\r` to overwrite progress lines in-place. Split on
    // both `\r` and `\n` so we surface each "frame" as its own
    // progress line.
    stderrBuffer += chunk;
    const lines = stderrBuffer.split(/[\r\n]/);
    stderrBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const parsed = parseProgressLine(trimmed);
      if (parsed !== undefined) {
        push({ type: "progress", phase: parsed.phase, percent: parsed.percent, raw: trimmed });
      } else {
        push({ type: "stderr", line: trimmed });
      }
    }
  });

  // Abort plumbing — caller's AbortSignal kills the child.
  if (opts.signal !== undefined) {
    const onAbort = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener("abort", onAbort, { once: true });
  }

  // Hard timeout — runaway clones don't sit forever.
  const timeoutTimer = setTimeout(() => {
    child.kill("SIGTERM");
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  }, CLONE_TIMEOUT_MS);
  timeoutTimer.unref();

  const promise = new Promise<void>((resolveOuter) => {
    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      finish({
        type: "error",
        message: `Failed to spawn git clone: ${err instanceof Error ? err.message : String(err)}`,
      });
      resolveOuter();
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      void (async () => {
        if (code === 0) {
          // Success — strip the token from `origin` if we injected
          // one. Best-effort; if it fails we still report success
          // (the clone IS done) but warn-log it.
          if (opts.token !== undefined) {
            await stripTokenFromOrigin(target, displayUrl).catch(() => undefined);
          }
          if (opts.insecureTls === true) {
            await persistInsecureTlsForOrigin(target, displayUrl).catch(() => undefined);
          }
          try {
            await applySandboxTreeHandoff(target);
          } catch (err) {
            await rm(target, { recursive: true, force: true }).catch(() => undefined);
            finish({
              type: "error",
              message: `git clone completed but sandbox permission handoff failed: ${err instanceof Error ? err.message : String(err)}`,
            });
            resolveOuter();
            return;
          }
          finish({ type: "done", target });
          resolveOuter();
          return;
        }
        // Non-zero exit (or killed). Clean up the half-cloned dir
        // so a retry doesn't trip "destination already exists" and
        // no leftover token bytes survive in `.git/config`.
        await rm(target, { recursive: true, force: true }).catch(() => undefined);
        const sigMsg = signal !== null ? ` (signal ${signal})` : "";
        finish({
          type: "error",
          message: `git clone exited with code ${code}${sigMsg}`,
        });
        resolveOuter();
      })();
    });
  });

  return { promise, events };
}

/**
 * After a successful clone, rewrite `origin` to the token-free URL
 * so the token doesn't persist in `.git/config`. Best-effort —
 * any failure is swallowed by the caller.
 */
async function stripTokenFromOrigin(target: string, cleanUrl: string): Promise<void> {
  await runGitQuiet(target, ["remote", "set-url", "origin", cleanUrl]);
}

/**
 * Persist the clone-time TLS opt-in for future fetch/pull/push from the
 * same repo without changing global git config. URL scoping keeps the
 * relaxed verification tied to the cloned origin URL instead of every
 * HTTPS remote on the machine.
 */
async function persistInsecureTlsForOrigin(target: string, cleanUrl: string): Promise<void> {
  await runGitQuiet(target, ["config", "--local", `http.${cleanUrl}.sslVerify`, "false"]);
}

function gitCloneEnv(): Record<string, string> {
  const env = scrubbedEnv();
  return {
    ...env,
    ...(config.agentToolSandbox.enabled ? { HOME: config.agentToolSandbox.home } : {}),
    // Prevent git from prompting on stdin when credentials are
    // wrong / missing — without this, git can hang indefinitely
    // waiting for a username/password.
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function runGitQuiet(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, ...args], {
      env: gitCloneEnv(),
      stdio: "ignore",
      ...sandboxSpawnIdentity(),
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0] ?? "command"} exited ${code}`));
    });
  });
}

/**
 * Verify the target directory is suitable for a clone: either
 * doesn't exist, or exists and is empty. Returns the resolved path
 * on success. Used by the route before spawning `git clone` so we
 * surface "directory not empty" as a 409 rather than letting the
 * spawn fail with a less friendly error.
 */
export async function assertTargetClonable(target: string): Promise<void> {
  const resolved = resolve(target);
  try {
    const st = await stat(resolved);
    if (!st.isDirectory()) {
      throw new GitCloneError(
        "target_not_a_directory",
        `Target exists but is not a directory: ${resolved}`,
      );
    }
    // Exists and is a directory — only OK if empty. git clone will
    // refuse to clone into a non-empty dir; we catch it here to give
    // a better error.
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(resolved);
    if (entries.length > 0) {
      throw new GitCloneError("target_not_empty", `Target directory is not empty: ${resolved}`);
    }
  } catch (err) {
    if (err instanceof GitCloneError) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return; // doesn't exist — fine
    throw err;
  }
}

export { join as joinTargetPath };

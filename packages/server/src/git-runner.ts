import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { assertInsideRoot } from "./file-manager.js";

const execFileAsync = promisify(execFile);

/**
 * Thin wrapper around `git` for the pi-forge's git panel.
 *
 * Rules:
 *   - NEVER `exec` with string interpolation. Always `execFile` with
 *     an args array. The project path comes from our own
 *     `project-manager` (validated against WORKSPACE_PATH); commit
 *     messages and remote/branch names come from user input — args
 *     arrays make shell-quoting moot regardless of content.
 *   - "Not a git repo" → return empty / sensible default, NEVER 500.
 *     Users can have non-git project folders and the panel should
 *     just sit quiet, not error.
 *   - User-visible errors carry a short message we synthesize from
 *     the stderr; we never blast raw stderr at the client (would
 *     leak fs paths + git plumbing detail).
 *
 * Output buffer: 16 MB on every call. Plenty for `diff` and `log
 * --oneline -30` even on monorepos; if a future `log` query needs
 * more, we'll cap it explicitly.
 */

const MAX_BUFFER = 16 * 1024 * 1024;

/* ----------------------------- errors ----------------------------- */

export class GitNotInstalledError extends Error {
  constructor() {
    super("git binary not found on PATH");
    this.name = "GitNotInstalledError";
  }
}

export class GitCommandError extends Error {
  readonly exitCode: number | null;
  /** Sanitized first line of stderr — safe to surface to the user. */
  readonly userMessage: string;
  constructor(exitCode: number | null, userMessage: string, fullMessage: string) {
    super(fullMessage);
    this.name = "GitCommandError";
    this.exitCode = exitCode;
    this.userMessage = userMessage;
  }
}

/* ----------------------------- types ----------------------------- */

/**
 * Status flag combinations exposed to the client. We map git's
 * porcelain v1 two-character XY codes into a coarser bucket so the
 * UI can render badges without a full git literacy quiz.
 */
export type FileStatusKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "ignored"
  | "conflicted"
  | "unknown";

export interface FileStatusEntry {
  /** Path relative to the project root. */
  path: string;
  /** True when the change is in the index (XY's first char != ' ' or '?'). */
  staged: boolean;
  /** True when the working-tree differs from the index (XY's second char != ' '). */
  unstaged: boolean;
  /** Coarse classification driven by the dominant XY char. */
  kind: FileStatusKind;
  /** Two-char porcelain code, returned verbatim for advanced UI. */
  code: string;
  /** For renames/copies, the original path (porcelain "<orig> -> <new>"). */
  originalPath?: string;
}

export interface StatusResult {
  isGitRepo: boolean;
  branch: string | undefined;
  files: FileStatusEntry[];
}

export interface LogEntry {
  hash: string;
  message: string;
  author: string;
  date: string;
  /** Parent commit hashes — empty for the root commit, two for merges. */
  parents: string[];
  /**
   * Ref decorations git would print with `%D` — branch tips, tags, and
   * the magic "HEAD -> main" indicator that tells you which ref is
   * currently checked out. The renderer uses these to badge the
   * commit row with branch / tag pills.
   */
  refs: string[];
}

export interface BranchEntry {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface BranchesResult {
  isGitRepo: boolean;
  current: string | undefined;
  branches: BranchEntry[];
}

export interface WorktreeEntry {
  path: string;
  head: string | undefined;
  branch: string | undefined;
  bare: boolean;
  detached: boolean;
  current: boolean;
}

export interface WorktreesResult {
  isGitRepo: boolean;
  worktrees: WorktreeEntry[];
}

/* ----------------------------- helpers ----------------------------- */

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * Run `git <args>` in `cwd`. Resolves on exit code 0; rejects with
 * `GitCommandError` (with sanitized userMessage) otherwise.
 *
 * `GIT_TERMINAL_PROMPT=0` keeps git from blocking on interactive
 * credential prompts when the user pushes without configured creds —
 * we want a fast 4xx instead of a hung process. Same for
 * `GIT_ASKPASS` set to `true` (the no-op binary).
 */
/**
 * `-c` flags prepended to every git invocation so a hostile per-repo
 * `.git/config` can't get the pi-forge to execute arbitrary commands
 * via `core.fsmonitor` / `core.editor` / `core.pager` /
 * `core.sshCommand` / `core.askPass`. Cloning a third-party repo is a
 * normal flow; the cloned repo's local config CAN ship hostile values
 * for these keys (the initial clone is from upstream and doesn't apply
 * the local config, but every subsequent `git status` etc. does).
 *
 * Setting these to safe defaults at invocation time overrides any
 * value the repo's `.git/config` set. Reference:
 * https://github.blog/2022-04-12-git-security-vulnerability-announced/
 */
const HARDENING_ARGS: readonly string[] = [
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.askPass=",
  "-c",
  "core.sshCommand=ssh",
  "-c",
  "core.editor=true",
  "-c",
  "core.pager=cat",
];

async function runGit(cwd: string, args: string[]): Promise<RunResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...HARDENING_ARGS, ...args], {
      cwd,
      maxBuffer: MAX_BUFFER,
      env: gitEnv(),
    });
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: string | number;
    };
    if (e.code === "ENOENT") throw new GitNotInstalledError();
    const stderr = (e.stderr ?? "").toString();
    const userMessage = sanitizeStderr(stderr, cwd);
    const exitCode = typeof e.code === "number" ? e.code : null;
    throw new GitCommandError(exitCode, userMessage, stderr || (e.message ?? "git failed"));
  }
}

/**
 * Build the env object every git invocation should use. Centralising it
 * here lets `runGit` (the typed-error wrapper) and `runGitRaw` (the
 * permissive escape hatch used by `turn-diff-builder`) share the same
 * GIT_TERMINAL_PROMPT / GIT_ASKPASS / LC_ALL / HOME scrubbing.
 *
 * `git config` consults $HOME for the user's global config. If the
 * parent process has no HOME (some container init flows, certain
 * systemd/launchd configurations), git falls back to /etc/passwd
 * lookup which can fail opaquely. Force a sensible default from
 * `os.homedir()` (which itself checks USERPROFILE on Windows + falls
 * back to the passwd entry).
 */
function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: process.env.HOME ?? homedir(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "true",
    LC_ALL: "C",
  };
}

/**
 * Permissive runner for callers that need a custom maxBuffer or
 * non-typed-error semantics. Returns the raw stdout/stderr/exitCode
 * tuple WITHOUT mapping non-zero exit codes to GitCommandError —
 * callers handle exit codes themselves. Inherits the same env
 * scrubbing as `runGit`.
 *
 * Currently used by `turn-diff-builder.ts` which wants `git diff` to
 * succeed even when the path is untracked (exit 0 with empty output)
 * and accepts a 16 MB diff buffer.
 */
export async function runGitRaw(
  cwd: string,
  args: string[],
  opts: { maxBuffer?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("git", [...HARDENING_ARGS, ...args], {
      cwd,
      maxBuffer: opts.maxBuffer ?? MAX_BUFFER,
      env: gitEnv(),
    });
    return { stdout, stderr };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new GitNotInstalledError();
    throw err;
  }
}

/**
 * Trim git's stderr to a one-line user-visible message. Strips the
 * project root path (would otherwise leak filesystem layout — `git
 * push` failing with "fatal: unable to access '/Users/.../foo/.git/'"
 * would echo the host path back to the browser). Also drops the
 * common "fatal: "/"error: "/"warning: " prefix and clamps to 200
 * chars. Single-tenant doesn't make this a security issue per se,
 * but the previous comment claimed scrubbing happened when it didn't
 * — bringing the implementation in line with the documented behavior.
 */
function sanitizeStderr(stderr: string, cwd?: string): string {
  let firstLine = stderr.split("\n").find((l) => l.trim().length > 0) ?? "git error";
  if (cwd !== undefined && cwd.length > 0) {
    firstLine = firstLine.split(cwd).join("<project>");
  }
  // Drop common "fatal: " / "error: " prefixes that confuse users.
  const stripped = firstLine.replace(/^(fatal|error|warning):\s*/i, "");
  return stripped.length > 200 ? stripped.slice(0, 197) + "…" : stripped;
}

/**
 * Initialize a fresh git repo at `cwd` with `main` as the initial
 * branch. `git init -b main` requires git ≥ 2.28; below that the
 * `--initial-branch` flag is unrecognized and we fall back to a
 * plain `git init` — caller can still rename to main on the first
 * commit if desired. Idempotent: if `cwd` is already a repo, this
 * resolves without changing anything (git's own `init` is a no-op
 * on an existing repo).
 */
export async function initRepo(cwd: string): Promise<void> {
  try {
    await runGit(cwd, ["init", "-b", "main"]);
  } catch (err) {
    // Older git versions (< 2.28) don't recognise `-b`. Detect via
    // the stderr message and retry without it. Other errors propagate.
    const msg = err instanceof Error ? err.message : "";
    if (/unknown (option|switch).*-b|invalid option.*initial-branch/i.test(msg)) {
      await runGit(cwd, ["init"]);
      return;
    }
    throw err;
  }
}

/**
 * True iff `cwd` is inside a git working tree. Cheap probe used by
 * every public function so "not a repo" can return the empty default
 * rather than throw. Exported so route helpers (e.g. for the diff
 * endpoints' `isGitRepo` flag) don't have to re-implement it.
 */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    // GitCommandError (non-zero exit, common: "not a git repository"),
    // GitNotInstalledError, or fs error. All collapse to "not a repo"
    // — the panel renders an empty state without distinguishing.
    return false;
  }
}

/* ----------------------------- status ----------------------------- */

/**
 * `git status --porcelain=v1 -uall -z` output. Records are NUL-
 * terminated (no quoting / escaping), so paths containing literal
 * newlines, quotes, or other special chars round-trip cleanly.
 *
 * Each record is `XY <path>` (length ≥ 4 with the leading XY + space).
 * Renames and copies are special: `XY <newpath>` is followed by a
 * SECOND NUL-terminated record containing only the original path. We
 * peek at the next token in that case rather than splitting on " -> ".
 */
function parseStatus(stdout: string): FileStatusEntry[] {
  const out: FileStatusEntry[] = [];
  // Trailing NUL produces an empty final element — drop it.
  const records = stdout.split("\0").filter((r) => r.length > 0);
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? "";
    if (rec.length < 4) continue;
    const code = rec.slice(0, 2);
    const path = rec.slice(3);
    const x = code[0] ?? " ";
    const y = code[1] ?? " ";
    let originalPath: string | undefined;
    // For renames/copies, the next record is the ORIGINAL path. Peek
    // and consume.
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const next = records[i + 1];
      if (next !== undefined) {
        originalPath = next;
        i++;
      }
    }
    if (path.length === 0) continue;
    const staged = x !== " " && x !== "?";
    const unstaged = y !== " " && y !== "?";
    const entry: FileStatusEntry = {
      path,
      staged,
      unstaged,
      kind: classifyStatus(x, y),
      code,
    };
    if (originalPath !== undefined) entry.originalPath = originalPath;
    out.push(entry);
  }
  return out;
}

function classifyStatus(x: string, y: string): FileStatusKind {
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "conflicted";
  }
  if (x === "?" && y === "?") return "untracked";
  if (x === "!" || y === "!") return "ignored";
  // Prefer the staged side's classification — it's "what will be
  // committed". Fall back to the unstaged side.
  const c = x !== " " && x !== "?" ? x : y;
  switch (c) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

export async function getStatus(cwd: string): Promise<StatusResult> {
  if (!(await isGitRepo(cwd))) {
    return { isGitRepo: false, branch: undefined, files: [] };
  }
  const [branchRes, statusRes] = await Promise.all([
    runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => undefined),
    runGit(cwd, ["status", "--porcelain=v1", "-uall", "-z"]),
  ]);
  // `--abbrev-ref HEAD` returns "HEAD" on a detached checkout; surface
  // that verbatim so the UI can render it.
  const branch = branchRes?.stdout.trim();
  return {
    isGitRepo: true,
    branch: branch !== undefined && branch.length > 0 ? branch : undefined,
    files: parseStatus(statusRes.stdout),
  };
}

/* ----------------------------- diffs ----------------------------- */

/**
 * Diff variants share the same shape (raw unified text + a
 * "isGitRepo" flag the route can use to decide between 200 empty and
 * 200 with content). Empty repo / non-repo → empty string.
 */
/**
 * Diff result that includes the `isGitRepo` flag the route returns
 * verbatim. Wrapping the flag here means a single `isGitRepo` probe
 * inside the runner — the route doesn't need to call `isGitRepo`
 * a second time after the runner returned an empty diff.
 */
export interface DiffResult {
  isGitRepo: boolean;
  diff: string;
}

async function diffArgs(cwd: string, args: string[]): Promise<DiffResult> {
  if (!(await isGitRepo(cwd))) return { isGitRepo: false, diff: "" };
  const baseArgs = ["diff", "--no-color", "--no-ext-diff", ...args];
  const { stdout } = await runGit(cwd, baseArgs);
  return { isGitRepo: true, diff: stdout };
}

export function getDiff(cwd: string): Promise<DiffResult> {
  return diffArgs(cwd, []);
}

export function getStagedDiff(cwd: string): Promise<DiffResult> {
  return diffArgs(cwd, ["--cached"]);
}

export async function getFileDiff(cwd: string, path: string, staged: boolean): Promise<DiffResult> {
  if (!(await isGitRepo(cwd))) return { isGitRepo: false, diff: "" };
  // Belt-and-suspenders lexical guard. git itself rejects paths outside
  // the working tree, but routing every path through the same check
  // file-manager uses keeps the boundary obvious in one place. `path`
  // arrives relative-to-project from the route, so resolve against cwd
  // before checking.
  assertInsideRoot(resolve(cwd, path), cwd);
  const args = ["diff", "--no-color", "--no-ext-diff"];
  if (staged) args.push("--cached");
  args.push("--", path);
  const { stdout } = await runGit(cwd, args);
  return { isGitRepo: true, diff: stdout };
}

/* ----------------------------- log ----------------------------- */

export interface LogResult {
  isGitRepo: boolean;
  commits: LogEntry[];
}

export async function getLog(cwd: string, limit = 30): Promise<LogResult> {
  if (!(await isGitRepo(cwd))) return { isGitRepo: false, commits: [] };
  // Custom format with NUL field separators and RS record separator.
  // Avoids ambiguity if a commit message has any character we'd
  // otherwise pick as a delimiter. New fields:
  //   %P → space-separated parent hashes (empty for root, 2+ for merges)
  //   %D → ref decorations like "HEAD -> main, origin/main, tag: v1"
  // We pass `HEAD --branches --tags --remotes` so branches that
  // aren't ancestors of HEAD still surface — the graph renderer wants
  // the full topology, not just first-parent ancestry from the
  // current branch. Explicit `HEAD` keeps the checked-out branch in
  // the result even if many older branch tips would otherwise crowd
  // it out at the `--max-count` boundary. `--topo-order` keeps
  // commits from disjoint branches grouped instead of date-interleaved
  // so the graph reads cleanly.
  const FS = "\x1F";
  const RS = "\x1E";
  const fmt = `%H${FS}%s${FS}%an${FS}%aI${FS}%P${FS}%D${RS}`;
  const { stdout } = await runGit(cwd, [
    "log",
    "--topo-order",
    "HEAD",
    "--branches",
    "--tags",
    "--remotes",
    `--max-count=${Math.max(1, Math.min(limit, 1000))}`,
    `--pretty=format:${fmt}`,
  ]);
  if (stdout.length === 0) return { isGitRepo: true, commits: [] };
  const commits = stdout
    .split(RS)
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.length > 0)
    .map((rec): LogEntry => {
      const [hash = "", message = "", author = "", date = "", parentsRaw = "", refsRaw = ""] =
        rec.split(FS);
      const parents =
        parentsRaw.length > 0 ? parentsRaw.split(" ").filter((p) => p.length > 0) : [];
      const refs =
        refsRaw.length > 0
          ? refsRaw
              .split(",")
              .map((r) => r.trim())
              .filter((r) => r.length > 0)
          : [];
      return { hash, message, author, date, parents, refs };
    });
  return { isGitRepo: true, commits };
}

/* ----------------------------- remotes ----------------------------- */

export interface RemoteEntry {
  name: string;
  /** Fetch URL (the more meaningful of the two for users). */
  fetchUrl: string;
  /** Push URL — usually identical to fetch, but git allows configuring them
   *  separately (e.g. read-only mirror + write-through fork). Surfaced
   *  alongside fetch so the UI can flag the divergence when present. */
  pushUrl: string;
  /** True when this repo has local URL-scoped SSL verification disabled for the remote URL. */
  insecureTls: boolean;
}

/**
 * `git remote -v` output is two lines per remote (one (fetch), one (push)),
 * tab-delimited:
 *
 *   origin\thttps://github.com/foo/bar.git (fetch)
 *   origin\thttps://github.com/foo/bar.git (push)
 *
 * We parse both forms into a single entry per remote so the UI doesn't
 * render duplicates. Empty array for non-git or no-remotes-configured.
 */
export interface RemotesResult {
  isGitRepo: boolean;
  remotes: RemoteEntry[];
}

export async function getRemotes(cwd: string): Promise<RemotesResult> {
  if (!(await isGitRepo(cwd))) return { isGitRepo: false, remotes: [] };
  const { stdout } = await runGit(cwd, ["remote", "-v"]);
  const map = new Map<string, RemoteEntry>();
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    // `name<TAB>url (fetch|push)`
    const m = /^(\S+)\s+(.+?)\s+\((fetch|push)\)$/.exec(line);
    if (m === null) continue;
    const name = m[1] ?? "";
    const url = m[2] ?? "";
    const dir = m[3] === "push" ? "push" : "fetch";
    if (name.length === 0) continue;
    const existing = map.get(name);
    if (existing === undefined) {
      // Pre-fill the OTHER URL with the same value; if the second
      // line for this remote contradicts, we overwrite below.
      map.set(name, { name, fetchUrl: url, pushUrl: url, insecureTls: false });
    } else if (dir === "push") {
      existing.pushUrl = url;
    } else {
      existing.fetchUrl = url;
    }
  }
  const remotes = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  await Promise.all(
    remotes.map(async (remote) => {
      remote.insecureTls = await remoteHasInsecureTls(cwd, remote);
    }),
  );
  return { isGitRepo: true, remotes };
}

/**
 * Add a remote. Same name validator as branch creation reused via
 * `assertRemoteName`. The URL is passed verbatim to git as a
 * positional arg; `execFile` (no shell) means there's no command-
 * injection surface even if the URL contains spaces or shell
 * metachars. Common shapes: `https://github.com/foo/bar.git`,
 * `git@github.com:foo/bar.git`, `file:///abs/path`.
 */
export async function addRemote(
  cwd: string,
  name: string,
  url: string,
  opts: { insecureTls?: boolean } = {},
): Promise<void> {
  assertRemoteName(name);
  assertRemoteUrl(url);
  await runGit(cwd, ["remote", "add", name, url]);
  if (opts.insecureTls === true) {
    await setUrlInsecureTls(cwd, url, true);
  }
}

function assertRemoteUrl(url: string): void {
  if (url.length === 0 || url.length > 1024) {
    throw new InvalidBranchNameError(`invalid remote URL`);
  }
  // Reject leading dash so the URL can't be parsed as a flag if a
  // future code path drops the `--` separator. `git remote add`
  // ignores `--` in current versions, but defensive.
  if (url.startsWith("-")) {
    throw new InvalidBranchNameError(`invalid remote URL`);
  }
}

async function getRemoteUrls(cwd: string, name: string): Promise<string[]> {
  assertRemoteName(name);
  const urls = new Set<string>();
  const fetchUrl = await runGit(cwd, ["remote", "get-url", name]);
  const pushUrl = await runGit(cwd, ["remote", "get-url", "--push", name]).catch(() => undefined);
  const fetch = fetchUrl.stdout.trim();
  const push = pushUrl?.stdout.trim();
  if (fetch.length > 0) urls.add(fetch);
  if (push !== undefined && push.length > 0) urls.add(push);
  return [...urls];
}

async function remoteHasInsecureTls(cwd: string, remote: RemoteEntry): Promise<boolean> {
  const urls = new Set([remote.fetchUrl, remote.pushUrl].filter((url) => url.length > 0));
  for (const url of urls) {
    try {
      const { stdout } = await runGit(cwd, [
        "config",
        "--local",
        "--get-urlmatch",
        "http.sslVerify",
        url,
      ]);
      if (stdout.trim().toLowerCase() === "false") return true;
    } catch {
      // No local URL-specific match for this URL.
    }
  }
  return false;
}

async function setUrlInsecureTls(cwd: string, url: string, enabled: boolean): Promise<void> {
  assertRemoteUrl(url);
  const key = `http.${url}.sslVerify`;
  if (enabled) {
    await runGit(cwd, ["config", "--local", key, "false"]);
    return;
  }
  await runGit(cwd, ["config", "--local", "--unset-all", key]).catch(() => undefined);
}

export async function setRemoteInsecureTls(
  cwd: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  const urls = await getRemoteUrls(cwd, name);
  await Promise.all(urls.map((url) => setUrlInsecureTls(cwd, url, enabled)));
}

/**
 * Remove a remote. Idempotent at the route layer — git emits
 * "fatal: No such remote" if the name is unknown, which surfaces as
 * the existing 400 git_failed; the route layer can choose to map
 * that to 404 if needed.
 */
export async function removeRemote(cwd: string, name: string): Promise<void> {
  assertRemoteName(name);
  await runGit(cwd, ["remote", "remove", name]);
}

/* ----------------------------- branches ----------------------------- */

export async function getWorktrees(cwd: string): Promise<WorktreesResult> {
  if (!(await isGitRepo(cwd))) return { isGitRepo: false, worktrees: [] };
  const currentPath = await canonicalPath(cwd);
  const { stdout } = await runGit(cwd, ["worktree", "list", "--porcelain", "-z"]);
  const worktrees: WorktreeEntry[] = [];
  let entry: WorktreeEntry | undefined;
  const finish = async (): Promise<void> => {
    if (entry !== undefined) {
      const path = await canonicalPath(entry.path);
      worktrees.push({ ...entry, path, current: path === currentPath });
      entry = undefined;
    }
  };
  for (const token of stdout.split("\0")) {
    if (token.length === 0) {
      await finish();
      continue;
    }
    if (token.startsWith("worktree ")) {
      await finish();
      const path = token.slice("worktree ".length);
      entry = {
        path,
        head: undefined,
        branch: undefined,
        bare: false,
        detached: false,
        current: false,
      };
    } else if (entry !== undefined && token.startsWith("HEAD ")) {
      entry.head = token.slice("HEAD ".length);
    } else if (entry !== undefined && token.startsWith("branch ")) {
      const branch = token.slice("branch ".length);
      entry.branch = branch.startsWith("refs/heads/") ? branch.slice("refs/heads/".length) : branch;
    } else if (entry !== undefined && token === "bare") {
      entry.bare = true;
    } else if (entry !== undefined && token === "detached") {
      entry.detached = true;
    }
  }
  await finish();
  return { isGitRepo: true, worktrees };
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

export async function getBranches(cwd: string): Promise<BranchesResult> {
  if (!(await isGitRepo(cwd))) return { isGitRepo: false, current: undefined, branches: [] };
  const { stdout } = await runGit(cwd, ["branch", "-a", "--format=%(HEAD)\x1F%(refname:short)"]);
  const branches: BranchEntry[] = [];
  let current: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.length === 0) continue;
    const [headFlag = "", name = ""] = line.split("\x1F");
    if (name.length === 0) continue;
    // git emits "(HEAD detached at ...)" as a pseudo-ref; skip.
    if (name.startsWith("(")) continue;
    const isCurrent = headFlag === "*";
    // git's --format always prefixes remote-tracking branches with
    // `remotes/`. The earlier `origin/` heuristic mis-classified a
    // local branch literally named `origin/feature` as remote.
    const remote = name.startsWith("remotes/");
    const cleanName = remote ? name.slice("remotes/".length) : name;
    branches.push({ name: cleanName, current: isCurrent, remote });
    if (isCurrent) current = cleanName;
  }
  return { isGitRepo: true, current, branches };
}

/* ----------------------------- mutations ----------------------------- */

export async function stagePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(cwd, ["add", "--", ...paths]);
}

export async function unstagePaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(cwd, ["restore", "--staged", "--", ...paths]);
}

/**
 * Discard local changes for the given files: restores both the
 * index AND the working tree to HEAD via `git restore --staged
 * --worktree --source=HEAD -- <paths>`. The user-visible "Revert"
 * action.
 *
 * For untracked files, `git restore` errors with "pathspec did
 * not match any file(s) known to git". The route surfaces this
 * via `GitCommandError` so the UI can display "untracked files
 * can't be reverted; delete them via the file browser instead."
 *
 * Destructive — the caller is expected to gate this behind a
 * confirmation in the UI (the click-twice-to-confirm pattern in
 * GitPanel).
 */
export async function revertPaths(cwd: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  await runGit(cwd, ["restore", "--staged", "--worktree", "--source=HEAD", "--", ...paths]);
}

/**
 * Commit the currently-staged changes. Empty / whitespace-only
 * messages are rejected at the route layer; this just runs the
 * command. `--no-verify` is NOT used — we want pre-commit hooks to
 * fire so the user's lint/test/format checks gate browser commits
 * the same way they gate terminal commits.
 */
export async function commit(cwd: string, message: string): Promise<{ hash: string }> {
  await runGit(cwd, ["commit", "-m", message]);
  // Capture the new HEAD's hash so the route can echo it back —
  // useful for the UI to highlight "your commit" in the log section.
  const { stdout } = await runGit(cwd, ["rev-parse", "HEAD"]);
  return { hash: stdout.trim() };
}

/* ----------------------------- branch ops ----------------------------- */

/**
 * Restrict branch names to the same character set git itself accepts in
 * common usage — letters, digits, dot, dash, underscore, slash. Reject
 * anything else (spaces, control chars, leading dash that could be
 * mistaken for a flag, dot-only segments, double slashes, etc.) with a
 * single error code so the route can return a stable 400.
 */
export class InvalidBranchNameError extends Error {
  constructor(name: string) {
    super(`invalid branch name: ${JSON.stringify(name)}`);
    this.name = "InvalidBranchNameError";
  }
}

function assertBranchName(name: string): void {
  if (name.length === 0 || name.length > 200) throw new InvalidBranchNameError(name);
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new InvalidBranchNameError(name);
  if (name.startsWith("-") || name.startsWith("/") || name.endsWith("/")) {
    throw new InvalidBranchNameError(name);
  }
  if (name.includes("//") || name.includes("..") || name.includes("@{")) {
    throw new InvalidBranchNameError(name);
  }
  // git reserves `HEAD` and a few similar single-token refs.
  if (name === "HEAD" || name === "FETCH_HEAD" || name === "ORIG_HEAD" || name === "MERGE_HEAD") {
    throw new InvalidBranchNameError(name);
  }
  // git's check-ref-format rules we replicate explicitly so the user
  // gets the cleaner `invalid_branch_name` 400 instead of `git_failed`:
  //   - no segment may begin with `.` (so `.foo` and `bar/.baz` reject)
  //   - no segment may end with `.lock` (git uses .lock files for ref locks)
  //   - the whole name may not end with `.`
  if (name.endsWith(".")) throw new InvalidBranchNameError(name);
  for (const segment of name.split("/")) {
    if (segment.startsWith(".")) throw new InvalidBranchNameError(name);
    if (segment.endsWith(".lock")) throw new InvalidBranchNameError(name);
  }
}

/**
 * Switch the working tree to `branch`. Refuses on a dirty tree (git's
 * default) — the caller is expected to surface the resulting
 * `GitCommandError` to the user, who can stash or revert first.
 *
 * No `--` separator: `git checkout -- <name>` interprets <name> as a
 * pathspec and ALWAYS fails with "did not match any file(s) known to
 * git". The branch-name validator (assertBranchName) already rejects
 * leading dashes, so flag injection isn't a concern here.
 */
export async function checkoutBranch(cwd: string, branch: string): Promise<void> {
  assertBranchName(branch);
  await runGit(cwd, ["checkout", branch]);
}

export interface CreateBranchOptions {
  /** Branch / commit to base the new branch on. Defaults to current HEAD. */
  startPoint?: string;
  /** When true, also switch the working tree to the new branch. */
  checkout?: boolean;
}

/**
 * Create a new local branch. `startPoint` defaults to HEAD; pass
 * `origin/main` (etc.) to branch off a tracking ref. When `checkout`
 * is true, uses `git checkout -b` to create + switch in one step.
 */
export async function createBranch(
  cwd: string,
  name: string,
  opts: CreateBranchOptions = {},
): Promise<void> {
  assertBranchName(name);
  if (opts.startPoint !== undefined) assertBranchName(opts.startPoint);
  if (opts.checkout === true) {
    const args = ["checkout", "-b", name];
    if (opts.startPoint !== undefined) args.push(opts.startPoint);
    await runGit(cwd, args);
  } else {
    const args = ["branch", name];
    if (opts.startPoint !== undefined) args.push(opts.startPoint);
    await runGit(cwd, args);
  }
}

export interface DeleteBranchOptions {
  /** Force-delete via `-D` even when the branch isn't merged. */
  force?: boolean;
}

/**
 * Delete a local branch. Default uses `-d` (refuses to delete an
 * unmerged branch); `force: true` switches to `-D`. Refuses to delete
 * the currently-checked-out branch (git's default behavior surfaces a
 * `GitCommandError`).
 */
export async function deleteBranch(
  cwd: string,
  name: string,
  opts: DeleteBranchOptions = {},
): Promise<void> {
  assertBranchName(name);
  await runGit(cwd, ["branch", opts.force === true ? "-D" : "-d", name]);
}

export interface PushOptions {
  remote?: string;
  branch?: string;
  /**
   * When true, adds `--set-upstream` so the push records the
   * remote/branch as the tracking ref. Required on first push of a
   * new branch — without this the user gets the default
   * "fatal: The current branch has no upstream branch" error.
   */
  setUpstream?: boolean;
}

export interface FetchOptions {
  remote?: string;
  /** Add `--prune` so deleted upstream branches are removed locally too. */
  prune?: boolean;
}

/**
 * `git fetch [<remote>]` — never touches the working tree, so safe to
 * call regardless of dirty state. Returns the captured output (mostly
 * stderr — git's "Fetching origin\nFrom github.com:foo/bar..." text).
 */
export async function fetch(cwd: string, opts: FetchOptions = {}): Promise<{ stdout: string }> {
  const args = ["fetch"];
  if (opts.prune === true) args.push("--prune");
  if (opts.remote !== undefined) {
    assertRemoteName(opts.remote);
    args.push(opts.remote);
  }
  const { stdout, stderr } = await runGit(cwd, args);
  return { stdout: stdout.length > 0 ? stdout : stderr };
}

export interface PullOptions {
  remote?: string;
  branch?: string;
  /**
   * `--rebase` rebases local commits on top of the fetched ref instead
   * of merging. Mirrors `git pull --rebase` semantics; the user can
   * switch in the UI per-pull.
   */
  rebase?: boolean;
}

/**
 * `git pull [<remote> [<branch>]]` — fetches AND merges (or rebases).
 * Conflicts are NOT resolved by us — the underlying GitCommandError's
 * stderr is surfaced verbatim (e.g. "CONFLICT (content): Merge
 * conflict in foo.ts") so the user can drop to the integrated
 * terminal to fix.
 *
 * Argument grammar: the second positional is a branch ONLY when the
 * first positional is also given. `git pull <name>` is interpreted
 * as a remote, not a branch — so when the caller passes only `branch`
 * we default `remote` to `"origin"` rather than producing a
 * misleading "remote not found" error.
 */
export async function pull(cwd: string, opts: PullOptions = {}): Promise<{ stdout: string }> {
  const args = ["pull"];
  if (opts.rebase === true) args.push("--rebase");
  const remote = opts.remote ?? (opts.branch !== undefined ? "origin" : undefined);
  if (remote !== undefined) {
    assertRemoteName(remote);
    args.push(remote);
  }
  if (opts.branch !== undefined) {
    assertBranchName(opts.branch);
    args.push(opts.branch);
  }
  const { stdout, stderr } = await runGit(cwd, args);
  return { stdout: stdout.length > 0 ? stdout : stderr };
}

export async function push(cwd: string, opts: PushOptions = {}): Promise<{ stdout: string }> {
  const args = ["push"];
  if (opts.setUpstream === true) args.push("--set-upstream");
  if (opts.remote !== undefined) {
    assertRemoteName(opts.remote);
    args.push(opts.remote);
  }
  if (opts.branch !== undefined) {
    assertBranchName(opts.branch);
    args.push(opts.branch);
  }
  // Push status info goes to stderr by default; we capture both.
  const { stdout, stderr } = await runGit(cwd, args);
  return { stdout: stdout.length > 0 ? stdout : stderr };
}

/**
 * Validate a git remote name. Rules are looser than branch names:
 * remotes don't reserve `HEAD`/`FETCH_HEAD`/etc., and the `.lock`
 * suffix only matters for ref files. We keep the same character
 * set + leading-dash + traversal guards (the security-relevant
 * ones), but skip the ref-reserved-word and `.lock`/dot-segment
 * checks. A user with a remote literally named `HEAD` (unusual but
 * legal) won't get a 400.
 */
function assertRemoteName(name: string): void {
  if (name.length === 0 || name.length > 200) throw new InvalidBranchNameError(name);
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) throw new InvalidBranchNameError(name);
  if (name.startsWith("-")) throw new InvalidBranchNameError(name);
  if (name.includes("..") || name.includes("@{")) throw new InvalidBranchNameError(name);
}

/**
 * Phase 13 git integration test.
 *
 * Boots the server, creates a project pointing at a freshly-init'd
 * tmp git repo with one commit, then drives every /git/* route. No
 * LLM. Push round-trip uses a local bare repo (`git init --bare`
 * under the test workspace) as origin — no network, no auth, but
 * exercises the actual push path and verifies the upstream HEAD
 * advances via `git ls-remote`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile as fsWrite } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");

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

interface JsonResponse {
  status: number;
  body: unknown;
}

async function jget(url: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-git-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-git-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-git-data-"));
  const externalWorktreeRoot = await mkdtemp(join(tmpdir(), "pi-git-external-wt-"));

  // ---- Real git repo with one commit ----
  const projectPath = join(workspacePath, "demo");
  await mkdir(projectPath, { recursive: true });
  await git(projectPath, ["init", "-q", "--initial-branch=main"]);
  await git(projectPath, ["config", "user.email", "test@example.com"]);
  await git(projectPath, ["config", "user.name", "test"]);
  await git(projectPath, ["config", "commit.gpgsign", "false"]);
  await fsWrite(join(projectPath, "README.md"), "# demo\n", "utf8");
  await git(projectPath, ["add", "."]);
  await git(projectPath, ["commit", "-q", "-m", "initial"]);
  const siblingWorktreePath = join(externalWorktreeRoot, "demo-feature");
  await git(projectPath, ["worktree", "add", "-q", "-b", "feature/worktree", siblingWorktreePath]);

  // ---- Plain (non-git) project ----
  const nonGitPath = join(workspacePath, "plain");
  await mkdir(nonGitPath, { recursive: true });

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
      setTimeout(() => child.kill("SIGKILL"), 1500).unref();
    });
  };

  try {
    await waitFor(`${base}/api/v1/health`);

    // Register both projects.
    const cp1 = await jsend(
      "POST",
      `${base}/api/v1/projects`,
      { name: "demo", path: projectPath },
      auth,
    );
    assert("POST /projects (git) → 201", cp1.status === 201);
    const gitProjectId = (cp1.body as { id: string }).id;

    const cp2 = await jsend(
      "POST",
      `${base}/api/v1/projects`,
      { name: "plain", path: nonGitPath },
      auth,
    );
    assert("POST /projects (plain) → 201", cp2.status === 201);
    const plainProjectId = (cp2.body as { id: string }).id;

    // ---- non-git directory: graceful empty result, NOT 500 ----
    {
      const r = await jget(
        `${base}/api/v1/git/status?projectId=${encodeURIComponent(plainProjectId)}`,
        auth,
      );
      assert("status on non-git → 200", r.status === 200);
      const body = r.body as { isGitRepo: boolean; files: unknown[] };
      assert("non-git: isGitRepo === false", body.isGitRepo === false);
      assert("non-git: files === []", Array.isArray(body.files) && body.files.length === 0);

      const log = await jget(
        `${base}/api/v1/git/log?projectId=${encodeURIComponent(plainProjectId)}`,
        auth,
      );
      assert("log on non-git → 200 with empty commits", log.status === 200);
      assert(
        "non-git: commits === []",
        Array.isArray((log.body as { commits: unknown[] }).commits) &&
          (log.body as { commits: unknown[] }).commits.length === 0,
      );
    }

    // ---- worktree discovery + selected worktree status ----
    {
      const r = await jget(
        `${base}/api/v1/git/worktrees?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      assert("worktrees → 200", r.status === 200);
      const body = r.body as { worktrees: { path: string; branch?: string; current: boolean }[] };
      assert(
        "worktrees include main + sibling",
        body.worktrees.some((w) => w.path === projectPath && w.current) &&
          body.worktrees.some(
            (w) => w.path === siblingWorktreePath && w.branch === "feature/worktree",
          ),
      );
      assert(
        "registered worktree outside WORKSPACE_PATH is included",
        body.worktrees.some(
          (w) => w.path === siblingWorktreePath && w.branch === "feature/worktree",
        ),
      );

      await fsWrite(join(siblingWorktreePath, "worktree-only.txt"), "from sibling\n", "utf8");
      const qs = new URLSearchParams({
        projectId: gitProjectId,
        worktreePath: siblingWorktreePath,
      }).toString();
      const selected = await jget(`${base}/api/v1/git/status?${qs}`, auth);
      assert("selected worktree status → 200", selected.status === 200);
      const selectedFiles = (selected.body as { branch?: string; files: { path: string }[] }).files;
      assert(
        "selected worktree sees its own untracked file",
        selectedFiles.some((f) => f.path === "worktree-only.txt"),
      );

      const mainStatus = await jget(
        `${base}/api/v1/git/status?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      const mainFiles = (mainStatus.body as { files: { path: string }[] }).files;
      assert(
        "main worktree does not see sibling-only file",
        !mainFiles.some((f) => f.path === "worktree-only.txt"),
      );
    }

    // ---- modify a tracked file + add an untracked one ----
    await fsWrite(join(projectPath, "README.md"), "# demo\n\n+ added line\n", "utf8");
    await fsWrite(join(projectPath, "fresh.txt"), "hello\n", "utf8");

    // ---- /git/status reflects the changes ----
    {
      const r = await jget(
        `${base}/api/v1/git/status?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      assert("status → 200", r.status === 200);
      const body = r.body as {
        isGitRepo: boolean;
        branch?: string;
        files: { path: string; staged: boolean; unstaged: boolean; kind: string }[];
      };
      assert("isGitRepo === true", body.isGitRepo === true);
      assert("branch === 'main'", body.branch === "main");
      const readme = body.files.find((f) => f.path === "README.md");
      const fresh = body.files.find((f) => f.path === "fresh.txt");
      assert("README.md surfaced as modified-unstaged", readme?.kind === "modified");
      assert("README.md unstaged === true", readme?.unstaged === true);
      assert("README.md staged === false (not yet)", readme?.staged === false);
      assert("fresh.txt surfaced as untracked", fresh?.kind === "untracked");
    }

    // ---- /git/diff returns non-empty unstaged diff ----
    {
      const r = await jget(
        `${base}/api/v1/git/diff?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      assert("diff → 200", r.status === 200);
      const body = r.body as { diff: string };
      assert("diff includes added line", body.diff.includes("+ added line"));
    }

    // ---- /git/diff/file (single file, unstaged) ----
    {
      const qs = new URLSearchParams({ projectId: gitProjectId, path: "README.md" }).toString();
      const r = await jget(`${base}/api/v1/git/diff/file?${qs}`, auth);
      assert("diff/file → 200", r.status === 200);
      assert(
        "diff/file targets README.md",
        (r.body as { diff: string }).diff.includes("README.md"),
      );
    }

    // ---- stage README.md ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/stage`,
        { projectId: gitProjectId, paths: ["README.md"] },
        auth,
      );
      assert("stage → 200", r.status === 200);

      const status = await jget(
        `${base}/api/v1/git/status?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      const files = (status.body as { files: { path: string; staged: boolean }[] }).files;
      const readme = files.find((f) => f.path === "README.md");
      assert("README.md now staged === true", readme?.staged === true);
    }

    // ---- /git/diff/staged ----
    {
      const r = await jget(
        `${base}/api/v1/git/diff/staged?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      assert("diff/staged → 200", r.status === 200);
      assert(
        "diff/staged includes README.md change",
        (r.body as { diff: string }).diff.includes("+ added line"),
      );
    }

    // ---- unstage README.md ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/unstage`,
        { projectId: gitProjectId, paths: ["README.md"] },
        auth,
      );
      assert("unstage → 200", r.status === 200);

      const status = await jget(
        `${base}/api/v1/git/status?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      const files = (status.body as { files: { path: string; staged: boolean }[] }).files;
      const readme = files.find((f) => f.path === "README.md");
      assert("README.md back to staged === false", readme?.staged === false);
    }

    // ---- empty commit message → 400 ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/commit`,
        { projectId: gitProjectId, message: "   " },
        auth,
      );
      assert("commit empty message → 400", r.status === 400);
      assert("empty message error code", (r.body as { error: string }).error === "empty_message");
    }

    // ---- commit (re-stage README.md first) ----
    {
      await jsend(
        "POST",
        `${base}/api/v1/git/stage`,
        { projectId: gitProjectId, paths: ["README.md"] },
        auth,
      );
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/commit`,
        { projectId: gitProjectId, message: "tweak readme" },
        auth,
      );
      assert("commit → 200", r.status === 200);
      assert(
        "commit returns hash",
        typeof (r.body as { hash: string }).hash === "string" &&
          (r.body as { hash: string }).hash.length === 40,
      );

      const log = await jget(
        `${base}/api/v1/git/log?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      const commits = (log.body as { commits: { message: string }[] }).commits;
      assert(
        "log shows new commit at top",
        commits.length >= 2 && commits[0]?.message === "tweak readme",
      );
    }

    // ---- branches ----
    {
      const r = await jget(
        `${base}/api/v1/git/branches?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      assert("branches → 200", r.status === 200);
      const body = r.body as {
        isGitRepo: boolean;
        current?: string;
        branches: { name: string; current: boolean }[];
      };
      assert("branches.current === 'main'", body.current === "main");
      assert(
        "branches list includes main",
        body.branches.some((b) => b.name === "main" && b.current),
      );
    }

    // ---- branch create + checkout + delete ----
    {
      const create = await jsend(
        "POST",
        `${base}/api/v1/git/branch/create`,
        { projectId: gitProjectId, name: "feature/test", checkout: true },
        auth,
      );
      assert("branch/create + checkout → 200", create.status === 200);
      const branchesAfter = await jget(
        `${base}/api/v1/git/branches?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      const body = branchesAfter.body as {
        current?: string;
        branches: { name: string; current: boolean }[];
      };
      assert("HEAD switched to feature/test", body.current === "feature/test");
      assert(
        "branches list includes feature/test as current",
        body.branches.some((b) => b.name === "feature/test" && b.current),
      );
    }
    {
      const back = await jsend(
        "POST",
        `${base}/api/v1/git/checkout`,
        { projectId: gitProjectId, branch: "main" },
        auth,
      );
      assert("checkout main → 200", back.status === 200);
      const after = await jget(
        `${base}/api/v1/git/branches?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      const body = after.body as { current?: string };
      assert("HEAD back on main", body.current === "main");
    }
    {
      // -d refuses unmerged branches; feature/test was created at HEAD
      // and never had divergent commits, so it IS merged into main.
      // Plain delete should succeed.
      const del = await fetch(
        `${base}/api/v1/git/branch/feature%2Ftest?projectId=${encodeURIComponent(gitProjectId)}`,
        { method: "DELETE", headers: auth },
      );
      assert("branch delete → 200", del.status === 200);
      const after = await jget(
        `${base}/api/v1/git/branches?projectId=${encodeURIComponent(gitProjectId)}`,
        auth,
      );
      const body = after.body as { branches: { name: string }[] };
      assert(
        "feature/test removed from branch list",
        !body.branches.some((b) => b.name === "feature/test"),
      );
    }
    {
      // Invalid branch name should hit the validator before git runs.
      const bad = await jsend(
        "POST",
        `${base}/api/v1/git/branch/create`,
        { projectId: gitProjectId, name: "-evil flag" },
        auth,
      );
      assert("invalid branch name → 400", bad.status === 400);
      const body = bad.body as { error: string };
      assert(
        "invalid_branch_name error code",
        body.error === "invalid_branch_name",
        `got: ${body.error}`,
      );
    }
    // Names git itself rejects but our validator now catches earlier
    // so the user sees `invalid_branch_name` not `git_failed`.
    for (const bogus of ["foo.lock", ".foo", "foo.", "bar/.baz"]) {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/branch/create`,
        { projectId: gitProjectId, name: bogus },
        auth,
      );
      const body = r.body as { error?: string };
      assert(
        `${bogus} → invalid_branch_name`,
        r.status === 400 && body.error === "invalid_branch_name",
        `got status=${r.status} error=${body.error ?? "(none)"}`,
      );
    }

    // ---- push without upstream → 400 with sanitized message ----
    {
      const r = await jsend("POST", `${base}/api/v1/git/push`, { projectId: gitProjectId }, auth);
      assert("push without upstream → 400", r.status === 400);
      const body = r.body as { error: string; message?: string };
      assert("push error code === 'git_failed'", body.error === "git_failed");
      assert(
        "push error message references upstream/no remote",
        typeof body.message === "string" && body.message.length > 0,
        `message: ${body.message ?? "(none)"}`,
      );
    }

    // ---- push round-trip: set up a local bare repo as origin ----
    // Round-trip exercises the actual push wire path, not just the
    // "no upstream" error case. We host a bare repo on the local
    // filesystem; git treats a `file://` URL the same as a remote
    // for push/fetch purposes, no network or auth needed.
    const upstreamPath = join(workspacePath, "upstream.git");
    await mkdir(upstreamPath, { recursive: true });
    await execFileAsync("git", ["init", "-q", "--bare", upstreamPath]);
    await git(projectPath, ["remote", "add", "origin", upstreamPath]);
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/push`,
        { projectId: gitProjectId, remote: "origin", branch: "main", setUpstream: true },
        auth,
      );
      assert("push with --set-upstream → 200", r.status === 200);
      const body = r.body as { output?: string };
      assert(
        "push output mentions main or main->main",
        typeof body.output === "string" && body.output.length > 0,
        `output: ${body.output ?? "(none)"}`,
      );
      // Verify the upstream actually received the commit by reading
      // the bare repo's refs directly (no extra HTTP call needed).
      const lsRemote = await execFileAsync("git", ["ls-remote", upstreamPath, "refs/heads/main"]);
      assert(
        "upstream main ref exists post-push",
        /[0-9a-f]{40}\s+refs\/heads\/main/.test(lsRemote.stdout),
        `ls-remote: ${lsRemote.stdout.slice(0, 200)}`,
      );
    }
    {
      // Second commit; bare push (the upstream is now tracked, so
      // no remote/branch args needed) should succeed and the
      // upstream HEAD should advance.
      await fsWrite(join(projectPath, "second.txt"), "second\n", "utf8");
      await git(projectPath, ["add", "."]);
      await git(projectPath, ["commit", "-q", "-m", "second"]);
      const headBefore = (
        await execFileAsync("git", ["ls-remote", upstreamPath, "refs/heads/main"])
      ).stdout
        .trim()
        .split(/\s+/)[0];
      const r = await jsend("POST", `${base}/api/v1/git/push`, { projectId: gitProjectId }, auth);
      assert("plain push to tracked upstream → 200", r.status === 200);
      const headAfter = (
        await execFileAsync("git", ["ls-remote", upstreamPath, "refs/heads/main"])
      ).stdout
        .trim()
        .split(/\s+/)[0];
      assert(
        "upstream main HEAD advanced",
        typeof headBefore === "string" && typeof headAfter === "string" && headBefore !== headAfter,
        `before=${headBefore ?? ""} after=${headAfter ?? ""}`,
      );
    }

    // ---- anonymous → 401 on a git route ----
    {
      const r = await jget(
        `${base}/api/v1/git/status?projectId=${encodeURIComponent(gitProjectId)}`,
      );
      assert("anonymous → 401", r.status === 401);
    }

    // ---- unknown project → 404 ----
    {
      const r = await jget(
        `${base}/api/v1/git/status?projectId=00000000-0000-0000-0000-000000000000`,
        auth,
      );
      assert("unknown projectId → 404", r.status === 404);
    }
  } finally {
    await stop();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
    await rm(externalWorktreeRoot, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-git] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-git] PASS");
}

main().catch((err: unknown) => {
  console.error("[test-git] uncaught:", err);
  process.exit(1);
});

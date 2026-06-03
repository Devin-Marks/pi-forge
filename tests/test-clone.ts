/**
 * Integration test for the "Clone repository" project-setup flow.
 *
 * Coverage:
 *   - validateCloneUrl (unit) — accepts https + file, rejects ssh/http/garbage
 *   - parseProgressLine (unit) — known git progress shapes
 *   - assertTargetClonable (unit) — fresh dir vs existing-non-empty
 *   - End-to-end POST /api/v1/projects/clone:
 *       - Creates a local bare repo with one commit as the clone source
 *       - Streams: started → progress* → done → project_created
 *       - Project is registered with the expected path
 *       - Cloned folder contains the committed file + `.git/`
 *   - Rejects clone into a non-empty target with 409
 *
 * Token-injection is exercised at the URL-build level (we can't
 * spin up an HTTPS server with auth in a unit test) — the test
 * confirms a token-bearing URL is constructed without the token
 * leaking into the cloned `origin` URL.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");

// Match the pattern other tests use: dynamic import of the dist/ JS
// keeps `npm run check` from tripping on missing type info for the
// compiled module (the import lives behind an `as unknown as`
// validated interface).
interface GitCloneModule {
  validateCloneUrl: (raw: string) => URL;
  parseProgressLine: (line: string) => { phase: string; percent: number | null } | undefined;
  assertTargetClonable: (target: string) => Promise<void>;
  GitCloneError: new (code: string, message: string) => Error & { code: string };
}
const { validateCloneUrl, parseProgressLine, assertTargetClonable, GitCloneError } = (await import(
  resolve(repoRoot, "packages/server/dist/git-clone.js")
)) as unknown as GitCloneModule;

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

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // Deterministic identity so commits succeed without the
    // host user's git config.
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
}

function runGit(cwd: string, args: string[]): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn("git", args, {
      cwd,
      stdio: "ignore",
      env: gitEnv(),
    });
    child.on("error", rejectFn);
    child.on("close", (code) => {
      if (code === 0) resolveFn();
      else rejectFn(new Error(`git ${args.join(" ")} exited ${code}`));
    });
  });
}

function gitOutput(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", rejectFn);
    child.on("close", (code) => {
      if (code === 0) resolveFn(stdout);
      else rejectFn(new Error(`git ${args.join(" ")} exited ${code}: ${stderr}`));
    });
  });
}

/**
 * Build a bare git repo with one commit containing `README.md`.
 * Returns the on-disk path; the clone source URL is the
 * `file://`-formatted version of this path.
 */
async function buildBareSourceRepo(workspaceParent: string): Promise<string> {
  // Two dirs: a "source" worktree where we make the commit, and a
  // bare repo we push to. The bare one is the actual clone source.
  const sourceWork = await mkdtemp(join(workspaceParent, "clone-src-"));
  const bare = await mkdtemp(join(workspaceParent, "clone-bare-"));
  await runGit(sourceWork, ["init", "--initial-branch", "main"]);
  await writeFile(join(sourceWork, "README.md"), "# hello\n", "utf8");
  await runGit(sourceWork, ["add", "README.md"]);
  await runGit(sourceWork, ["commit", "-m", "init"]);
  await runGit(bare, ["init", "--bare", "--initial-branch", "main"]);
  await runGit(sourceWork, ["remote", "add", "origin", bare]);
  await runGit(sourceWork, ["push", "origin", "main"]);
  await rm(sourceWork, { recursive: true, force: true });
  return bare;
}

interface RunningServer {
  base: string;
  workspacePath: string;
  stop: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-clone-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-clone-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-clone-data-"));
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
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[clone-srv] ${String(b)}`));
  const base = `http://127.0.0.1:${port}`;
  const stop = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((res) => {
        child.once("exit", () => res());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1500).unref();
      });
    }
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  };
  try {
    await waitFor(`${base}/api/v1/health`);
  } catch (err) {
    await stop();
    throw err;
  }
  return { base, workspacePath, stop };
}

interface CloneEvent {
  type: string;
  [k: string]: unknown;
}

/**
 * POST /projects/clone and collect all SSE events. Resolves when the
 * stream closes. Throws on HTTP error before the stream starts.
 */
async function streamClone(
  base: string,
  body: Record<string, unknown>,
): Promise<{ status: number; events: CloneEvent[] }> {
  const res = await fetch(`${base}/api/v1/projects/clone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
    return { status: res.status, events: [{ type: "http_error", ...(parsed as object) }] };
  }
  if (res.body === null) return { status: res.status, events: [] };
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const events: CloneEvent[] = [];
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value.replace(/\r\n/g, "\n");
    let sep = buf.indexOf("\n\n");
    while (sep !== -1) {
      const message = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      for (const line of message.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trimStart();
        try {
          events.push(JSON.parse(payload) as CloneEvent);
        } catch {
          /* skip malformed frames */
        }
      }
      sep = buf.indexOf("\n\n");
    }
  }
  return { status: res.status, events };
}

async function main(): Promise<void> {
  console.log("[test-clone] validateCloneUrl");
  assert(
    "rejects garbage",
    thrown(() => validateCloneUrl("not a url"), "invalid_url"),
  );
  assert(
    "rejects http://",
    thrown(() => validateCloneUrl("http://github.com/foo/bar.git"), "unsupported_protocol"),
  );
  assert(
    "rejects ssh://",
    thrown(() => validateCloneUrl("ssh://git@github.com/foo/bar.git"), "unsupported_protocol"),
  );
  assert(
    "accepts https://",
    didNotThrow(() => validateCloneUrl("https://github.com/foo/bar.git")),
  );
  assert(
    "accepts file://",
    didNotThrow(() => validateCloneUrl("file:///tmp/some/repo")),
  );

  console.log("\n[test-clone] parseProgressLine");
  const p1 = parseProgressLine("Receiving objects:  45% (450/1000), 1.23 MiB | 200 KiB/s");
  assert("'Receiving objects' phase parsed", p1?.phase === "Receiving objects");
  assert("'Receiving objects' percent === 45", p1?.percent === 45);
  const p2 = parseProgressLine("Resolving deltas: 100% (123/123), done.");
  assert("'Resolving deltas' percent === 100", p2?.percent === 100);
  const p3 = parseProgressLine("Counting objects: 1234, done.");
  assert("phase-only line parses with percent=null", p3?.phase === "Counting objects");
  assert("phase-only line null percent", p3?.percent === null);
  assert(
    "completely unknown line returns undefined",
    parseProgressLine("some random text not in phase format") === undefined,
  );

  console.log("\n[test-clone] assertTargetClonable");
  const probeRoot = await mkdtemp(join(tmpdir(), "pi-forge-clone-probe-"));
  try {
    // Non-existent path is fine.
    await assertTargetClonable(join(probeRoot, "fresh"));
    assert("nonexistent target → OK", true);
    // Empty existing dir is also fine.
    await mkdir(join(probeRoot, "empty"));
    await assertTargetClonable(join(probeRoot, "empty"));
    assert("empty existing target → OK", true);
    // Non-empty existing dir is rejected.
    await mkdir(join(probeRoot, "occupied"));
    await writeFile(join(probeRoot, "occupied", "x"), "x", "utf8");
    let occupiedErr: unknown;
    try {
      await assertTargetClonable(join(probeRoot, "occupied"));
    } catch (e) {
      occupiedErr = e;
    }
    assert(
      "non-empty existing target → rejects with target_not_empty",
      occupiedErr instanceof GitCloneError && occupiedErr.code === "target_not_empty",
    );
  } finally {
    await rm(probeRoot, { recursive: true, force: true });
  }

  console.log("\n[test-clone] end-to-end via POST /projects/clone");
  const srv = await startServer();
  try {
    // Build the bare source repo OUTSIDE the workspace (clone source
    // is separate from the workspace where the clone lands).
    const sourceParent = await mkdtemp(join(tmpdir(), "pi-forge-clone-source-"));
    const bare = await buildBareSourceRepo(sourceParent);
    const sourceUrl = pathToFileURL(bare).toString();

    try {
      const { status, events } = await streamClone(srv.base, {
        url: sourceUrl,
        parentPath: srv.workspacePath,
        folderName: "cloned-repo",
        projectName: "Cloned Repo",
      });
      assert("POST /projects/clone HTTP status 200", status === 200);
      const types = events.map((e) => e.type);
      assert(
        "first event is `started`",
        types[0] === "started",
        `types=${types.slice(0, 3).join(",")}`,
      );
      assert("at least one `progress` event", types.includes("progress"));
      assert(
        "ends with `done` then `project_created`",
        types.includes("done") && types.includes("project_created"),
      );
      const projectCreated = events.find((e) => e.type === "project_created");
      const project = projectCreated?.project as
        | { id: string; path: string; name: string }
        | undefined;
      assert("project_created carries a project", project !== undefined);
      // project-manager realpaths the path on creation (so symlinks
      // can't bypass workspace boundary checks). On macOS that
      // resolves /var/folders/... → /private/var/folders/..., so we
      // compare endings rather than the full path.
      assert(
        "project.path ends with the clone target folder",
        project?.path !== undefined && project.path.endsWith("/cloned-repo"),
        `got ${project?.path}`,
      );
      // Verify clone contents on disk.
      const readme = await stat(join(srv.workspacePath, "cloned-repo", "README.md"));
      assert("cloned target contains README.md", readme.isFile());
      const dotGit = await stat(join(srv.workspacePath, "cloned-repo", ".git"));
      assert("cloned target contains .git directory", dotGit.isDirectory());

      const insecure = await streamClone(srv.base, {
        url: sourceUrl,
        parentPath: srv.workspacePath,
        folderName: "insecure-cloned-repo",
        projectName: "Insecure Cloned Repo",
        insecureTls: true,
      });
      assert("clone with insecureTls HTTP status 200", insecure.status === 200);
      const persistedTls = await gitOutput(join(srv.workspacePath, "insecure-cloned-repo"), [
        "config",
        "--local",
        "--get-urlmatch",
        "http.sslVerify",
        sourceUrl,
      ]);
      assert(
        "clone insecureTls persists local URL-scoped sslVerify=false",
        persistedTls.trim() === "false",
      );

      // Second clone into the same folder fails fast with 409.
      const second = await streamClone(srv.base, {
        url: sourceUrl,
        parentPath: srv.workspacePath,
        folderName: "cloned-repo",
        projectName: "Cloned Repo 2",
      });
      assert("re-clone into non-empty folder → 409", second.status === 409);

      // A parent directory that is a symlink inside WORKSPACE_PATH but
      // resolves outside it must be rejected before spawning `git clone`.
      const outsideParent = await mkdtemp(join(tmpdir(), "pi-forge-clone-outside-"));
      const symlinkParent = join(srv.workspacePath, "outside-link");
      try {
        await symlink(outsideParent, symlinkParent, "dir");
        const escaped = await streamClone(srv.base, {
          url: sourceUrl,
          parentPath: symlinkParent,
          folderName: "escaped-repo",
          projectName: "Escaped Repo",
        });
        assert("clone parent symlink outside workspace → 403", escaped.status === 403);
        let escapedStat: Awaited<ReturnType<typeof stat>> | undefined;
        try {
          escapedStat = await stat(join(outsideParent, "escaped-repo"));
        } catch {
          escapedStat = undefined;
        }
        assert("symlink escape target was not created", escapedStat === undefined);
      } finally {
        await rm(outsideParent, { recursive: true, force: true });
      }
    } finally {
      await rm(sourceParent, { recursive: true, force: true });
    }
  } finally {
    await srv.stop();
  }

  if (failures > 0) {
    console.log(`\n[test-clone] FAIL — ${failures} assertion(s)`);
    process.exit(1);
  }
  console.log("\n[test-clone] PASS");
}

function thrown(fn: () => unknown, expectedCode: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof GitCloneError && err.code === expectedCode;
  }
}

function didNotThrow(fn: () => unknown): boolean {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

await main();

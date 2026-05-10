/**
 * Hunk-level staging integration test.
 *
 * Boots the server in-process under a temp WORKSPACE_PATH, creates a
 * real git repo with a tracked file, modifies it to produce multiple
 * distinct hunks, and drives `/api/v1/git/apply-hunks` to verify:
 *
 *   - Staging hunk 0 alone leaves the file with only the un-selected
 *     hunks visible in the unstaged-side diff
 *   - The staged-side diff matches exactly what the user picked
 *   - Unstaging from the staged side is symmetric with staging
 *   - Multi-hunk selections are applied in one call
 *   - Binary file → ok:false with code `binary_or_no_hunks`
 *   - Out-of-range hunk index → ok:false with code `hunk_index_out_of_range`
 *   - File with no diff (already-clean) → ok:false with code `no_diff`
 *   - 401 without auth, 400 on bad input
 *
 * Approach: spawn the server as a subprocess so it picks up env-via-
 * argv-shim (matches test-files / test-session-export pattern); run
 * git via `execFile` from the test for setup + verification.
 */
import { spawn, type ChildProcess, execFile } from "node:child_process";
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
async function jsend(
  method: "POST",
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

/** Helper to invoke git in the project dir and return stdout. */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-hunk-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-hunk-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-hunk-data-"));
  const projectPath = join(workspacePath, "demo");
  await mkdir(projectPath, { recursive: true });

  // Build a real git repo with a tracked multi-line file. Three changes
  // far enough apart to land in three separate hunks under the default
  // 3-line context window.
  await git(projectPath, "init", "-q");
  await git(projectPath, "config", "user.email", "test@example.com");
  await git(projectPath, "config", "user.name", "Test");
  await git(projectPath, "config", "commit.gpgsign", "false");

  const initialLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  await fsWrite(join(projectPath, "file.txt"), initialLines, "utf8");
  await git(projectPath, "add", "file.txt");
  await git(projectPath, "commit", "-q", "-m", "initial");

  // Modify lines 2, 15, 28 — three distinct hunks with default 3-line context.
  const modified = initialLines
    .replace("line 2\n", "LINE 2 CHANGED\n")
    .replace("line 15\n", "LINE 15 CHANGED\n")
    .replace("line 28\n", "LINE 28 CHANGED\n");
  await fsWrite(join(projectPath, "file.txt"), modified, "utf8");

  // Sanity: did we get 3 hunks?
  const initialDiff = await git(projectPath, "diff", "--", "file.txt");
  const initialHunkCount = (initialDiff.match(/^@@ /gm) ?? []).length;
  assert("setup: file has 3 hunks", initialHunkCount === 3, `got ${initialHunkCount}`);

  const apiKey = "test-hunk-key-" + randomBytes(8).toString("hex");
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

    const create = await jsend(
      "POST",
      `${base}/api/v1/projects`,
      { name: "demo", path: projectPath },
      auth,
    );
    assert("POST /projects → 201", create.status === 201);
    const project = create.body as { id: string; path: string };
    // Use the realpath'd path the server returned for any future paths,
    // not the original mkdtemp path (file-manager will reject otherwise).
    const canonicalPath = project.path;

    // ---- happy path: stage hunk 0 only ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/apply-hunks`,
        { projectId: project.id, path: "file.txt", mode: "stage", hunkIndices: [0] },
        auth,
      );
      assert("POST /git/apply-hunks stage [0] → 200", r.status === 200);
      assert(
        "apply-hunks ok:true",
        (r.body as { ok: boolean }).ok === true,
        JSON.stringify(r.body),
      );

      // Staged-side diff should now contain exactly the LINE 2 change.
      const staged = await git(canonicalPath, "diff", "--cached", "--", "file.txt");
      assert("staged diff contains LINE 2 CHANGED", staged.includes("LINE 2 CHANGED"));
      assert("staged diff omits LINE 15", !staged.includes("LINE 15 CHANGED"));
      assert("staged diff omits LINE 28", !staged.includes("LINE 28 CHANGED"));

      // Unstaged-side diff should now show only the remaining 2 hunks
      // (the LINE 15 and LINE 28 changes).
      const unstaged = await git(canonicalPath, "diff", "--", "file.txt");
      const remainingHunks = (unstaged.match(/^@@ /gm) ?? []).length;
      assert("unstaged diff has 2 remaining hunks", remainingHunks === 2);
      assert("unstaged still contains LINE 15", unstaged.includes("LINE 15 CHANGED"));
      assert("unstaged still contains LINE 28", unstaged.includes("LINE 28 CHANGED"));
    }

    // ---- multi-hunk selection: stage the remaining two ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/apply-hunks`,
        // After hunk 0 was staged, the unstaged-side diff renumbers —
        // it now has two hunks indexed 0 and 1 again. Stage both.
        { projectId: project.id, path: "file.txt", mode: "stage", hunkIndices: [0, 1] },
        auth,
      );
      assert("POST /git/apply-hunks stage [0,1] → 200", r.status === 200);
      assert("multi-hunk stage ok:true", (r.body as { ok: boolean }).ok === true);
      const unstaged = await git(canonicalPath, "diff", "--", "file.txt");
      assert("unstaged diff is empty after staging all hunks", unstaged.trim().length === 0);
      const staged = await git(canonicalPath, "diff", "--cached", "--", "file.txt");
      assert(
        "staged diff has all 3 changes",
        staged.includes("LINE 2 CHANGED") &&
          staged.includes("LINE 15 CHANGED") &&
          staged.includes("LINE 28 CHANGED"),
      );
    }

    // ---- symmetric unstage: unstage hunk 1 (LINE 15) from the staged side ----
    {
      // The staged-side diff has 3 hunks now (indices 0, 1, 2). Unstage
      // index 1 — the LINE 15 hunk.
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/apply-hunks`,
        { projectId: project.id, path: "file.txt", mode: "unstage", hunkIndices: [1] },
        auth,
      );
      assert("POST /git/apply-hunks unstage [1] → 200", r.status === 200);
      assert("unstage ok:true", (r.body as { ok: boolean }).ok === true);
      const staged = await git(canonicalPath, "diff", "--cached", "--", "file.txt");
      assert(
        "staged diff still has LINE 2 + LINE 28",
        staged.includes("LINE 2 CHANGED") && staged.includes("LINE 28 CHANGED"),
      );
      assert("staged diff no longer has LINE 15", !staged.includes("LINE 15 CHANGED"));
      const unstaged = await git(canonicalPath, "diff", "--", "file.txt");
      assert("unstaged side now has the LINE 15 change back", unstaged.includes("LINE 15 CHANGED"));
    }

    // ---- error: out-of-range index ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/apply-hunks`,
        { projectId: project.id, path: "file.txt", mode: "unstage", hunkIndices: [99] },
        auth,
      );
      assert("out-of-range index → ok:false", (r.body as { ok: boolean }).ok === false);
      assert(
        "out-of-range error code surfaced",
        (r.body as { error?: string }).error === "hunk_index_out_of_range",
        JSON.stringify(r.body),
      );
    }

    // ---- error: no diff on requested side (clean stage attempt with empty unstaged) ----
    {
      // Reset unstaged side first by staging everything via the file-level path.
      await jsend(
        "POST",
        `${base}/api/v1/git/stage`,
        { projectId: project.id, paths: ["file.txt"] },
        auth,
      );
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/apply-hunks`,
        { projectId: project.id, path: "file.txt", mode: "stage", hunkIndices: [0] },
        auth,
      );
      assert("no-diff stage → ok:false", (r.body as { ok: boolean }).ok === false);
      assert(
        "no-diff error code surfaced",
        (r.body as { error?: string }).error === "no_diff",
        JSON.stringify(r.body),
      );
    }

    // ---- error: binary file ----
    {
      // Reset everything first
      await git(canonicalPath, "reset", "-q", "HEAD", "--", "file.txt");
      await git(canonicalPath, "checkout", "-q", "--", "file.txt");

      // Add a binary file and modify it
      const bin = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
      await fsWrite(join(canonicalPath, "image.bin"), bin);
      await git(canonicalPath, "add", "image.bin");
      await git(canonicalPath, "commit", "-q", "-m", "add binary");
      const bin2 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8]);
      await fsWrite(join(canonicalPath, "image.bin"), bin2);

      const r = await jsend(
        "POST",
        `${base}/api/v1/git/apply-hunks`,
        { projectId: project.id, path: "image.bin", mode: "stage", hunkIndices: [0] },
        auth,
      );
      assert("binary file → ok:false", (r.body as { ok: boolean }).ok === false);
      assert(
        "binary file error code surfaced",
        (r.body as { error?: string }).error === "binary_or_no_hunks",
        JSON.stringify(r.body),
      );
    }

    // ---- 400 on missing required field ----
    {
      const r = await jsend(
        "POST",
        `${base}/api/v1/git/apply-hunks`,
        { projectId: project.id, path: "file.txt", mode: "stage" /* no hunkIndices */ },
        auth,
      );
      assert("missing hunkIndices → 400", r.status === 400);
    }

    // ---- 401 without auth ----
    {
      const r = await jsend("POST", `${base}/api/v1/git/apply-hunks`, {
        projectId: project.id,
        path: "file.txt",
        mode: "stage",
        hunkIndices: [0],
      });
      assert("unauthenticated → 401", r.status === 401);
    }
  } finally {
    await stop();
    await Promise.all([
      rm(workspacePath, { recursive: true, force: true }),
      rm(configDir, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  }

  if (failures > 0) {
    console.log(`\n[test-hunk-staging] ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`\n[test-hunk-staging] all checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

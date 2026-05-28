/**
 * Phase 3 project-management integration test.
 *
 * Spawns the server with WORKSPACE_PATH and PI_CONFIG_DIR pointing at fresh
 * temp directories so tests don't interact with anything on the host. Auth is
 * disabled (no UI_PASSWORD, no API_KEY) — auth itself is covered by test-auth.
 *
 * Covers all 7 assertions from the dev plan plus a couple of extras:
 *   - browse with no path defaults to WORKSPACE_PATH
 *   - browse flags `.git` directories
 *   - delete leaves the on-disk folder intact
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

interface RunningServer {
  base: string;
  child: ChildProcess;
  workspacePath: string;
  configDir: string;
  dataDir: string;
  stop: () => Promise<void>;
}

async function startServer(): Promise<RunningServer> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  // FORGE_DATA_DIR isolates the projects.json this test reads
  // and writes. Without it the test would touch the dev's actual
  // ~/.pi-forge/projects.json, leaking state across test runs
  // (and clobbering the user's real project list).
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
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
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      API_KEY: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

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
  return { base, child, workspacePath, configDir, dataDir, stop };
}

interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

async function jget(url: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function main(): Promise<void> {
  const srv = await startServer();
  const { base, workspacePath, configDir } = srv;
  console.log(`[test-projects] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-projects] PI_CONFIG_DIR=${configDir}`);

  try {
    // Seed: a real project folder, a git-repo folder, and a hidden folder
    // (which should be filtered out by the browser).
    const repoFolder = join(workspacePath, "my-repo");
    const otherFolder = join(workspacePath, "other");
    const reorderOneFolder = join(workspacePath, "reorder-one");
    const reorderTwoFolder = join(workspacePath, "reorder-two");
    const hiddenFolder = join(workspacePath, ".hidden");
    await mkdir(repoFolder, { recursive: true });
    await mkdir(otherFolder, { recursive: true });
    await mkdir(reorderOneFolder, { recursive: true });
    await mkdir(reorderTwoFolder, { recursive: true });
    await mkdir(hiddenFolder, { recursive: true });
    await mkdir(join(repoFolder, ".git"));
    await writeFile(join(repoFolder, ".git", "HEAD"), "ref: refs/heads/main\n");

    // 1. Initially empty list
    {
      const { status, body } = await jget(`${base}/api/v1/projects`);
      assert("GET /projects initial → 200 + empty list", status === 200);
      assert(
        "  body.projects is an empty array",
        Array.isArray((body as { projects: unknown[] }).projects) &&
          (body as { projects: unknown[] }).projects.length === 0,
      );
    }

    // 2. Create with valid path inside WORKSPACE_PATH → 201
    let created: Project;
    {
      const { status, body } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "my-repo",
        path: repoFolder,
      });
      assert("POST /projects (valid) → 201", status === 201, `status=${status}`);
      created = body as Project;
      // The server realpaths the input before storing (project-manager.ts
      // canonicalizes so symlinks can't bypass the workspace boundary).
      // On macOS that turns `/var/folders/...` into `/private/var/...`.
      // Assert both ends resolve to the same canonical path rather than
      // requiring string equality with the un-realpath'd input.
      const { realpath } = await import("node:fs/promises");
      const repoFolderReal = await realpath(repoFolder);
      assert(
        "  response includes id, name, path, createdAt",
        typeof created.id === "string" &&
          created.name === "my-repo" &&
          created.path === repoFolderReal &&
          typeof created.createdAt === "string",
        `created.path=${created.path} repoFolderReal=${repoFolderReal}`,
      );
    }

    // 3. Path outside WORKSPACE_PATH → 403
    {
      const { status, body } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "bad",
        path: "/etc",
      });
      assert("POST /projects (path outside workspace) → 403", status === 403);
      assert(
        "  error code is path_not_allowed",
        (body as { error: string }).error === "path_not_allowed",
      );
    }

    // 4. Path traversal via ../ → 403
    {
      const { status } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "bad",
        path: join(workspacePath, "..", "..", "etc"),
      });
      assert("POST /projects (../../etc) → 403", status === 403);
    }

    // 5. GET /projects returns the created project
    {
      const { status, body } = await jget(`${base}/api/v1/projects`);
      const projects = (body as { projects: Project[] }).projects;
      assert("GET /projects → 200 with one project", status === 200 && projects.length === 1);
      assert("  returned project matches the created id", projects[0]?.id === created.id);
    }

    // 6. PATCH renames
    {
      const { status, body } = await jsend("PATCH", `${base}/api/v1/projects/${created.id}`, {
        name: "renamed-repo",
      });
      assert("PATCH /projects/:id → 200", status === 200);
      assert("  name updated", (body as Project).name === "renamed-repo");
    }

    // 7. browse defaults to WORKSPACE_PATH and excludes hidden dirs
    {
      const { status, body } = await jget(`${base}/api/v1/projects/browse`);
      assert("GET /projects/browse → 200", status === 200);
      const r = body as {
        path: string;
        parentPath: string | null;
        entries: { name: string; isGitRepo: boolean }[];
      };
      assert("  browse path is workspace root", r.path === resolve(workspacePath));
      assert("  browse at root returns parentPath=null", r.parentPath === null);
      const names = r.entries.map((e) => e.name).sort();
      assert(
        "  entries include visible folders and filter hidden dirs",
        JSON.stringify(names) ===
          JSON.stringify(["my-repo", "other", "reorder-one", "reorder-two"]),
        JSON.stringify(names),
      );
      const repo = r.entries.find((e) => e.name === "my-repo");
      const other = r.entries.find((e) => e.name === "other");
      assert("  my-repo is flagged isGitRepo=true", repo?.isGitRepo === true);
      assert("  other is flagged isGitRepo=false", other?.isGitRepo === false);
    }

    // 7b. browse inside a subfolder returns parentPath = the workspace root
    {
      const { body } = await jget(
        `${base}/api/v1/projects/browse?path=${encodeURIComponent(repoFolder)}`,
      );
      const r = body as { path: string; parentPath: string | null };
      assert(
        "browse inside subfolder reports parentPath = workspace root",
        r.parentPath === resolve(workspacePath),
        `got ${r.parentPath}`,
      );
    }

    // 7c. duplicate path is rejected with 409
    {
      // re-create a project at the same path as `created`
      const { status, body } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "dup",
        path: repoFolder,
      });
      assert("POST duplicate path → 409", status === 409);
      assert(
        "  error code is duplicate_path",
        (body as { error: string }).error === "duplicate_path",
      );
    }

    // 7d. Persist explicit project order.
    {
      const { body: b } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "reorder-one",
        path: reorderOneFolder,
      });
      const one = b as Project;
      const { body: c } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "reorder-two",
        path: reorderTwoFolder,
      });
      const two = c as Project;
      const wanted = [two.id, created.id, one.id];
      const { status, body } = await jsend("PUT", `${base}/api/v1/projects/order`, {
        ids: wanted,
      });
      const projects = (body as { projects: Project[] }).projects;
      assert("PUT /projects/order → 200", status === 200, `status=${status}`);
      assert(
        "  list order follows requested ids",
        JSON.stringify(projects.map((p) => p.id)) === JSON.stringify(wanted),
        JSON.stringify(projects.map((p) => p.id)),
      );
      const { body: listed } = await jget(`${base}/api/v1/projects`);
      assert(
        "  reordered list persists to GET /projects",
        JSON.stringify((listed as { projects: Project[] }).projects.map((p) => p.id)) ===
          JSON.stringify(wanted),
      );
      const invalid = await jsend("PUT", `${base}/api/v1/projects/order`, { ids: [created.id] });
      assert("PUT /projects/order missing ids → 400", invalid.status === 400);
      assert(
        "  invalid order returns invalid_project_order",
        (invalid.body as { error: string }).error === "invalid_project_order",
      );
      await jsend("DELETE", `${base}/api/v1/projects/${one.id}`);
      await jsend("DELETE", `${base}/api/v1/projects/${two.id}`);
    }

    // 8. browse outside workspace → 403
    {
      const { status, body } = await jget(
        `${base}/api/v1/projects/browse?path=${encodeURIComponent("/etc")}`,
      );
      assert("GET /projects/browse?path=/etc → 403", status === 403);
      assert(
        "  error code is path_not_allowed",
        (body as { error: string }).error === "path_not_allowed",
      );
    }

    // 9. DELETE removes the project record AND the session dir (since
    //    v1.3.0 the cascade is unconditional). The workspace folder
    //    on disk is left intact — that's user-owned work.
    //    Plant a fake JSONL under the session dir first so we can
    //    assert it's actually removed.
    {
      const sessionDir = join(workspacePath, ".pi", "sessions", created.id);
      await mkdir(sessionDir, { recursive: true });
      await writeFile(join(sessionDir, "abc.jsonl"), `{"type":"session"}\n`);
      const { status, body } = await jsend("DELETE", `${base}/api/v1/projects/${created.id}`);
      assert("DELETE /projects/:id → 200", status === 200);
      assert(
        "  delete returns { cascaded: true }",
        (body as { cascaded?: boolean }).cascaded === true,
      );
      const list = (await jget(`${base}/api/v1/projects`)).body as { projects: Project[] };
      assert("  list is empty after delete", list.projects.length === 0);
      const dirStat = await stat(sessionDir).catch(() => undefined);
      assert("  session dir removed", dirStat === undefined);
      const folderStat = await stat(repoFolder).catch(() => undefined);
      assert(
        "  on-disk project folder still exists after delete",
        folderStat !== undefined && folderStat.isDirectory(),
      );
    }

    // 9b. DELETE on a project that never had any sessions.
    //     The most common real-world case — `rm({ force: true })` on a
    //     missing dir should still report `cascaded: true`.
    {
      const emptyFolder = join(workspacePath, "empty-cascade");
      await mkdir(emptyFolder, { recursive: true });
      const { body: cb } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "empty-cascade",
        path: emptyFolder,
      });
      const emptyId = (cb as Project).id;
      const { status, body } = await jsend("DELETE", `${base}/api/v1/projects/${emptyId}`);
      assert("delete on project with no sessions → 200", status === 200);
      assert(
        "  cascaded: true even when no session dir existed",
        (body as { cascaded?: boolean }).cascaded === true,
      );
    }

    // 10. PATCH non-existent id → 404
    {
      const { status, body } = await jsend(
        "PATCH",
        `${base}/api/v1/projects/00000000-0000-0000-0000-000000000000`,
        { name: "x" },
      );
      assert("PATCH /projects/:nonexistent → 404", status === 404);
      assert(
        "  error code is project_not_found",
        (body as { error: string }).error === "project_not_found",
      );
    }

    // 11. Persistence: restart the server, list still shows projects with their
    // current state — including a rename that was applied before restart.
    {
      const { body: a } = await jsend("POST", `${base}/api/v1/projects`, {
        name: "persistent",
        path: otherFolder,
      });
      const persistentId = (a as Project).id;
      // Rename it, so we can prove the rename survives too.
      await jsend("PATCH", `${base}/api/v1/projects/${persistentId}`, {
        name: "persistent-renamed",
      });
      // soft-restart by sending SIGTERM and starting a new child against same dirs.
      await new Promise<void>((res) => {
        srv.child.once("exit", () => res());
        srv.child.kill("SIGTERM");
      });
      // re-spawn against same workspace+config+data dirs
      const port = await pickFreePort();
      const child2 = spawn(process.execPath, [serverEntry], {
        cwd: repoRoot,
        env: {
          ...process.env,
          PORT: String(port),
          LOG_LEVEL: "warn",
          NODE_ENV: "test",
          WORKSPACE_PATH: workspacePath,
          PI_CONFIG_DIR: configDir,
          FORGE_DATA_DIR: srv.dataDir,
          // Ambient auth env from the dev's shell would otherwise enable auth
          // on the restarted server, turning the rename-survives assertion
          // into a confusing 401-vs-200 mismatch.
          UI_PASSWORD: undefined,
          JWT_SECRET: undefined,
          API_KEY: undefined,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child2.stderr?.on("data", (b) => process.stderr.write(`[server2 stderr] ${String(b)}`));
      const base2 = `http://127.0.0.1:${port}`;
      try {
        await waitFor(`${base2}/api/v1/health`);
        const { body: list2 } = await jget(`${base2}/api/v1/projects`);
        const projects = (list2 as { projects: Project[] }).projects;
        assert(
          "after restart, persisted project still listed",
          projects.length === 1 && projects[0]?.id === persistentId,
          `count=${projects.length}`,
        );
        assert(
          "after restart, the rename survived",
          projects[0]?.name === "persistent-renamed",
          `name=${projects[0]?.name}`,
        );
      } finally {
        await new Promise<void>((res) => {
          if (child2.exitCode !== null) return res();
          child2.once("exit", () => res());
          child2.kill("SIGTERM");
          setTimeout(() => child2.kill("SIGKILL"), 1500).unref();
        });
      }
    }
  } finally {
    await srv.stop();
  }

  if (failures > 0) {
    console.log(`\n[test-projects] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-projects] PASS");
}

main().catch((err) => {
  console.error("[test-projects] uncaught error:", err);
  process.exit(1);
});

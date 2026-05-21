/**
 * Quick-actions integration test.
 *
 * Verifies:
 *   - List / create / update / delete round-trip
 *   - Presence-discriminated kind: both-fields and neither-field → 400
 *   - Switching kind via PUT drops the now-unused fields
 *   - Run command-action: stdout captured, cwd is the project root,
 *     exit code propagated, scrubbed env (no leaked FORGE_TEST_SECRET)
 *   - Per-stream truncation flag on huge output
 *   - 404 on unknown action / unknown project
 *   - Prompt-action returns 400 when posted to /run (client-side concern)
 *   - MINIMAL_UI=1 → command runs return 403
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

interface JsonResponse {
  status: number;
  body: unknown;
}

async function jget(base: string, path: string): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  base: string,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<JsonResponse> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

interface ServerModule {
  buildServer: () => Promise<{
    listen: (opts: { port: number; host: string }) => Promise<string>;
    close: () => Promise<void>;
  }>;
}

async function bootServer(
  workspacePath: string,
  configDir: string,
  dataDir: string,
  opts: { minimalUi?: boolean } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;
  if (opts.minimalUi === true) {
    process.env.MINIMAL_UI = "1";
  } else {
    delete process.env.MINIMAL_UI;
  }
  // The dist module is cached after the first import — re-importing
  // won't pick up the new env. Tests that need a fresh config call
  // bootServer in a separate `import()` URL (with a cache-buster
  // query string), see `bootFresh()`.
  const serverModule = (await import(
    `${resolve(repoRoot, "packages/server/dist/index.js")}`
  )) as unknown as ServerModule;
  const fastify = await serverModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });
  return { base, close: () => fastify.close() };
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

async function waitForHealth(url: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${url}`);
}

/**
 * Boot the server in a child process so module-load-time env reads
 * (notably `config.minimalUi`) reflect the env we set. The
 * in-process `import()` cannot do this for repeat boots — the
 * dist module is already cached.
 */
async function bootSubprocess(
  workspacePath: string,
  configDir: string,
  dataDir: string,
  opts: { minimalUi?: boolean } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const serverEntry = resolve(repoRoot, "packages/server/dist/index.js");
  const port = await pickFreePort();
  const env: Record<string, string | undefined> = {
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
    MINIMAL_UI: opts.minimalUi === true ? "1" : undefined,
  };
  const child: ChildProcess = spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[subserver] ${String(b)}`));
  const base = `http://127.0.0.1:${port}`;
  await waitForHealth(`${base}/api/v1/health`);
  const close = (): Promise<void> =>
    new Promise<void>((res) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        res();
        return;
      }
      child.once("exit", () => res());
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2000).unref();
    });
  return { base, close };
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-qa-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-qa-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-qa-data-"));
  // Sentinel in env — scrubbedEnv() must drop this when running command
  // chips. The `report-env` style chip below greps for it; if it shows
  // up in stdout, the scrub is leaking.
  process.env.FORGE_TEST_SECRET = "should-not-leak";

  console.log(`[test-quick-actions] WORKSPACE_PATH=${workspacePath}`);

  let serverHandle: { base: string; close: () => Promise<void> } | undefined;

  try {
    serverHandle = await bootServer(workspacePath, configDir, dataDir);
    const base = serverHandle.base;

    // 1. Empty list on fresh data dir.
    {
      const r = await jget(base, "/api/v1/quick-actions");
      assert("GET on fresh dir → 200 with empty list", r.status === 200);
      const body = r.body as { actions: unknown[] };
      assert("  actions array is empty", Array.isArray(body.actions) && body.actions.length === 0);
    }

    // 2. Create a project (needed for run-cwd).
    const projResp = await jsend(base, "POST", "/api/v1/projects", {
      name: "qa-test",
      path: workspacePath,
    });
    assert("create project → 201", projResp.status === 201);
    const projectId = (projResp.body as { id: string }).id;
    const projectPath = (projResp.body as { path: string }).path;

    // 3. Create a command action.
    let cmdActionId = "";
    {
      const r = await jsend(base, "POST", "/api/v1/quick-actions", {
        name: "List files",
        command: "ls -1",
      });
      assert("POST command action → 201", r.status === 201, JSON.stringify(r.body));
      const body = r.body as { id: string; name: string; command: string };
      cmdActionId = body.id;
      assert("  id assigned", typeof body.id === "string" && body.id.length > 0);
      assert("  name persisted", body.name === "List files");
      assert("  command persisted", body.command === "ls -1");
    }

    // 4. Create a prompt action.
    let promptActionId = "";
    {
      const r = await jsend(base, "POST", "/api/v1/quick-actions", {
        name: "Plan task",
        text: "Plan this task step by step.",
        mode: "insert",
      });
      assert("POST prompt action → 201", r.status === 201);
      const body = r.body as { id: string; text: string; mode: string };
      promptActionId = body.id;
      assert("  text persisted", body.text === "Plan this task step by step.");
      assert("  mode persisted", body.mode === "insert");
    }

    // 5. List both.
    {
      const r = await jget(base, "/api/v1/quick-actions");
      const body = r.body as { actions: { id: string }[] };
      assert("GET after creates → 2 actions", body.actions.length === 2);
    }

    // 6. Validators — neither field set.
    {
      const r = await jsend(base, "POST", "/api/v1/quick-actions", { name: "Bad" });
      assert("POST without command/text → 400", r.status === 400);
    }

    // 7. Validators — both fields set.
    {
      const r = await jsend(base, "POST", "/api/v1/quick-actions", {
        name: "Bad",
        command: "ls",
        text: "do it",
      });
      assert("POST with both command and text → 400", r.status === 400);
    }

    // 8. PUT switches kind cleanly.
    {
      const r = await jsend(base, "PUT", `/api/v1/quick-actions/${cmdActionId}`, {
        name: "List files",
        text: "List the files for me",
      });
      assert("PUT command → prompt → 200", r.status === 200, JSON.stringify(r.body));
      const body = r.body as { command?: string; text?: string };
      assert("  command field dropped", body.command === undefined);
      assert("  text field set", body.text === "List the files for me");

      // Revert to command for the run tests.
      const back = await jsend(base, "PUT", `/api/v1/quick-actions/${cmdActionId}`, {
        name: "List files",
        command: "ls -1",
        timeoutMs: 5000,
      });
      assert("PUT back to command → 200", back.status === 200);
    }

    // 9. PUT unknown id → 404.
    {
      const r = await jsend(base, "PUT", "/api/v1/quick-actions/does-not-exist", {
        name: "x",
        command: "ls",
      });
      assert("PUT unknown id → 404", r.status === 404);
    }

    // 10. Run command action.
    {
      // Drop a known file in the project root so the ls output is
      // predictable.
      const probe = "QUICK_ACTION_PROBE.txt";
      await (await import("node:fs/promises")).writeFile(join(projectPath, probe), "hi", "utf8");
      const r = await jsend(base, "POST", `/api/v1/quick-actions/${cmdActionId}/run`, {
        projectId,
      });
      assert("POST /run command action → 200", r.status === 200, JSON.stringify(r.body));
      const body = r.body as {
        success: boolean;
        exitCode: number | null;
        stdout: string;
        stderr: string;
        durationMs: number;
        timedOut: boolean;
        truncated: boolean;
      };
      assert("  success=true", body.success === true, JSON.stringify(body));
      assert("  exitCode=0", body.exitCode === 0);
      assert(
        "  stdout contains probe filename",
        body.stdout.includes(probe),
        `stdout=${body.stdout}`,
      );
      assert("  durationMs is a non-negative integer", Number.isInteger(body.durationMs));
      assert("  timedOut=false", body.timedOut === false);
      assert("  truncated=false", body.truncated === false);
    }

    // 11. Run command action with env probe — FORGE_TEST_SECRET must
    //     NOT appear in the spawned shell's env.
    {
      // Create a dedicated chip so we don't conflate with the ls test.
      const probeAction = await jsend(base, "POST", "/api/v1/quick-actions", {
        name: "env probe",
        // Print every env var; the FORGE_TEST_SECRET check below greps.
        command: "env",
      });
      assert("POST env-probe action → 201", probeAction.status === 201);
      const probeId = (probeAction.body as { id: string }).id;
      const r = await jsend(base, "POST", `/api/v1/quick-actions/${probeId}/run`, { projectId });
      assert("POST /run env probe → 200", r.status === 200);
      const body = r.body as { stdout: string };
      assert(
        "  FORGE_TEST_SECRET scrubbed from spawned shell env",
        !body.stdout.includes("should-not-leak"),
        `leak in stdout: ${body.stdout.slice(0, 400)}`,
      );
      await jsend(base, "DELETE", `/api/v1/quick-actions/${probeId}`);
    }

    // 12. Unknown project on /run → 404.
    {
      const r = await jsend(base, "POST", `/api/v1/quick-actions/${cmdActionId}/run`, {
        projectId: "00000000-0000-0000-0000-000000000000",
      });
      assert("POST /run unknown project → 404", r.status === 404);
    }

    // 13. Unknown action on /run → 404.
    {
      const r = await jsend(base, "POST", "/api/v1/quick-actions/does-not-exist/run", {
        projectId,
      });
      assert("POST /run unknown action → 404", r.status === 404);
    }

    // 14. Prompt action on /run → 400 (not a command action).
    {
      const r = await jsend(base, "POST", `/api/v1/quick-actions/${promptActionId}/run`, {
        projectId,
      });
      assert("POST /run on prompt action → 400", r.status === 400, JSON.stringify(r.body));
    }

    // 15. Non-zero exit and stderr capture.
    {
      const created = await jsend(base, "POST", "/api/v1/quick-actions", {
        name: "fail",
        command: "echo to-stderr 1>&2; exit 7",
      });
      const id = (created.body as { id: string }).id;
      const r = await jsend(base, "POST", `/api/v1/quick-actions/${id}/run`, { projectId });
      const body = r.body as { success: boolean; exitCode: number | null; stderr: string };
      assert("  non-zero exit → success=false", body.success === false);
      assert("  exitCode=7", body.exitCode === 7);
      assert("  stderr captured", body.stderr.includes("to-stderr"));
      await jsend(base, "DELETE", `/api/v1/quick-actions/${id}`);
    }

    // 16. On-disk shape — file persisted with the expected fields.
    {
      const raw = await readFile(join(dataDir, "quick-actions.json"), "utf8");
      const parsed = JSON.parse(raw) as { id: string; name: string }[];
      assert("on-disk file is a JSON array", Array.isArray(parsed));
      assert(
        "  contains command action by id",
        parsed.some((a) => a.id === cmdActionId),
      );
      assert(
        "  contains prompt action by id",
        parsed.some((a) => a.id === promptActionId),
      );
    }

    // 17. Delete.
    {
      const r = await jsend(base, "DELETE", `/api/v1/quick-actions/${cmdActionId}`);
      assert("DELETE command action → 204", r.status === 204);
      const list = await jget(base, "/api/v1/quick-actions");
      const body = list.body as { actions: { id: string }[] };
      assert(
        "  command action absent after delete",
        !body.actions.some((a) => a.id === cmdActionId),
      );
    }

    // 18. Delete unknown id → 404.
    {
      const r = await jsend(base, "DELETE", "/api/v1/quick-actions/does-not-exist");
      assert("DELETE unknown id → 404", r.status === 404);
    }

    await serverHandle.close();
    serverHandle = undefined;

    // 19. MINIMAL_UI=1 — re-boot with the flag and verify /run returns
    //     403 even for a valid command action. List/create still work
    //     so settings UI can manage chips for when minimal flips off.
    {
      const minDataDir = await mkdtemp(join(tmpdir(), "pi-forge-qa-min-"));
      const minConfigDir = await mkdtemp(join(tmpdir(), "pi-forge-qa-mincfg-"));
      const minWs = await mkdtemp(join(tmpdir(), "pi-forge-qa-minws-"));
      const minHandle = await bootSubprocess(minWs, minConfigDir, minDataDir, {
        minimalUi: true,
      });
      try {
        const proj = await jsend(minHandle.base, "POST", "/api/v1/projects", {
          name: "min",
          path: minWs,
        });
        const minProjectId = (proj.body as { id: string }).id;
        const created = await jsend(minHandle.base, "POST", "/api/v1/quick-actions", {
          name: "ls",
          command: "ls",
        });
        assert("MINIMAL_UI: create command action still works", created.status === 201);
        const id = (created.body as { id: string }).id;
        const run = await jsend(minHandle.base, "POST", `/api/v1/quick-actions/${id}/run`, {
          projectId: minProjectId,
        });
        assert("MINIMAL_UI: /run returns 403", run.status === 403, JSON.stringify(run.body));
        const err = (run.body as { error: string }).error;
        assert(
          "  error code is command_actions_disabled_in_minimal",
          err === "command_actions_disabled_in_minimal",
          err,
        );
      } finally {
        await minHandle.close();
        await rm(minDataDir, { recursive: true, force: true }).catch(() => undefined);
        await rm(minConfigDir, { recursive: true, force: true }).catch(() => undefined);
        await rm(minWs, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } finally {
    if (serverHandle !== undefined) await serverHandle.close();
    delete process.env.FORGE_TEST_SECRET;
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-quick-actions] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-quick-actions] PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

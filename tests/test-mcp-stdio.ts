/**
 * STDIO MCP integration test.
 *
 * Drives the MCP manager + routes against the local stdio fixture
 * at `tests/fixtures/mcp-stdio-fixture.mjs`. Coverage:
 *
 *   - global stdio entry: load → spawn → list tools → execute
 *   - dispose/re-load (container-recreation shape) respawns persisted stdio tools
 *   - env redaction: GET returns sentinel; PUT round-trips real value
 *   - project stdio entry: gated by trust → `trust_required` state
 *   - POST /mcp/trust grants → reconnects → tools appear
 *   - DELETE /mcp/trust revokes → project unloaded; re-load re-gates
 *   - presence-based one-of: both url + command → 400; neither → 400
 *   - crash-on-spawn → state `error` with lastError set
 *   - project delete cascade clears the trust file
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const fixtureScript = resolve(__dirname, "fixtures", "mcp-stdio-fixture.mjs");

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

async function main(): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-mcp-stdio-data-"));
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-mcp-stdio-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-mcp-stdio-cfg-"));
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  console.log(`[test-mcp-stdio] FORGE_DATA_DIR=${dataDir}`);
  console.log(`[test-mcp-stdio] WORKSPACE_PATH=${workspacePath}`);

  const serverModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as typeof import("../packages/server/src/index.js");
  const managerModule = (await import(
    resolve(repoRoot, "packages/server/dist/mcp/manager.js")
  )) as typeof import("../packages/server/src/mcp/manager.js");
  const configModule = (await import(
    resolve(repoRoot, "packages/server/dist/mcp/config.js")
  )) as typeof import("../packages/server/src/mcp/config.js");

  // Wait for an entry to reach an expected state. Most manager loads now
  // await connect attempts, but route-triggered reconnects still benefit
  // from a small poll while the HTTP response and status view settle.
  type ConnectionState =
    | "idle"
    | "connecting"
    | "connected"
    | "error"
    | "disabled"
    | "trust_required";
  type ServerStatus = ReturnType<typeof managerModule.getStatus>[number];
  const waitForState = async (
    name: string,
    target: ConnectionState,
    opts: { projectId?: string; budgetMs?: number } = {},
  ): Promise<ServerStatus | undefined> => {
    const deadline = Date.now() + (opts.budgetMs ?? 5000);
    const wantScope = opts.projectId !== undefined ? "project" : "global";
    const statusOpts = opts.projectId !== undefined ? { projectId: opts.projectId } : undefined;
    while (Date.now() < deadline) {
      const status = managerModule.getStatus(statusOpts);
      const entry = status.find((s) => s.name === name && s.scope === wantScope);
      if (entry?.state === target) return entry;
      await new Promise((r) => setTimeout(r, 50));
    }
    return undefined;
  };

  const fastify = await serverModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    /* ===== Case A: global stdio entry → spawn → list → execute ===== */
    await configModule.writeMcpJson({
      servers: {
        local: {
          command: "node",
          args: [fixtureScript],
          env: { MCP_TEST_VAR_A: "value-A", MCP_TEST_VAR_B: "value-B" },
        },
      },
    });
    await managerModule.loadGlobal();
    const connected = managerModule.getStatus().find((s) => s.name === "local");
    assert(
      "global stdio: state === connected",
      connected?.state === "connected",
      JSON.stringify(connected),
    );
    assert("global stdio: kind === stdio", connected?.kind === "stdio");
    assert("global stdio: command surfaced", connected?.command === "node");
    assert(
      "global stdio: 2 tools (echo + report-env)",
      connected?.toolCount === 2,
      `toolCount=${String(connected?.toolCount)}`,
    );

    /* ===== Case B: bridged execute reaches the subprocess ===== */
    const tools = managerModule.customToolsForProject("any-project-id");
    const echo = tools.find((t) => t.name === "local__echo");
    assert("bridged echo tool present", echo !== undefined);
    if (echo !== undefined) {
      const result = await echo.execute(
        "tcid-1",
        { text: "round-trip" },
        undefined,
        undefined,
        {} as Parameters<typeof echo.execute>[4],
      );
      const out = JSON.stringify(result);
      assert("execute returned echoed text", out.includes("round-trip"), out);
    }

    /* ===== Case C: env actually reaches the subprocess ===== */
    const reportEnv = tools.find((t) => t.name === "local__report-env");
    if (reportEnv !== undefined) {
      const r = await reportEnv.execute(
        "tcid-env",
        {},
        undefined,
        undefined,
        {} as Parameters<typeof reportEnv.execute>[4],
      );
      const out = JSON.stringify(r);
      assert("subprocess env: MCP_TEST_VAR_A passed through", out.includes("value-A"), out);
      assert("subprocess env: MCP_TEST_VAR_B passed through", out.includes("value-B"), out);
    }

    /* ===== Case D: dispose/re-load respawns persisted stdio tools ===== */
    await managerModule.disposeAll();
    await managerModule.loadGlobal();
    const restarted = managerModule.getStatus().find((s) => s.name === "local");
    assert(
      "stdio restart: loadGlobal awaited connected state",
      restarted?.state === "connected" && restarted.toolCount === 2,
      JSON.stringify(restarted),
    );
    const restartedTools = managerModule.customToolsForProject("any-project-id");
    const restartedEcho = restartedTools.find((t) => t.name === "local__echo");
    assert("stdio restart: echo tool present after reload", restartedEcho !== undefined);
    if (restartedEcho !== undefined) {
      const result = await restartedEcho.execute(
        "tcid-restart",
        { text: "after-restart" },
        undefined,
        undefined,
        {} as Parameters<typeof restartedEcho.execute>[4],
      );
      assert(
        "stdio restart: restarted subprocess handles calls",
        JSON.stringify(result).includes("after-restart"),
      );
    }

    /* ===== Case E: env values are redacted on the GET path ===== */
    {
      const r = await jget(base, "/api/v1/mcp/servers");
      assert("GET /mcp/servers → 200", r.status === 200);
      const body = r.body as {
        servers: Record<string, { env?: Record<string, string> }>;
      };
      const envOnWire = body.servers.local?.env ?? {};
      assert(
        "env values redacted on the wire",
        envOnWire.MCP_TEST_VAR_A === "***REDACTED***" &&
          envOnWire.MCP_TEST_VAR_B === "***REDACTED***",
        JSON.stringify(envOnWire),
      );
    }

    /* ===== Case F: sentinel round-trip on save preserves prior value ===== */
    {
      // The UI sees `***REDACTED***`. Save without changing it.
      const r = await jsend(base, "PUT", "/api/v1/mcp/servers/local", {
        command: "node",
        args: [fixtureScript],
        env: { MCP_TEST_VAR_A: "***REDACTED***", MCP_TEST_VAR_B: "value-B-edited" },
        enabled: true,
      });
      assert("PUT /mcp/servers/local → 200", r.status === 200);
      // Re-read the on-disk file directly.
      const raw = await readFile(join(dataDir, "mcp.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        servers: Record<string, { env?: Record<string, string> }>;
      };
      const persisted = parsed.servers.local?.env ?? {};
      assert(
        "sentinel preserved prior MCP_TEST_VAR_A value",
        persisted.MCP_TEST_VAR_A === "value-A",
        JSON.stringify(persisted),
      );
      assert(
        "non-sentinel overwrote MCP_TEST_VAR_B",
        persisted.MCP_TEST_VAR_B === "value-B-edited",
        JSON.stringify(persisted),
      );
    }

    /* ===== Case G: one-of url/command validation ===== */
    {
      const both = await jsend(base, "PUT", "/api/v1/mcp/servers/bad-both", {
        url: "https://example.com",
        command: "node",
      });
      assert("PUT with both url + command → 400", both.status === 400, JSON.stringify(both.body));
      const neither = await jsend(base, "PUT", "/api/v1/mcp/servers/bad-neither", {
        enabled: true,
      });
      assert(
        "PUT with neither url nor command → 400",
        neither.status === 400,
        JSON.stringify(neither.body),
      );
    }

    /* ===== Case H: crash-on-start surfaces in `error` state ===== */
    {
      await jsend(base, "PUT", "/api/v1/mcp/servers/crasher", {
        command: "node",
        args: [fixtureScript, "--crash-on-start"],
      });
      const status = await waitForState("crasher", "error", { budgetMs: 5000 });
      assert("crashed stdio: state === error", status?.state === "error", JSON.stringify(status));
      assert(
        "crashed stdio: lastError populated",
        typeof status?.lastError === "string" && status.lastError.length > 0,
        JSON.stringify(status?.lastError),
      );
    }

    /* ===== Case I: project stdio entry is gated by trust ===== */
    // Create a project + drop a project .mcp.json with a stdio entry.
    const projRes = await jsend(base, "POST", "/api/v1/projects", {
      name: "stdio-trust-test",
      path: workspacePath,
    });
    assert("create project → 201", projRes.status === 201);
    const projectId = (projRes.body as { id: string }).id;

    await writeFile(
      join(workspacePath, ".mcp.json"),
      JSON.stringify({
        servers: {
          "proj-fixture": {
            command: "node",
            args: [fixtureScript, "--name", "proj-fixture"],
          },
        },
      }),
      "utf8",
    );

    // GET should report stdioTrust: false and the entry as trust_required.
    {
      const r = await jget(base, `/api/v1/mcp/servers?projectId=${projectId}`);
      const body = r.body as {
        stdioTrust?: { trusted: boolean };
        status: { name: string; scope: string; state: string }[];
      };
      assert("GET reports stdioTrust.trusted === false", body.stdioTrust?.trusted === false);
      const projStatus = body.status.find(
        (s) => s.name === "proj-fixture" && s.scope === "project",
      );
      assert(
        "project stdio entry: state === trust_required",
        projStatus?.state === "trust_required",
        JSON.stringify(projStatus),
      );
      // No tools should be visible until trust is granted.
      const toolsForProj = managerModule.customToolsForProject(projectId);
      const fromProject = toolsForProj.filter((t) => t.name.startsWith("proj-fixture__"));
      assert(
        "no project tools surface before trust",
        fromProject.length === 0,
        `count=${fromProject.length}`,
      );
    }

    /* ===== Case J: granting trust spawns the subprocess + surfaces tools ===== */
    {
      const grant = await jsend(base, "POST", `/api/v1/mcp/trust/${projectId}`);
      assert("POST /mcp/trust → 200", grant.status === 200);
      assert("grant body: trusted === true", (grant.body as { trusted: boolean }).trusted === true);
      const status = await waitForState("proj-fixture", "connected", {
        projectId,
        budgetMs: 5000,
      });
      assert(
        "project stdio: connected after trust",
        status?.state === "connected",
        JSON.stringify(status),
      );
      const toolsForProj = managerModule.customToolsForProject(projectId);
      const fromProject = toolsForProj.filter((t) => t.name.startsWith("proj-fixture__"));
      assert(
        "project tools visible after trust",
        fromProject.length === 2,
        `count=${fromProject.length}`,
      );
    }

    /* ===== Case K: revoke trust unloads the project pool ===== */
    {
      const revoke = await jsend(base, "DELETE", `/api/v1/mcp/trust/${projectId}`);
      assert("DELETE /mcp/trust → 200", revoke.status === 200);
      // After revoke, the project entries are dropped from the pool.
      const status = managerModule.getStatus({ projectId });
      const projEntries = status.filter((s) => s.scope === "project");
      assert(
        "project entries dropped from pool after revoke",
        projEntries.length === 0,
        JSON.stringify(projEntries),
      );
      // Re-loading the project re-applies the gate.
      const r = await jget(base, `/api/v1/mcp/servers?projectId=${projectId}`);
      const body = r.body as {
        stdioTrust?: { trusted: boolean };
        status: { name: string; scope: string; state: string }[];
      };
      assert(
        "re-loaded after revoke: stdioTrust.trusted === false",
        body.stdioTrust?.trusted === false,
      );
      const projStatus = body.status.find(
        (s) => s.name === "proj-fixture" && s.scope === "project",
      );
      assert(
        "re-loaded after revoke: state === trust_required",
        projStatus?.state === "trust_required",
        JSON.stringify(projStatus),
      );
    }

    /* ===== Case L: project delete cascades the trust entry ===== */
    {
      // Re-grant so the trust file actually has an entry to clear.
      await jsend(base, "POST", `/api/v1/mcp/trust/${projectId}`);
      const trustPath = join(dataDir, "mcp-stdio-trust.json");
      const beforeRaw = await readFile(trustPath, "utf8").catch(() => "{}");
      const before = JSON.parse(beforeRaw) as { projects?: Record<string, unknown> };
      assert(
        "trust file has entry before project delete",
        before.projects?.[projectId] !== undefined,
        beforeRaw,
      );
      const del = await jsend(base, "DELETE", `/api/v1/projects/${projectId}`);
      assert("DELETE project → 200", del.status === 200);
      const afterRaw = await readFile(trustPath, "utf8").catch(() => "{}");
      const after = JSON.parse(afterRaw) as { projects?: Record<string, unknown> };
      assert(
        "trust file entry cleared after project delete",
        after.projects?.[projectId] === undefined,
        afterRaw,
      );
    }
  } finally {
    await fastify.close();
    await managerModule.disposeAll().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-mcp-stdio] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-mcp-stdio] PASS");
}

// Silence the unused mkdir import warning — we use mkdir-like setup in
// tmpdir() but no explicit mkdir call. Keep the import handy in case
// future cases (multi-file project fixture) need it.
void mkdir;

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

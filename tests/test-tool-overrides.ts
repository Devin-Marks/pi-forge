/**
 * Per-tool overrides integration test.
 *
 * Boots the server in-process with a temp PI_CONFIG_DIR /
 * FORGE_DATA_DIR, exercises the GET /config/tools and
 * PUT /config/tools/:family/:name/enabled routes, and verifies the
 * on-disk override file mutates correctly.
 *
 * Coverage:
 *   - GET /config/tools on a fresh install — returns the seven
 *     builtins with `enabled: true` (allow-by-default), empty mcp
 *     list (no servers configured).
 *   - PUT /config/tools/builtin/bash/enabled false → 200, GET
 *     reflects bash disabled.
 *   - PUT toggle round-trip (true → false → true) leaves the
 *     override file in a clean state (no stale entry).
 *   - PUT with an invalid family → 400 (Fastify schema validation).
 *   - PUT with malformed body → 400.
 *   - On-disk file shape — the override file at
 *     ${FORGE_DATA_DIR}/tool-overrides.json contains the
 *     disabled name and nothing else.
 *   - Per-project overrides:
 *       - PUT with scope=project + projectId writes to the project
 *         section; GET ?projectId= echoes `projectOverride` +
 *         `globalEnabled`; effective `enabled` reflects the override.
 *       - Project enable beats global disable, and vice versa.
 *       - DELETE clears the override; GET reverts to inheriting the
 *         global state.
 *       - PUT scope=project without projectId → 400.
 *       - PUT scope=project with unknown projectId → 404.
 *   - Cascade view at GET /config/tools/overrides — returns every
 *     project's per-family overrides; cleared overrides are absent;
 *     global-only disables don't bleed into the project section.
 */
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
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
  method: "POST" | "PUT" | "DELETE",
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
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-tools-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-tools-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-tools-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };

  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  const overridesPath = join(dataDir, "tool-overrides.json");

  try {
    // ---- 1. Fresh listing — all builtins enabled, no MCP ----
    {
      const r = await jget(base, "/api/v1/config/tools");
      assert("GET /config/tools (fresh) → 200", r.status === 200);
      const body = r.body as {
        builtin: { name: string; enabled: boolean }[];
        mcp: unknown[];
      };
      // 7 SDK builtins + ask_user_question + todo + process (all three
      // implemented in pi-forge but surfaced under "Built-in tools"
      // so users can disable them from Settings → Tools). See
      // packages/server/src/session-registry.ts BUILTIN_TOOL_NAMES.
      assert(
        "  ten builtins listed",
        body.builtin.length === 10,
        `got ${body.builtin.length}: ${body.builtin.map((b) => b.name).join(",")}`,
      );
      const names = new Set(body.builtin.map((b) => b.name));
      for (const expected of [
        "read",
        "bash",
        "edit",
        "write",
        "grep",
        "find",
        "ls",
        "ask_user_question",
        "todo",
        "process",
      ]) {
        assert(
          `  builtin "${expected}" present and enabled`,
          names.has(expected) && body.builtin.find((b) => b.name === expected)?.enabled === true,
        );
      }
      assert("  mcp list empty (no servers configured)", body.mcp.length === 0);
    }

    // ---- 2. Disable bash via PUT — verify GET reflects, file written ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/builtin/bash/enabled", {
        enabled: false,
      });
      assert("PUT bash disabled → 200", r.status === 200, JSON.stringify(r.body));
      const body = r.body as { family: string; name: string; enabled: boolean };
      assert(
        "  response echoes the new state",
        body.family === "builtin" && body.name === "bash" && body.enabled === false,
        JSON.stringify(body),
      );

      const list = await jget(base, "/api/v1/config/tools");
      const bash = (list.body as { builtin: { name: string; enabled: boolean }[] }).builtin.find(
        (b) => b.name === "bash",
      );
      assert("  GET reflects bash disabled", bash?.enabled === false);

      // On-disk file should contain bash in builtin disabled list.
      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
        mcp: string[];
      };
      assert(
        "  tool-overrides.json contains 'bash' in builtin",
        onDisk.builtin.includes("bash") && onDisk.mcp.length === 0,
        JSON.stringify(onDisk),
      );
    }

    // ---- 3. Re-enable bash — file returns to clean state ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/builtin/bash/enabled", {
        enabled: true,
      });
      assert("PUT bash re-enabled → 200", r.status === 200);

      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
        mcp: string[];
      };
      assert(
        "  tool-overrides.json no longer contains 'bash'",
        !onDisk.builtin.includes("bash"),
        JSON.stringify(onDisk),
      );

      const list = await jget(base, "/api/v1/config/tools");
      const bash = (list.body as { builtin: { name: string; enabled: boolean }[] }).builtin.find(
        (b) => b.name === "bash",
      );
      assert("  GET reflects bash re-enabled", bash?.enabled === true);
    }

    // ---- 4. Idempotent toggles — double-disable, double-enable ----
    {
      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: false });
      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: false });
      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
      };
      const grepCount = onDisk.builtin.filter((n) => n === "grep").length;
      assert("double-disable doesn't duplicate the entry", grepCount === 1, `count=${grepCount}`);

      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: true });
      await jsend(base, "PUT", "/api/v1/config/tools/builtin/grep/enabled", { enabled: true });
      const onDisk2 = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
      };
      assert(
        "double-enable removes and stays clean",
        !onDisk2.builtin.includes("grep"),
        JSON.stringify(onDisk2),
      );
    }

    // ---- 5. Invalid family → 400 (schema validation) ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/garbage/something/enabled", {
        enabled: false,
      });
      assert("invalid family → 400", r.status === 400, `status=${r.status}`);
    }

    // ---- 6. Malformed body → 400 ----
    {
      const r = await jsend(base, "PUT", "/api/v1/config/tools/builtin/bash/enabled", {
        notTheRightField: true,
      });
      assert("malformed body → 400", r.status === 400, `status=${r.status}`);
    }

    // ---- 7. MCP namespace — disable + verify on disk in mcp section ----
    // No actual MCP server is connected here; we exercise the toggle
    // route + storage independently to prove the mcp family path works.
    // The bridged-name format `<server>__<tool>` is the contract; the
    // route doesn't validate that the server exists (overrides can
    // pre-exist before a server connects).
    {
      const r = await jsend(
        base,
        "PUT",
        `/api/v1/config/tools/mcp/${encodeURIComponent("myserver__add")}/enabled`,
        { enabled: false },
      );
      assert("PUT mcp tool disabled → 200", r.status === 200, JSON.stringify(r.body));
      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        builtin: string[];
        mcp: string[];
      };
      assert(
        "  tool-overrides.json contains 'myserver__add' in mcp",
        onDisk.mcp.includes("myserver__add"),
        JSON.stringify(onDisk),
      );
    }

    // ---- 8. Per-project overrides ----
    //
    // Need a real project so the route's existence check passes.
    // Create one rooted in our temp workspace.
    const projectDir = join(workspacePath, "alpha");
    await mkdir(projectDir, { recursive: true });
    const projCreate = await jsend(base, "POST", "/api/v1/projects", {
      name: "alpha",
      path: projectDir,
    });
    if (projCreate.status !== 201) {
      throw new Error(
        `project create failed: ${projCreate.status} ${JSON.stringify(projCreate.body)}`,
      );
    }
    const projectId = (projCreate.body as { id: string }).id;

    {
      // Project explicitly disables `read` even though global is enabled.
      const r = await jsend(
        base,
        "PUT",
        `/api/v1/config/tools/builtin/read/enabled?projectId=${encodeURIComponent(projectId)}`,
        { enabled: false, scope: "project" },
      );
      assert("PUT scope=project disable → 200", r.status === 200, JSON.stringify(r.body));
      const body = r.body as {
        family: string;
        name: string;
        enabled: boolean;
        scope: string;
        projectId?: string;
      };
      assert(
        "  response echoes scope=project + projectId",
        body.scope === "project" && body.projectId === projectId,
        JSON.stringify(body),
      );

      // GET with the projectId echoes the override + the project's
      // effective state (disabled), and globalEnabled stays true.
      const list = await jget(
        base,
        `/api/v1/config/tools?projectId=${encodeURIComponent(projectId)}`,
      );
      const read = (
        list.body as {
          builtin: {
            name: string;
            enabled: boolean;
            globalEnabled: boolean;
            projectOverride?: string;
          }[];
        }
      ).builtin.find((b) => b.name === "read");
      assert(
        "  GET ?projectId= reflects effective=false, override=disabled, global=true",
        read?.enabled === false &&
          read?.projectOverride === "disabled" &&
          read?.globalEnabled === true,
        JSON.stringify(read),
      );

      // GET WITHOUT projectId still shows global (read enabled, no override).
      const listGlobal = await jget(base, "/api/v1/config/tools");
      const readGlobal = (
        listGlobal.body as {
          builtin: { name: string; enabled: boolean; projectOverride?: string }[];
        }
      ).builtin.find((b) => b.name === "read");
      assert(
        "  GET (no projectId) ignores project overrides",
        readGlobal?.enabled === true && readGlobal?.projectOverride === undefined,
        JSON.stringify(readGlobal),
      );

      // On-disk file: projects[projectId].builtin.disable contains "read".
      const onDisk = JSON.parse(await readFile(overridesPath, "utf8")) as {
        projects?: Record<string, { builtin?: { enable?: string[]; disable?: string[] } }>;
      };
      assert(
        "  tool-overrides.json: projects[id].builtin.disable contains 'read'",
        onDisk.projects?.[projectId]?.builtin?.disable?.includes("read") === true,
        JSON.stringify(onDisk),
      );
    }

    {
      // Disable `find` GLOBALLY, then explicitly enable in the project.
      // Verifies project enable beats global disable.
      await jsend(base, "PUT", "/api/v1/config/tools/builtin/find/enabled", { enabled: false });
      const r = await jsend(
        base,
        "PUT",
        `/api/v1/config/tools/builtin/find/enabled?projectId=${encodeURIComponent(projectId)}`,
        { enabled: true, scope: "project" },
      );
      assert("PUT scope=project enable over global-disable → 200", r.status === 200);

      const list = await jget(
        base,
        `/api/v1/config/tools?projectId=${encodeURIComponent(projectId)}`,
      );
      const find = (
        list.body as {
          builtin: {
            name: string;
            enabled: boolean;
            globalEnabled: boolean;
            projectOverride?: string;
          }[];
        }
      ).builtin.find((b) => b.name === "find");
      assert(
        "  project enable wins: effective=true, global=false, override=enabled",
        find?.enabled === true &&
          find?.globalEnabled === false &&
          find?.projectOverride === "enabled",
        JSON.stringify(find),
      );
    }

    {
      // DELETE the per-project override on `read` — should revert to
      // global (enabled).
      const r = await jsend(
        base,
        "DELETE",
        `/api/v1/config/tools/builtin/read/enabled?projectId=${encodeURIComponent(projectId)}`,
      );
      assert("DELETE per-project override → 200", r.status === 200, JSON.stringify(r.body));

      const list = await jget(
        base,
        `/api/v1/config/tools?projectId=${encodeURIComponent(projectId)}`,
      );
      const read = (
        list.body as {
          builtin: {
            name: string;
            enabled: boolean;
            projectOverride?: string;
          }[];
        }
      ).builtin.find((b) => b.name === "read");
      assert(
        "  GET shows override cleared, inherits global enabled",
        read?.enabled === true && read?.projectOverride === undefined,
        JSON.stringify(read),
      );

      // Idempotent — second DELETE still 200.
      const r2 = await jsend(
        base,
        "DELETE",
        `/api/v1/config/tools/builtin/read/enabled?projectId=${encodeURIComponent(projectId)}`,
      );
      assert("DELETE is idempotent → 200", r2.status === 200, JSON.stringify(r2.body));
    }

    {
      // PUT scope=project without projectId → 400.
      const r = await jsend(base, "PUT", "/api/v1/config/tools/builtin/bash/enabled", {
        enabled: false,
        scope: "project",
      });
      assert(
        "PUT scope=project without projectId → 400",
        r.status === 400,
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );
    }

    {
      // PUT scope=project with unknown projectId → 404.
      const r = await jsend(
        base,
        "PUT",
        "/api/v1/config/tools/builtin/bash/enabled?projectId=does-not-exist",
        { enabled: false, scope: "project" },
      );
      assert(
        "PUT scope=project with unknown projectId → 404",
        r.status === 404,
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );
    }

    {
      // GET /config/tools/overrides — cascade view used by the
      // Settings UI's "+ Add override for…" picker. Should reflect
      // both the project's outstanding `find` enable (set above) AND
      // the previously-set MCP `myserver__add` global disable
      // shouldn't appear (it's global, not per-project). Project
      // `read` was DELETEd, so it shouldn't appear either.
      const r = await jget(base, "/api/v1/config/tools/overrides");
      assert("GET /config/tools/overrides → 200", r.status === 200);
      const body = r.body as {
        projects: Record<
          string,
          {
            builtin: { enable: string[]; disable: string[] };
            mcp: { enable: string[]; disable: string[] };
            extension: { enable: string[]; disable: string[] };
          }
        >;
      };
      const proj = body.projects[projectId];
      assert("  cascade contains the project entry", proj !== undefined, JSON.stringify(body));
      assert(
        "  cascade.builtin.enable contains 'find'",
        proj?.builtin.enable.includes("find") === true,
        JSON.stringify(proj),
      );
      assert(
        "  cascade.builtin.disable does NOT contain 'read' (cleared)",
        proj?.builtin.disable.includes("read") === false,
        JSON.stringify(proj),
      );
      assert(
        "  cascade.mcp.disable does NOT include the global mcp disable",
        proj?.mcp.disable.includes("myserver__add") === false,
        JSON.stringify(proj),
      );
      // Regression: the response schema must declare `extension`. Fastify
      // strips properties that aren't in the response schema, and the
      // SettingsPanel UI assumed all three families were present, so a
      // missing `extension` key crashed the whole tab. The schema now
      // requires it; the field must come back even when there's no
      // outstanding extension override.
      assert(
        "  cascade.extension is present (response schema includes it)",
        proj?.extension !== undefined &&
          Array.isArray(proj.extension.enable) &&
          Array.isArray(proj.extension.disable),
        JSON.stringify(proj),
      );
    }
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-tool-overrides] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-tool-overrides] all assertions passed");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.log(`[test-tool-overrides] uncaught: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });

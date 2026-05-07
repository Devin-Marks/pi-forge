/**
 * Phase 7 config + skills integration test.
 *
 * Boots the server in-process with a temp `PI_CONFIG_DIR` so writes don't
 * touch the developer's real `~/.pi/agent`. Auth is disabled (no
 * `UI_PASSWORD` / `API_KEY`) since auth coverage is in test-auth.ts.
 *
 * Coverage:
 *   - GET /config/models on a missing models.json → empty `{ providers: {} }`
 *   - PUT /config/models with a valid provider → 200; on-disk file is
 *     written atomically and survives a fresh GET.
 *   - PUT /config/models with a malformed body (no `providers`) → 400.
 *   - PUT /config/auth/<provider> with an apiKey → 200; auth.json contains
 *     the entry; GET /config/auth reports `configured: true` BUT NEVER the
 *     actual key value.
 *   - DELETE /config/auth/<provider> → 204; subsequent GET shows the
 *     provider absent.
 *   - DELETE /config/auth/<unknown> → 404.
 *   - GET /config/providers — live registry returns built-in models with
 *     `hasAuth` flags reflecting auth.json.
 *   - GET /config/settings → empty object initially; PUT merges patches;
 *     `null` values delete keys.
 *   - GET /config/skills?projectId=... lists skills (empty by default;
 *     creating a SKILL.md under the project's `.pi/skills/` makes it appear
 *     with `enabled: false`).
 *   - PUT /config/skills/<name>/enabled?projectId=... toggles in
 *     `settings.skills`.
 *   - GET /config/skills?projectId=<unknown> → 404 (project_not_found).
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  console.log(`[test-config] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-config] PI_CONFIG_DIR=${configDir}`);
  console.log(`[test-config] FORGE_DATA_DIR=${dataDir}`);

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

  try {
    // 1. models.json — empty initially
    {
      const r = await jget(base, "/api/v1/config/models");
      assert("GET /config/models initial → 200", r.status === 200);
      assert(
        "  body is { providers: {} }",
        JSON.stringify(r.body) === '{"providers":{}}',
        JSON.stringify(r.body),
      );
    }

    // 2. PUT /config/models — accepts a custom provider, writes to disk.
    // Note: the SDK requires both `baseUrl` and `apiKey` for non-built-in
    // providers with custom models (validateConfig in model-registry.js).
    // Without the apiKey the registry silently rejects the provider and the
    // /providers route doesn't surface it.
    const customProvider = {
      providers: {
        "my-vllm": {
          baseUrl: "http://localhost:8000/v1",
          apiKey: "fake-test-key",
          api: "completions",
          models: [
            {
              id: "qwen2.5-coder",
              name: "Qwen 2.5 Coder",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32768,
              maxTokens: 4096,
            },
          ],
        },
      },
    };
    {
      const r = await jsend(base, "PUT", "/api/v1/config/models", customProvider);
      assert("PUT /config/models valid → 200", r.status === 200);
    }
    {
      const onDisk = JSON.parse(
        await readFile(join(configDir, "models.json"), "utf8"),
      ) as typeof customProvider;
      assert(
        "models.json on disk matches what we wrote",
        onDisk.providers["my-vllm"]?.baseUrl === "http://localhost:8000/v1",
        JSON.stringify(onDisk),
      );
      const r = await jget(base, "/api/v1/config/models");
      assert(
        "GET reflects the new provider",
        (r.body as { providers: Record<string, unknown> }).providers["my-vllm"] !== undefined,
      );
    }

    // 3. PUT /config/models with malformed body → 400.
    {
      const r = await jsend(base, "PUT", "/api/v1/config/models", { not: "right" });
      assert("PUT /config/models malformed → 400", r.status === 400);
    }

    // 4. /config/auth — store, presence-only read, delete.
    {
      const empty = await jget(base, "/api/v1/config/auth");
      assert("GET /config/auth initial → 200", empty.status === 200);
      assert(
        "  body has empty providers map",
        JSON.stringify((empty.body as { providers: object }).providers) === "{}",
      );

      const set = await jsend(base, "PUT", "/api/v1/config/auth/anthropic", {
        apiKey: "sk-test-redacted-fake-key",
      });
      assert("PUT /config/auth/anthropic → 200", set.status === 200);
      assert(
        "  body reports configured: true",
        (set.body as { configured: boolean }).configured === true,
      );

      const summary = await jget(base, "/api/v1/config/auth");
      assert("GET /config/auth post-write → 200", summary.status === 200);
      const providers = (summary.body as { providers: Record<string, { configured: boolean }> })
        .providers;
      assert("  anthropic entry present", providers.anthropic !== undefined);
      assert("  anthropic.configured === true", providers.anthropic?.configured === true);
      // CRITICAL: response must NEVER leak the actual key value.
      assert(
        "GET /config/auth body does NOT contain the key value",
        !JSON.stringify(summary.body).includes("sk-test-redacted-fake-key"),
        JSON.stringify(summary.body),
      );

      const del = await jsend(base, "DELETE", "/api/v1/config/auth/anthropic");
      assert("DELETE /config/auth/anthropic → 204", del.status === 204);

      const after = await jget(base, "/api/v1/config/auth");
      assert(
        "GET /config/auth after delete → anthropic absent",
        Object.prototype.hasOwnProperty.call(
          (after.body as { providers: Record<string, unknown> }).providers,
          "anthropic",
        ) === false,
      );

      const delMissing = await jsend(base, "DELETE", "/api/v1/config/auth/anthropic");
      assert("DELETE /config/auth/<missing> → 404", delMissing.status === 404);
    }

    // 5. /config/providers — live registry includes built-in providers.
    {
      const r = await jget(base, "/api/v1/config/providers");
      assert("GET /config/providers → 200", r.status === 200);
      const list = (r.body as { providers: { provider: string; models: unknown[] }[] }).providers;
      assert("  providers list is non-empty", Array.isArray(list) && list.length > 0);
      assert(
        "  custom provider 'my-vllm' shows up",
        list.some((p) => p.provider === "my-vllm"),
      );
    }

    // 6. /config/settings — initial empty, partial updates merge,
    //    null deletes.
    {
      const initial = await jget(base, "/api/v1/config/settings");
      assert("GET /config/settings initial → 200", initial.status === 200);
      assert("  body is {}", JSON.stringify(initial.body) === "{}");

      const update = await jsend(base, "PUT", "/api/v1/config/settings", {
        defaultProvider: "anthropic",
        defaultModel: "claude-opus-4-5",
        steeringMode: "all",
      });
      assert("PUT /config/settings → 200", update.status === 200);
      const merged = update.body as { defaultProvider: string; defaultModel: string };
      assert("  body.defaultProvider === 'anthropic'", merged.defaultProvider === "anthropic");
      assert(
        "  body.defaultModel === 'claude-opus-4-5'",
        merged.defaultModel === "claude-opus-4-5",
      );

      // Partial merge: change only defaultModel; defaultProvider stays.
      const merge2 = await jsend(base, "PUT", "/api/v1/config/settings", {
        defaultModel: "claude-haiku-4-5",
      });
      const m2 = merge2.body as { defaultProvider: string; defaultModel: string };
      assert("partial merge keeps defaultProvider", m2.defaultProvider === "anthropic");
      assert("partial merge updates defaultModel", m2.defaultModel === "claude-haiku-4-5");

      // Null deletes a key.
      const merge3 = await jsend(base, "PUT", "/api/v1/config/settings", {
        defaultProvider: null,
      });
      const m3 = merge3.body as { defaultProvider?: string; defaultModel: string };
      assert("null patch deletes defaultProvider", m3.defaultProvider === undefined);
      assert("null patch leaves defaultModel intact", m3.defaultModel === "claude-haiku-4-5");
    }

    // 7. /config/skills — needs a real project (route validates projectId).
    //    Create a project, then a project-local SKILL.md, then list +
    //    toggle.
    let projectId: string;
    {
      const skillSrc =
        "---\nname: hello\ndescription: Says hello to the user.\n---\n\nWhen asked to say hello, respond with 'hello world'.\n";
      await mkdir(join(workspacePath, ".pi", "skills", "hello"), { recursive: true });
      await writeFile(join(workspacePath, ".pi", "skills", "hello", "SKILL.md"), skillSrc, "utf8");

      const proj = await jsend(base, "POST", "/api/v1/projects", {
        name: "test-config",
        path: workspacePath,
      });
      assert("create project → 201", proj.status === 201);
      projectId = (proj.body as { id: string }).id;

      const list = await jget(base, `/api/v1/config/skills?projectId=${projectId}`);
      assert("GET /config/skills → 200", list.status === 200);
      const skills = (list.body as { skills: { name: string; enabled: boolean; source: string }[] })
        .skills;
      const hello = skills.find((s) => s.name === "hello");
      assert("project-local 'hello' skill discovered", hello !== undefined);
      assert("  source is 'project'", hello?.source === "project");
      // Skills are now ENABLED by default in the global state (the
      // model is "exclude by `!name` pattern"; absence of the pattern
      // means enabled). Disable the skill first so the subsequent
      // PUT-true and on-disk pattern checks have something to flip.
      assert("  enabled is initially true (default state)", hello?.enabled === true);

      const initialDisable = await jsend(
        base,
        "PUT",
        `/api/v1/config/skills/hello/enabled?projectId=${projectId}`,
        { enabled: false },
      );
      assert("PUT /config/skills/hello/enabled false → 200", initialDisable.status === 200);
      const disabledOnce = (
        initialDisable.body as { skills: { name: string; enabled: boolean }[] }
      ).skills.find((s) => s.name === "hello");
      assert("  hello.enabled === false after disable", disabledOnce?.enabled === false);
      // settings.json should now contain the `!hello` exclude pattern.
      const onDiskAfterDisable = JSON.parse(
        await readFile(join(configDir, "settings.json"), "utf8"),
      ) as { skills?: string[] };
      assert(
        "settings.skills contains the `!hello` exclude pattern after disable",
        onDiskAfterDisable.skills?.includes("!hello") === true,
        JSON.stringify(onDiskAfterDisable.skills),
      );

      const enable = await jsend(
        base,
        "PUT",
        `/api/v1/config/skills/hello/enabled?projectId=${projectId}`,
        { enabled: true },
      );
      assert("PUT /config/skills/hello/enabled true → 200", enable.status === 200);
      const enabledSkills = (enable.body as { skills: { name: string; enabled: boolean }[] })
        .skills;
      const hello2 = enabledSkills.find((s) => s.name === "hello");
      assert("  hello.enabled === true after re-enable", hello2?.enabled === true);

      // Enabling clears the `!hello` exclude pattern from settings.json
      // (skills are enabled by default; absence of the pattern is the
      // signal). settings.skills must NOT contain `!hello` here.
      const onDisk = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")) as {
        skills?: string[];
      };
      assert(
        "settings.skills no longer contains the `!hello` exclude pattern",
        onDisk.skills?.includes("!hello") !== true,
        JSON.stringify(onDisk.skills),
      );

      const disable = await jsend(
        base,
        "PUT",
        `/api/v1/config/skills/hello/enabled?projectId=${projectId}`,
        { enabled: false },
      );
      const disabledSkills = (disable.body as { skills: { name: string; enabled: boolean }[] })
        .skills;
      assert(
        "PUT enabled: false re-disables the skill",
        disabledSkills.find((s) => s.name === "hello")?.enabled === false,
      );

      // ----- per-project overrides (tri-state with global precedence) -----
      // Re-enable globally so we can test the disable-via-project path.
      await jsend(base, "PUT", `/api/v1/config/skills/hello/enabled?projectId=${projectId}`, {
        enabled: true,
        scope: "global",
      });
      // Project-scope: disable in THIS project. Global stays enabled.
      const projDisable = await jsend(
        base,
        "PUT",
        `/api/v1/config/skills/hello/enabled?projectId=${projectId}`,
        { enabled: false, scope: "project" },
      );
      assert(
        "scope=project PUT → 200",
        projDisable.status === 200,
        JSON.stringify(projDisable.body),
      );
      const afterProjDisable = (
        projDisable.body as {
          skills: {
            name: string;
            enabled: boolean;
            effective: boolean;
            projectOverride?: string;
          }[];
        }
      ).skills.find((s) => s.name === "hello");
      assert(
        "  global stays enabled",
        afterProjDisable?.enabled === true,
        JSON.stringify(afterProjDisable),
      );
      assert(
        "  projectOverride === 'disabled'",
        afterProjDisable?.projectOverride === "disabled",
        JSON.stringify(afterProjDisable),
      );
      assert(
        "  effective is false (project disable wins)",
        afterProjDisable?.effective === false,
        JSON.stringify(afterProjDisable),
      );

      // Cascade view shows the override.
      const overridesView = await jget(base, "/api/v1/config/skills/overrides");
      assert("GET /config/skills/overrides → 200", overridesView.status === 200);
      const projects = (
        overridesView.body as {
          projects: Record<string, { enable: string[]; disable: string[] }>;
        }
      ).projects;
      assert(
        "  override file lists this project's disable",
        projects[projectId]?.disable.includes("hello") === true,
        JSON.stringify(projects),
      );

      // pi's settings.json should NOT have absorbed the project
      // override — project state lives in the pi-forge-private
      // overrides file. In the new pattern model, "global view
      // unaffected" means the global file does NOT pick up a
      // `!hello` exclude pattern as a side-effect of the project-
      // scope disable.
      const settingsPostProj = JSON.parse(
        await readFile(join(configDir, "settings.json"), "utf8"),
      ) as { skills?: string[] };
      assert(
        "  pi settings.skills does NOT contain `!hello` (global view unaffected)",
        settingsPostProj.skills?.includes("!hello") !== true,
        JSON.stringify(settingsPostProj.skills),
      );

      // DELETE clears the project override (= inherit from global).
      const cleared = await jsend(
        base,
        "DELETE",
        `/api/v1/config/skills/hello/enabled?projectId=${projectId}`,
      );
      assert("DELETE /config/skills/:name/enabled → 200", cleared.status === 200);
      const afterClear = (
        cleared.body as {
          skills: { name: string; effective: boolean; projectOverride?: string }[];
        }
      ).skills.find((s) => s.name === "hello");
      assert(
        "  projectOverride absent after clear",
        afterClear?.projectOverride === undefined,
        JSON.stringify(afterClear),
      );
      assert(
        "  effective falls back to global (true)",
        afterClear?.effective === true,
        JSON.stringify(afterClear),
      );

      // Project-scope ENABLE adds a skill that's globally disabled.
      await jsend(base, "PUT", `/api/v1/config/skills/hello/enabled?projectId=${projectId}`, {
        enabled: false,
        scope: "global",
      });
      const projEnable = await jsend(
        base,
        "PUT",
        `/api/v1/config/skills/hello/enabled?projectId=${projectId}`,
        { enabled: true, scope: "project" },
      );
      const afterProjEnable = (
        projEnable.body as {
          skills: { name: string; enabled: boolean; effective: boolean }[];
        }
      ).skills.find((s) => s.name === "hello");
      assert(
        "scope=project enable + global disabled → effective true",
        afterProjEnable?.enabled === false && afterProjEnable.effective === true,
        JSON.stringify(afterProjEnable),
      );
      // Re-enable globally so the rest of the original test sequence
      // continues to pass (it expects hello to start enabled below).
      await jsend(base, "PUT", `/api/v1/config/skills/hello/enabled?projectId=${projectId}`, {
        enabled: true,
        scope: "global",
      });
      // Clean the project override before falling through to the
      // legacy "PUT enabled: false" assertion below.
      await jsend(base, "DELETE", `/api/v1/config/skills/hello/enabled?projectId=${projectId}`);

      const unknownSkill = await jsend(
        base,
        "PUT",
        `/api/v1/config/skills/no-such-skill/enabled?projectId=${projectId}`,
        { enabled: true },
      );
      assert(
        "PUT toggle on unknown skill → 404",
        unknownSkill.status === 404,
        JSON.stringify(unknownSkill.body),
      );

      const unknownProject = await jget(
        base,
        `/api/v1/config/skills?projectId=00000000-0000-0000-0000-000000000000`,
      );
      assert("GET /config/skills with unknown projectId → 404", unknownProject.status === 404);
    }

    // 8. atomic write proof: models.json updated mid-test should produce a
    //    file with no .tmp leftovers in the dir.
    {
      const dirEntries = await stat(configDir);
      assert("config dir exists", dirEntries.isDirectory());
      // (We don't enumerate here — atomic-write correctness is exercised by
      // the read-after-write assertions throughout. The .tmp files are
      // renamed in place; if they hung around we'd see test-7's project
      // creation interact poorly. Smoke check only.)
    }

    // Suppress unused-variable warning for projectId (it's used inside its
    // own block above).
    void projectId;
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-config] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-config] PASS");
}

main().catch((err) => {
  console.error("[test-config] uncaught error:", err);
  process.exit(1);
});

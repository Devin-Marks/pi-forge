/**
 * Pi prompts surface integration test.
 *
 * Mirrors the skills coverage in test-config.ts but for the `/config/prompts`
 * endpoints + per-project overrides + cascade view. Also exercises the
 * SettingsManager monkey-patch via `effectivePromptsForProject` indirectly
 * (via project-scope PUT/DELETE behaviour visible through GET).
 *
 * What this test does NOT cover:
 *   - Actual prompt expansion at session.prompt() time. That's pi SDK
 *     behaviour, gated by `expandPromptTemplates: true` in the SDK
 *     itself; we don't re-test the SDK contract.
 *   - The chat-input slash-command palette. UI behaviour, no server
 *     surface to assert against.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-prompts-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-prompts-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-prompts-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  console.log(`[test-prompts] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-prompts] PI_CONFIG_DIR=${configDir}`);
  console.log(`[test-prompts] FORGE_DATA_DIR=${dataDir}`);

  // Seed a project-local prompt template under the workspace's
  // `.pi/prompts/` directory. The pi SDK's prompt loader picks up
  // top-level `.md` files there.
  await mkdir(join(workspacePath, ".pi", "prompts"), { recursive: true });
  await writeFile(
    join(workspacePath, ".pi", "prompts", "summarize.md"),
    [
      "---",
      "name: summarize",
      "description: Summarize the given file at a high level.",
      "argument-hint: <path>",
      "---",
      "Read $1 and produce a 3-bullet executive summary.",
      "",
    ].join("\n"),
    "utf8",
  );

  // And a global one so we exercise both source kinds.
  await mkdir(join(configDir, "prompts"), { recursive: true });
  await writeFile(
    join(configDir, "prompts", "review.md"),
    [
      "---",
      "name: review",
      "description: Review the diff of the current branch and suggest improvements.",
      "---",
      "Run git diff main..HEAD and review the changes for correctness and style.",
      "",
    ].join("\n"),
    "utf8",
  );

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
    // 1. Create a project so the prompt routes can scope to it.
    const proj = await jsend(base, "POST", "/api/v1/projects", {
      name: "test-prompts",
      path: workspacePath,
    });
    assert("create project → 201", proj.status === 201);
    const projectId = (proj.body as { id: string }).id;

    // 2. GET /config/prompts — should list both global + project-local.
    {
      const list = await jget(base, `/api/v1/config/prompts?projectId=${projectId}`);
      assert("GET /config/prompts → 200", list.status === 200);
      const body = list.body as {
        prompts: { name: string; source: string; enabled: boolean; effective: boolean; argumentHint?: string }[];
        diagnostics: unknown[];
      };
      const summarize = body.prompts.find((p) => p.name === "summarize");
      const review = body.prompts.find((p) => p.name === "review");
      assert("  project-local 'summarize' present", summarize !== undefined);
      assert("  global 'review' present", review !== undefined);
      assert("  source classification correct", summarize?.source === "project" && review?.source === "global");
      assert("  argumentHint surfaced", summarize?.argumentHint === "<path>");
      assert("  both default to enabled (no global !patterns)", summarize?.enabled === true && review?.enabled === true);
      assert("  diagnostics is empty array (SDK doesn't surface prompt collisions yet)", Array.isArray(body.diagnostics) && body.diagnostics.length === 0);
    }

    // 3. PUT global enabled=false on `summarize` — writes pi's settings.prompts pattern.
    {
      const r = await jsend(
        base,
        "PUT",
        `/api/v1/config/prompts/summarize/enabled?projectId=${projectId}`,
        { enabled: false, scope: "global" },
      );
      assert("PUT /config/prompts/summarize/enabled false (global) → 200", r.status === 200);
      const updated = (r.body as { prompts: { name: string; enabled: boolean }[] }).prompts.find(
        (p) => p.name === "summarize",
      );
      assert("  summarize.enabled === false after disable", updated?.enabled === false);

      const onDisk = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8")) as {
        prompts?: string[];
      };
      assert(
        "  settings.json contains `!summarize` exclude pattern",
        onDisk.prompts?.includes("!summarize") === true,
        JSON.stringify(onDisk.prompts),
      );
    }

    // 4. PUT project enabled=true on `summarize` — project enable beats global disable.
    {
      const r = await jsend(
        base,
        "PUT",
        `/api/v1/config/prompts/summarize/enabled?projectId=${projectId}`,
        { enabled: true, scope: "project" },
      );
      assert("PUT /config/prompts/summarize/enabled true (project) → 200", r.status === 200);
      const updated = (
        r.body as { prompts: { name: string; enabled: boolean; effective: boolean; projectOverride?: string }[] }
      ).prompts.find((p) => p.name === "summarize");
      assert(
        "  global remains disabled",
        updated?.enabled === false,
        JSON.stringify(updated),
      );
      assert("  projectOverride === 'enabled'", updated?.projectOverride === "enabled");
      assert(
        "  effective is true (project enable wins)",
        updated?.effective === true,
        JSON.stringify(updated),
      );
    }

    // 5. GET /config/prompts/overrides — cascade view returns the file contents.
    {
      const r = await jget(base, "/api/v1/config/prompts/overrides");
      assert("GET /config/prompts/overrides → 200", r.status === 200);
      const body = r.body as {
        projects: Record<string, { enable: string[]; disable: string[] }>;
      };
      assert(
        "  override file lists this project's enable",
        body.projects[projectId]?.enable.includes("summarize") === true,
        JSON.stringify(body),
      );
    }

    // 6. DELETE the project override — effective falls back to (still-disabled) global.
    {
      const r = await jsend(
        base,
        "DELETE",
        `/api/v1/config/prompts/summarize/enabled?projectId=${projectId}`,
      );
      assert("DELETE /config/prompts/summarize/enabled → 200", r.status === 200);
      const updated = (
        r.body as { prompts: { name: string; effective: boolean; projectOverride?: string }[] }
      ).prompts.find((p) => p.name === "summarize");
      assert("  projectOverride absent after clear", updated?.projectOverride === undefined);
      assert(
        "  effective falls back to global (false)",
        updated?.effective === false,
        JSON.stringify(updated),
      );
    }

    // 7. Unknown prompt → 404.
    {
      const r = await jsend(
        base,
        "PUT",
        `/api/v1/config/prompts/no-such-prompt/enabled?projectId=${projectId}`,
        { enabled: true },
      );
      assert(
        "PUT toggle on unknown prompt → 404",
        r.status === 404,
        JSON.stringify(r.body),
      );
    }

    // 8. Unknown projectId → 404.
    {
      const r = await jget(
        base,
        `/api/v1/config/prompts?projectId=00000000-0000-0000-0000-000000000000`,
      );
      assert("GET /config/prompts with unknown projectId → 404", r.status === 404);
    }
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-prompts] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-prompts] PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

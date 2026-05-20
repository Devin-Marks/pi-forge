/**
 * Per-project system-prompt addendum integration test.
 *
 * Verifies:
 *   - GET / PUT /projects/:id/system-prompt round-trip
 *   - Empty string clears the entry on disk (doesn't grow the file)
 *   - Byte-cap rejection at the route layer (400)
 *   - Unknown projectId → 404 on both GET and PUT
 *   - Cascade-delete: deleting a project removes its addendum entry
 *   - End-to-end wiring: the addendum reaches AgentSession.systemPrompt
 *     via pi's `appendSystemPrompt` extension hook (no live LLM call —
 *     just the SDK's `systemPrompt` getter, which is built from the
 *     ResourceLoader output that buildForgeResourceLoader feeds in).
 */
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

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-sysp-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-sysp-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-sysp-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;
  // Keep the secret-hygiene rule out of the picture so byte counting
  // doesn't have to account for two append entries.
  delete process.env.AGENT_SECRET_HYGIENE_RULE;

  console.log(`[test-system-prompt] WORKSPACE_PATH=${workspacePath}`);
  console.log(`[test-system-prompt] PI_CONFIG_DIR=${configDir}`);
  console.log(`[test-system-prompt] FORGE_DATA_DIR=${dataDir}`);

  const serverModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };
  const registryModule = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as {
    createSession: (
      projectId: string,
      workspacePath: string,
    ) => Promise<{
      sessionId: string;
      session: { systemPrompt: string };
    }>;
    disposeSession: (id: string) => Promise<void>;
  };

  const fastify = await serverModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    // 1. Create a project to scope the addendum to.
    const proj = await jsend(base, "POST", "/api/v1/projects", {
      name: "test-system-prompt",
      path: workspacePath,
    });
    assert("create project → 201", proj.status === 201);
    const projectId = (proj.body as { id: string }).id;

    // 2. GET on a fresh project returns an empty addendum + the cap.
    {
      const r = await jget(base, `/api/v1/projects/${projectId}/system-prompt`);
      assert("GET fresh project → 200", r.status === 200);
      const body = r.body as { addendum: string; maxBytes: number };
      assert("  addendum is empty string", body.addendum === "");
      assert(
        "  maxBytes is a positive integer",
        Number.isInteger(body.maxBytes) && body.maxBytes > 0,
        JSON.stringify(body),
      );
    }

    // 3. PUT a non-empty addendum.
    const SAMPLE =
      "This project uses TypeScript strict mode. Prefer named exports over default exports.";
    {
      const r = await jsend(base, "PUT", `/api/v1/projects/${projectId}/system-prompt`, {
        addendum: SAMPLE,
      });
      assert("PUT addendum → 200", r.status === 200);
      const body = r.body as { addendum: string };
      assert("  echoed addendum matches input", body.addendum === SAMPLE);
    }

    // 4. GET reads what was written.
    {
      const r = await jget(base, `/api/v1/projects/${projectId}/system-prompt`);
      assert("GET after write → 200", r.status === 200);
      const body = r.body as { addendum: string };
      assert("  persisted addendum matches", body.addendum === SAMPLE);
    }

    // 5. On-disk file shape.
    {
      const raw = await readFile(join(dataDir, "system-prompt-overrides.json"), "utf8");
      const parsed = JSON.parse(raw) as { projects: Record<string, string> };
      assert("  on-disk file has projects map", parsed.projects[projectId] === SAMPLE);
    }

    // 6. The addendum actually reaches the agent's system prompt.
    {
      const live = await registryModule.createSession(projectId, workspacePath);
      try {
        const sp = live.session.systemPrompt;
        assert(
          "  AgentSession.systemPrompt contains the addendum",
          typeof sp === "string" && sp.includes(SAMPLE),
          `len=${sp.length}; ends='${sp.slice(-200)}'`,
        );
      } finally {
        await registryModule.disposeSession(live.sessionId);
      }
    }

    // 7. Empty string clears the entry (file no longer mentions this project).
    {
      const r = await jsend(base, "PUT", `/api/v1/projects/${projectId}/system-prompt`, {
        addendum: "",
      });
      assert("PUT empty addendum → 200", r.status === 200);
      const body = r.body as { addendum: string };
      assert("  echoed addendum is empty after clear", body.addendum === "");
      const raw = await readFile(join(dataDir, "system-prompt-overrides.json"), "utf8");
      const parsed = JSON.parse(raw) as { projects: Record<string, string> };
      assert(
        "  cleared project absent from on-disk file",
        parsed.projects[projectId] === undefined,
        JSON.stringify(parsed),
      );
    }

    // 8. Whitespace-only is treated as empty (no stored entry).
    {
      const r = await jsend(base, "PUT", `/api/v1/projects/${projectId}/system-prompt`, {
        addendum: "   \n\t  \n",
      });
      assert("PUT whitespace-only → 200", r.status === 200);
      const raw = await readFile(join(dataDir, "system-prompt-overrides.json"), "utf8");
      const parsed = JSON.parse(raw) as { projects: Record<string, string> };
      assert(
        "  whitespace-only does not create an entry",
        parsed.projects[projectId] === undefined,
        JSON.stringify(parsed),
      );
    }

    // 9. Byte-cap rejection. The schema's maxLength enforces the char cap;
    //    we exercise it with a large single-byte-char string.
    {
      const huge = "x".repeat(20_001);
      const r = await jsend(base, "PUT", `/api/v1/projects/${projectId}/system-prompt`, {
        addendum: huge,
      });
      // Fastify's schema validator rejects with 400 before our handler runs.
      assert("PUT oversize addendum → 400", r.status === 400, JSON.stringify(r.body));
    }

    // 10. Unknown projectId.
    const FAKE = "00000000-0000-0000-0000-000000000000";
    {
      const g = await jget(base, `/api/v1/projects/${FAKE}/system-prompt`);
      assert("GET unknown project → 404", g.status === 404);
      const p = await jsend(base, "PUT", `/api/v1/projects/${FAKE}/system-prompt`, {
        addendum: "hi",
      });
      assert("PUT unknown project → 404", p.status === 404);
    }

    // 11. Cascade-delete: project deletion removes the addendum entry.
    {
      // Re-write an addendum so we have something to verify gets removed.
      const w = await jsend(base, "PUT", `/api/v1/projects/${projectId}/system-prompt`, {
        addendum: "to-be-deleted",
      });
      assert("re-PUT before delete → 200", w.status === 200);
      const d = await jsend(base, "DELETE", `/api/v1/projects/${projectId}`);
      assert("DELETE project → 200", d.status === 200);
      const raw = await readFile(join(dataDir, "system-prompt-overrides.json"), "utf8");
      const parsed = JSON.parse(raw) as { projects: Record<string, string> };
      assert(
        "  addendum removed from disk after project delete",
        parsed.projects[projectId] === undefined,
        JSON.stringify(parsed),
      );
    }
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    await rm(configDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-system-prompt] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-system-prompt] PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

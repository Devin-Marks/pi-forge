/**
 * Skill slash-command integration coverage.
 *
 * Verifies the server's live-session validation and SDK-native prompt form
 * without requiring an LLM provider. The session prompt is replaced with a
 * fixture after session creation so the test can assert fire-and-forget
 * argument forwarding directly.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillInvocation } from "../packages/client/src/lib/skill-command.js";

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

async function send(
  base: string,
  method: "POST" | "PUT",
  path: string,
  body: unknown,
): Promise<JsonResponse> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function writeSkill(workspacePath: string, name: string): Promise<void> {
  const directory = join(workspacePath, ".pi", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${name} skill description.`,
      "---",
      "",
      `Run the ${name} skill.`,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-skill-command-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-skill-command-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-skill-command-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  await writeSkill(workspacePath, "hello");

  const { buildServer } = (await import(resolve(repoRoot, "packages/server/dist/index.js"))) as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };
  const { getSession, disposeAllSessions } = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as {
    getSession: (id: string) => { session: unknown } | undefined;
    disposeAllSessions: () => void;
  };

  const fastify = await buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });
  try {
    const project = await send(base, "POST", "/api/v1/projects", {
      name: "skill-command-test",
      path: workspacePath,
    });
    assert("create project → 201", project.status === 201, JSON.stringify(project.body));
    const projectId = (project.body as { id: string }).id;

    const created = await send(base, "POST", "/api/v1/sessions", { projectId });
    assert("create session → 201", created.status === 201, JSON.stringify(created.body));
    const sessionId = (created.body as { sessionId: string }).sessionId;
    const live = getSession(sessionId);
    if (live === undefined) throw new Error("created session was not registered as live");

    let promptText: string | undefined;
    let promptCalls = 0;
    let reloadCalls = 0;
    const runtimeKeys: string[] = [];
    const fakeSession = {
      model: { provider: "test", id: "test-model" },
      modelRuntime: {
        reloadConfig: async () => {
          reloadCalls += 1;
        },
        setRuntimeApiKey: async (provider: string, apiKey: string) => {
          runtimeKeys.push(`${provider}:${apiKey}`);
        },
        removeRuntimeApiKey: async () => undefined,
        hasConfiguredAuth: () => true,
      },
      resourceLoader: {
        getSkills: () => ({ skills: [{ name: "hello" }] }),
      },
      isStreaming: false,
      prompt: async (text: string): Promise<void> => {
        promptCalls += 1;
        promptText = text;
      },
    };
    (live as unknown as { session: typeof fakeSession }).session = fakeSession;

    const configured = await send(base, "PUT", "/api/v1/config/auth/test", {
      apiKey: "skill-test-key",
    });
    assert("configure test provider credential → 200", configured.status === 200);

    const invoked = await send(base, "POST", `/api/v1/sessions/${sessionId}/skill`, {
      name: "hello",
      instructions: "first second",
    });
    assert(
      "enabled live skill invocation → 202",
      invoked.status === 202,
      JSON.stringify(invoked.body),
    );
    assert(
      "skill prompt runs normal runtime-auth preflight",
      reloadCalls === 1 && runtimeKeys.includes("test:skill-test-key"),
      JSON.stringify({ reloadCalls, runtimeKeys }),
    );
    assert(
      "skill arguments forward through SDK-native slash command",
      promptText === "/skill:hello first second",
      String(promptText),
    );

    promptText = undefined;
    promptCalls = 0;
    fakeSession.isStreaming = true;
    const rejectedStreaming = await send(base, "POST", `/api/v1/sessions/${sessionId}/skill`, {
      name: "hello",
    });
    assert(
      "streaming session skill invocation → 409",
      rejectedStreaming.status === 409,
      JSON.stringify(rejectedStreaming.body),
    );
    assert(
      "streaming session has stable error code",
      (rejectedStreaming.body as { error?: string }).error === "session_streaming",
      JSON.stringify(rejectedStreaming.body),
    );
    assert("streaming session does not call SDK prompt", promptCalls === 0, String(promptCalls));
    fakeSession.isStreaming = false;

    const disabled = await send(
      base,
      "PUT",
      `/api/v1/config/skills/hello/enabled?projectId=${projectId}`,
      { enabled: false },
    );
    assert("disable skill → 200", disabled.status === 200, JSON.stringify(disabled.body));
    const rejectedDisabled = await send(base, "POST", `/api/v1/sessions/${sessionId}/skill`, {
      name: "hello",
    });
    assert(
      "disabled skill → 409",
      rejectedDisabled.status === 409,
      JSON.stringify(rejectedDisabled.body),
    );
    assert(
      "disabled skill has stable error code",
      (rejectedDisabled.body as { error?: string }).error === "skill_not_effective",
      JSON.stringify(rejectedDisabled.body),
    );

    const rejectedUnknown = await send(base, "POST", `/api/v1/sessions/${sessionId}/skill`, {
      name: "missing",
    });
    assert(
      "unknown skill → 404",
      rejectedUnknown.status === 404,
      JSON.stringify(rejectedUnknown.body),
    );
    assert(
      "unknown skill has stable error code",
      (rejectedUnknown.body as { error?: string }).error === "skill_not_found",
      JSON.stringify(rejectedUnknown.body),
    );

    await writeSkill(workspacePath, "added-later");
    const rejectedUnavailable = await send(base, "POST", `/api/v1/sessions/${sessionId}/skill`, {
      name: "added-later",
    });
    assert(
      "skill absent from the live resource loader → 409",
      rejectedUnavailable.status === 409,
      JSON.stringify(rejectedUnavailable.body),
    );
    assert(
      "unavailable live skill has stable error code",
      (rejectedUnavailable.body as { error?: string }).error === "skill_unavailable_in_session",
      JSON.stringify(rejectedUnavailable.body),
    );

    const names = new Set(["hello"]);
    const parsed = parseSkillInvocation("/skill:hello first second", names);
    assert(
      "client parser preserves argument-bearing exact skill invocation",
      parsed?.name === "hello" && parsed.instructions === "first second",
      JSON.stringify(parsed),
    );
    const multiline = parseSkillInvocation("/skill:hello first\nsecond", names);
    assert(
      "client parser preserves multiline skill instructions",
      multiline?.name === "hello" && multiline.instructions === "first\nsecond",
      JSON.stringify(multiline),
    );
    assert(
      "client parser rejects unknown names",
      parseSkillInvocation("/skill:missing arg", names) === undefined,
    );
  } finally {
    disposeAllSessions();
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) process.exitCode = 1;
}

void main();

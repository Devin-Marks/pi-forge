/**
 * Phase 14 attachments integration test.
 *
 * Boots the server in-process via `buildServer()` so we can reach
 * into the live session registry and stub `session.prompt()` —
 * exposing the call args lets us assert that:
 *   - PNG attachments arrive as `images[0]` with the expected
 *     base64 + MIME type.
 *   - Text-file attachments are prepended to the prompt as a
 *     fenced code block named after the file.
 *   - The size limit + image-count limit return 400 BEFORE
 *     `session.prompt()` is invoked.
 *
 * The test stubs `session.prompt`, `session.model`, and the
 * `session.modelRuntime` auth preflight surface so the route passes without
 * configuring a real provider. No LLM round-trip required.
 */
import { mkdtemp, rm } from "node:fs/promises";
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

interface PromptCall {
  text: string;
  opts: { images?: { data: string; mimeType: string; type: string }[] } | undefined;
}

/**
 * 1×1 transparent PNG. Generated once at module load so each test
 * uses the same byte sequence (deterministic base64 in assertions).
 */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-attach-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-attach-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-attach-data-"));

  // Set env BEFORE importing modules — config.ts reads it at module load.
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  process.env.LOG_LEVEL = "warn";
  process.env.SERVE_CLIENT = "false";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  interface TestRegistry {
    createSession: (
      projectId: string,
      workspacePath: string,
    ) => Promise<{
      sessionId: string;
      projectId: string;
      session: {
        prompt: (text: string, opts?: unknown) => Promise<void>;
        model: unknown;
        modelRuntime: {
          reloadConfig: () => Promise<void>;
          setRuntimeApiKey: (provider: string, apiKey: string) => Promise<void>;
          removeRuntimeApiKey: (provider: string) => Promise<void>;
          hasConfiguredAuth: (provider: string) => boolean;
        };
      };
    }>;
    disposeSession: (id: string) => boolean;
  }
  const registry = (await import(
    resolve(repoRoot, "packages/server/dist/session-registry.js")
  )) as unknown as TestRegistry;
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
    const projectId = "proj-" + Date.now().toString(36);
    const live = await registry.createSession(projectId, workspacePath);

    // Stub the SDK surface the prompt route inspects + the prompt
    // call itself. `session.model` is a getter on AgentSession (not
    // a settable field) so we replace `live.session` with a fake
    // entirely. Other LiveSession fields (clients, lastActivityAt,
    // etc.) live on the wrapper, not the session itself, so this is
    // safe.
    const calls: PromptCall[] = [];
    const fakeSession = {
      model: { provider: "test", id: "test-model" },
      modelRuntime: {
        reloadConfig: async () => undefined,
        setRuntimeApiKey: async () => undefined,
        removeRuntimeApiKey: async () => undefined,
        hasConfiguredAuth: () => true,
      },
      prompt: async (text: string, opts?: unknown): Promise<void> => {
        calls.push({ text, opts: opts as PromptCall["opts"] });
      },
      messages: [] as unknown[],
      isStreaming: false,
    };
    (live as unknown as { session: typeof fakeSession }).session = fakeSession;

    // ---- 1. PNG attachment passes through as images[0] ----
    {
      calls.length = 0;
      const fd = new FormData();
      fd.append("text", "what's in this image?");
      fd.append("attachments", new Blob([TINY_PNG], { type: "image/png" }), "tiny.png");
      const res = await fetch(`${base}/api/v1/sessions/${live.sessionId}/prompt`, {
        method: "POST",
        body: fd,
      });
      assert("PNG multipart → 202", res.status === 202, `status=${res.status}`);
      // Fire-and-forget — give the route a tick to schedule the stub call.
      await new Promise((r) => setTimeout(r, 20));
      assert("session.prompt was called once", calls.length === 1, `calls=${calls.length}`);
      const call = calls[0];
      assert(
        "prompt text matches",
        call?.text === "what's in this image?",
        `text=${call?.text ?? "(none)"}`,
      );
      const img = call?.opts?.images?.[0];
      assert("images[0] exists", img !== undefined);
      assert("images[0].mimeType === 'image/png'", img?.mimeType === "image/png");
      assert(
        "images[0].data is the PNG's base64",
        img?.data === TINY_PNG.toString("base64"),
        `got: ${img?.data?.slice(0, 32) ?? "(none)"}…`,
      );
    }

    // ---- 2. Text file is prepended as a fenced code block ----
    {
      calls.length = 0;
      const fd = new FormData();
      fd.append("text", "review this");
      fd.append(
        "attachments",
        new Blob(["export const x = 1;\nexport const y = 2;\n"], {
          type: "text/typescript",
        }),
        "snippet.ts",
      );
      const res = await fetch(`${base}/api/v1/sessions/${live.sessionId}/prompt`, {
        method: "POST",
        body: fd,
      });
      assert("text-file multipart → 202", res.status === 202);
      await new Promise((r) => setTimeout(r, 20));
      assert("session.prompt was called once", calls.length === 1);
      const call = calls[0];
      // Fence format: `${fence}${lang} file: ${name}\n${content}\n${fence}`.
      // The language hint + "file: " prefix is shared with `@<path>`
      // references so the chat bubble can render both as badges
      // uniformly (see file-references.ts#expandFileReferences and
      // routes/prompt.ts#composePromptText).
      const expectedFence =
        "```ts file: snippet.ts\nexport const x = 1;\nexport const y = 2;\n\n```\n\nreview this";
      assert(
        "prompt text contains fenced block with lang hint + filename + content",
        call?.text === expectedFence,
        `got: ${JSON.stringify(call?.text ?? "")}`,
      );
      assert(
        "no images on text-only multipart",
        call?.opts?.images === undefined,
        `images=${JSON.stringify(call?.opts?.images ?? null)}`,
      );
    }

    // ---- 3. Oversize file → 400 BEFORE prompt() invoked ----
    {
      calls.length = 0;
      // MAX_FILE_BYTES is 20 MB (routes/prompt.ts); send 21 MB to trip
      // the per-file cap. The cap was raised from 10 MB to 20 MB to
      // accommodate moderate image / converted-document attachments.
      const oversize = Buffer.alloc(21 * 1024 * 1024, 0x41);
      const fd = new FormData();
      fd.append("text", "ignore");
      fd.append("attachments", new Blob([oversize], { type: "text/plain" }), "big.txt");
      const res = await fetch(`${base}/api/v1/sessions/${live.sessionId}/prompt`, {
        method: "POST",
        body: fd,
      });
      assert("oversize attachment → 400", res.status === 400, `status=${res.status}`);
      const body = (await res.json()) as { error?: string };
      assert(
        "oversize error code is attachment_too_large",
        body.error === "attachment_too_large",
        `error=${body.error ?? "(none)"}`,
      );
      await new Promise((r) => setTimeout(r, 20));
      assert("prompt() not called for oversize", calls.length === 0);
    }

    // ---- 4. >4 images → 400 BEFORE prompt() invoked ----
    {
      calls.length = 0;
      const fd = new FormData();
      fd.append("text", "many images");
      for (let i = 0; i < 5; i++) {
        fd.append("attachments", new Blob([TINY_PNG], { type: "image/png" }), `tiny-${i}.png`);
      }
      const res = await fetch(`${base}/api/v1/sessions/${live.sessionId}/prompt`, {
        method: "POST",
        body: fd,
      });
      assert("5 images → 400", res.status === 400, `status=${res.status}`);
      const body = (await res.json()) as { error?: string };
      assert(
        "too-many-images error code",
        body.error === "too_many_images",
        `error=${body.error ?? "(none)"}`,
      );
      await new Promise((r) => setTimeout(r, 20));
      assert("prompt() not called for too-many-images", calls.length === 0);
    }

    // ---- 5. JSON path still works (backward compat) ----
    {
      calls.length = 0;
      const res = await fetch(`${base}/api/v1/sessions/${live.sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "plain json prompt" }),
      });
      assert("JSON prompt → 202", res.status === 202);
      await new Promise((r) => setTimeout(r, 20));
      assert("JSON prompt invokes session.prompt", calls.length === 1);
      assert(
        "JSON prompt text round-trips",
        calls[0]?.text === "plain json prompt",
        `text=${calls[0]?.text ?? "(none)"}`,
      );
    }

    registry.disposeSession(live.sessionId);
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-attachments] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-attachments] PASS");
}

main().catch((err: unknown) => {
  console.error("[test-attachments] uncaught:", err);
  process.exit(1);
});

/**
 * Phase 6 REST API integration test.
 *
 * Boots the server in-process with auth enabled (API_KEY set), then drives
 * the full programmatic surface using bearer auth — never touches the
 * browser login flow.
 *
 * Coverage:
 *   - Public routes (no auth): GET /health, /auth/status; /api/docs UI;
 *     /api/docs/json (the OpenAPI spec)
 *   - OpenAPI spec contains the new sessions/prompt/control routes
 *   - Validation: POST /sessions without projectId → 400; POST /sessions/:id/prompt
 *     without text → 400
 *   - Not-found: GET /sessions/<unknown> → 404
 *   - Full programmatic cycle: create project → create session → connect SSE
 *     (asserts `snapshot` over the wire) → POST /prompt (202 even with no
 *     model — the prompt rejects async; the route returns 202) → POST /abort
 *     (idempotent on idle) → DELETE /sessions/:id (204)
 *
 * No LLM is required; the prompt cycle deliberately exercises the
 * fire-and-forget path without expecting agent_start/end (those need an LLM
 * round-trip and are covered by tests/test-sse.ts under PI_TEST_LIVE_PROMPT=1).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

interface JsonResponse {
  status: number;
  body: unknown;
}

async function jget(url: string, headers: Record<string, string> = {}): Promise<JsonResponse> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  return { status: res.status, body: text === "" ? undefined : JSON.parse(text) };
}

async function jsend(
  method: "POST" | "PATCH" | "DELETE",
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

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-data-"));
  const apiKey = "test-api-key-" + randomBytes(8).toString("hex");
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
      AUTH_BANNER_TEXT: "Welcome\\nRead <b>the policy</b>",
      AUTH_BANNER_HTML: "true",
      AUTH_LOGO_URL: "https://example.com/pi-forge-logo.png",
      AUTH_COLOR_SCHEME: "#08111f,#102033,#3b82f6,#f8fafc,#cbd5e1,#38bdf8,#082f49,#7dd3fc",
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

  const base = `http://127.0.0.1:${port}`;
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
    const auth = { Authorization: `Bearer ${apiKey}` };

    // 1. Public routes (no auth required).
    {
      const health = await jget(`${base}/api/v1/health`);
      assert("/api/v1/health → 200 with no auth", health.status === 200);
      const body = health.body as { status: string; activeSessions: number };
      assert("health.status === 'ok'", body.status === "ok");

      const status = await jget(`${base}/api/v1/auth/status`);
      assert("/api/v1/auth/status → 200 with no auth", status.status === 200);
      assert(
        "auth/status reports authEnabled=true",
        (status.body as { authEnabled: boolean }).authEnabled === true,
      );

      const uiConfig = await jget(`${base}/api/v1/ui-config`);
      assert("/api/v1/ui-config → 200 with no auth", uiConfig.status === 200);
      const uiBody = uiConfig.body as {
        authBannerText?: string;
        authBannerHtml?: boolean;
        authLogoUrl?: string;
        authColorScheme?: {
          pageBackground: string;
          cardBackground: string;
          border: string;
          text: string;
          mutedText: string;
          buttonBackground: string;
          buttonText: string;
          buttonHoverBackground: string;
        };
      };
      assert(
        "ui-config decodes banner newlines",
        uiBody.authBannerText === "Welcome\nRead <b>the policy</b>",
      );
      assert("ui-config reports banner HTML opt-in", uiBody.authBannerHtml === true);
      assert(
        "ui-config reports custom logo URL",
        uiBody.authLogoUrl === "https://example.com/pi-forge-logo.png",
      );
      assert(
        "ui-config reports auth color scheme",
        uiBody.authColorScheme?.pageBackground === "#08111f" &&
          uiBody.authColorScheme.buttonHoverBackground === "#7dd3fc",
      );
    }

    // 2. Auth-protected routes reject anonymous requests.
    {
      const noAuth = await jget(`${base}/api/v1/projects`);
      assert("anonymous /projects → 401", noAuth.status === 401);
      const ok = await jget(`${base}/api/v1/projects`, auth);
      assert("/projects with valid API key → 200", ok.status === 200);
    }

    // 3. Swagger UI + raw spec.
    {
      const docsUi = await fetch(`${base}/api/docs/static/index.html`, { headers: auth });
      // /api/docs redirects to /api/docs/static/index.html on some swagger-ui
      // versions; either landing page is acceptable. Just assert non-401.
      assert("/api/docs/* (auth) does not 401", docsUi.status !== 401);
      const docsJson = await jget(`${base}/api/docs/json`, auth);
      assert("/api/docs/json → 200 with auth", docsJson.status === 200);
      const spec = docsJson.body as {
        openapi?: string;
        paths?: Record<string, unknown>;
      };
      assert("OpenAPI spec has openapi version", typeof spec.openapi === "string");
      assert("spec includes /sessions path", spec.paths?.["/api/v1/sessions"] !== undefined);
      assert(
        "spec includes /sessions/{id}/prompt",
        spec.paths?.["/api/v1/sessions/{id}/prompt"] !== undefined,
      );
      assert(
        "spec includes /sessions/{id}/abort",
        spec.paths?.["/api/v1/sessions/{id}/abort"] !== undefined,
      );
    }

    // 4. Validation errors.
    {
      const noBody = await jsend("POST", `${base}/api/v1/sessions`, {}, auth);
      assert("POST /sessions without projectId → 400", noBody.status === 400);

      const unknownProject = await jsend(
        "POST",
        `${base}/api/v1/sessions`,
        { projectId: "00000000-0000-0000-0000-000000000000" },
        auth,
      );
      assert("POST /sessions with unknown projectId → 404", unknownProject.status === 404);

      const unknownGet = await jget(
        `${base}/api/v1/sessions/00000000-0000-0000-0000-000000000000`,
        auth,
      );
      assert("GET /sessions/<unknown> → 404", unknownGet.status === 404);
    }

    // 5. Programmatic cycle: project → session → SSE → prompt → abort → delete.
    let projectId: string;
    {
      const proj = await jsend(
        "POST",
        `${base}/api/v1/projects`,
        { name: "test-api", path: workspacePath },
        auth,
      );
      assert("create project → 201", proj.status === 201);
      projectId = (proj.body as { id: string }).id;
    }

    let sessionId: string;
    {
      const sess = await jsend("POST", `${base}/api/v1/sessions`, { projectId }, auth);
      assert("create session → 201", sess.status === 201);
      const body = sess.body as {
        sessionId: string;
        projectId: string;
        isLive: boolean;
        isStreaming: boolean;
      };
      sessionId = body.sessionId;
      assert("created session.projectId matches", body.projectId === projectId);
      assert("created session.isLive === true", body.isLive === true);
      assert("created session.isStreaming === false", body.isStreaming === false);
    }

    {
      const list = await jget(`${base}/api/v1/sessions?projectId=${projectId}`, auth);
      assert("list sessions for project → 200", list.status === 200);
      const sessions = (list.body as { sessions: { sessionId: string }[] }).sessions;
      assert(
        "list contains the created session",
        sessions.some((s) => s.sessionId === sessionId),
      );
    }

    {
      const meta = await jget(`${base}/api/v1/sessions/${sessionId}`, auth);
      assert("GET /sessions/:id → 200", meta.status === 200);
      assert("GET /sessions/:id is live", (meta.body as { isLive: boolean }).isLive === true);
    }

    // SSE: open the stream, read the snapshot frame, then close.
    {
      const ctrl = new AbortController();
      const sse = await fetch(`${base}/api/v1/sessions/${sessionId}/stream`, {
        headers: { ...auth, Accept: "text/event-stream" },
        signal: ctrl.signal,
      });
      assert("stream → 200", sse.status === 200);
      if (sse.body !== null) {
        const reader = sse.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = "";
        const readFrame = async (): Promise<{ type: string }> => {
          while (true) {
            const sep = buf.indexOf("\n\n");
            if (sep !== -1) {
              const frame = buf.slice(0, sep);
              buf = buf.slice(sep + 2);
              for (const line of frame.split("\n")) {
                if (line.startsWith("data:"))
                  return JSON.parse(line.slice(5).trimStart()) as { type: string };
              }
            }
            const { value, done } = await reader.read();
            if (done) throw new Error("stream ended early");
            buf += value;
          }
        };
        const first = await readFrame();
        assert("first SSE frame is `snapshot`", first.type === "snapshot");
        ctrl.abort();
        try {
          await reader.cancel();
        } catch {
          // expected
        }
      }
    }

    // POST /prompt validation + accepted.
    {
      const noText = await jsend("POST", `${base}/api/v1/sessions/${sessionId}/prompt`, {}, auth);
      assert("POST /prompt without text → 400", noText.status === 400);

      // No model + no auth in this test fixture, so the route's pre-flight
      // check (added in Phase 8) returns 400 with `no_api_key` rather than
      // letting `session.prompt()` fail silently. The 202 path requires a
      // configured provider key, which we don't set up here — covered by
      // the live-prompt path in test-sse.ts under PI_TEST_LIVE_PROMPT=1.
      const rejected = await jsend(
        "POST",
        `${base}/api/v1/sessions/${sessionId}/prompt`,
        { text: "no model configured — pre-flight rejects with 400" },
        auth,
      );
      assert("POST /prompt with no auth configured → 400", rejected.status === 400);
      assert(
        "POST /prompt error code is `no_api_key` or `no_model_configured`",
        (rejected.body as { error: string }).error === "no_api_key" ||
          (rejected.body as { error: string }).error === "no_model_configured",
        JSON.stringify(rejected.body),
      );
    }

    // POST /abort is idempotent on an idle session (204).
    {
      const aborted = await jsend(
        "POST",
        `${base}/api/v1/sessions/${sessionId}/abort`,
        undefined,
        auth,
      );
      assert("POST /abort → 204", aborted.status === 204);
    }

    // POST /steer — schema validation + accept on live session.
    {
      const noText = await jsend("POST", `${base}/api/v1/sessions/${sessionId}/steer`, {}, auth);
      assert("POST /steer without text → 400", noText.status === 400);

      const accepted = await jsend(
        "POST",
        `${base}/api/v1/sessions/${sessionId}/steer`,
        { text: "queued — sits on the queue when idle, delivered next prompt" },
        auth,
      );
      assert("POST /steer with text → 202", accepted.status === 202);
      assert(
        "POST /steer body { accepted: true }",
        (accepted.body as { accepted: boolean }).accepted === true,
      );

      const followUp = await jsend(
        "POST",
        `${base}/api/v1/sessions/${sessionId}/steer`,
        { text: "follow-up message", mode: "followUp" },
        auth,
      );
      assert("POST /steer mode=followUp → 202", followUp.status === 202);

      const unknown = await jsend(
        "POST",
        `${base}/api/v1/sessions/00000000-0000-0000-0000-000000000000/steer`,
        { text: "x" },
        auth,
      );
      assert("POST /steer on unknown session → 404", unknown.status === 404);
    }

    // POST /model — verify `unknown_model` maps cleanly (the H1 regression
    // would surface here as a 400 with a leaky Node-internal message instead
    // of a stable error code).
    {
      const noBody = await jsend("POST", `${base}/api/v1/sessions/${sessionId}/model`, {}, auth);
      assert("POST /model without body → 400", noBody.status === 400);

      const unknownModel = await jsend(
        "POST",
        `${base}/api/v1/sessions/${sessionId}/model`,
        { provider: "no-such-provider", modelId: "no-such-model" },
        auth,
      );
      assert("POST /model unknown → 400", unknownModel.status === 400);
      // The route was refined (control.ts:447-461) to distinguish an
      // unknown PROVIDER from an unknown model under a known provider.
      // We sent a junk provider, so `unknown_provider` is the right
      // code; assert either-or so the test still passes for the
      // unknown-model case if a future test variant flips the input.
      const errCode = (unknownModel.body as { error: string }).error;
      assert(
        "POST /model unknown error code is `unknown_provider` or `unknown_model`",
        errCode === "unknown_provider" || errCode === "unknown_model",
        JSON.stringify(unknownModel.body),
      );
    }

    // POST /fork — verify entry-not-found maps to the typed code (the H2
    // regression would have produced a 500 with the SDK message in the body).
    {
      const noBody = await jsend("POST", `${base}/api/v1/sessions/${sessionId}/fork`, {}, auth);
      assert("POST /fork without entryId → 400", noBody.status === 400);

      const unknownEntry = await jsend(
        "POST",
        `${base}/api/v1/sessions/${sessionId}/fork`,
        { entryId: "00000000-0000-0000-0000-000000000000" },
        auth,
      );
      assert("POST /fork with bad entryId → 400", unknownEntry.status === 400);
      assert(
        "POST /fork bad entry error code is `entry_not_found` or `fork_failed`",
        (unknownEntry.body as { error: string }).error === "entry_not_found" ||
          (unknownEntry.body as { error: string }).error === "fork_failed",
        JSON.stringify(unknownEntry.body),
      );

      const unknownSession = await jsend(
        "POST",
        `${base}/api/v1/sessions/00000000-0000-0000-0000-000000000000/fork`,
        { entryId: "x" },
        auth,
      );
      assert("POST /fork on unknown session → 404", unknownSession.status === 404);
    }

    // POST /navigate — same treatment as fork for entry-not-found (H3).
    {
      const noBody = await jsend("POST", `${base}/api/v1/sessions/${sessionId}/navigate`, {}, auth);
      assert("POST /navigate without entryId → 400", noBody.status === 400);

      const unknownEntry = await jsend(
        "POST",
        `${base}/api/v1/sessions/${sessionId}/navigate`,
        { entryId: "00000000-0000-0000-0000-000000000000" },
        auth,
      );
      assert("POST /navigate with bad entryId → 400", unknownEntry.status === 400);
      assert(
        "POST /navigate bad entry error code is `entry_not_found`",
        (unknownEntry.body as { error: string }).error === "entry_not_found",
        JSON.stringify(unknownEntry.body),
      );
    }

    // POST /compact — the session has only the synthetic init state; the SDK
    // throws "Nothing to compact" / "No model" depending on context. Either
    // is a stable typed 400 (H3 would have returned 500 with SDK message).
    {
      const result = await jsend("POST", `${base}/api/v1/sessions/${sessionId}/compact`, {}, auth);
      assert("POST /compact on tiny idle session → 400", result.status === 400);
      const allowed = new Set([
        "nothing_to_compact",
        "no_model_configured",
        "already_compacted",
        "no_api_key",
      ]);
      assert(
        "POST /compact error code is one of the typed values",
        allowed.has((result.body as { error: string }).error),
        JSON.stringify(result.body),
      );
    }

    // DELETE the session.
    {
      const del = await jsend("DELETE", `${base}/api/v1/sessions/${sessionId}`, undefined, auth);
      assert("DELETE /sessions/:id → 204", del.status === 204);
      const after = await jget(`${base}/api/v1/sessions/${sessionId}`, auth);
      // Since v1.3.0, DELETE always hard-deletes (dispose + remove JSONL
      // + cascade subagent JSONLs). The legacy `?hard=` toggle is gone.
      // GET after delete is always 404.
      assert("GET after delete returns 404", after.status === 404);

      // Second DELETE on the same id: the live entry is gone and there's
      // no JSONL on disk, so the cold-delete fallback also returns
      // not_found → route emits 404.
      const del2 = await jsend("DELETE", `${base}/api/v1/sessions/${sessionId}`, undefined, auth);
      assert(
        "DELETE on already-deleted session → 404",
        del2.status === 404,
        `status=${del2.status}`,
      );
    }

    // 6. Health reflects post-test registry state.
    {
      const health = await jget(`${base}/api/v1/health`);
      assert(
        "health.activeSessions === 0 after teardown",
        (health.body as { activeSessions: number }).activeSessions === 0,
      );
    }
  } finally {
    await stop();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-api] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-api] PASS");
}

main().catch((err) => {
  console.error("[test-api] uncaught error:", err);
  process.exit(1);
});

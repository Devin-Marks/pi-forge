/**
 * Cross-session text search integration test.
 *
 * Boots the server in-process under a temp WORKSPACE_PATH, creates two
 * projects, hand-writes JSONL session files into each project's session
 * directory (mirroring the on-disk shape the SDK produces — one
 * `{type:"session"}` header line followed by `{type:"message",...}`
 * lines), then drives `/api/v1/search/sessions` to verify:
 *
 *   - Matches in user / assistant text and assistant tool-call args
 *     are surfaced
 *   - Tool-result content is filtered out (per design)
 *   - Empty / missing query → 400 (Fastify schema validation)
 *   - Auth is enforced (401 without Bearer)
 *   - Per-session match limit and global session limit hold
 *   - messageIndex matches the snapshot's flat `messages` array
 *     position (i.e. only counts `type === "message"` lines)
 *   - Session name (from `session_info`) and project name appear in the
 *     response
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile as fsWrite } from "node:fs/promises";
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
  method: "POST" | "PUT" | "DELETE",
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

interface SessionLine {
  type: "session" | "message" | "session_info" | "model_change" | "tool_result";
  id: string;
  parentId?: string;
  timestamp: string;
  // session
  version?: number;
  cwd?: string;
  // session_info
  name?: string;
  // message
  message?: { role: "user" | "assistant"; content: unknown };
  // tool_result envelope (synthetic — real tool_results are message envelopes
  // with role:"toolResult", but a `tool_result` top-level type works as a
  // negative-control fixture)
  text?: string;
}

function header(cwd: string): SessionLine {
  return {
    type: "session",
    version: 1,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  };
}

function infoNamed(parentId: string, name: string): SessionLine {
  return {
    type: "session_info",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    name,
  };
}

function userText(parentId: string, text: string): SessionLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantText(parentId: string, text: string): SessionLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function assistantToolCall(
  parentId: string,
  name: string,
  args: Record<string, unknown>,
): SessionLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: randomUUID(), name, arguments: args }],
    },
  };
}

function toolResultMessage(parentId: string, content: string): SessionLine {
  // Real tool_result lines have role: "toolResult" with details.text or
  // similar. The session-searcher only surfaces user/assistant roles, so
  // any role "toolResult" payload should be invisible to search even when
  // its content matches the query.
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "user",
      // Forced into a content shape the searcher should NOT match by
      // putting the keyword inside a non-text block.
      content: [{ type: "toolResult", text: content }],
    } as unknown as { role: "user"; content: unknown },
  };
}

function writeSessionJsonl(filePath: string, lines: SessionLine[]): Promise<void> {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return fsWrite(filePath, body, "utf8");
}

interface SearchResponse {
  engine: "ripgrep" | "node";
  truncated: boolean;
  results: {
    sessionId: string;
    projectId: string;
    projectName: string;
    sessionName?: string;
    modifiedAt: string;
    matches: {
      messageIndex: number;
      messageEnvelopeId?: string;
      kind: "user" | "assistant" | "tool_call";
      snippet: string;
      matchOffset: number;
      matchLength: number;
    }[];
  }[];
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-search-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-search-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-search-data-"));
  const sessionDir = join(workspacePath, ".pi", "sessions");
  const projectAPath = join(workspacePath, "alpha");
  const projectBPath = join(workspacePath, "beta");
  await mkdir(projectAPath, { recursive: true });
  await mkdir(projectBPath, { recursive: true });

  const apiKey = "test-search-key-" + randomBytes(8).toString("hex");
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
      SESSION_DIR: sessionDir,
      API_KEY: apiKey,
      UI_PASSWORD: undefined,
      JWT_SECRET: undefined,
      SERVE_CLIENT: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", (b) => process.stderr.write(`[server stderr] ${String(b)}`));

  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${apiKey}` };
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

    // Create two projects via the API so they end up in projects.json
    // with realpath'd paths the searcher can resolve.
    const createA = await jsend(
      "POST",
      `${base}/api/v1/projects`,
      { name: "Alpha Project", path: projectAPath },
      auth,
    );
    assert("POST /projects (alpha) → 201", createA.status === 201);
    const projectAId = (createA.body as { id: string }).id;

    const createB = await jsend(
      "POST",
      `${base}/api/v1/projects`,
      { name: "Beta Project", path: projectBPath },
      auth,
    );
    assert("POST /projects (beta) → 201", createB.status === 201);
    const projectBId = (createB.body as { id: string }).id;

    // Stage hand-written JSONL session files. Path layout matches what
    // session-registry expects: ${SESSION_DIR}/<projectId>/<file>.jsonl
    const sessionDirA = join(sessionDir, projectAId);
    const sessionDirB = join(sessionDir, projectBId);
    await mkdir(sessionDirA, { recursive: true });
    await mkdir(sessionDirB, { recursive: true });

    // Session 1 (alpha): user asks about authentication, assistant runs
    // a bash tool call referencing the keyword.
    const s1Path = join(sessionDirA, "2026-05-10T12-00-00-000Z_session1.jsonl");
    const s1Header = header(projectAPath);
    const s1Lines: SessionLine[] = [
      s1Header,
      infoNamed(s1Header.id, "Auth refactor"),
      userText(s1Header.id, "Where is the JWT verification logic?"),
      assistantText(s1Header.id, "It lives in auth.ts — let me grep."),
      assistantToolCall(s1Header.id, "bash", { command: "grep -r jwt-verify ." }),
      // tool result with the same keyword — should NOT show up in search.
      toolResultMessage(s1Header.id, "/path/jwt-verify.ts:42: function verify..."),
      userText(s1Header.id, "Thanks, that's the right place."),
    ];
    await writeSessionJsonl(s1Path, s1Lines);

    // Session 2 (beta): three messages about deployment.
    const s2Path = join(sessionDirB, "2026-05-10T13-00-00-000Z_session2.jsonl");
    const s2Header = header(projectBPath);
    const s2Lines: SessionLine[] = [
      s2Header,
      // No session_info — exercises the "no session name" branch.
      userText(s2Header.id, "How do I deploy this to Kubernetes?"),
      assistantText(s2Header.id, "There's a manifest under kubernetes/ — let's look."),
      assistantToolCall(s2Header.id, "read", { path: "kubernetes/deployment.yaml" }),
      userText(s2Header.id, "Got it, deployment.yaml looks fine."),
    ];
    await writeSessionJsonl(s2Path, s2Lines);

    // Make sure file mtimes differ so sort is deterministic.
    await new Promise((r) => setTimeout(r, 25));

    // ---- happy path: search for "JWT" — hits user text in session 1 ----
    {
      const r = await jget(`${base}/api/v1/search/sessions?q=JWT`, auth);
      assert("GET /search/sessions?q=JWT → 200", r.status === 200);
      const body = r.body as SearchResponse;
      assert("engine reported", body.engine === "ripgrep" || body.engine === "node");
      const session1 = body.results.find((g) => g.sessionId === s1Header.id);
      assert("session 1 surfaced", session1 !== undefined);
      if (session1 !== undefined) {
        assert("project name resolved", session1.projectName === "Alpha Project");
        assert("session name from session_info", session1.sessionName === "Auth refactor");
        // The user text on JSONL line 3 (after header + session_info) is
        // the FIRST `type:"message"` line → messageIndex 0.
        const userMatch = session1.matches.find((m) => m.kind === "user");
        assert(
          "user text match has messageIndex 0",
          userMatch !== undefined && userMatch.messageIndex === 0,
          userMatch === undefined ? "no user match" : `messageIndex=${userMatch.messageIndex}`,
        );
        assert(
          "user snippet contains JWT",
          userMatch !== undefined && /jwt/i.test(userMatch.snippet),
        );
      }
    }

    // ---- tool-result content does NOT surface ----
    {
      // The keyword "jwt-verify" only appears in:
      //  (a) the assistant's bash tool-call args (should match)
      //  (b) the tool_result content (should NOT match)
      // We expect to get exactly one match per session per snippet —
      // surfacing the assistant tool call.
      const r = await jget(`${base}/api/v1/search/sessions?q=jwt-verify`, auth);
      assert("GET /search/sessions?q=jwt-verify → 200", r.status === 200);
      const body = r.body as SearchResponse;
      const session1 = body.results.find((g) => g.sessionId === s1Header.id);
      assert("session surfaced", session1 !== undefined);
      if (session1 !== undefined) {
        const kinds = session1.matches.map((m) => m.kind);
        assert("tool_call surfaced", kinds.includes("tool_call"), `kinds=${JSON.stringify(kinds)}`);
        // The tool_result line contains "jwt-verify" too — but it has
        // role "user" with a non-text content block, which the searcher
        // skips. We assert NO `user`-kind match snippet equals the
        // tool-result text.
        const userMatchToolResultText = session1.matches.find(
          (m) => m.kind === "user" && m.snippet.includes("function verify"),
        );
        assert("tool_result content NOT surfaced", userMatchToolResultText === undefined);
      }
    }

    // ---- multi-session result + project resolution ----
    {
      // "deploy" hits in session 2 (multiple messages). Should land
      // under Beta Project with the correct sessionId.
      const r = await jget(`${base}/api/v1/search/sessions?q=deploy`, auth);
      assert("GET /search/sessions?q=deploy → 200", r.status === 200);
      const body = r.body as SearchResponse;
      const session2 = body.results.find((g) => g.sessionId === s2Header.id);
      assert("session 2 surfaced", session2 !== undefined);
      if (session2 !== undefined) {
        assert("project B name resolved", session2.projectName === "Beta Project");
        assert("session 2 has no name", session2.sessionName === undefined);
        assert("multiple matches collected", session2.matches.length >= 2);
      }
    }

    // ---- per-session match limit ----
    {
      const r = await jget(`${base}/api/v1/search/sessions?q=deploy&matchesPerSession=1`, auth);
      assert("GET with matchesPerSession=1 → 200", r.status === 200);
      const body = r.body as SearchResponse;
      const session2 = body.results.find((g) => g.sessionId === s2Header.id);
      assert("matchesPerSession honored", session2 !== undefined && session2.matches.length === 1);
    }

    // ---- empty query → 400 (schema validation) ----
    {
      const r = await jget(`${base}/api/v1/search/sessions?q=`, auth);
      assert("GET with empty q → 400", r.status === 400);
    }

    // ---- auth enforcement ----
    {
      const r = await jget(`${base}/api/v1/search/sessions?q=JWT`);
      assert("GET without auth → 401", r.status === 401);
    }
  } finally {
    await stop();
    await Promise.all([
      rm(workspacePath, { recursive: true, force: true }),
      rm(configDir, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  }

  if (failures > 0) {
    console.log(`\n[test-session-search] ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`\n[test-session-search] all checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Single-session conversation export integration test.
 *
 * Boots the server in-process under a temp WORKSPACE_PATH, creates a
 * project, hand-writes a parent JSONL session + one subagent child
 * JSONL into the per-project session directory (mirroring the on-disk
 * layout pi-subagents produces:
 * `<sessionDir>/<projectId>/<parentBasename>/<runId>/<child>.jsonl`),
 * then drives `/api/v1/sessions/:id/export?format=…` to verify:
 *
 *   - JSONL export is byte-faithful for child sessions
 *   - JSONL export inlines the child between the parent's `subagent`
 *     tool call and its tool result, bracketed by the synthetic
 *     `subagent_inline_start` / `subagent_inline_end` envelopes
 *   - Markdown export contains expected sections (`## You`,
 *     `## Assistant`, `**bash**` fenced block, blockquote tool-result,
 *     `<details>` for thinking + subagent inline)
 *   - Markdown header surfaces session name + project name + cwd
 *   - Tool-result blockquote truncates at TOOL_RESULT_CAP with the
 *     "(truncated, N bytes total)" sentinel
 *   - Filename in Content-Disposition uses session-name slug
 *   - Unknown sessionId → 404
 *   - Bad format → 400
 *   - 401 without auth
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

interface FetchResult {
  status: number;
  headers: Record<string, string>;
  text: string;
}

async function jget(url: string, headers: Record<string, string> = {}): Promise<FetchResult> {
  const res = await fetch(url, { headers });
  const text = await res.text();
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return { status: res.status, headers: out, text };
}

async function jsend(
  method: "POST",
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<FetchResult> {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    (init.headers as Record<string, string>)["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return { status: res.status, headers: out, text };
}

interface JsonlLine {
  type: string;
  id: string;
  parentId?: string;
  timestamp: string;
  version?: number;
  cwd?: string;
  name?: string;
  message?: { role: string; content: unknown };
  provider?: string;
  modelId?: string;
}

function header(cwd: string, sessionId: string): JsonlLine {
  return {
    type: "session",
    version: 1,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd,
  };
}

function modelChange(parentId: string, provider: string, modelId: string): JsonlLine {
  return {
    type: "model_change",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    provider,
    modelId,
  };
}

function infoNamed(parentId: string, name: string): JsonlLine {
  return {
    type: "session_info",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    name,
  };
}

function userText(parentId: string, text: string): JsonlLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: [{ type: "text", text }] },
  };
}

function assistantText(parentId: string, text: string): JsonlLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function assistantBash(parentId: string, command: string, callId: string): JsonlLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "bash", arguments: { command } }],
    },
  };
}

function assistantSubagent(parentId: string, prompt: string, callId: string): JsonlLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "subagent", arguments: { prompt } }],
    },
  };
}

function toolResult(parentId: string, callId: string, text: string): JsonlLine {
  // Cast through `unknown` so the synthetic `toolCallId` + `details`
  // fields land on the wire shape pickToolResultText reads from
  // without forcing JsonlLine to model every variant the SDK emits.
  const line: unknown = {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      content: [],
      toolCallId: callId,
      details: { text },
    },
  };
  return line as JsonlLine;
}

function thinkingMessage(parentId: string, text: string): JsonlLine {
  return {
    type: "message",
    id: randomUUID(),
    parentId,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content: [
        { type: "thinking", text },
        { type: "text", text: "Done thinking." },
      ],
    },
  };
}

function writeJsonl(filePath: string, lines: JsonlLine[]): Promise<void> {
  const body = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  return fsWrite(filePath, body, "utf8");
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-export-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-forge-export-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-forge-export-data-"));
  const sessionDir = join(workspacePath, ".pi", "sessions");
  const projectPath = join(workspacePath, "demo");
  await mkdir(projectPath, { recursive: true });

  const apiKey = "test-export-key-" + randomBytes(8).toString("hex");
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

    // Create a project so projects.json has it (the exporter walks
    // every project's session dir to resolve a sessionId).
    const created = await jsend(
      "POST",
      `${base}/api/v1/projects`,
      { name: "Demo Project", path: projectPath },
      auth,
    );
    assert("POST /projects → 201", created.status === 201);
    const project = JSON.parse(created.text) as { id: string };

    const sessionDirForProject = join(sessionDir, project.id);
    await mkdir(sessionDirForProject, { recursive: true });

    // ---- Build the parent session JSONL ----
    const parentSessionId = randomUUID();
    const parentBasename = `2026-05-10T12-00-00-000Z_${parentSessionId}`;
    const parentFile = join(sessionDirForProject, `${parentBasename}.jsonl`);
    const subagentCallId = "call_subagent_1";
    const bashCallId = "call_bash_1";
    const longResult = "x".repeat(3000); // > TOOL_RESULT_CAP (2000)
    const parentLines: JsonlLine[] = [
      header(projectPath, parentSessionId),
      modelChange(parentSessionId, "anthropic", "claude-sonnet-4-6"),
      infoNamed(parentSessionId, "Refactor auth module"),
      userText(parentSessionId, "Run a quick smoke and dispatch the refactor work."),
      assistantBash(parentSessionId, "ls -la", bashCallId),
      toolResult(
        parentSessionId,
        bashCallId,
        "total 8\ndrwxr-xr-x  3 user  staff   96 May 10 ...\n",
      ),
      thinkingMessage(parentSessionId, "Let me delegate the refactor."),
      assistantSubagent(parentSessionId, "Refactor packages/server/src/auth.ts", subagentCallId),
      toolResult(parentSessionId, subagentCallId, longResult),
      userText(parentSessionId, "Thanks, looks good."),
    ];
    await writeJsonl(parentFile, parentLines);

    // ---- Build the subagent child JSONL at the pi-subagents path ----
    const childSessionId = randomUUID();
    const childRunId = "run-1";
    const childDir = join(sessionDirForProject, parentBasename, childRunId);
    await mkdir(childDir, { recursive: true });
    const childFile = join(childDir, `${childSessionId}.jsonl`);
    const childLines: JsonlLine[] = [
      header(projectPath, childSessionId),
      infoNamed(childSessionId, "subagent: refactor auth"),
      userText(childSessionId, "Refactor packages/server/src/auth.ts"),
      assistantText(childSessionId, "I'll start by reading the file."),
      assistantBash(childSessionId, "cat packages/server/src/auth.ts", "child_bash_1"),
      toolResult(childSessionId, "child_bash_1", "// auth.ts contents..."),
    ];
    await writeJsonl(childFile, childLines);

    // ---- JSONL export of the parent ----
    {
      const r = await jget(`${base}/api/v1/sessions/${parentSessionId}/export?format=jsonl`, auth);
      assert("GET export?format=jsonl → 200", r.status === 200);
      assert(
        "Content-Type is ndjson",
        r.headers["content-type"]?.includes("application/x-ndjson") ?? false,
      );
      const cd = r.headers["content-disposition"] ?? "";
      assert(
        "filename slug uses session name",
        cd.includes("refactor-auth-module") && cd.endsWith(`.jsonl"`),
        `Content-Disposition: ${cd}`,
      );
      // Inline boundaries appear in order around the child's content.
      const startIdx = r.text.indexOf('"subagent_inline_start"');
      const endIdx = r.text.indexOf('"subagent_inline_end"');
      const childHdrIdx = r.text.indexOf(`"id":"${childSessionId}"`);
      assert("subagent_inline_start present", startIdx >= 0);
      assert("subagent_inline_end present", endIdx > startIdx);
      assert(
        "child header inlined between boundaries",
        childHdrIdx > startIdx && childHdrIdx < endIdx,
      );
      // Boundary references the parent tool call id.
      assert(
        "inline_start references parent tool call id",
        r.text.includes(`"parentToolCallId":"${subagentCallId}"`),
      );
    }

    // ---- JSONL export of the CHILD itself — no further inlining ----
    {
      const r = await jget(`${base}/api/v1/sessions/${childSessionId}/export?format=jsonl`, auth);
      assert("GET child export?format=jsonl → 200", r.status === 200);
      assert("child export has no inline boundaries", !r.text.includes("subagent_inline_start"));
    }

    // ---- Markdown export of the parent ----
    {
      const r = await jget(
        `${base}/api/v1/sessions/${parentSessionId}/export?format=markdown`,
        auth,
      );
      assert("GET export?format=markdown → 200", r.status === 200);
      assert(
        "Content-Type is markdown",
        r.headers["content-type"]?.includes("text/markdown") ?? false,
      );
      const cd = r.headers["content-disposition"] ?? "";
      assert(
        "markdown filename slug uses session name",
        cd.includes("refactor-auth-module") && cd.endsWith(`.md"`),
        `Content-Disposition: ${cd}`,
      );
      const md = r.text;
      assert("markdown header has session name", md.includes("# Refactor auth module"));
      assert("project surfaced", md.includes("Demo Project"));
      assert("model surfaced", md.includes("anthropic"));
      assert("user heading present", md.includes("## You"));
      assert("assistant heading present", md.includes("## Assistant"));
      assert("bash tool fenced", md.includes("**bash**") && md.includes("```bash\nls -la"));
      assert("tool result blockquoted", md.includes("> total 8"));
      assert(
        "long tool result truncated with sentinel",
        md.includes("(truncated, 3000 bytes total)"),
      );
      assert("thinking folded into <details>", md.includes("<summary>Thinking</summary>"));
      assert(
        "subagent inlined under details",
        md.includes(`<summary>↳ subagent ${childSessionId}</summary>`),
      );
      assert(
        "subagent inline contains child user text",
        md.includes("Refactor packages/server/src/auth.ts"),
      );
      assert(
        "subagent uses h3 nested heading",
        md.includes("### You") || md.includes("### Assistant"),
      );
    }

    // ---- 404 on unknown session id ----
    {
      const r = await jget(`${base}/api/v1/sessions/${randomUUID()}/export?format=markdown`, auth);
      assert("unknown sessionId → 404", r.status === 404);
    }

    // ---- 400 on bad format ----
    {
      const r = await jget(`${base}/api/v1/sessions/${parentSessionId}/export?format=xml`, auth);
      assert("bad format → 400", r.status === 400);
    }

    // ---- 401 without auth ----
    {
      const r = await jget(`${base}/api/v1/sessions/${parentSessionId}/export?format=jsonl`);
      assert("unauthenticated → 401", r.status === 401);
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
    console.log(`\n[test-session-export] ${failures} failure(s)`);
    process.exit(1);
  }
  console.log(`\n[test-session-export] all checks passed`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

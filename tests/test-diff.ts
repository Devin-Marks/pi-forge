/**
 * Phase 12 turn-diff integration test.
 *
 * Two layers of coverage:
 *
 *   1. Unit-style: import `buildTurnDiff` directly and feed it a
 *      synthesized `messages` array against a real on-disk project.
 *      Asserts pure-addition fallback (untracked file), git-diff
 *      cumulative path (tracked file with edits), additions/deletions
 *      counting, multi-edit-same-file grouping.
 *
 *   2. Route smoke: start the server, create a session, hit
 *      `GET /api/v1/sessions/:id/turn-diff` and assert the wire
 *      shape. With no edits in the session, the entry list is empty
 *      and the route still responds 200.
 *
 * No LLM required. Edit/write tool result shapes are synthesized from
 * the SDK's documented schemas (toolCall content blocks with
 * `name: "edit"|"write"` + `arguments: { path, ... }`, paired with
 * toolResult messages by `toolCallId`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile as fsWrite } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
// Importing the compiled server module directly. The .d.ts lives next
// to the .js after `npm run build`, so the relative import resolves.
// @ts-expect-error — relative import to compiled output, no published .d.ts in place
import { buildTurnDiff } from "../packages/server/dist/turn-diff-builder.js";

const execFileAsync = promisify(execFile);

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

/* ---------- helpers to synthesize message arrays ---------- */

interface SynthAssistantBlock {
  type: "toolCall";
  id: string;
  name: "write" | "edit";
  arguments: Record<string, unknown>;
}

function makeUserMessage(text: string): unknown {
  return { role: "user", content: text, timestamp: Date.now() };
}

function makeAssistantWithCalls(blocks: SynthAssistantBlock[]): unknown {
  return {
    role: "assistant",
    content: blocks,
    timestamp: Date.now(),
  };
}

function makeToolResult(args: {
  toolCallId: string;
  toolName: "write" | "edit";
  diff?: string;
  patch?: string;
  isError?: boolean;
}): unknown {
  return {
    role: "toolResult",
    toolCallId: args.toolCallId,
    toolName: args.toolName,
    content: [{ type: "text", text: "ok" }],
    details:
      args.diff !== undefined || args.patch !== undefined
        ? { diff: args.diff, patch: args.patch }
        : undefined,
    isError: args.isError === true,
    timestamp: Date.now(),
  };
}

async function unitTests(): Promise<void> {
  const projectPath = await mkdtemp(join(tmpdir(), "pi-diff-proj-"));

  // --- Case A: untracked file (no git repo) — expect pure-addition fallback. ---
  {
    const filePath = join(projectPath, "fresh.ts");
    await fsWrite(filePath, "export const x = 1;\nexport const y = 2;\n", "utf8");
    const callId = randomUUID();
    const messages = [
      makeUserMessage("create fresh.ts"),
      makeAssistantWithCalls([
        { type: "toolCall", id: callId, name: "write", arguments: { path: filePath, content: "" } },
      ]),
      makeToolResult({ toolCallId: callId, toolName: "write" }),
    ];
    const entries = await buildTurnDiff({ messages: messages as never[] }, projectPath);
    assert("untracked write produces 1 entry", entries.length === 1, JSON.stringify(entries));
    const e = entries[0];
    if (e !== undefined) {
      assert("entry.file matches", e.file === filePath);
      assert("entry.tool === 'write'", e.tool === "write");
      assert("entry.isPureAddition === true", e.isPureAddition === true);
      assert(
        "diff starts with /dev/null pure-addition header",
        e.diff.includes("--- /dev/null") && e.diff.includes("+++ b/"),
      );
      assert(
        "additions === 2 (file has 2 lines)",
        e.additions === 2,
        `additions=${e.additions} diff=${e.diff}`,
      );
      assert("deletions === 0 (new file)", e.deletions === 0);
    }
  }

  // --- Case B: tracked file edited — expect git diff HEAD path. ---
  {
    const trackedDir = await mkdtemp(join(tmpdir(), "pi-diff-git-"));
    await execFileAsync("git", ["init", "-q", "--initial-branch=main"], { cwd: trackedDir });
    await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: trackedDir });
    await execFileAsync("git", ["config", "user.name", "test"], { cwd: trackedDir });
    const trackedFile = join(trackedDir, "tracked.ts");
    await fsWrite(trackedFile, "line1\nline2\nline3\n", "utf8");
    await execFileAsync("git", ["add", "."], { cwd: trackedDir });
    await execFileAsync("git", ["commit", "-q", "-m", "init"], { cwd: trackedDir });
    // Simulate pre-existing user work before the agent turn, then
    // mutate again for the turn itself. The last-turn diff should use
    // the tool's scoped details.diff and NOT show the pre-existing
    // dirty line from `git diff HEAD`.
    await fsWrite(trackedFile, "line1\npreexisting dirty line\nline2\nline3\n", "utf8");
    await fsWrite(
      trackedFile,
      "line1\npreexisting dirty line\nLINE2-CHANGED\nline3\n+ extra\n",
      "utf8",
    );

    const callId = randomUUID();
    const perEditDiff = `  1 line1\n  2 preexisting dirty line\n- 3 line2\n+ 3 LINE2-CHANGED\n  4 line3\n+ 5 + extra\n`;
    const perEditPatch = `--- a/tracked.ts\n+++ b/tracked.ts\n@@ -1,3 +1,4 @@\n line1\n-line2\n+LINE2-CHANGED\n line3\n+ extra\n`;
    const messages = [
      makeUserMessage("modify tracked.ts"),
      makeAssistantWithCalls([
        {
          type: "toolCall",
          id: callId,
          name: "edit",
          arguments: {
            path: trackedFile,
            edits: [{ oldText: "line2", newText: "LINE2-CHANGED" }],
          },
        },
      ]),
      makeToolResult({
        toolCallId: callId,
        toolName: "edit",
        diff: perEditDiff,
        patch: perEditPatch,
      }),
    ];
    const entries = await buildTurnDiff({ messages: messages as never[] }, trackedDir);
    assert("tracked edit produces 1 entry", entries.length === 1);
    const e = entries[0];
    if (e !== undefined) {
      assert("entry.tool === 'edit'", e.tool === "edit");
      assert("entry.isPureAddition === false (git diff path)", e.isPureAddition === false);
      assert(
        "turn diff includes the changed line",
        e.diff.includes("LINE2-CHANGED"),
        `diff: ${e.diff}`,
      );
      assert(
        "turn diff uses details.patch over display diff",
        !e.diff.includes("  2 preexisting dirty line"),
        `diff: ${e.diff}`,
      );
      assert(
        "turn diff excludes pre-existing dirty work",
        !e.diff.includes("preexisting dirty line"),
        `diff: ${e.diff}`,
      );
      assert("additions >= 2", e.additions >= 2, `additions=${e.additions}`);
      assert("deletions >= 1", e.deletions >= 1, `deletions=${e.deletions}`);
    }
    await rm(trackedDir, { recursive: true, force: true });
  }

  // --- Case C: verbose pi-format tool diffs are trimmed around edits. ---
  {
    const filePath = join(projectPath, "verbose.ts");
    await fsWrite(
      filePath,
      Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n"),
      "utf8",
    );
    const callId = randomUUID();
    const verbosePiDiff = Array.from({ length: 20 }, (_, i) => {
      const lineNo = i + 1;
      if (lineNo === 10) return `- ${lineNo} line ${lineNo}`;
      if (lineNo === 11) return `+ ${lineNo} changed line`;
      return `  ${lineNo} line ${lineNo}`;
    }).join("\n");
    const messages = [
      makeUserMessage("edit verbose.ts"),
      makeAssistantWithCalls([
        { type: "toolCall", id: callId, name: "edit", arguments: { path: filePath } },
      ]),
      makeToolResult({ toolCallId: callId, toolName: "edit", diff: verbosePiDiff }),
    ];
    const entries = await buildTurnDiff({ messages: messages as never[] }, projectPath);
    const diff = entries[0]?.diff ?? "";
    assert("verbose pi diff produces 1 entry", entries.length === 1);
    assert("verbose pi diff keeps changed line", diff.includes("changed line"), diff);
    assert("verbose pi diff trims distant leading context", !diff.includes("  1 line 1"), diff);
    assert("verbose pi diff trims distant trailing context", !diff.includes("  20 line 20"), diff);
  }

  // --- Case D: untracked existing edit without details does NOT render as whole-file add. ---
  {
    const filePath = join(projectPath, "untracked-existing.ts");
    await fsWrite(filePath, "one\ntwo changed\nthree\n", "utf8");
    const callId = randomUUID();
    const messages = [
      makeUserMessage("edit an untracked existing file"),
      makeAssistantWithCalls([
        {
          type: "toolCall",
          id: callId,
          name: "edit",
          arguments: {
            path: filePath,
            edits: [{ oldText: "two", newText: "two changed" }],
          },
        },
      ]),
      makeToolResult({ toolCallId: callId, toolName: "edit" }),
    ];
    const entries = await buildTurnDiff({ messages: messages as never[] }, projectPath);
    const e = entries[0];
    assert("untracked existing edit produces 1 entry", entries.length === 1);
    if (e !== undefined) {
      assert("untracked existing edit is not pure addition", e.isPureAddition === false);
      assert("untracked existing edit shows deletion", e.diff.includes("-two"), e.diff);
      assert("untracked existing edit shows insertion", e.diff.includes("+two changed"), e.diff);
      assert("untracked existing edit does not add every line", e.additions === 1, e.diff);
    }
  }

  // --- Case E: multi-edit same file in one turn — collapses to one entry. ---
  {
    const filePath = join(projectPath, "multi.ts");
    await fsWrite(filePath, "a\nb\nc\n", "utf8");
    const id1 = randomUUID();
    const id2 = randomUUID();
    const messages = [
      makeUserMessage("two edits"),
      makeAssistantWithCalls([
        { type: "toolCall", id: id1, name: "edit", arguments: { path: filePath } },
        { type: "toolCall", id: id2, name: "edit", arguments: { path: filePath } },
      ]),
      makeToolResult({
        toolCallId: id1,
        toolName: "edit",
        diff: "--- a/multi.ts\n+++ b/multi.ts\n@@ -1,1 +1,1 @@\n-a\n+A\n",
      }),
      makeToolResult({
        toolCallId: id2,
        toolName: "edit",
        diff: "--- a/multi.ts\n+++ b/multi.ts\n@@ -2,1 +2,1 @@\n-b\n+B\n",
      }),
    ];
    const entries = await buildTurnDiff({ messages: messages as never[] }, projectPath);
    assert("multi-edit same file collapses to 1 entry", entries.length === 1);
  }

  // --- Case F: only consider the LATEST turn (after most recent user message). ---
  {
    const filePath = join(projectPath, "older.ts");
    await fsWrite(filePath, "old\n", "utf8");
    const oldId = randomUUID();
    const newId = randomUUID();
    const newFile = join(projectPath, "newer.ts");
    await fsWrite(newFile, "new\n", "utf8");
    const messages = [
      makeUserMessage("turn 1"),
      makeAssistantWithCalls([
        { type: "toolCall", id: oldId, name: "edit", arguments: { path: filePath } },
      ]),
      makeToolResult({ toolCallId: oldId, toolName: "edit", diff: "old diff" }),
      makeUserMessage("turn 2"),
      makeAssistantWithCalls([
        { type: "toolCall", id: newId, name: "write", arguments: { path: newFile } },
      ]),
      makeToolResult({ toolCallId: newId, toolName: "write" }),
    ];
    const entries = await buildTurnDiff({ messages: messages as never[] }, projectPath);
    assert("only most-recent-turn entries returned", entries.length === 1);
    if (entries.length === 1) {
      const e = entries[0];
      assert("recent entry is the newer.ts one", e?.file === newFile);
    }
  }

  await rm(projectPath, { recursive: true, force: true });
}

async function routeTest(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-diff-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-diff-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-diff-data-"));
  const projectPath = join(workspacePath, "demo");
  await mkdir(projectPath, { recursive: true });

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

    const cp = await fetch(`${base}/api/v1/projects`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "demo", path: projectPath }),
    });
    assert("POST /projects → 201", cp.status === 201);
    const project = (await cp.json()) as { id: string };

    const cs = await fetch(`${base}/api/v1/sessions`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ projectId: project.id }),
    });
    assert("POST /sessions → 201", cs.status === 201);
    const session = (await cs.json()) as { sessionId: string };

    // Empty turn-diff for a fresh session (no edits yet).
    const td = await fetch(`${base}/api/v1/sessions/${session.sessionId}/turn-diff`, {
      headers: auth,
    });
    assert("GET /turn-diff → 200 on empty session", td.status === 200);
    const tdBody = (await td.json()) as { entries: unknown[] };
    assert("entries is an array", Array.isArray(tdBody.entries));
    assert("empty session yields no entries", tdBody.entries.length === 0);

    // 404 for an unknown session.
    const miss = await fetch(`${base}/api/v1/sessions/not-a-session/turn-diff`, { headers: auth });
    assert("GET /turn-diff for unknown session → 404", miss.status === 404);

    // Anonymous → 401.
    const anon = await fetch(`${base}/api/v1/sessions/${session.sessionId}/turn-diff`);
    assert("anonymous → 401", anon.status === 401);
  } finally {
    await stop();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("[test-diff] unit tests");
  await unitTests();
  console.log("[test-diff] route tests");
  await routeTest();

  if (failures > 0) {
    console.log(`\n[test-diff] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-diff] PASS");
}

main().catch((err: unknown) => {
  console.error("[test-diff] uncaught:", err);
  process.exit(1);
});

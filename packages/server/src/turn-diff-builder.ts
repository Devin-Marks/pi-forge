import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { runGitRaw } from "./git-runner.js";

/**
 * Aggregate file changes across a single agent turn into one
 * reviewable changeset.
 *
 * Approach (cumulative-by-design):
 *   1. Walk the session's messages from the most recent user message
 *      forward, collecting every toolCall whose `name` is `write` or
 *      `edit`. Pair each with its `toolResult` via `toolCallId`.
 *   2. Extract the affected file path from the toolCall's `input.path`
 *      (the SDK schema for both tools).
 *   3. For each unique file, prefer `git diff HEAD -- <path>` so the
 *      output is the CUMULATIVE diff of all edits in the turn (and
 *      reflects prior tracked content, not just per-edit deltas).
 *      That lines up with what users actually want to review:
 *      "what's different from main now?", not "what was the agent's
 *      4th edit operation?".
 *   4. If the file is untracked OR the project has no `.git`, fall
 *      back to a pure-addition diff: read the current contents and
 *      emit `--- /dev/null` / `+++ b/<path>` / `+`-prefixed lines.
 *      Captures the full new file when the agent created it from
 *      scratch.
 *   5. If neither path works (file deleted, can't read, etc.), fall
 *      back to the SDK's per-edit `details.diff` from the LAST edit
 *      result for that file. Imperfect but better than nothing.
 *
 * Boundary: when the caller passes `startIndex` (the message-array
 * index captured at the most recent `agent_start` event by the session
 * registry), we walk from there exactly. Otherwise we approximate
 * "latest turn" as "since the most recent user message" — fine for
 * cold-loaded sessions that haven't yet emitted an `agent_start`.
 */

export interface TurnDiffEntry {
  /** Absolute path on disk. Use the project root to derive a
   *  display-relative path on the client side. */
  file: string;
  /** Tool that produced this entry's primary action: write OR edit
   *  (mixed actions across the same file fall back to "edit" since
   *  edit's details have a usable diff). */
  tool: "write" | "edit";
  /** Unified-diff string, suitable for `react-diff-view`. */
  diff: string;
  /** Number of `+` lines (excluding the `+++` header). */
  additions: number;
  /** Number of `-` lines (excluding the `---` header). */
  deletions: number;
  /** True when the diff was reconstructed from disk because the file
   *  is untracked or the project has no git history. The client may
   *  want to label these "new file" instead of just rendering. */
  isPureAddition: boolean;
}

interface EditOperation {
  oldText: string;
  newText: string;
}

interface ToolCallInfo {
  toolCallId: string;
  toolName: "write" | "edit";
  path: string;
  edits?: EditOperation[];
}

interface ToolCallResultPair {
  call: ToolCallInfo;
  result: {
    diff?: string;
    patch?: string;
    isError: boolean;
  };
}

/**
 * Walk the session's messages array and pull out the latest turn's
 * write/edit operations, paired with their result details.
 *
 * When `explicitStartIndex` is provided (the session-registry's
 * `lastAgentStartIndex`), the walk starts there and ignores
 * intermediate user-shaped messages produced by compaction or steering.
 * Otherwise we fall back to "the most recent user message" — fine for
 * the common case and necessary for cold-loaded sessions that never
 * emitted `agent_start` since the server booted.
 */
export function collectTurnTouches(
  messages: readonly unknown[],
  explicitStartIndex?: number,
): ToolCallResultPair[] {
  let startIndex = 0;
  if (
    explicitStartIndex !== undefined &&
    explicitStartIndex >= 0 &&
    explicitStartIndex <= messages.length
  ) {
    startIndex = explicitStartIndex;
  } else {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: unknown };
      if (m.role === "user") {
        startIndex = i + 1;
        break;
      }
    }
  }

  // Build callId → ToolCallInfo from assistant messages first.
  // The SDK's `ToolCall` block (defined in `@earendil-works/pi-ai`'s
  // types.d.ts) uses `arguments` for the input object — NOT `input`.
  // We accept either field as a defensive measure: `arguments` is
  // canonical, `input` is the historical naming some other SDKs use
  // and a sensible alias if the pi schema ever shifts.
  const callsById = new Map<string, ToolCallInfo>();
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i] as { role?: unknown; content?: unknown };
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content) {
      const b = block as {
        type?: unknown;
        name?: unknown;
        id?: unknown;
        arguments?: unknown;
        input?: unknown;
      };
      if (b.type !== "toolCall") continue;
      const name = b.name;
      if (name !== "write" && name !== "edit") continue;
      const id = typeof b.id === "string" ? b.id : undefined;
      const args = (b.arguments ?? b.input) as { path?: unknown; edits?: unknown } | undefined;
      const path = typeof args?.path === "string" ? args.path : undefined;
      if (id === undefined || path === undefined) continue;
      const info: ToolCallInfo = { toolCallId: id, toolName: name, path };
      if (name === "edit" && Array.isArray(args?.edits)) {
        const edits = args.edits
          .map((e) => {
            const edit = e as { oldText?: unknown; newText?: unknown };
            return typeof edit.oldText === "string" && typeof edit.newText === "string"
              ? { oldText: edit.oldText, newText: edit.newText }
              : undefined;
          })
          .filter((e): e is EditOperation => e !== undefined);
        if (edits.length > 0) info.edits = edits;
      }
      callsById.set(id, info);
    }
  }

  // Walk toolResults in order so multiple edits to the same file land
  // in chronological sequence. The fallback "latest details.diff per
  // file" naturally emerges because later entries overwrite earlier
  // ones in the per-file map upstream.
  const out: ToolCallResultPair[] = [];
  for (let i = startIndex; i < messages.length; i++) {
    const m = messages[i] as {
      role?: unknown;
      toolCallId?: unknown;
      details?: unknown;
      isError?: unknown;
    };
    if (m.role !== "toolResult") continue;
    if (typeof m.toolCallId !== "string") continue;
    const call = callsById.get(m.toolCallId);
    if (call === undefined) continue;
    const details = m.details as { diff?: unknown; patch?: unknown } | undefined;
    const diffStr = typeof details?.diff === "string" ? details.diff : undefined;
    const patchStr = typeof details?.patch === "string" ? details.patch : undefined;
    const result: ToolCallResultPair["result"] = { isError: m.isError === true };
    if (diffStr !== undefined) result.diff = diffStr;
    if (patchStr !== undefined) result.patch = patchStr;
    out.push({ call, result });
  }
  return out;
}

/**
 * Build the per-file turn-diff for a session. Caller passes the
 * session's `workspacePath` (the project root) — the builder uses it
 * to scope `git diff` calls and to resolve relative paths the agent
 * may have written into the toolCall input.
 */
export async function buildTurnDiff(
  session: Pick<AgentSession, "messages">,
  projectPath: string,
  explicitStartIndex?: number,
): Promise<TurnDiffEntry[]> {
  const touches = collectTurnTouches(session.messages, explicitStartIndex);
  if (touches.length === 0) return [];

  const isGitRepo = await stat(join(projectPath, ".git")).then(
    (s) => s.isDirectory() || s.isFile(), // .git can be a file in worktrees
    () => false,
  );

  // Group by canonicalized absolute path. Multiple edits to the same
  // file fold into one entry — we use cumulative `git diff HEAD`
  // when possible so the order doesn't matter.
  const byFile = new Map<string, ToolCallResultPair[]>();
  for (const pair of touches) {
    const abs = absolutize(pair.call.path, projectPath);
    const existing = byFile.get(abs);
    if (existing === undefined) byFile.set(abs, [pair]);
    else existing.push(pair);
  }

  // Single `git diff HEAD -- <files...>` for every touched file at
  // once, then split the output by `diff --git` headers. Replaces the
  // per-file subprocess fork; on a 50-file refactor that's 50→1 git
  // invocations. Untracked files (no entry in HEAD) are absent from
  // the result map and fall through to `tryPureAddition` below.
  const gitDiffs = isGitRepo
    ? await tryGitDiffMany(projectPath, [...byFile.keys()])
    : new Map<string, string>();

  const entries: TurnDiffEntry[] = [];
  for (const [absPath, pairs] of byFile) {
    const toolName = preferredTool(pairs);
    let diff: string | undefined;
    let isPureAddition = false;

    // Prefer the edit tool's own per-operation patch when available.
    // It is scoped to this turn, while `git diff HEAD` also includes
    // any pre-existing dirty worktree changes and can make the
    // last-turn panel look like entire files changed. Multiple
    // edit/write calls for the same file are kept in chronological
    // order as separate chunks in one accordion entry. If an older SDK
    // only has `details.diff`, trim its display-oriented context.
    diff = combineToolDiffs(pairs);

    if ((diff === undefined || diff.length === 0) && isGitRepo) {
      diff = gitDiffs.get(absPath);
    }

    if (diff === undefined || diff.length === 0) {
      // If an edit result did not persist details.patch/details.diff
      // (or the file is untracked so git has no baseline), reconstruct
      // a scoped patch from the edit arguments. This prevents edited
      // pre-existing untracked files from rendering as whole-file
      // additions.
      diff = await tryEditArgumentPatch(projectPath, absPath, pairs);
    }

    if (diff === undefined || diff.length === 0) {
      // No operation diff, argument patch, or git diff available
      // (brand-new write, no repo, file went missing). Try
      // pure-addition from current disk contents.
      const pure = await tryPureAddition(projectPath, absPath);
      if (pure !== undefined) {
        diff = pure;
        isPureAddition = true;
      }
    }

    if (diff === undefined || diff.length === 0) {
      // Truly nothing to show — skip rather than emit a noisy entry.
      continue;
    }

    const { additions, deletions } = countChanges(diff);
    entries.push({
      file: absPath,
      tool: toolName,
      diff,
      additions,
      deletions,
      isPureAddition,
    });
  }

  // Sort alphabetically for stable rendering.
  entries.sort((a, b) => a.file.localeCompare(b.file));
  return entries;
}

function preferredTool(pairs: ToolCallResultPair[]): "write" | "edit" {
  // If any entry was a `write`, the file was overwritten at some
  // point — that dominates. Otherwise it's `edit`.
  return pairs.some((p) => p.call.toolName === "write") ? "write" : "edit";
}

function combineToolDiffs(pairs: ToolCallResultPair[]): string | undefined {
  const patchChunks = pairs
    .map((p) => p.result.patch)
    .filter((d): d is string => d !== undefined && d.length > 0);
  if (patchChunks.length > 0) {
    return patchChunks
      .map((d) => d.trimEnd())
      .join("\n")
      .concat("\n");
  }

  const displayChunks = pairs
    .map((p) => p.result.diff)
    .filter((d): d is string => d !== undefined && d.length > 0);
  if (displayChunks.length === 0) return undefined;
  return displayChunks
    .map((d) => trimPiDiffContext(d).trimEnd())
    .join("\n")
    .concat("\n");
}

const TURN_DIFF_CONTEXT_LINES = 3;

function trimPiDiffContext(diff: string): string {
  const rawLines = diff.split("\n");
  const hadTrailingNewline = rawLines.length > 0 && rawLines[rawLines.length - 1] === "";
  const lines = hadTrailingNewline ? rawLines.slice(0, -1) : rawLines;
  if (lines.length === 0) return diff;

  const lineRe = /^([+\- ]) *(\d+)(?: (.*))?$/;
  const skipRe = /^ +\.\.\.$/;
  const parsed = lines.map((line) => {
    if (skipRe.test(line)) return { line, changed: false, skip: true };
    const m = lineRe.exec(line);
    if (m === null) return undefined;
    const marker = m[1];
    return { line, changed: marker === "+" || marker === "-", skip: false };
  });

  if (parsed.some((p) => p === undefined)) return diff;
  const changedIndexes = parsed.map((p, i) => (p?.changed === true ? i : -1)).filter((i) => i >= 0);
  if (changedIndexes.length === 0) return diff;

  const keep = new Set<number>();
  for (const idx of changedIndexes) {
    const start = Math.max(0, idx - TURN_DIFF_CONTEXT_LINES);
    const end = Math.min(parsed.length - 1, idx + TURN_DIFF_CONTEXT_LINES);
    for (let i = start; i <= end; i++) keep.add(i);
  }

  const out: string[] = [];
  let skipped = false;
  for (let i = 0; i < lines.length; i++) {
    const p = parsed[i];
    if (p?.skip === true) {
      if (out.length > 0 && out[out.length - 1] !== "   ...") out.push("   ...");
      skipped = false;
      continue;
    }
    if (!keep.has(i)) {
      skipped = true;
      continue;
    }
    if (skipped && out.length > 0 && out[out.length - 1] !== "   ...") out.push("   ...");
    out.push(lines[i] ?? "");
    skipped = false;
  }
  return out.join("\n") + (hadTrailingNewline ? "\n" : "");
}

function absolutize(path: string, projectPath: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(join(projectPath, path));
}

function relabelNoIndexDiff(diff: string, oldFile: string, newFile: string, rel: string): string {
  return diff
    .split("\n")
    .map((line) => {
      if (line === `diff --git a/${oldFile} b/${newFile}`) return `diff --git a/${rel} b/${rel}`;
      if (line.startsWith(`--- ${oldFile}`)) return `--- a/${rel}`;
      if (line.startsWith(`+++ ${newFile}`)) return `+++ b/${rel}`;
      return line;
    })
    .join("\n");
}

async function tryEditArgumentPatch(
  projectPath: string,
  absPath: string,
  pairs: ToolCallResultPair[],
): Promise<string | undefined> {
  const editPairs = pairs.filter((p) => p.call.toolName === "edit" && p.call.edits !== undefined);
  if (editPairs.length === 0) return undefined;

  let after: string;
  try {
    after = await readFile(absPath, "utf8");
  } catch {
    return undefined;
  }

  let before = after;
  for (let i = editPairs.length - 1; i >= 0; i--) {
    const edits = editPairs[i]?.call.edits ?? [];
    for (let j = edits.length - 1; j >= 0; j--) {
      const edit = edits[j];
      if (edit === undefined) continue;
      const idx = before.lastIndexOf(edit.newText);
      if (idx === -1) return undefined;
      before = before.slice(0, idx) + edit.oldText + before.slice(idx + edit.newText.length);
    }
  }

  if (before === after) return undefined;
  const rel = relative(projectPath, absPath);
  if (rel.startsWith("..")) return undefined;

  const dir = await mkdtemp(join(tmpdir(), "pi-turn-diff-"));
  try {
    const oldFile = join(dir, "old");
    const newFile = join(dir, "new");
    await writeFile(oldFile, before, "utf8");
    await writeFile(newFile, after, "utf8");
    const r = await runGitRaw(
      projectPath,
      ["diff", "--no-color", "--no-ext-diff", "--no-index", oldFile, newFile],
      { maxBuffer: 16 * 1024 * 1024 },
    ).catch((err: unknown) => {
      const e = err as { stdout?: unknown };
      if (typeof e.stdout === "string" && e.stdout.length > 0) return { stdout: e.stdout };
      if (Buffer.isBuffer(e.stdout) && e.stdout.length > 0) return { stdout: e.stdout.toString() };
      throw err;
    });
    return relabelNoIndexDiff(r.stdout, oldFile, newFile, rel);
  } catch {
    return undefined;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run `git diff HEAD -- <files...>` for ALL touched files in one
 * subprocess. Returns a map of absolute-path → unified-diff string;
 * files that produced no diff (unchanged, untracked, deleted) are
 * absent from the map. Callers fall back to `tryPureAddition` /
 * the per-edit diff for those.
 *
 * `--no-color` keeps escape codes out; `--no-ext-diff` skips user-
 * configured external diff drivers that could vary output.
 *
 * Output format for multi-file diffs:
 *   diff --git a/<rel1> b/<rel1>
 *   ...hunks...
 *   diff --git a/<rel2> b/<rel2>
 *   ...
 * We split by the regex anchor `(?=^diff --git )` (multiline) which
 * preserves the leading `diff --git` line on each chunk so the
 * chunk parses cleanly as a single-file unified diff downstream.
 */
async function tryGitDiffMany(
  projectPath: string,
  absPaths: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (absPaths.length === 0) return out;
  const rels: string[] = [];
  const relToAbs = new Map<string, string>();
  for (const abs of absPaths) {
    const rel = relative(projectPath, abs);
    if (rel.startsWith("..")) continue;
    rels.push(rel);
    relToAbs.set(rel, abs);
  }
  if (rels.length === 0) return out;
  let stdout: string;
  try {
    const r = await runGitRaw(
      projectPath,
      ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", ...rels],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    stdout = r.stdout;
  } catch {
    // Common failures: not a git repo (no HEAD yet), git not on PATH.
    return out;
  }
  if (stdout.length === 0) return out;
  // Split-with-lookahead keeps the `diff --git ...` header on each chunk.
  const chunks = stdout.split(/(?=^diff --git )/m).filter((c) => c.length > 0);
  for (const chunk of chunks) {
    const newlineIdx = chunk.indexOf("\n");
    const headerLine = newlineIdx === -1 ? chunk : chunk.slice(0, newlineIdx);
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(headerLine);
    if (m === null) continue;
    // Prefer matching against the post-rename (b/) path; fall back to
    // a/ for renames where we asked by the old name. Renames inside
    // a turn-diff are rare since the agent's own write/edit tools
    // operate by path — but be defensive.
    const newRel = m[2] ?? "";
    const oldRel = m[1] ?? "";
    const abs = relToAbs.get(newRel) ?? relToAbs.get(oldRel);
    if (abs === undefined) continue;
    out.set(abs, chunk);
  }
  return out;
}

/**
 * Build a unified diff that adds the file from /dev/null. Used when
 * the file is untracked / new — every line is an addition.
 */
async function tryPureAddition(projectPath: string, absPath: string): Promise<string | undefined> {
  let content: string;
  try {
    content = await readFile(absPath, "utf8");
  } catch {
    // File vanished between the toolCall and our read (agent deleted
    // it after writing it). Return undefined → caller skips this file
    // in the turn diff rather than failing the whole build.
    return undefined;
  }
  const rel = relative(projectPath, absPath);
  if (rel.startsWith("..")) return undefined;
  const lines = content.length === 0 ? [] : content.split("\n");
  // Trailing newline produces a trailing empty element from split;
  // drop it so the hunk count is right.
  const tail =
    content.endsWith("\n") && lines.length > 0 && lines[lines.length - 1] === ""
      ? lines.slice(0, -1)
      : lines;
  const header =
    `diff --git a/${rel} b/${rel}\n` +
    `new file mode 100644\n` +
    `--- /dev/null\n` +
    `+++ b/${rel}\n`;
  if (tail.length === 0) return header;
  const hunk = `@@ -0,0 +1,${tail.length} @@\n` + tail.map((l) => `+${l}`).join("\n") + "\n";
  return header + hunk;
}

function countChanges(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++")) continue;
    if (line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

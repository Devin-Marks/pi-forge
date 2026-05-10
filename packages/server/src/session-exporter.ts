import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { discoverSessionsOnDisk, findSessionLocation } from "./session-registry.js";
import { getProject, readProjects } from "./project-manager.js";

/**
 * Single-session exporter. Two output formats:
 *
 *   - **JSONL** — the raw on-disk session JSONL with subagent child
 *     JSONLs inlined between the parent's `subagent` tool call and its
 *     matching tool result. Inline boundaries use synthetic envelope
 *     types `subagent_inline_start` / `subagent_inline_end` so SDK
 *     consumers that don't understand them treat them as unknown and
 *     skip (matching the SDK's own forward-compat policy).
 *   - **Markdown** — a flat human-readable transcript: user / assistant
 *     bubbles, tool calls as fenced code blocks, tool results as
 *     blockquotes (capped at TOOL_RESULT_CAP bytes per result).
 *     Subagent children render nested at h3 under the parent's tool
 *     call section.
 *
 * Sub-agent matching is **positional**: the Nth `subagent` tool call
 * gets the Nth chronologically-sorted child. pi-subagents creates the
 * child JSONL at tool invocation time so this ordering holds in
 * practice. Mismatched counts (e.g. a failed call that never spawned
 * a child) inline what we have and skip the rest — better than
 * pretending the data isn't there.
 */

/** Soft cap per tool-result rendering in markdown — keeps exports skim-able. */
const TOOL_RESULT_CAP = 2_000;

export interface ExportArtifact {
  /** UTF-8 string ready to send to the client. */
  content: string;
  /** Filename hint for the Content-Disposition header. */
  filename: string;
  /** Suitable Content-Type. */
  contentType: string;
}

export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`session ${sessionId} not found`);
    this.name = "SessionNotFoundError";
  }
}

/**
 * Locate a session by id. Walks every project's on-disk session dir
 * (delegating to `discoverSessionsOnDisk` so subagent children are
 * resolvable too) and returns the discovered metadata for the match.
 */
async function findSessionFile(sessionId: string): Promise<
  | {
      filePath: string;
      projectId: string;
      workspacePath: string;
      sessionName?: string;
      parentSessionId?: string;
    }
  | undefined
> {
  const loc = await findSessionLocation(sessionId);
  if (loc === undefined) return undefined;
  const discovered = await discoverSessionsOnDisk(loc.projectId, loc.workspacePath);
  const match = discovered.find((d) => d.sessionId === sessionId);
  if (match === undefined) return undefined;
  const out: {
    filePath: string;
    projectId: string;
    workspacePath: string;
    sessionName?: string;
    parentSessionId?: string;
  } = {
    filePath: match.path,
    projectId: loc.projectId,
    workspacePath: loc.workspacePath,
  };
  if (match.name !== undefined) out.sessionName = match.name;
  if (match.parentSessionId !== undefined) out.parentSessionId = match.parentSessionId;
  return out;
}

/**
 * Discover and chronologically-sort the subagent children of `parentSessionId`
 * within the same project. Returns `[]` for sessions with no children,
 * including sessions that ARE themselves children (we don't recurse beyond
 * one level — see the module doc).
 */
async function loadChildSessions(
  parentSessionId: string,
  projectId: string,
  workspacePath: string,
): Promise<{ sessionId: string; filePath: string; createdAt: Date }[]> {
  const discovered = await discoverSessionsOnDisk(projectId, workspacePath);
  const children = discovered
    .filter((d) => d.parentSessionId === parentSessionId)
    .map((d) => ({ sessionId: d.sessionId, filePath: d.path, createdAt: d.createdAt }))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return children;
}

/* ----------------------------- JSONL export ----------------------------- */

export async function exportAsJsonl(sessionId: string): Promise<ExportArtifact> {
  const located = await findSessionFile(sessionId);
  if (located === undefined) throw new SessionNotFoundError(sessionId);

  const parentContent = await readFile(located.filePath, "utf8");
  const parentLines = splitLines(parentContent);

  // For child sessions, no further inlining — return the file as-is.
  // The user is exporting "this conversation" and the child is already
  // a complete conversation in itself.
  const isChild = located.parentSessionId !== undefined;
  if (isChild) {
    return {
      content: parentContent.endsWith("\n") ? parentContent : parentContent + "\n",
      filename: filenameFor(located.sessionName ?? sessionId, "jsonl"),
      contentType: "application/x-ndjson",
    };
  }

  const children = await loadChildSessions(sessionId, located.projectId, located.workspacePath);
  // Pre-load every child's content so the inline pass doesn't await
  // per-line. Children typically count in the single digits.
  const childContents = await Promise.all(
    children.map(async (c) => ({ ...c, lines: splitLines(await readFile(c.filePath, "utf8")) })),
  );

  // Walk the parent's lines; when we see an assistant message with a
  // `subagent` tool-call block, immediately after the parent line emit
  // the next child's full JSONL bracketed by inline-boundary envelopes.
  const out: string[] = [];
  let childCursor = 0;
  for (const line of parentLines) {
    out.push(line);
    const callId = subagentToolCallIdFromLine(line);
    if (callId === undefined) continue;
    const child = childContents[childCursor];
    if (child === undefined) continue;
    childCursor += 1;
    out.push(
      JSON.stringify({
        type: "subagent_inline_start",
        parentToolCallId: callId,
        childSessionId: child.sessionId,
      }),
    );
    for (const childLine of child.lines) out.push(childLine);
    out.push(
      JSON.stringify({
        type: "subagent_inline_end",
        childSessionId: child.sessionId,
      }),
    );
  }
  // Trailing-orphan children (counts didn't match): append them at the
  // tail wrapped in the same envelope. Better to surface than to drop.
  for (let i = childCursor; i < childContents.length; i++) {
    const child = childContents[i];
    if (child === undefined) continue;
    out.push(
      JSON.stringify({
        type: "subagent_inline_start",
        parentToolCallId: null,
        childSessionId: child.sessionId,
        note: "orphaned — no matching parent tool call",
      }),
    );
    for (const childLine of child.lines) out.push(childLine);
    out.push(
      JSON.stringify({
        type: "subagent_inline_end",
        childSessionId: child.sessionId,
      }),
    );
  }

  return {
    content: out.join("\n") + "\n",
    filename: filenameFor(located.sessionName ?? sessionId, "jsonl"),
    contentType: "application/x-ndjson",
  };
}

/* ----------------------------- Markdown export ----------------------------- */

export async function exportAsMarkdown(sessionId: string): Promise<ExportArtifact> {
  const located = await findSessionFile(sessionId);
  if (located === undefined) throw new SessionNotFoundError(sessionId);

  const parentContent = await readFile(located.filePath, "utf8");
  const parentLines = splitLines(parentContent);

  const project = await getProject(located.projectId);
  const projectName = project?.name ?? "(unknown project)";
  const isChild = located.parentSessionId !== undefined;
  const children = isChild
    ? []
    : await loadChildSessions(sessionId, located.projectId, located.workspacePath);
  const childContents = await Promise.all(
    children.map(async (c) => ({ ...c, lines: splitLines(await readFile(c.filePath, "utf8")) })),
  );

  const out: string[] = [];
  out.push(...renderHeader(parentLines, located.sessionName, sessionId, projectName));
  out.push("");

  let childCursor = 0;
  for (const line of parentLines) {
    const parsed = safeParse(line);
    if (parsed === undefined) continue;
    const md = renderLine(parsed, /* depth */ 2);
    if (md.length === 0) continue;
    out.push(md);
    out.push("");
    // Inline a child after the matching subagent tool call.
    const callId = subagentToolCallIdFromParsed(parsed);
    if (callId === undefined) continue;
    const child = childContents[childCursor];
    if (child === undefined) continue;
    childCursor += 1;
    out.push(`<details><summary>↳ subagent ${child.sessionId}</summary>`);
    out.push("");
    for (const childLine of child.lines) {
      const childParsed = safeParse(childLine);
      if (childParsed === undefined) continue;
      // Nest one heading-depth deeper so the child's user/assistant
      // sections render as h3 under the parent's h2 tool-call entry.
      const childMd = renderLine(childParsed, /* depth */ 3);
      if (childMd.length === 0) continue;
      out.push(childMd);
      out.push("");
    }
    out.push("</details>");
    out.push("");
  }
  // Orphaned children (count mismatch) at the tail.
  for (let i = childCursor; i < childContents.length; i++) {
    const child = childContents[i];
    if (child === undefined) continue;
    out.push("---");
    out.push("");
    out.push(`### ↳ subagent ${child.sessionId} (orphaned — no matching parent tool call)`);
    out.push("");
    for (const childLine of child.lines) {
      const childParsed = safeParse(childLine);
      if (childParsed === undefined) continue;
      const childMd = renderLine(childParsed, 3);
      if (childMd.length === 0) continue;
      out.push(childMd);
      out.push("");
    }
  }

  return {
    content:
      out
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd() + "\n",
    filename: filenameFor(located.sessionName ?? sessionId, "md"),
    contentType: "text/markdown; charset=utf-8",
  };
}

/* ----------------------------- rendering helpers ----------------------------- */

interface ParsedLine {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  // session header
  cwd?: unknown;
  // session_info
  name?: unknown;
  // message envelope
  message?: { role?: unknown; content?: unknown; toolCallId?: unknown; details?: unknown };
  // model_change
  provider?: unknown;
  modelId?: unknown;
}

function splitLines(content: string): string[] {
  return content.split("\n").filter((l) => l.length > 0);
}

function safeParse(line: string): ParsedLine | undefined {
  try {
    return JSON.parse(line) as ParsedLine;
  } catch {
    return undefined;
  }
}

function renderHeader(
  lines: string[],
  sessionName: string | undefined,
  sessionId: string,
  projectName: string,
): string[] {
  let createdAt: string | undefined;
  let cwd: string | undefined;
  let model: string | undefined;
  for (const line of lines) {
    const parsed = safeParse(line);
    if (parsed === undefined) continue;
    if (parsed.type === "session") {
      if (typeof parsed.timestamp === "string") createdAt = parsed.timestamp;
      if (typeof parsed.cwd === "string") cwd = parsed.cwd;
    } else if (parsed.type === "model_change" && model === undefined) {
      const provider = typeof parsed.provider === "string" ? parsed.provider : undefined;
      const modelId = typeof parsed.modelId === "string" ? parsed.modelId : undefined;
      if (provider !== undefined && modelId !== undefined) model = `${provider} / ${modelId}`;
      else if (modelId !== undefined) model = modelId;
    }
    if (createdAt !== undefined && cwd !== undefined && model !== undefined) break;
  }

  const out: string[] = [];
  out.push(`# ${sessionName ?? "Session"}`);
  out.push("");
  out.push(`- **Session id:** \`${sessionId}\``);
  out.push(`- **Project:** ${projectName}`);
  if (createdAt !== undefined) out.push(`- **Created:** ${createdAt}`);
  if (model !== undefined) out.push(`- **Model:** ${model}`);
  if (cwd !== undefined) out.push(`- **Workspace:** \`${cwd}\``);
  return out;
}

function renderLine(parsed: ParsedLine, depth: 2 | 3): string {
  if (parsed.type !== "message") return "";
  const msg = parsed.message;
  if (msg === undefined || msg === null || typeof msg !== "object") return "";
  const role = (msg as { role?: unknown }).role;
  const ts = typeof parsed.timestamp === "string" ? prettyTimestamp(parsed.timestamp) : "";
  if (role === "user") {
    return renderUserMessage(msg, depth, ts);
  }
  if (role === "assistant") {
    return renderAssistantMessage(msg, depth, ts);
  }
  if (role === "toolResult") {
    return renderStandaloneToolResult(msg);
  }
  return "";
}

function renderUserMessage(
  msg: { role?: unknown; content?: unknown },
  depth: 2 | 3,
  ts: string,
): string {
  const heading = depth === 2 ? "## You" : "### You";
  const out: string[] = [ts.length > 0 ? `${heading} — ${ts}` : heading, ""];
  out.push(...renderContent(msg.content));
  return out.join("\n");
}

function renderAssistantMessage(
  msg: { role?: unknown; content?: unknown },
  depth: 2 | 3,
  ts: string,
): string {
  const heading = depth === 2 ? "## Assistant" : "### Assistant";
  const out: string[] = [ts.length > 0 ? `${heading} — ${ts}` : heading, ""];
  out.push(...renderContent(msg.content));
  return out.join("\n");
}

function renderStandaloneToolResult(msg: { content?: unknown; details?: unknown }): string {
  // toolResult lines render as blockquote bodies under the tool call
  // they pair with — rendered separately when the SDK doesn't emit
  // them inline with the call (loose pre-pairing).
  const text = pickToolResultText(msg);
  if (text.length === 0) return "";
  return blockquote(truncate(text, TOOL_RESULT_CAP));
}

function renderContent(content: unknown): string[] {
  // String form: simple "user typed text" — render as a paragraph.
  if (typeof content === "string") {
    return content.length > 0 ? [content] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const block of content) {
    if (block === undefined || block === null || typeof block !== "object") continue;
    const b = block as {
      type?: unknown;
      text?: unknown;
      name?: unknown;
      arguments?: unknown;
      input?: unknown;
      filename?: unknown;
      mimeType?: unknown;
      data?: unknown;
    };
    if (b.type === "text" && typeof b.text === "string") {
      out.push(b.text);
    } else if (b.type === "thinking") {
      const t = typeof b.text === "string" ? b.text : "";
      // Thinking blocks fold into a <details> so the transcript stays
      // skim-able; reviewers can expand to see the full chain.
      out.push("<details><summary>Thinking</summary>");
      out.push("");
      if (t.length > 0) out.push(t);
      out.push("</details>");
    } else if (b.type === "toolCall") {
      out.push(renderToolCall(b));
    } else if (b.type === "image") {
      const filename = typeof b.filename === "string" ? b.filename : "image";
      const mime = typeof b.mimeType === "string" ? b.mimeType : "";
      out.push(`*[image: ${filename}${mime !== "" ? " (" + mime + ")" : ""}]*`);
    } else if (b.type === "file") {
      const filename = typeof b.filename === "string" ? b.filename : "file";
      out.push(`*[file: ${filename}]*`);
    } else if (b.type === "toolResult") {
      // toolResult content blocks carry the result payload either as a
      // top-level `content` (string or block list) or under `details`;
      // pickToolResultText accepts either shape.
      const text = pickToolResultText(b as { content?: unknown; details?: unknown });
      if (text.length > 0) out.push(blockquote(truncate(text, TOOL_RESULT_CAP)));
    }
  }
  return out;
}

function renderToolCall(b: { name?: unknown; arguments?: unknown; input?: unknown }): string {
  const name = typeof b.name === "string" ? b.name : "tool";
  const args = (b.arguments ?? b.input) as Record<string, unknown> | undefined;
  // Per-tool language hints make the rendered code blocks meaningful
  // to clipboard / GitHub renderers. Default to plain text.
  const lang = languageForTool(name);
  const body = stringifyArgs(name, args);
  return `**${name}**\n\n\`\`\`${lang}\n${body}\n\`\`\``;
}

function languageForTool(name: string): string {
  if (name === "bash") return "bash";
  if (name === "edit" || name === "write") return "diff";
  if (name === "read" || name === "ls" || name === "find" || name === "grep") return "";
  return "";
}

function stringifyArgs(name: string, args: Record<string, unknown> | undefined): string {
  if (args === undefined || args === null || typeof args !== "object") return "";
  // Special-case `bash` so the command renders as a bare shell line —
  // most natural form for the most common tool.
  if (name === "bash" && typeof args.command === "string") {
    return args.command;
  }
  // Generic: pretty-print the args object.
  return JSON.stringify(args, null, 2);
}

function pickToolResultText(b: { content?: unknown; details?: unknown }): string {
  // Tool results in pi can be either:
  //   - top-level string (legacy)
  //   - content[].text (assistant-style block list)
  //   - details.text / details.diff (SDK envelope variant)
  // Render whichever the line happens to carry; never guess.
  const details = b.details as { text?: unknown; diff?: unknown } | undefined;
  if (typeof details?.text === "string") return details.text;
  if (typeof details?.diff === "string") return details.diff;
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) {
    const text = b.content
      .filter(
        (block): block is { type: string; text: string } =>
          block !== null &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      )
      .map((block) => block.text)
      .join("\n");
    if (text.length > 0) return text;
  }
  return "";
}

function blockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (truncated, ${text.length} bytes total)`;
}

function prettyTimestamp(iso: string): string {
  // Strip the millisecond + Z noise so the rendered transcript isn't
  // dominated by timestamps; ISO date + HH:MM:SS is plenty.
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(iso);
  if (m === null) return iso;
  return `${m[1]} ${m[2]}`;
}

function subagentToolCallIdFromLine(line: string): string | undefined {
  const parsed = safeParse(line);
  if (parsed === undefined) return undefined;
  return subagentToolCallIdFromParsed(parsed);
}

function subagentToolCallIdFromParsed(parsed: ParsedLine): string | undefined {
  if (parsed.type !== "message") return undefined;
  const msg = parsed.message;
  if (msg === undefined || msg === null || typeof msg !== "object") return undefined;
  if ((msg as { role?: unknown }).role !== "assistant") return undefined;
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (block === undefined || block === null || typeof block !== "object") continue;
    const b = block as { type?: unknown; name?: unknown; id?: unknown };
    if (b.type === "toolCall" && b.name === "subagent" && typeof b.id === "string") {
      return b.id;
    }
  }
  return undefined;
}

function filenameFor(label: string, ext: "md" | "jsonl"): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  const date = new Date().toISOString().slice(0, 10);
  const base = slug.length > 0 ? slug : "session";
  return `${base}-${date}.${ext}`;
}

/** Test helper — never called from the route. */
export function _readProjectsForTest(): ReturnType<typeof readProjects> {
  return readProjects();
}

/** Test helper — fully resolves a session file (without reading contents). */
export async function _findSessionFileForTest(
  sessionId: string,
): Promise<{ filePath: string; projectId: string } | undefined> {
  const f = await findSessionFile(sessionId);
  if (f === undefined) return undefined;
  return { filePath: f.filePath, projectId: f.projectId };
}

/** Used by the route to compute a deterministic dirname for diagnostics. */
export function _exportDirForTest(filePath: string): string {
  return dirname(filePath);
}

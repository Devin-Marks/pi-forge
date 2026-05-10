import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "./config.js";
import { ripgrepAvailable } from "./file-searcher.js";
import { readProjects } from "./project-manager.js";

/**
 * Cross-session text search across every JSONL under `${SESSION_DIR}`.
 *
 * Each ripgrep / Node hit is a single JSONL line which we parse to
 * decide whether the match falls inside content we surface:
 *
 *   - `type === "message"` with `message.role` of `"user"` or
 *     `"assistant"` → match against the rendered text of every
 *     `text` block.
 *   - `type === "message"` with an assistant `toolCall` content block
 *     → match against the rendered `name(arg=value, ...)` form so
 *     "bash ls" / "edit foo.ts" queries hit.
 *   - Anything else (session header, model_change, tool_result,
 *     thinking, queue events) is filtered out — too noisy for the
 *     dropdown, and tool_results in particular can be megabytes of
 *     file content.
 *
 * Matches are grouped by `sessionId` (the `id` field on the line-1
 * session header). Each group carries its on-disk path, project
 * metadata, and up to N per-session message snippets so the UI can
 * render "session header → matched messages" without further
 * server round-trips.
 */

export interface SessionSearchOptions {
  query: string;
  /** Hard cap on returned sessions. */
  sessionLimit: number;
  /** Per-session match cap. */
  matchesPerSession: number;
  /** Wall-clock budget. Aborts in-flight work if exceeded. */
  timeoutMs: number;
}

export interface SessionSearchMatch {
  /**
   * Zero-based index of this message among `type === "message"` lines
   * in the JSONL. Maps directly to the snapshot `messages` array for
   * un-forked sessions (the common case). Forked sessions whose active
   * branch differs from disk order may not find this index — the
   * client falls back to `messageEnvelopeId` lookup.
   */
  messageIndex: number;
  /** The envelope `id` field on the JSONL line, for branch-aware lookup. */
  messageEnvelopeId: string | undefined;
  /** "user" | "assistant" | "tool_call" — what the snippet represents. */
  kind: "user" | "assistant" | "tool_call";
  /** Snippet of the matched content (~120 chars, match centered). */
  snippet: string;
  /** Offset of the match within `snippet`, for highlighting. */
  matchOffset: number;
  /** Length of the matched substring within `snippet`. */
  matchLength: number;
}

export interface SessionSearchResultGroup {
  sessionId: string;
  projectId: string;
  projectName: string;
  /** User-defined session name when set; first user message otherwise. */
  sessionName: string | undefined;
  /** ISO 8601 — file mtime, used for sort. */
  modifiedAt: string;
  matches: SessionSearchMatch[];
}

export interface SessionSearchResult {
  engine: "ripgrep" | "node";
  results: SessionSearchResultGroup[];
  /** True when we hit `sessionLimit` or the timeout while collecting. */
  truncated: boolean;
}

const SNIPPET_CONTEXT = 60;

export async function searchSessions(opts: SessionSearchOptions): Promise<SessionSearchResult> {
  const projects = await readProjects();
  const projectById = new Map(projects.map((p) => [p.id, p] as const));

  const lineHits = (await ripgrepAvailable())
    ? await collectWithRipgrep(opts)
    : await collectInProcess(opts);

  const grouped = new Map<
    string,
    {
      sessionId: string;
      projectId: string;
      filePath: string;
      matches: SessionSearchMatch[];
      messageCounter: number;
    }
  >();

  // Walk hits in `(file, lineNumber)` order so we can compute messageIndex
  // (count of `type === "message"` lines preceding this one) without
  // re-reading entire files. `collectWithRipgrep` and `collectInProcess`
  // both honor that ordering.
  for (const hit of lineHits) {
    const projectId = projectIdFromPath(hit.filePath);
    if (projectId === undefined) continue; // Hit outside the per-project layout
    if (!projectById.has(projectId)) continue; // Orphaned dir from a deleted project

    // Lazy-initialize the per-file group on first hit; its `messageCounter`
    // tracks the running message-line index within that file so
    // subsequent hits in the same file don't have to rescan.
    let group = grouped.get(hit.filePath);
    if (group === undefined) {
      const sessionId = await readSessionIdFromHeader(hit.filePath);
      if (sessionId === undefined) continue; // Corrupt / missing header
      group = {
        sessionId,
        projectId,
        filePath: hit.filePath,
        matches: [],
        messageCounter: 0,
      };
      grouped.set(hit.filePath, group);
    }

    if (group.matches.length >= opts.matchesPerSession) continue;

    const parsed = safeParseLine(hit.line);
    if (parsed === undefined) continue;

    const extracted = extractSnippet(parsed, opts.query);
    if (extracted === undefined) continue;

    // messageIndex tracking: count `type === "message"` lines from the
    // start of the file up to AND INCLUDING this hit. We need to scan
    // the file's intervening lines if we skipped any since the previous
    // hit. The cheap path is "no skipped lines" (consecutive hits) —
    // most queries only hit a handful of distinct lines per file.
    const messageIndex = await advanceMessageIndex(group, hit.lineNumber);
    if (messageIndex === undefined) continue;

    group.matches.push({
      messageIndex,
      messageEnvelopeId: typeof parsed.id === "string" ? parsed.id : undefined,
      kind: extracted.kind,
      snippet: extracted.snippet,
      matchOffset: extracted.matchOffset,
      matchLength: extracted.matchLength,
    });
  }

  const results: SessionSearchResultGroup[] = [];
  let truncated = false;
  // Sort by file mtime (newest first) so recent matches land at the top.
  const fileStats = await Promise.all(
    Array.from(grouped.values()).map(async (g) => ({
      group: g,
      modifiedAt: await fileMtime(g.filePath),
      sessionName: await readSessionNameFromFile(g.filePath),
    })),
  );
  fileStats.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));

  for (const entry of fileStats) {
    if (results.length >= opts.sessionLimit) {
      truncated = true;
      break;
    }
    const project = projectById.get(entry.group.projectId);
    if (project === undefined) continue;
    results.push({
      sessionId: entry.group.sessionId,
      projectId: entry.group.projectId,
      projectName: project.name,
      sessionName: entry.sessionName,
      modifiedAt: entry.modifiedAt,
      matches: entry.group.matches,
    });
  }

  return {
    engine: (await ripgrepAvailable()) ? "ripgrep" : "node",
    results,
    truncated,
  };
}

/* ----------------------------- ripgrep path ----------------------------- */

interface LineHit {
  filePath: string;
  lineNumber: number;
  line: string;
}

interface RipgrepEvent {
  type: "begin" | "match" | "end" | "summary" | "context";
  data?: Record<string, unknown>;
}

async function collectWithRipgrep(opts: SessionSearchOptions): Promise<LineHit[]> {
  // Hits are bounded by the global session limit × per-session matches —
  // a generous ceiling that prevents runaway output without truncating
  // legitimate workloads. The session-grouping pass downstream applies
  // the actual per-session caps.
  const maxLines = opts.sessionLimit * opts.matchesPerSession * 4;

  const args: string[] = [
    "--json",
    "--no-heading",
    "--max-filesize",
    "100M", // session JSONLs can be sizeable
    "--max-count",
    String(maxLines),
    "-i", // case-insensitive — matches the dropdown's "type to find" UX
    "--fixed-strings",
    "--glob",
    "*.jsonl",
    "--",
    opts.query,
    config.sessionDir,
  ];

  return new Promise<LineHit[]>((resolveFn) => {
    const hits: LineHit[] = [];
    const child = spawn("rg", args);
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);

    let buf = "";
    let currentFile: string | undefined;

    const finish = (): void => {
      clearTimeout(timer);
      resolveFn(hits);
    };

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.length > 0) handleEvent(line);
        nl = buf.indexOf("\n");
      }
    });
    child.on("error", () => finish());
    child.on("close", () => finish());

    const handleEvent = (jsonLine: string): void => {
      let event: RipgrepEvent;
      try {
        event = JSON.parse(jsonLine) as RipgrepEvent;
      } catch {
        return;
      }
      if (event.type === "begin") {
        const data = event.data as { path?: { text?: string } } | undefined;
        currentFile = data?.path?.text;
      } else if (event.type === "match" && currentFile !== undefined) {
        if (hits.length >= maxLines) {
          child.kill("SIGTERM");
          return;
        }
        const data = event.data as { lines?: { text?: string }; line_number?: number } | undefined;
        if (data === undefined) return;
        const lineText = data.lines?.text ?? "";
        const lineNumber = data.line_number ?? 0;
        if (lineNumber === 0) return;
        hits.push({
          filePath: currentFile,
          lineNumber,
          line: stripTrailingNewline(lineText),
        });
      }
    };
  });
}

/* ----------------------------- in-process path ----------------------------- */

async function collectInProcess(opts: SessionSearchOptions): Promise<LineHit[]> {
  const hits: LineHit[] = [];
  const deadline = Date.now() + opts.timeoutMs;
  const needle = opts.query.toLowerCase();
  const maxLines = opts.sessionLimit * opts.matchesPerSession * 4;

  let projectDirs: string[];
  try {
    projectDirs = await readdir(config.sessionDir);
  } catch {
    return hits; // Session dir doesn't exist yet — empty result is fine.
  }

  for (const projectDir of projectDirs) {
    if (Date.now() >= deadline || hits.length >= maxLines) break;
    const fullDir = join(config.sessionDir, projectDir);
    let entries;
    try {
      entries = await readdir(fullDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (Date.now() >= deadline || hits.length >= maxLines) break;
      if (!ent.isFile() || !ent.name.endsWith(".jsonl")) continue;
      const filePath = join(fullDir, ent.name);
      let content: string;
      try {
        content = await readFile(filePath, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (Date.now() >= deadline || hits.length >= maxLines) break;
        const line = lines[i] ?? "";
        if (line.length === 0) continue;
        if (line.toLowerCase().includes(needle)) {
          hits.push({ filePath, lineNumber: i + 1, line });
        }
      }
    }
  }

  return hits;
}

/* ----------------------------- parsing helpers ----------------------------- */

interface ParsedLine {
  type?: unknown;
  id?: unknown;
  message?: { role?: unknown; content?: unknown };
}

function safeParseLine(line: string): ParsedLine | undefined {
  try {
    return JSON.parse(line) as ParsedLine;
  } catch {
    return undefined;
  }
}

interface ExtractedMatch {
  kind: "user" | "assistant" | "tool_call";
  snippet: string;
  matchOffset: number;
  matchLength: number;
}

function extractSnippet(parsed: ParsedLine, query: string): ExtractedMatch | undefined {
  if (parsed.type !== "message") return undefined;
  const msg = parsed.message;
  if (msg === undefined || msg === null || typeof msg !== "object") return undefined;
  const role = (msg as { role?: unknown }).role;
  if (role !== "user" && role !== "assistant") return undefined;
  const content = (msg as { content?: unknown }).content;

  // String content is the simple "user typed text" shape some SDK
  // versions still emit. Treat as a single text block.
  if (typeof content === "string") {
    const hit = findMatch(content, query);
    if (hit === undefined) return undefined;
    return {
      kind: role === "user" ? "user" : "assistant",
      snippet: clipSnippet(content, hit.offset, query.length),
      matchOffset: clippedMatchOffset(content, hit.offset),
      matchLength: query.length,
    };
  }
  if (!Array.isArray(content)) return undefined;

  // Walk content blocks. Prefer text-block matches (most readable).
  // If no text block matches but a toolCall does, surface the rendered
  // tool form as the snippet.
  for (const block of content) {
    if (block === undefined || block === null || typeof block !== "object") continue;
    const b = block as { type?: unknown; text?: unknown };
    if (b.type === "text" && typeof b.text === "string") {
      const hit = findMatch(b.text, query);
      if (hit !== undefined) {
        return {
          kind: role === "user" ? "user" : "assistant",
          snippet: clipSnippet(b.text, hit.offset, query.length),
          matchOffset: clippedMatchOffset(b.text, hit.offset),
          matchLength: query.length,
        };
      }
    }
  }

  // Tool-call fallback: only assistants emit toolCall blocks.
  if (role === "assistant") {
    for (const block of content) {
      if (block === undefined || block === null || typeof block !== "object") continue;
      const b = block as { type?: unknown; name?: unknown; arguments?: unknown; input?: unknown };
      if (b.type !== "toolCall") continue;
      const rendered = renderToolCall(b);
      const hit = findMatch(rendered, query);
      if (hit === undefined) continue;
      return {
        kind: "tool_call",
        snippet: clipSnippet(rendered, hit.offset, query.length),
        matchOffset: clippedMatchOffset(rendered, hit.offset),
        matchLength: query.length,
      };
    }
  }

  return undefined;
}

function renderToolCall(block: { name?: unknown; arguments?: unknown; input?: unknown }): string {
  const name = typeof block.name === "string" ? block.name : "tool";
  const args = (block.arguments ?? block.input) as Record<string, unknown> | undefined;
  if (args === undefined || args === null || typeof args !== "object") return name + "()";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null) continue;
    let s: string;
    if (typeof v === "string") s = v;
    else if (typeof v === "number" || typeof v === "boolean") s = String(v);
    else s = JSON.stringify(v);
    if (s.length > 200) s = s.slice(0, 200) + "…";
    parts.push(`${k}=${s}`);
  }
  return `${name}(${parts.join(", ")})`;
}

function findMatch(haystack: string, query: string): { offset: number } | undefined {
  const i = haystack.toLowerCase().indexOf(query.toLowerCase());
  if (i === -1) return undefined;
  return { offset: i };
}

function clipSnippet(source: string, matchOffset: number, matchLength: number): string {
  const start = Math.max(0, matchOffset - SNIPPET_CONTEXT);
  const end = Math.min(source.length, matchOffset + matchLength + SNIPPET_CONTEXT);
  let snippet = source.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) snippet = "…" + snippet;
  if (end < source.length) snippet = snippet + "…";
  return snippet;
}

function clippedMatchOffset(source: string, matchOffset: number): number {
  // The clipped snippet always centers the match (with possible "…"
  // prefix). Compute the new offset relative to the snippet so the
  // client can highlight the exact substring.
  const start = Math.max(0, matchOffset - SNIPPET_CONTEXT);
  const prefixEllipsis = start > 0 ? 1 : 0;
  const original = source.slice(start, matchOffset);
  const collapsed = original.replace(/\s+/g, " ").replace(/^\s+/, "");
  return prefixEllipsis + collapsed.length;
}

/* ----------------------------- file walking ----------------------------- */

const headerCache = new Map<string, string | undefined>();
const nameCache = new Map<string, string | undefined>();
const messageIndexCache = new Map<string, number[]>();

async function readSessionIdFromHeader(filePath: string): Promise<string | undefined> {
  if (headerCache.has(filePath)) return headerCache.get(filePath);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    headerCache.set(filePath, undefined);
    return undefined;
  }
  const firstNl = content.indexOf("\n");
  const firstLine = firstNl === -1 ? content : content.slice(0, firstNl);
  let header: { type?: unknown; id?: unknown };
  try {
    header = JSON.parse(firstLine) as { type?: unknown; id?: unknown };
  } catch {
    headerCache.set(filePath, undefined);
    return undefined;
  }
  if (header.type !== "session" || typeof header.id !== "string") {
    headerCache.set(filePath, undefined);
    return undefined;
  }
  headerCache.set(filePath, header.id);
  return header.id;
}

async function readSessionNameFromFile(filePath: string): Promise<string | undefined> {
  if (nameCache.has(filePath)) return nameCache.get(filePath);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    nameCache.set(filePath, undefined);
    return undefined;
  }
  const lines = content.split("\n");
  for (const line of lines) {
    if (line.length === 0) continue;
    let parsed: { type?: unknown; name?: unknown };
    try {
      parsed = JSON.parse(line) as { type?: unknown; name?: unknown };
    } catch {
      continue;
    }
    if (parsed.type === "session_info" && typeof parsed.name === "string") {
      nameCache.set(filePath, parsed.name);
      return parsed.name;
    }
  }
  nameCache.set(filePath, undefined);
  return undefined;
}

async function fileMtime(filePath: string): Promise<string> {
  try {
    const { stat } = await import("node:fs/promises");
    const s = await stat(filePath);
    return s.mtime.toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function projectIdFromPath(filePath: string): string | undefined {
  // ${SESSION_DIR}/<projectId>/<file>.jsonl — projectId is the
  // immediate parent dir. Subagent child JSONLs live one level deeper
  // and we ignore them here (their parent's main session is what we
  // surface in search results).
  const sessionDir = config.sessionDir;
  if (!filePath.startsWith(sessionDir)) return undefined;
  const rel = filePath.slice(sessionDir.length).replace(/^[/\\]+/, "");
  const parts = rel.split(/[/\\]/);
  if (parts.length < 2) return undefined;
  if (parts.length > 2) return undefined; // Subagent child — skip
  return parts[0];
}

/**
 * Scan from the file's last-known message-line cursor up to the line
 * containing this hit, counting `type === "message"` lines. Returns the
 * 0-based index of the message at `lineNumber` (or undefined if that
 * line isn't a message line).
 */
async function advanceMessageIndex(
  group: { filePath: string; messageCounter: number },
  lineNumber: number,
): Promise<number | undefined> {
  const cached = messageIndexCache.get(group.filePath);
  if (cached !== undefined) {
    // Cached layout: array of all message-line numbers (1-based) in
    // the file. Binary-search to find the index for this line.
    const idx = cached.indexOf(lineNumber);
    return idx === -1 ? undefined : idx;
  }
  let content: string;
  try {
    content = await readFile(group.filePath, "utf8");
  } catch {
    return undefined;
  }
  const messageLines: number[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length === 0) continue;
    // Cheap pre-check before JSON.parse: every message line starts
    // with `{"type":"message"`. Skipping the parse for non-message
    // lines is a 10× speedup on long sessions.
    if (!line.startsWith('{"type":"message"')) continue;
    messageLines.push(i + 1); // 1-based to match ripgrep
  }
  messageIndexCache.set(group.filePath, messageLines);
  const idx = messageLines.indexOf(lineNumber);
  return idx === -1 ? undefined : idx;
}

function stripTrailingNewline(s: string): string {
  if (s.endsWith("\r\n")) return s.slice(0, -2);
  if (s.endsWith("\n")) return s.slice(0, -1);
  return s;
}

/** Test-only: drop all per-file caches between assertions. */
export function _resetSessionSearcherCaches(): void {
  headerCache.clear();
  nameCache.clear();
  messageIndexCache.clear();
}

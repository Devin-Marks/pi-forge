/**
 * Parse the `details` payload of a `subagent` tool result message into
 * the shape the SubagentResultCard renders. Pure function — defensive
 * enough to handle malformed details (returns an empty array) so a
 * future pi-subagents schema bump can't crash the chat view.
 *
 * Reference for the shape: pi-subagents `src/shared/types.ts` defines
 * `Details { mode, runId?, context?, results: SingleResult[] }` where
 * each `SingleResult` carries `agent`, `task`, `exitCode`, optional
 * `sessionFile` (absolute path to the child JSONL — we extract the
 * filename's UUID stem as the child sessionId), and optional
 * `finalOutput`. Management-mode calls (`action: "list" | ...`) use the
 * same tool name but have `mode: "management"` and no `results[].sessionFile`.
 */

export type SubagentMode = "single" | "parallel" | "chain" | "management" | "unknown";
export type SubagentContext = "fresh" | "fork" | undefined;

export interface SubagentResult {
  agent: string;
  task: string;
  exitCode: number;
  /** Best-effort sessionId derived from the basename of `sessionFile`. */
  sessionId?: string;
  /** Absolute path on the server's disk — surfaced for tooltips. */
  sessionFile?: string;
  finalOutput?: string;
}

export interface SubagentDetails {
  mode: SubagentMode;
  runId?: string;
  context?: SubagentContext;
  results: SubagentResult[];
}

export interface SubagentNotifyDetails {
  agent: string;
  status: "completed" | "failed" | "paused";
  taskInfo?: string;
  resultPreview: string;
  durationMs?: number;
  sessionLabel?: string;
  sessionValue?: string;
}

const VALID_MODES: ReadonlySet<SubagentMode> = new Set([
  "single",
  "parallel",
  "chain",
  "management",
]);

/**
 * Extract the child sessionId from an absolute JSONL path. pi-subagents
 * names files `<uuid>.jsonl`, so we take the basename without the
 * extension. Returns undefined if the path doesn't end in `.jsonl`.
 */
function sessionIdFromFile(file: string): string | undefined {
  if (!file.endsWith(".jsonl")) return undefined;
  // Use POSIX basename rules — pi-subagents writes paths in OS-native
  // form, but on every platform the last separator is reliably `/` or `\`.
  const lastSlash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
  const stem = base.slice(0, -".jsonl".length);
  if (stem.length === 0) return undefined;
  return stem;
}

export function parseSubagentNotify(
  content: unknown,
  details?: unknown,
): SubagentNotifyDetails | undefined {
  if (typeof details === "object" && details !== null) {
    const d = details as {
      agent?: unknown;
      status?: unknown;
      taskInfo?: unknown;
      resultPreview?: unknown;
      durationMs?: unknown;
      sessionLabel?: unknown;
      sessionValue?: unknown;
    };
    if (
      typeof d.agent === "string" &&
      (d.status === "completed" || d.status === "failed" || d.status === "paused") &&
      typeof d.resultPreview === "string"
    ) {
      const out: SubagentNotifyDetails = {
        agent: d.agent,
        status: d.status,
        resultPreview: d.resultPreview,
      };
      if (typeof d.taskInfo === "string") out.taskInfo = d.taskInfo;
      if (typeof d.durationMs === "number") out.durationMs = d.durationMs;
      if (typeof d.sessionLabel === "string") out.sessionLabel = d.sessionLabel;
      if (typeof d.sessionValue === "string") out.sessionValue = d.sessionValue;
      return out;
    }
  }

  if (typeof content !== "string") return undefined;
  const lines = content.split("\n");
  const header = lines[0] ?? "";
  const match =
    /^Background task (completed|failed|paused): \*\*(.+?)\*\*(?:\s+(\([^)]*\)))?$/.exec(header);
  if (match === null) return undefined;
  const body = lines.slice(2);
  let sessionIndex = -1;
  for (let i = body.length - 1; i >= 1; i--) {
    if (
      body[i - 1]?.trim() === "" &&
      /^(Session|Session file|Session share error):\s+/.test(body[i]!)
    ) {
      sessionIndex = i;
      break;
    }
  }
  const sessionLine = sessionIndex >= 0 ? body[sessionIndex] : undefined;
  const resultLines = sessionIndex >= 0 ? body.slice(0, sessionIndex) : body;
  const resultPreview = resultLines.join("\n").trim() || "(no output)";
  let sessionLabel: string | undefined;
  let sessionValue: string | undefined;
  if (sessionLine !== undefined) {
    const separator = sessionLine.indexOf(":");
    sessionLabel = sessionLine.slice(0, separator).toLowerCase();
    sessionValue = sessionLine.slice(separator + 1).trim();
  }
  return {
    agent: match[2]!,
    status: match[1] as SubagentNotifyDetails["status"],
    ...(match[3] !== undefined ? { taskInfo: match[3] } : {}),
    resultPreview,
    ...(sessionLabel !== undefined && sessionValue !== undefined
      ? { sessionLabel, sessionValue }
      : {}),
  };
}

export function parseSubagentDetails(details: unknown): SubagentDetails {
  if (typeof details !== "object" || details === null) {
    return { mode: "unknown", results: [] };
  }
  const d = details as { mode?: unknown; runId?: unknown; context?: unknown; results?: unknown };
  const mode: SubagentMode = VALID_MODES.has(d.mode as SubagentMode)
    ? (d.mode as SubagentMode)
    : "unknown";
  const runId = typeof d.runId === "string" && d.runId.length > 0 ? d.runId : undefined;
  const context: SubagentContext =
    d.context === "fresh" || d.context === "fork" ? d.context : undefined;
  const results: SubagentResult[] = [];
  if (Array.isArray(d.results)) {
    for (const r of d.results) {
      if (typeof r !== "object" || r === null) continue;
      const o = r as {
        agent?: unknown;
        task?: unknown;
        exitCode?: unknown;
        sessionFile?: unknown;
        finalOutput?: unknown;
      };
      const item: SubagentResult = {
        agent: typeof o.agent === "string" ? o.agent : "agent",
        task: typeof o.task === "string" ? o.task : "",
        exitCode: typeof o.exitCode === "number" ? o.exitCode : 0,
      };
      if (typeof o.sessionFile === "string" && o.sessionFile.length > 0) {
        item.sessionFile = o.sessionFile;
        const id = sessionIdFromFile(o.sessionFile);
        if (id !== undefined) item.sessionId = id;
      }
      if (typeof o.finalOutput === "string" && o.finalOutput.length > 0) {
        item.finalOutput = o.finalOutput;
      }
      results.push(item);
    }
  }
  // Canonical key order: mode, runId?, context?, results — matches the
  // pi-subagents Details type declaration order so JSON.stringify
  // output is stable across versions for tests + log readability.
  // JS object literals preserve insertion order; the spreads below
  // skip the optional keys cleanly when undefined.
  return {
    mode,
    ...(runId !== undefined ? { runId } : {}),
    ...(context !== undefined ? { context } : {}),
    results,
  };
}

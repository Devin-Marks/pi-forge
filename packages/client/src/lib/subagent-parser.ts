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

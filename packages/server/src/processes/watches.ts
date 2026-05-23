import type { LogWatch, LogWatchMatchEvent, LogWatchStream } from "./types.js";

/**
 * Compiled log-watch with the original index preserved (so the
 * match event can carry it for the agent's reference) and a
 * `fired` flag for single-fire semantics. Mutable per-process.
 */
export interface CompiledWatch {
  index: number;
  pattern: string;
  stream: LogWatchStream;
  repeat: boolean;
  regex: RegExp;
  fired: boolean;
}

/**
 * Compile the agent-supplied watches. Validation lives at the
 * tool boundary (see tool.ts); this function trusts shape +
 * regex validity and just normalises defaults.
 */
export function compileWatches(input: readonly LogWatch[] | undefined): CompiledWatch[] {
  if (input === undefined) return [];
  return input.map((w, i) => ({
    index: i,
    pattern: w.pattern,
    stream: w.stream ?? "both",
    repeat: w.repeat === true,
    regex: new RegExp(w.pattern),
    fired: false,
  }));
}

/**
 * Run a freshly-emitted line against the compiled set. Returns
 * the watches that matched AND are eligible to fire (skipping
 * single-fire watches that already fired). Mutates `fired` for
 * matched single-fire watches so the same line stream of repeats
 * doesn't keep alerting.
 */
export function evaluateWatches(
  watches: CompiledWatch[],
  source: "stdout" | "stderr",
  line: string,
): CompiledWatch[] {
  const hits: CompiledWatch[] = [];
  for (const w of watches) {
    if (w.stream !== "both" && w.stream !== source) continue;
    if (!w.repeat && w.fired) continue;
    if (!w.regex.test(line)) continue;
    if (!w.repeat) w.fired = true;
    hits.push(w);
  }
  return hits;
}

/**
 * Build the wire shape for a single match. Used by the manager
 * when it fans out a `process_watch_matched` event.
 */
export function buildMatchEvent(
  watch: CompiledWatch,
  processId: string,
  processName: string,
  processCommand: string,
  source: "stdout" | "stderr",
  line: string,
): LogWatchMatchEvent {
  return {
    processId,
    processName,
    processCommand,
    source,
    line,
    watch: {
      index: watch.index,
      pattern: watch.pattern,
      stream: watch.stream,
      repeat: watch.repeat,
    },
  };
}

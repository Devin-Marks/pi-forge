/**
 * Parse a `git diff` unified-diff string into per-line decorations
 * keyed against NEW-FILE line numbers (1-based).
 *
 * Mirrors VS Code's gutter rules so the visual treatment is familiar:
 *   - A run of `+` lines with no preceding `-` run is `added`.
 *   - A run of `-` lines followed by `+` lines pairs them — paired
 *     adds become `modified`, leftover deletes become `deletedAbove`.
 *   - A run of `-` lines with no following `+` becomes a single
 *     `deletedAbove` marker on the new-file line directly below the
 *     deletion (the line that's still in the file).
 *
 * Why mark deletions on the line BELOW: the deleted line itself is
 * gone — there's nothing to highlight. VS Code uses a small triangle
 * pointing at the boundary between the surviving line and where the
 * deleted lines used to be. We render the same idea by attaching a
 * single marker at the new-file line that took the deletion's slot.
 *
 * Pure function — no DOM, no async, no side effects. Easy to unit-test
 * (see `tests/test-diff-parser.ts`).
 */

export type DiffLineKind = "added" | "modified" | "deletedAbove";

export interface DiffLine {
  /** 1-based line number in the new (current) file. */
  line: number;
  kind: DiffLineKind;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (diff.length === 0) return [];
  // newLine = the new-file line about to be processed when we hit a
  // ' ' (context) or '+' (addition). Set by every hunk header.
  let newLine = 0;
  // Counter of `-` lines waiting to be paired with `+` lines in the
  // same run. Reset whenever the run breaks (context line, or hunk
  // boundary, or end of file).
  let pendingDeletes = 0;

  // De-dupe: if the same line ends up tagged twice (shouldn't happen in
  // a well-formed unified diff, but defensive against odd inputs),
  // `modified` wins over `added` over `deletedAbove`. Bucket keyed by
  // line number so insertion order doesn't matter.
  const byLine = new Map<number, DiffLineKind>();
  const emit = (line: number, kind: DiffLineKind): void => {
    const prev = byLine.get(line);
    if (prev === "modified") return;
    if (prev === "added" && kind === "deletedAbove") return;
    byLine.set(line, kind);
  };

  // Flush a pending-delete run as a single deletedAbove marker at the
  // current new-file line. Used at context boundaries, hunk
  // boundaries, and end of input. If we're past the last line of the
  // file (deletion at EOF), the gutter renderer clamps to the last
  // line — emit at newLine and let the consumer handle clamping.
  const flushPendingDeletes = (): void => {
    if (pendingDeletes === 0) return;
    emit(newLine, "deletedAbove");
    pendingDeletes = 0;
  };

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("@@")) {
      flushPendingDeletes();
      const m = HUNK_HEADER.exec(raw);
      if (m === null) continue;
      // m[1] is the +newStart. Set newLine to the first new-file line
      // in this hunk; subsequent ' ' / '+' lines will increment it.
      newLine = Number.parseInt(m[1] ?? "0", 10);
      pendingDeletes = 0;
      continue;
    }
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file" — metadata, doesn't advance
      // either side's line counter.
      continue;
    }
    // Lines that aren't part of any hunk (file headers like
    // `diff --git`, `index`, `---`, `+++`, blank lines between
    // multi-file diffs) appear before the first hunk header. Once
    // newLine === 0 we know we haven't entered a hunk yet and should
    // skip them all. After the first hunk, the only first-char prefixes
    // we expect are space/+/-/@/\.
    if (newLine === 0) continue;
    const prefix = raw.charAt(0);
    if (prefix === " ") {
      flushPendingDeletes();
      newLine += 1;
    } else if (prefix === "-") {
      pendingDeletes += 1;
    } else if (prefix === "+") {
      if (pendingDeletes > 0) {
        emit(newLine, "modified");
        pendingDeletes -= 1;
      } else {
        emit(newLine, "added");
      }
      newLine += 1;
    }
    // Other prefixes (file header noise that slipped past) — ignore.
  }
  flushPendingDeletes();

  // Sort by line so the output is stable and easy to assert in tests.
  return Array.from(byLine.entries())
    .map(([line, kind]) => ({ line, kind }))
    .sort((a, b) => a.line - b.line);
}

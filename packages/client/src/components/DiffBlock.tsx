import { useState } from "react";
import {
  Decoration,
  Diff,
  Hunk,
  parseDiff,
  type FileData,
  type HunkData,
  type RenderGutter,
} from "react-diff-view";
import "react-diff-view/style/index.css";
import { highlightHunks, languageForFile } from "../lib/diff-highlight";

/**
 * Optional per-hunk action handler. When supplied, DiffBlock renders
 * a small button above each hunk header (via react-diff-view's
 * `Decoration` slot, which is the only insertion point that doesn't
 * break the table layout). Used by GitPanel for hunk-level
 * stage / unstage; ignored elsewhere so chat / turn-diff diffs stay
 * action-free.
 *
 * `hunkIndex` is 0-based within the SAME file's hunks — i.e. the
 * position the server's `/git/apply-hunks` endpoint expects. Multi-
 * file diffs would need per-file index resets, but the consumers
 * that pass an action only ever render single-file diffs.
 */
export interface HunkActionProps {
  // exactOptionalPropertyTypes: true requires the explicit `| undefined`
  // so parents can pass through possibly-undefined props without a
  // conditional spread at every call site.
  onHunkAction?: ((hunkIndex: number) => void) | undefined;
  hunkActionLabel?: string | undefined;
  /** Set true to grey-out the button while the parent's request is in-flight. */
  hunkActionDisabled?: boolean | undefined;
}

/**
 * Soft cap on rendered changes per file before we collapse the rest
 * behind a "show all" affordance. parseDiff is already done by the
 * time we reach this point, so the cost we're avoiding is in
 * react-diff-view's per-row React work + the layout + the optional
 * tokenize call. ~800 visible lines is about the limit before scroll
 * + paint becomes noticeable on a mid-range laptop.
 */
const LARGE_FILE_LINE_THRESHOLD = 800;

/**
 * Gutter renderer for unified-mode diffs. `react-diff-view`'s
 * default unified mode renders TWO gutter columns (old + new) on
 * every row, which is noisy in our narrow layouts. We collapse to
 * one column by returning `null` for `side: "old"` (CSS in
 * `index.css`, scoped to `.pi-diff-unified`, then hides the column
 * entirely) and rendering the line number on `side: "new"`.
 *
 * gitdiff-parser's `ChangeData` is a discriminated union with
 * different shapes per type:
 *   - `normal` (context): `oldLineNumber` + `newLineNumber` (both
 *     numbers; we show new since it matches the post-edit file).
 *   - `insert`: just `lineNumber` (the new file's line).
 *   - `delete`: just `lineNumber` (the old file's line).
 */
const renderUnifiedGutter: RenderGutter = ({ change, side }) => {
  if (side === "old") return null;
  const num = change.type === "normal" ? change.newLineNumber : change.lineNumber;
  if (num === undefined) return null;
  return <span>{num}</span>;
};

/**
 * Gutter renderer for split-mode diffs. Both columns render — left
 * gets the old line number, right gets the new. Context rows show
 * both; insert rows leave the old gutter blank; delete rows leave
 * the new gutter blank.
 */
const renderSplitGutter: RenderGutter = ({ change, side }) => {
  if (change.type === "normal") {
    const num = side === "old" ? change.oldLineNumber : change.newLineNumber;
    return <span>{num}</span>;
  }
  if (change.type === "insert" && side === "new") return <span>{change.lineNumber}</span>;
  if (change.type === "delete" && side === "old") return <span>{change.lineNumber}</span>;
  return null;
};

/**
 * Reusable unified-diff renderer used by both the inline ChatView
 * edit-tool result and the TurnDiffPanel. Wraps `react-diff-view`'s
 * `Diff` + `Hunk` primitives with our dark-theme overrides.
 *
 * Render-path resolution (in order):
 *   1. Pi-format detection — pi's edit tool emits a humanized
 *      line-numbered display (`<marker><line-num> <content>`, no
 *      `@@`/`---` headers). Convert to canonical unified diff and
 *      try `parseDiff` against THAT. This is what we hit in practice.
 *   2. `parseDiff` on the raw input. Real unified diffs land here.
 *   3. Synthesize a `--- /+++` header for inputs that have `@@`
 *      hunks but no file header.
 *   4. Colored `<pre>` fallback — at least the +/- markers stay
 *      visible even if we can't structurally parse.
 *
 * Anything that lands in #4 also logs a console warning with the
 * first 200 chars so we can identify a NEW unhandled format.
 *
 * Syntax highlighting via `prism-react-renderer` is intentionally
 * deferred to a future polish pass — see `Dif1` in DEFERRED.md.
 */
export function DiffBlock({
  diff,
  viewType = "unified",
  onHunkAction,
  hunkActionLabel,
  hunkActionDisabled,
}: {
  diff: string;
  /**
   * Caller's chosen rendering mode. Each panel that hosts diffs owns
   * its own view-type preference (TurnDiffPanel uses
   * `pi.turnDiff.viewType`, GitPanel uses `pi.gitPanel.viewType`,
   * ChatView uses `pi.chat.viewType`) — DiffBlock is purely
   * controlled and never reads the prefs itself.
   */
  viewType?: "unified" | "split";
} & HunkActionProps) {
  let files: FileData[] = [];
  let strategy: "pi" | "raw" | "synthetic" | "fallback" = "fallback";

  // Path 1: pi humanized format. Tried first because once we know
  // the SDK is using it, every subsequent edit will hit this path
  // and we want the table renderer, not the colored fallback.
  const pi = convertPiFormat(diff);
  if (pi !== undefined) {
    const candidate = safeParse(pi);
    if (hasHunks(candidate)) {
      files = candidate;
      strategy = "pi";
    }
  }

  // Path 2: real unified diff as-is.
  if (strategy === "fallback") {
    const candidate = safeParse(diff);
    if (hasHunks(candidate)) {
      files = candidate;
      strategy = "raw";
    }
  }

  // Path 3: synthesize a file header for hunks-only inputs.
  if (strategy === "fallback" && needsSyntheticHeader(diff)) {
    const candidate = safeParse(SYNTHETIC_HEADER + diff.replace(/^\n+/, ""));
    if (hasHunks(candidate)) {
      files = candidate;
      strategy = "synthetic";
    }
  }

  if (strategy === "fallback") {
    if (typeof console !== "undefined") {
      console.warn(
        "[DiffBlock] parseDiff produced no hunks; rendering colored fallback. Diff prefix:",
        diff.slice(0, 200),
      );
    }
    return <FallbackDiff diff={diff} />;
  }

  const renderGutter = viewType === "split" ? renderSplitGutter : renderUnifiedGutter;
  // Wrapper class drives the CSS that hides the duplicate gutter
  // column in unified mode. Split mode keeps both columns visible.
  const wrapperClass = `pi-diff-block ${
    viewType === "split" ? "pi-diff-split" : "pi-diff-unified"
  } overflow-auto px-2 pb-2 text-[11px]`;
  return (
    <div className={wrapperClass}>
      {files.map((file) => (
        <FileDiff
          key={`${file.oldPath ?? ""}:${file.newPath ?? ""}`}
          file={file}
          viewType={viewType}
          renderGutter={renderGutter}
          onHunkAction={onHunkAction}
          hunkActionLabel={hunkActionLabel}
          hunkActionDisabled={hunkActionDisabled}
        />
      ))}
    </div>
  );
}

/**
 * One file's worth of diff. Lifted into its own component so the
 * "expand large diff" toggle can hold local state per file (multiple
 * files in the same diff each get their own collapsed/expanded
 * state).
 */
function FileDiff({
  file,
  viewType,
  renderGutter,
  onHunkAction,
  hunkActionLabel,
  hunkActionDisabled,
}: {
  file: FileData;
  viewType: "unified" | "split";
  renderGutter: RenderGutter;
} & HunkActionProps) {
  const [expanded, setExpanded] = useState(false);
  // Filename for syntax-highlighter selection. The diff header
  // uses `a/<path>` and `b/<path>` conventionally; strip the
  // `b/` prefix when present so `.tsx` etc. resolves correctly.
  // Falls back to oldPath for pure deletions.
  const filename = (file.newPath ?? file.oldPath ?? "").replace(/^[ab]\//, "");
  const language = languageForFile(filename);
  const totalChanges = file.hunks.reduce((acc, h) => acc + h.changes.length, 0);
  const isLarge = totalChanges > LARGE_FILE_LINE_THRESHOLD && !expanded;
  const visibleHunks = isLarge
    ? truncateHunksToBudget(file.hunks, LARGE_FILE_LINE_THRESHOLD)
    : file.hunks;
  const tokens = highlightHunks(visibleHunks, language);
  return (
    <>
      <Diff
        viewType={viewType}
        diffType={file.type}
        hunks={visibleHunks}
        renderGutter={renderGutter}
        // Diff's prop accepts `HunkTokens | null`, not `| undefined`.
        // Coerce so unhighlighted languages still render plainly.
        tokens={tokens ?? null}
      >
        {(hunks) => {
          // The Diff component types its children fn as
          // `(hunks) => ReactElement | ReactElement[]`. We need to
          // emit two elements per hunk (Decoration + Hunk) when the
          // action prop is set, so we build a flat ReactElement[]
          // and rely on the runtime accepting it; the explicit cast
          // sidesteps the narrower compile-time signature.
          const out: React.ReactElement[] = [];
          hunks.forEach((hunk, idx) => {
            // When the parent doesn't supply an action, render exactly
            // what we always have — no extra DOM. Hunk index here is
            // the position WITHIN this file's hunks, which matches
            // what /git/apply-hunks expects.
            if (onHunkAction !== undefined) {
              // Slim action strip rendered above each hunk via
              // react-diff-view's Decoration slot. Single-line
              // height (no extra vertical padding) so it doesn't
              // dominate the diff; blue accent keeps it visible
              // without being garish.
              out.push(
                <Decoration key={`dec-${hunk.content}`}>
                  <div className="flex items-center justify-between gap-2 border-y border-blue-700/30 bg-blue-950/30 px-2 py-px leading-none">
                    <span className="text-[9px] uppercase tracking-wider text-blue-400">
                      Hunk {idx + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => onHunkAction(idx)}
                      disabled={hunkActionDisabled === true}
                      className="rounded border border-blue-500/50 bg-blue-900/40 px-1.5 py-px text-[10px] text-blue-100 hover:border-blue-400 hover:bg-blue-800/60 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {hunkActionLabel ?? "Apply hunk"}
                    </button>
                  </div>
                </Decoration>,
              );
            }
            out.push(<Hunk key={hunk.content} hunk={hunk} />);
          });
          return out;
        }}
      </Diff>
      {isLarge && (
        <button
          onClick={() => setExpanded(true)}
          className="my-1 w-full rounded border border-neutral-700 bg-neutral-900/60 px-3 py-1 text-[11px] text-neutral-300 hover:border-neutral-500 hover:bg-neutral-900"
          title={`Showing ~${LARGE_FILE_LINE_THRESHOLD} of ${totalChanges} lines — large diffs slow the renderer; click to render the rest.`}
        >
          Show all ({totalChanges} lines, {file.hunks.length} hunks)
        </button>
      )}
    </>
  );
}

/**
 * Slice `hunks` so the cumulative `changes.length` stays under
 * `budget`. Keeps whole hunks (no mid-hunk truncation) so the
 * rendered region is always a valid diff. If the first hunk alone
 * blows the budget we still emit it — better to over-render than
 * to render nothing.
 */
function truncateHunksToBudget(hunks: HunkData[], budget: number): HunkData[] {
  const out: HunkData[] = [];
  let used = 0;
  for (const h of hunks) {
    // First check guards "would adding this exceed budget?" but only
    // after we've already emitted at least one hunk (so the
    // first-hunk-blows-budget case still gets rendered, matching the
    // doc-comment promise). Second check exits early once we're at
    // or above budget on the way out — saves walking through any
    // remaining tiny hunks.
    if (out.length > 0 && used + h.changes.length > budget) break;
    out.push(h);
    used += h.changes.length;
    if (used >= budget) break;
  }
  return out;
}

/**
 * Synthetic file header used when the input has hunks but no
 * `--- /+++` header. The path is a placeholder — `react-diff-view`
 * uses it as a key but doesn't render it (we never show file
 * headers in our chat / panel layouts; the parent component shows
 * the filename next to the +/- counts already).
 */
const SYNTHETIC_HEADER = "--- a/file\n+++ b/file\n";

/**
 * Convert pi's humanized edit display into a canonical unified
 * diff. Pi's format (defined in `pi-coding-agent`'s
 * `edit-diff.ts#generateDiffString`):
 *
 *   ` 1 # comment`        ← context (space marker, padded line-num, content)
 *   ` 2 def main():`
 *   `- 3     print('old')` ← removal (line-num is space-padded to file width)
 *   `+ 3     print('new')` ← addition
 *   ` 4`                   ← blank-line context (no content after num)
 *   `   ...`               ← skipped-context separator (≥3 spaces + literal "...")
 *   ` 30 # later in file`  ← context resumes at a higher line number
 *
 * The line number is space-padded to the width needed to display
 * the largest line number in the file, so e.g. 1000-line files
 * emit `- 999 ...` not `-999 ...`. The `...` marker appears between
 * two changes more than 8 context lines apart (default 4-around);
 * we treat each `...` as a HUNK BOUNDARY so the resulting unified
 * diff has accurate per-hunk line numbers.
 *
 * Returns `undefined` if any non-empty, non-skip-marker input line
 * doesn't match the pattern — the signal "this isn't pi format,
 * try something else." Returns a multi-hunk unified diff on success.
 *
 * Each hunk's `oldStart` / `newStart` come from the FIRST line of
 * that hunk. Pi always emits at least one context line at the start
 * of each rendered region (4-line default), so the first line is
 * almost always context where old==new. Edge-case hunks that begin
 * with a change immediately would have one of the starts off by
 * one — acceptable for review purposes.
 */
function convertPiFormat(diff: string): string | undefined {
  const lines = diff.split("\n");
  // Marker, optional space-padding, digits, optional " content".
  const lineRe = /^([+\- ]) *(\d+)(?: (.*))?$/;
  // Skipped-context marker: leading spaces (the empty padded
  // line-num column + the separator), then literal "...". Pi emits
  // at least 3 leading spaces (1 marker space + ≥1 padded space + 1
  // separator); we accept ≥1 to be lenient.
  const skipRe = /^ +\.\.\.$/;

  interface Hunk {
    oldStart: number;
    newStart: number;
    oldCount: number;
    newCount: number;
    body: string[];
  }
  const hunks: Hunk[] = [];
  let cur: Hunk | undefined;
  let matched = 0;

  const flush = (): void => {
    if (cur !== undefined && cur.body.length > 0) hunks.push(cur);
    cur = undefined;
  };

  for (const line of lines) {
    if (line.length === 0) continue;
    if (skipRe.test(line)) {
      // Hunk boundary — close the current hunk so the next
      // displayed region gets its own header with the correct
      // line numbers.
      flush();
      continue;
    }
    const m = lineRe.exec(line);
    if (m === null) return undefined;
    matched += 1;
    const marker = m[1] as "+" | "-" | " ";
    const num = Number.parseInt(m[2] ?? "", 10);
    const content = m[3] ?? "";
    if (cur === undefined) {
      // First line of a new hunk: use the displayed line number for
      // both starts. Pi's leading-context-then-change pattern means
      // this is virtually always a context line where old==new.
      cur = { oldStart: num, newStart: num, oldCount: 0, newCount: 0, body: [] };
    }
    if (marker === " ") {
      cur.body.push(" " + content);
      cur.oldCount += 1;
      cur.newCount += 1;
    } else if (marker === "-") {
      cur.body.push("-" + content);
      cur.oldCount += 1;
    } else {
      cur.body.push("+" + content);
      cur.newCount += 1;
    }
  }
  flush();

  if (matched === 0 || hunks.length === 0) return undefined;
  return (
    SYNTHETIC_HEADER +
    hunks
      .map(
        (h) =>
          `@@ -${h.oldStart},${h.oldCount} +${h.newStart},${h.newCount} @@\n` + h.body.join("\n"),
      )
      .join("\n") +
    "\n"
  );
}

function safeParse(diff: string): FileData[] {
  try {
    return parseDiff(diff);
  } catch {
    // gitdiff-parser throws on malformed unified diffs (rare from
    // server but possible from copy/pasted edge cases). Render as
    // an empty file list rather than crashing the whole panel.
    return [];
  }
}

function hasHunks(files: FileData[]): boolean {
  return files.length > 0 && files.some((f) => f.hunks.length > 0);
}

/**
 * True when the diff body contains at least one hunk header but no
 * file header. We require BOTH a `@@` line (so we don't synthesize
 * a header for plain text the user passed in by mistake) AND the
 * absence of `--- ` / `+++ ` lines. Lines starting with `---` or
 * `+++` in unified diffs are always the file headers — content
 * removal/addition lines start with a single `-` / `+`.
 */
function needsSyntheticHeader(diff: string): boolean {
  const hasHunk = /^@@ /m.test(diff);
  const hasHeader = /^--- /m.test(diff) && /^\+\+\+ /m.test(diff);
  return hasHunk && !hasHeader;
}

/**
 * Plain-text fallback that paints diff lines manually. Catches:
 *   - SDK edit results that omit the `--- /+++` headers (parseDiff
 *     skips them but the user still has a clearly-marked unified diff
 *     they want to read)
 *   - Empty or partial diffs
 *   - Anything else parseDiff couldn't make sense of
 *
 * Without this, the chat's edit results rendered as monochrome neutral
 * text — no red for removals, no green for additions. The CSS variables
 * scoped to `.pi-diff-block` only apply when react-diff-view rendered
 * the table; the fallback path needs explicit class colors.
 */
function FallbackDiff({ diff }: { diff: string }) {
  const lines = diff.split("\n");
  return (
    <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] leading-tight">
      {lines.map((line, i) => (
        <div key={i} className={lineClass(line)}>
          {line.length === 0 ? " " : line}
        </div>
      ))}
    </pre>
  );
}

function lineClass(line: string): string {
  // Order matters: check `+++` / `---` BEFORE `+` / `-`.
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-neutral-500";
  }
  if (line.startsWith("@@")) {
    return "bg-neutral-900 text-cyan-400";
  }
  if (line.startsWith("+")) {
    return "bg-emerald-950/60 text-emerald-200";
  }
  if (line.startsWith("-")) {
    return "bg-red-950/60 text-red-200";
  }
  return "text-neutral-400";
}

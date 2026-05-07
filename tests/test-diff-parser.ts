/**
 * Unit tests for `parseUnifiedDiff` — the pure-function input to the
 * editor's git-diff gutter. Pure parser, no DOM, no async — runs in
 * <50ms.
 *
 * Coverage targets:
 *   - Pure additions (no preceding deletes in run)
 *   - Pure deletions (no following adds in run) — emit deletedAbove
 *   - Modified runs (deletes followed by adds) — paired adds become
 *     `modified`; leftover deletes become `deletedAbove`
 *   - Multiple hunks in one diff
 *   - Untracked file (whole file as added)
 *   - Empty diff (clean working tree) — empty result
 *   - Lines that aren't part of any hunk (file headers) — ignored
 *   - "\\ No newline at end of file" trailer — ignored
 *   - Deletion at end of file (newLine ends past doc length)
 *
 * Imports the COMPILED `dist/client/lib/diff-parser.js`? No — the
 * client doesn't ship a separate dist for ts files. Instead we import
 * the .ts source directly via tsx, which the test runner already uses.
 */
import { parseUnifiedDiff, type DiffLine } from "../packages/client/src/lib/diff-parser";

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, `\n    expected: ${e}\n    actual:   ${a}`);
}

function expectChanges(label: string, diff: string, expected: DiffLine[]): void {
  const got = parseUnifiedDiff(diff);
  assertEqual(label, got, expected);
}

// --- Empty / no-op cases ---------------------------------------------

expectChanges("empty string returns empty array", "", []);
expectChanges(
  "clean diff (only headers, no hunks) returns empty",
  [
    "diff --git a/foo.ts b/foo.ts",
    "index abc123..def456 100644",
    "--- a/foo.ts",
    "+++ b/foo.ts",
  ].join("\n"),
  [],
);

// --- Pure additions --------------------------------------------------

expectChanges(
  "pure addition of two lines",
  ["@@ -5,2 +5,4 @@", " context line", "+added one", "+added two", " context line"].join("\n"),
  [
    { line: 6, kind: "added" },
    { line: 7, kind: "added" },
  ],
);

// --- Pure deletions --------------------------------------------------

expectChanges(
  "pure deletion emits a single deletedAbove on the next surviving line",
  ["@@ -5,4 +5,2 @@", " context", "-removed one", "-removed two", " surviving"].join("\n"),
  [{ line: 6, kind: "deletedAbove" }],
);

// --- Modified (paired delete + add) ----------------------------------

expectChanges(
  "delete followed by same-count add → all adds marked modified",
  ["@@ -1,3 +1,3 @@", " context", "-old", "+new", " context"].join("\n"),
  [{ line: 2, kind: "modified" }],
);

expectChanges(
  "delete followed by larger add → paired marked modified, extras added",
  ["@@ -1,3 +1,5 @@", " context", "-old", "+new1", "+new2", "+new3", " context"].join("\n"),
  [
    { line: 2, kind: "modified" },
    { line: 3, kind: "added" },
    { line: 4, kind: "added" },
  ],
);

expectChanges(
  "larger delete than add → paired marked modified, leftover delete emits deletedAbove",
  ["@@ -1,5 +1,3 @@", " context", "-old1", "-old2", "-old3", "+new", " context"].join("\n"),
  [
    { line: 2, kind: "modified" },
    // Two leftover deletes, but they collapse into a single
    // deletedAbove marker on the line below the deletion
    // (parser-side de-dup; the gutter only renders one triangle per
    // surviving line regardless of how many lines were deleted).
    { line: 3, kind: "deletedAbove" },
  ],
);

// --- Multiple hunks --------------------------------------------------

expectChanges(
  "two independent hunks coexist in the output",
  [
    "@@ -1,2 +1,3 @@",
    " context",
    "+added in hunk 1",
    " context",
    "@@ -20,3 +21,3 @@",
    " context",
    "-removed",
    "+replacement",
    " context",
  ].join("\n"),
  [
    { line: 2, kind: "added" },
    { line: 22, kind: "modified" },
  ],
);

// --- Whole-file added (untracked or new) -----------------------------

expectChanges(
  "untracked file shows every line as added",
  [
    "diff --git a/new.ts b/new.ts",
    "new file mode 100644",
    "index 000000..abc123",
    "--- /dev/null",
    "+++ b/new.ts",
    "@@ -0,0 +1,3 @@",
    "+line one",
    "+line two",
    "+line three",
  ].join("\n"),
  [
    { line: 1, kind: "added" },
    { line: 2, kind: "added" },
    { line: 3, kind: "added" },
  ],
);

// --- "\\ No newline at end of file" trailer --------------------------

expectChanges(
  "no-newline marker is ignored — doesn't shift line counters",
  [
    "@@ -1,3 +1,3 @@",
    " context",
    "-old final",
    "\\ No newline at end of file",
    "+new final",
    "\\ No newline at end of file",
  ].join("\n"),
  [{ line: 2, kind: "modified" }],
);

// --- Deletion at end of file -----------------------------------------

expectChanges(
  "deletion at end of file emits deletedAbove past the last line",
  ["@@ -1,3 +1,1 @@", " surviving", "-old1", "-old2"].join("\n"),
  // newLine sits at 2 (one past the surviving line) when we flush —
  // the gutter renderer is responsible for clamping to doc.lines.
  [{ line: 2, kind: "deletedAbove" }],
);

// --- Hunk header parsing ---------------------------------------------

expectChanges(
  "hunk header with single-line counts (no comma) parses correctly",
  // `@@ -42 +42 @@` declares a 1-line hunk — body has exactly one
  // delete + one add, no context (which would be malformed for a
  // length-1 hunk). Common for single-line modifications.
  ["@@ -42 +42 @@", "-old", "+new"].join("\n"),
  [{ line: 42, kind: "modified" }],
);

// --- Final tally -----------------------------------------------------

if (failures > 0) {
  console.log(`\n[test-diff-parser] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[test-diff-parser] PASS");

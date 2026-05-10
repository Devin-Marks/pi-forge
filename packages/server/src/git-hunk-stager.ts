import { spawn } from "node:child_process";
import { getFileDiff } from "./git-runner.js";

/**
 * Hunk-level staging. Builds a synthetic unified diff containing only
 * the user-selected hunks of a file, then feeds it to
 * `git apply --cached [--reverse] --recount` via stdin.
 *
 * Why this works:
 *   - `git apply --cached` updates the index without touching the
 *     working tree — exactly what `git add` does for a whole file.
 *   - `--recount` rewrites the per-hunk line-count fields, so we
 *     don't have to recompute them after subsetting hunks (the line
 *     numbers in `@@ -X,Y +A,B @@` may be stale relative to a partial
 *     patch; git fixes them itself).
 *   - `--reverse` flips the patch so unstaging from the staged-side
 *     diff applies cleanly. Symmetric with stage.
 *
 * Binary files have no `@@` hunks (`git diff` emits
 * `Binary files a/foo and b/foo differ`); we reject upfront so the
 * UI can surface a clear "binary files can't be hunk-staged" error
 * rather than confusing the user with a `git apply` failure mode.
 */

export type ApplyMode = "stage" | "unstage";

export class HunkStagingError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "HunkStagingError";
  }
}

export interface HunkExtractResult {
  /** The synthetic patch ready to feed to `git apply`. */
  patch: string;
  /** Total hunks present in the source diff (for client validation). */
  totalHunks: number;
}

/**
 * Pure helper: split a unified diff into header + hunk blocks and
 * return a synthetic diff containing only the requested hunk indices.
 *
 * - "Header" = every line before the first `@@`. Includes the
 *   `diff --git`, `index`, `---`, `+++` lines that `git apply`
 *   needs to identify the target file.
 * - "Hunk" = a `@@` line and everything until the next `@@` line
 *   (or end of diff).
 *
 * Throws `HunkStagingError` for binary diffs (no `@@`), out-of-range
 * indices, or empty selections — these are bad-input failures the
 * caller should surface to the UI.
 */
export function extractHunks(fullDiff: string, indices: number[]): HunkExtractResult {
  if (indices.length === 0) {
    throw new HunkStagingError("no_hunks_selected", "no hunk indices supplied");
  }
  const lines = fullDiff.split("\n");
  // First @@ marks the start of hunk 0. Header is everything above.
  let firstHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.startsWith("@@")) {
      firstHunk = i;
      break;
    }
  }
  if (firstHunk === -1) {
    throw new HunkStagingError(
      "binary_or_no_hunks",
      "diff has no @@ hunks (binary file or empty diff)",
    );
  }
  const header = lines.slice(0, firstHunk);
  // Walk the rest, splitting on every `@@` line.
  const hunks: string[][] = [];
  let current: string[] = [];
  for (let i = firstHunk; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.startsWith("@@")) {
      if (current.length > 0) hunks.push(current);
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) hunks.push(current);

  for (const idx of indices) {
    if (idx < 0 || idx >= hunks.length) {
      throw new HunkStagingError(
        "hunk_index_out_of_range",
        `hunk index ${idx} out of range [0, ${hunks.length})`,
      );
    }
  }
  // Sort indices ascending so the synthetic patch's hunks remain in
  // file order — `git apply` doesn't strictly require it but it's
  // saner to debug.
  const sorted = Array.from(new Set(indices)).sort((a, b) => a - b);
  const selected: string[] = [...header];
  for (const idx of sorted) {
    const hunk = hunks[idx];
    if (hunk === undefined) continue;
    for (const ln of hunk) selected.push(ln);
  }
  // Ensure trailing newline — git apply is finicky about a missing
  // final \n on the patch input.
  let patch = selected.join("\n");
  if (!patch.endsWith("\n")) patch += "\n";
  return { patch, totalHunks: hunks.length };
}

/**
 * Stage or unstage the selected hunks of a single file. Fetches the
 * current diff for the appropriate side (unstaged-side for stage,
 * staged-side for unstage), extracts the requested hunks, then pipes
 * the synthetic patch into `git apply --cached`.
 */
export async function applyHunks(
  cwd: string,
  path: string,
  indices: number[],
  mode: ApplyMode,
): Promise<{ totalHunks: number }> {
  // Pull from the side the user is acting on. Staging operates on the
  // unstaged-side diff (working tree vs index); unstaging operates on
  // the staged-side diff (index vs HEAD), reversed.
  const diffResult = await getFileDiff(cwd, path, /* staged */ mode === "unstage");
  if (diffResult.diff.length === 0) {
    throw new HunkStagingError(
      "no_diff",
      "file has no diff on the requested side — already staged / unstaged?",
    );
  }
  const { patch, totalHunks } = extractHunks(diffResult.diff, indices);

  const args = ["apply", "--cached", "--recount"];
  if (mode === "unstage") args.push("--reverse");
  // No path arg — the patch's `--- a/...` / `+++ b/...` headers tell
  // git which file to touch. Adding the path here would just confuse
  // git apply on rename-detection cases.

  await runGitWithStdin(cwd, args, patch);
  return { totalHunks };
}

/* ----------------------------- internals ----------------------------- */

/**
 * Spawn `git <args>` with the given stdin content. Resolves on exit 0,
 * rejects with HunkStagingError("git_apply_failed", stderr) otherwise.
 *
 * Why a local helper and not git-runner.runGit: the runner is built
 * for subprocess output capture without a stdin path. This helper
 * keeps the simple "feed a patch in" semantics clean without
 * reshaping the runner API.
 */
function runGitWithStdin(cwd: string, args: string[], stdin: string): Promise<void> {
  return new Promise((resolveFn, rejectFn) => {
    const child = spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      rejectFn(new HunkStagingError("git_spawn_failed", err.message));
    });
    child.on("close", (code) => {
      if (code === 0) resolveFn();
      else {
        rejectFn(
          new HunkStagingError(
            "git_apply_failed",
            stderr.trim().length > 0 ? stderr.trim() : `git apply exited ${code ?? -1}`,
          ),
        );
      }
    });
    child.stdin.end(stdin);
  });
}

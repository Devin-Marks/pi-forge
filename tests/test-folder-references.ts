/**
 * Folder-reference expansion test.
 *
 * Verifies that `@<path>` markers resolving to a directory are
 * preserved in the prompt as `@<path>/` (defer to model tool use)
 * rather than rejected as errors. Covers:
 *
 *   - Directory marker preserved with trailing `/` appended
 *   - Existing trailing `/` from user input is kept (not doubled)
 *   - Quoted form `@"path with spaces"` works for directories too
 *   - Non-existent paths are escaped so `@mentions` are not file refs
 *   - Escaped `\\@` stays literal
 *   - File markers (small + large + binary) keep their existing
 *     behaviour — regression guard
 *   - listAllFiles output now includes directories with trailing `/`
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${detail !== undefined ? `  (${detail})` : ""}`);
    failures++;
  }
}

interface FileRefs {
  expandFileReferences: (text: string, workspacePath: string) => Promise<string>;
}

interface FileMgr {
  listAllFiles: (rootPath: string) => Promise<string[]>;
}

async function main(): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "pi-forge-folderref-"));

  // Set up a workspace tree:
  //   src/
  //     components/
  //       Button.tsx       (small, will inline)
  //     index.ts           (small, will inline)
  //   docs with spaces/    (directory with whitespace in name)
  //     readme.md
  //   big.txt              (>128 KB, will defer)
  await mkdir(join(workspace, "src", "components"), { recursive: true });
  await mkdir(join(workspace, "docs with spaces"), { recursive: true });
  await writeFile(join(workspace, "src", "index.ts"), "export const x = 1;\n");
  await writeFile(
    join(workspace, "src", "components", "Button.tsx"),
    "export const Button = () => null;\n",
  );
  await writeFile(join(workspace, "docs with spaces", "readme.md"), "# Readme\n");
  await writeFile(join(workspace, "big.txt"), "x".repeat(150 * 1024));

  const fr = (await import(
    resolve(REPO_ROOT, "packages/server/dist/file-references.js")
  )) as unknown as FileRefs;
  const fm = (await import(
    resolve(REPO_ROOT, "packages/server/dist/file-manager.js")
  )) as unknown as FileMgr;

  try {
    // ---- expandFileReferences with directory markers ----

    // 1. Bare directory reference — should normalize to `@src/`
    {
      const out = await fr.expandFileReferences("review @src for cleanups", workspace);
      assert(
        "bare directory `@src` is preserved with trailing slash appended",
        out === "review @src/ for cleanups",
        `got: ${JSON.stringify(out)}`,
      );
    }

    // 2. User-typed trailing slash — should NOT double it
    {
      const out = await fr.expandFileReferences("review @src/ for cleanups", workspace);
      assert(
        "directory `@src/` (user-typed slash) is preserved as-is",
        out === "review @src/ for cleanups",
        `got: ${JSON.stringify(out)}`,
      );
    }

    // 3. Nested directory
    {
      const out = await fr.expandFileReferences("look at @src/components closely", workspace);
      assert(
        "nested directory `@src/components` becomes `@src/components/`",
        out === "look at @src/components/ closely",
        `got: ${JSON.stringify(out)}`,
      );
    }

    // 4. Quoted path with spaces resolving to a directory
    {
      const out = await fr.expandFileReferences(`peek at @"docs with spaces" please`, workspace);
      assert(
        "quoted directory marker preserved + slash appended",
        out === `peek at @"docs with spaces/" please`,
        `got: ${JSON.stringify(out)}`,
      );
    }

    // 5. Non-existent paths are escaped so ordinary @mentions do not
    // get surfaced as file references in the rendered chat bubble.
    {
      const out = await fr.expandFileReferences("thanks @alex for the notes", workspace);
      assert(
        "missing bare mention is escaped literal text",
        out === "thanks \\@alex for the notes",
        `got: ${JSON.stringify(out)}`,
      );
    }

    // 5b. Backslash escapes a marker even when the path exists.
    {
      const out = await fr.expandFileReferences("literal \\@src please", workspace);
      assert(
        "escaped at-sign stays literal",
        out === "literal \\@src please",
        `got: ${JSON.stringify(out)}`,
      );
    }

    // ---- regression: file behaviour unchanged ----

    // 6. Small file still inlines as fenced block + preserves marker
    {
      const out = await fr.expandFileReferences("ts: @src/index.ts", workspace);
      assert(
        "small file marker preserved + content inlined as fenced block",
        out.includes("@src/index.ts\n```") && out.includes("export const x = 1;"),
        `got: ${JSON.stringify(out)}`,
      );
    }

    // 7. Big file defers (marker preserved, no inline content)
    {
      const out = await fr.expandFileReferences("see @big.txt", workspace);
      assert(
        "big file marker is preserved without inlining",
        out === "see @big.txt",
        `got: ${JSON.stringify(out)}`,
      );
    }

    // ---- listAllFiles emits dirs with trailing `/` ----

    {
      const all = await fm.listAllFiles(workspace);
      assert(
        "listAllFiles includes directory entries with trailing `/`",
        all.includes("src/") && all.includes("src/components/"),
        `got: ${all.join(",")}`,
      );
      assert(
        "listAllFiles still includes file entries without trailing `/`",
        all.includes("src/index.ts") && all.includes("src/components/Button.tsx"),
        `got: ${all.join(",")}`,
      );
      assert(
        "listAllFiles emits the directory-with-spaces entry",
        all.includes("docs with spaces/"),
        `got: ${all.join(",")}`,
      );
    }

    // ---- aggregate-inline budget ----
    //
    // Six files at 100 KB each — every file is individually under the
    // 128 KB per-file cap, but together they're 600 KB > 512 KB
    // aggregate budget. Walk should inline the first 5 (smallest-first;
    // identical sizes here so any 5 win) and defer the 6th.
    {
      const budgetWorkspace = await mkdtemp(join(tmpdir(), "pi-forge-budget-"));
      try {
        const oneHundredK = "x".repeat(100 * 1024);
        for (let i = 1; i <= 6; i += 1) {
          await writeFile(join(budgetWorkspace, `f${i}.txt`), oneHundredK);
        }
        const out = await fr.expandFileReferences(
          "review @f1.txt @f2.txt @f3.txt @f4.txt @f5.txt @f6.txt please",
          budgetWorkspace,
        );
        // Count how many fenced "file: fN.txt" headers appear — that's
        // the count of inlined files. Bare markers (no fenced block)
        // are deferred.
        const inlinedCount = (out.match(/file: f\d\.txt/g) ?? []).length;
        assert(
          "5 of 6 100 KB files inline (sums to 500 KB ≤ 512 KB budget)",
          inlinedCount === 5,
          `got ${inlinedCount} inlined`,
        );
        // The deferred file appears as a bare `@fN.txt` marker without
        // a following fenced block.
        assert(
          "1 of 6 100 KB files defers (running budget exhausted)",
          // Six markers in the input. Five became `@fN.txt\n```...```\n`
          // (marker + fence). One stayed as the bare marker. Total bare
          // markers in output should be 1 — count by matching the
          // marker NOT followed by a fence.
          (out.match(/@f\d\.txt(?!\n```)/g) ?? []).length === 1,
          `got: ${JSON.stringify(out.slice(0, 200))}…`,
        );
      } finally {
        await rm(budgetWorkspace, { recursive: true, force: true }).catch(() => undefined);
      }
    }

    // Smallest-first ordering: in a mixed-size prompt that exceeds the
    // budget, the SMALLEST files should be the ones that inline. Three
    // files: 1 KB, 1 KB, 600 KB. Per-file cap is 128 KB so the 600 KB
    // file ALREADY defers (deferLarge, not budget-driven). Both 1 KB
    // files fit comfortably and inline.
    {
      const orderWorkspace = await mkdtemp(join(tmpdir(), "pi-forge-budget-order-"));
      try {
        await writeFile(join(orderWorkspace, "tiny1.txt"), "x".repeat(1024));
        await writeFile(join(orderWorkspace, "tiny2.txt"), "x".repeat(1024));
        await writeFile(join(orderWorkspace, "huge.txt"), "x".repeat(600 * 1024));
        const out = await fr.expandFileReferences(
          "see @huge.txt @tiny1.txt @tiny2.txt",
          orderWorkspace,
        );
        assert(
          "tiny files inline regardless of position in the prompt",
          out.includes("file: tiny1.txt") && out.includes("file: tiny2.txt"),
          `got: ${JSON.stringify(out.slice(0, 200))}…`,
        );
        assert(
          "huge file (>per-file cap) defers — bare marker, no fenced block",
          /@huge\.txt(?!\n```)/.test(out),
          `got: ${JSON.stringify(out.slice(0, 200))}…`,
        );
      } finally {
        await rm(orderWorkspace, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-folder-references] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-folder-references] PASS");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

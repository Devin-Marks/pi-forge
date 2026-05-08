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
 *   - Non-existent path still becomes `[@<path> not included: ...]`
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

    // 5. Non-existent path still errors out cleanly
    {
      const out = await fr.expandFileReferences("missing @nope", workspace);
      assert(
        "missing path produces `[@nope not included: ...]`",
        out.includes("[@nope not included") && out.includes("not found"),
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

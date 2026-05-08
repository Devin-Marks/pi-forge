#!/usr/bin/env node
/**
 * pi-forge postinstall: ensure node-pty's prebuilt `spawn-helper`
 * binaries are executable.
 *
 * The bug: `node-pty` ships prebuilt native binaries at
 *   `node_modules/node-pty/prebuilds/<platform>/spawn-helper`
 * The tarball's mode bits don't always survive npm's tar extract —
 * fresh installs frequently land `spawn-helper` at `0644` with no
 * exec bit. When pi-forge later spawns a PTY, `posix_spawnp` fails
 * with the unhelpful "spawn EACCES" or "posix_spawnp failed."
 *
 * `node-pty`'s own postinstall script handles the from-source-built
 * path (`build/Release/`) but NOT the prebuilt path (`prebuilds/`),
 * so the bug ships on every npm-published install of pi-forge.
 *
 * Why this script lives in pi-forge and not upstream: the upstream
 * fix would need to land in node-pty itself. Until then, every
 * package that depends on node-pty needs its own postinstall to
 * cover the gap. We pay one trivial chmod per install in exchange
 * for the integrated terminal actually working.
 *
 * Idempotent: chmod +x on something already +x is a no-op.
 * Failure-tolerant: missing node-pty (e.g. `--omit=optional`),
 * missing prebuilds dir (unusual platform), or chmod failure
 * (read-only mount, EPERM) all warn instead of failing the install.
 */
import { chmodSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let nodePtyDir;
try {
  nodePtyDir = dirname(require.resolve("node-pty/package.json"));
} catch {
  // node-pty not installed — no-op.
  process.exit(0);
}

const prebuildsDir = join(nodePtyDir, "prebuilds");
if (!existsSync(prebuildsDir)) process.exit(0);

let fixed = 0;
for (const platform of readdirSync(prebuildsDir)) {
  const helper = join(prebuildsDir, platform, "spawn-helper");
  if (!existsSync(helper)) continue;
  try {
    const mode = statSync(helper).mode;
    // 0o111 = any-x bits. If even one is set, assume the file is
    // already runnable.
    if ((mode & 0o111) !== 0) continue;
    chmodSync(helper, mode | 0o755);
    fixed++;
  } catch (err) {
    console.warn(
      `[pi-forge postinstall] could not chmod ${helper}: ${err instanceof Error ? err.message : err}`,
    );
  }
}

if (fixed > 0) {
  console.log(
    `[pi-forge postinstall] fixed exec bit on ${fixed} node-pty spawn-helper binar${
      fixed === 1 ? "y" : "ies"
    }`,
  );
}

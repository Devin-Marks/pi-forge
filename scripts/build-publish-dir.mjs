#!/usr/bin/env node
/**
 * Assemble `publish/` — the staging directory we ship to npm as the
 * `pi-forge` package.
 *
 * What this does:
 *   1. Sanity-checks that both server and client builds exist (caller
 *      must have already run `npm run build`).
 *   2. Wipes any prior `publish/` dir.
 *   3. Copies built server + client artifacts into `publish/dist/`.
 *   4. Copies the bin shim into `publish/bin/`.
 *   5. Synthesizes `publish/package.json` by reading the root version,
 *      hoisting the SERVER's runtime `dependencies` (the server's
 *      package.json is the source of truth — no manual duplication),
 *      and adding `bin`, `engines`, `files`, `repository`, etc.
 *   6. Copies `LICENSE` and writes a focused `README.md` that explains
 *      the npm consumer flow (different from the repo's contributor
 *      README, which assumes you cloned).
 *
 * Why a staging dir instead of flipping the root `private: false`:
 * keeps the source tree clean. The published artifact is a flat
 * single-package layout; the dev-time monorepo layout stays as it is.
 * No drift risk from manually keeping a hoisted-deps list in sync —
 * we read the server's deps fresh on every build.
 *
 * Run via: `npm run build:publish` (which depends on `npm run build`).
 *
 * The CI release workflow runs this between `npm run build` and
 * `npm publish ./publish`. Locally you can also run it for a smoke
 * test or to inspect the tarball with `npm pack` from `publish/`.
 */
import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLISH_DIR = resolve(REPO_ROOT, "publish");

const SERVER_DIST = resolve(REPO_ROOT, "packages/server/dist");
const CLIENT_DIST = resolve(REPO_ROOT, "packages/client/dist");
const BIN_SRC = resolve(REPO_ROOT, "bin/pi-forge.mjs");
const POSTINSTALL_SRC = resolve(REPO_ROOT, "bin/fix-pty-perms.mjs");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function main() {
  // 1. Sanity-check inputs
  for (const [label, path] of [
    ["server dist", SERVER_DIST],
    ["client dist", CLIENT_DIST],
    ["bin shim", BIN_SRC],
    ["postinstall script", POSTINSTALL_SRC],
  ]) {
    if (!existsSync(path)) {
      console.error(
        `[build-publish-dir] missing ${label} at ${path}\n` +
          `  Run 'npm run build' first to produce server + client artifacts.`,
      );
      process.exit(1);
    }
  }

  const rootPkg = await readJson(resolve(REPO_ROOT, "package.json"));
  const serverPkg = await readJson(resolve(REPO_ROOT, "packages/server/package.json"));

  // 2. Reset the staging dir
  await rm(PUBLISH_DIR, { recursive: true, force: true });
  await mkdir(PUBLISH_DIR, { recursive: true });

  // 3. Copy artifacts
  // recursive copy with `cp` (Node >=16.7) preserves directory structure
  // including nested `core/`, `mcp/`, `routes/` etc. under the server dist.
  await cp(SERVER_DIST, resolve(PUBLISH_DIR, "dist/server"), { recursive: true });
  await cp(CLIENT_DIST, resolve(PUBLISH_DIR, "dist/client"), { recursive: true });

  // 4. Bin shim + postinstall fix-pty-perms script
  await mkdir(resolve(PUBLISH_DIR, "bin"), { recursive: true });
  await copyFile(BIN_SRC, resolve(PUBLISH_DIR, "bin/pi-forge.mjs"));
  await copyFile(POSTINSTALL_SRC, resolve(PUBLISH_DIR, "bin/fix-pty-perms.mjs"));

  // 5. Synthetic package.json
  // Hoist the server's runtime deps verbatim — the server is the only
  // thing the bin actually loads, and its package.json is the
  // authoritative dep list. If a dep is added there, it's automatically
  // picked up by the next publish; nothing manual to edit here.
  if (serverPkg.dependencies === undefined) {
    console.error("[build-publish-dir] packages/server/package.json has no dependencies field");
    process.exit(1);
  }
  const publishPkg = {
    name: "pi-forge",
    version: rootPkg.version,
    description:
      "Browser UI for the pi coding agent — embedded HTTP server with a React workbench (chat, file browser, terminal, git, MCP).",
    keywords: ["pi", "coding-agent", "ai", "llm", "agent", "workbench", "fastify"],
    homepage: "https://github.com/Devin-Marks/pi-forge#readme",
    bugs: { url: "https://github.com/Devin-Marks/pi-forge/issues" },
    repository: {
      type: "git",
      url: "git+https://github.com/Devin-Marks/pi-forge.git",
    },
    license: "MIT",
    author: "Devin Marks",
    type: "module",
    bin: { "pi-forge": "bin/pi-forge.mjs" },
    files: ["bin/", "dist/", "README.md", "LICENSE"],
    // Same node target as the server workspace + CI matrix.
    engines: { node: ">=20" },
    // node-pty's tarball ships `prebuilds/<platform>/spawn-helper`
    // without a reliable executable bit (the upstream postinstall
    // only fixes `build/Release/`, not `prebuilds/`). Without an
    // exec bit, every PTY spawn fails with `posix_spawnp failed.`
    // Our postinstall walks every prebuild and chmod +x's the
    // spawn-helper. Idempotent + failure-tolerant — see
    // bin/fix-pty-perms.mjs for the full story.
    scripts: { postinstall: "node bin/fix-pty-perms.mjs" },
    dependencies: serverPkg.dependencies,
    // `publishConfig.provenance: true` makes `npm publish` attach a
    // sigstore-signed provenance attestation tying this version to the
    // GitHub Actions run that produced it. Free with the trusted-
    // publisher OIDC flow we use in `.github/workflows/release.yml`.
    publishConfig: { access: "public", provenance: true },
  };
  await writeFile(resolve(PUBLISH_DIR, "package.json"), JSON.stringify(publishPkg, null, 2) + "\n");

  // 6. LICENSE + README
  await copyFile(resolve(REPO_ROOT, "LICENSE"), resolve(PUBLISH_DIR, "LICENSE"));
  await writeFile(resolve(PUBLISH_DIR, "README.md"), buildPublishReadme(rootPkg.version));

  // Friendly summary
  console.log(`[build-publish-dir] assembled publish/ for pi-forge@${rootPkg.version}`);
  console.log(`  server dist: ${relativeFromRoot(SERVER_DIST)} → publish/dist/server/`);
  console.log(`  client dist: ${relativeFromRoot(CLIENT_DIST)} → publish/dist/client/`);
  console.log(`  bin: bin/pi-forge.mjs → publish/bin/pi-forge.mjs`);
  console.log(`  ${Object.keys(publishPkg.dependencies).length} runtime deps hoisted from server`);
  console.log(`Inspect with: cd publish && npm pack --dry-run`);
}

function relativeFromRoot(p) {
  return p.startsWith(REPO_ROOT) ? p.slice(REPO_ROOT.length + 1) : p;
}

function buildPublishReadme(version) {
  // Consumer-focused README — the in-repo README assumes you cloned
  // and want to contribute. npm users want to know how to install,
  // run, and configure.
  return `# pi-forge

Browser UI for the [pi coding agent](https://github.com/badlogic/pi-mono) —
an embedded HTTP server with a React workbench (chat, file browser,
terminal, git integration, MCP support).

## Install

\`\`\`bash
# One-shot
npx pi-forge

# Or install globally
npm i -g pi-forge
pi-forge
\`\`\`

Open <http://localhost:3000> and pick a workspace folder.

## Configuration

Every knob is settable as a \`--flag\` on the \`pi-forge\` command OR as
an environment variable. **Flags win when both are set.** Run
\`pi-forge --help\` for the full grouped list.

\`\`\`bash
pi-forge --port 4000 --workspace-path ~/Code
pi-forge --api-key @/run/secrets/api-key --no-expose-docs
\`\`\`

The most common knobs:

| Flag | Env var | Default | Purpose |
|---|---|---|---|
| \`--port\` | \`PORT\` | \`3000\` | HTTP listen port |
| \`--workspace-path\` | \`WORKSPACE_PATH\` | \`~/.pi-forge/workspace\` | Where project code lives |
| \`--pi-config-dir\` | \`PI_CONFIG_DIR\` | \`~/.pi/agent\` | Pi SDK config (auth, models, settings) |
| \`--forge-data-dir\` | \`FORGE_DATA_DIR\` | \`~/.pi-forge\` | pi-forge state (project list) |
| \`--ui-password\` | \`UI_PASSWORD\` | (unset) | Enables browser login if set |
| \`--api-key\` | \`API_KEY\` | (unset) | Enables \`Authorization: Bearer\` for programmatic use |

\`--ui-password\`, \`--api-key\`, and \`--jwt-secret\` accept \`@<path>\` to
read the value from a file (avoids shell history leakage). If both
\`--ui-password\` and \`--api-key\` are unset, auth is disabled — for
production, set at minimum \`--api-key\`.

## Programmatic API

REST + Server-Sent Events under \`/api/v1/\`. Interactive docs at
\`/api/docs\`. See the [project README](https://github.com/Devin-Marks/pi-forge#readme)
for the full surface and example curl flows.

## Versioning

This package version (\`${version}\`) tracks the [GitHub release](https://github.com/Devin-Marks/pi-forge/releases)
of the same name. Docker images and the npm package are published in
lockstep on each \`v*\` tag.

## License

MIT — see [LICENSE](./LICENSE).
`;
}

main().catch((err) => {
  console.error("[build-publish-dir] failed:", err);
  process.exit(1);
});

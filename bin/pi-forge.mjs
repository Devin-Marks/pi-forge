#!/usr/bin/env node
/**
 * pi-forge CLI launcher.
 *
 * The published npm package layout is:
 *
 *   pi-forge/
 *   ├── bin/pi-forge.mjs       (this file)
 *   ├── dist/server/           (built Fastify server — copy of packages/server/dist/)
 *   └── dist/client/           (built Vite SPA — copy of packages/client/dist/)
 *
 * The server's default `CLIENT_DIST_PATH` resolves relative to its own
 * compiled file (`dist/server/config.js` → `../../client/dist`), which
 * works for the in-repo `npm run build && node dist/index.js` flow and
 * the Docker image (both share the `packages/server/dist/` +
 * `packages/client/dist/` layout) but NOT for the flat published
 * package. We override `CLIENT_DIST_PATH` here so the same server entry
 * works in all three deployment shapes without touching server code.
 *
 * Flag parsing: `cli.js` translates argv into env-var writes BEFORE
 * `index.js` is imported, because config.js reads `process.env` at
 * module-load time. Every server env var has an equivalent --flag —
 * see `pi-forge --help` or `packages/server/src/cli.ts` for the
 * complete table. Env vars still work as fallbacks for users who
 * already have them set; flag values win when both are present.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

process.env.CLIENT_DIST_PATH ??= resolve(packageRoot, "dist", "client");
process.env.NODE_ENV ??= "production";

const cliEntry = resolve(packageRoot, "dist", "server", "cli.js");
const { parseCliArgs, applyCliEnv, buildHelpText } = await import(pathToFileURL(cliEntry).href);

const parsed = parseCliArgs(process.argv.slice(2));

if (parsed.errors.length > 0) {
  for (const err of parsed.errors) {
    process.stderr.write(`pi-forge: ${err}\n`);
  }
  process.stderr.write(`pi-forge: run with --help for usage.\n`);
  process.exit(2);
}

if (parsed.helpRequested) {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  process.stdout.write(buildHelpText(pkg.version));
  process.exit(0);
}

if (parsed.versionRequested) {
  const pkg = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));
  process.stdout.write(`pi-forge ${pkg.version}\n`);
  process.exit(0);
}

applyCliEnv(parsed);

const serverEntry = resolve(packageRoot, "dist", "server", "index.js");
const { start } = await import(pathToFileURL(serverEntry).href);
await start();

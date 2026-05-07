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
 * Everything else (workspace path, pi config dir, forge data dir, port,
 * auth) is read from env vars and uses the server's existing defaults
 * (`~/.pi-forge/workspace`, `~/.pi/agent`, `~/.pi-forge`, port 3000) —
 * users who installed via `npm i -g pi-forge` get sensible per-user
 * paths under their home directory without any setup.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");

process.env.CLIENT_DIST_PATH ??= resolve(packageRoot, "dist", "client");
process.env.NODE_ENV ??= "production";

const serverEntry = resolve(packageRoot, "dist", "server", "index.js");
const { start } = await import(pathToFileURL(serverEntry).href);
await start();

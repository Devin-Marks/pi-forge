/**
 * Smoke test for the assembled npm publish package.
 *
 * What this verifies:
 *   1. `scripts/build-publish-dir.mjs` runs cleanly and produces the
 *      expected layout (publish/bin, publish/dist/server, publish/dist/client,
 *      publish/package.json).
 *   2. The synthetic package.json has the right shape — name, version
 *      from root, bin entry, deps hoisted from the server workspace,
 *      provenance enabled, public access.
 *   3. `node publish/bin/pi-forge.mjs` boots the workbench, serves
 *      `/api/v1/health`, and serves the embedded SPA (`/`).
 *
 * Why this is its own test (not folded into test-scaffold):
 * test-scaffold runs the in-tree compiled server directly. This test
 * exercises the BIN SHIM specifically — env-var defaulting,
 * CLIENT_DIST_PATH override, dynamic import of the server entry. A
 * regression in the shim would only surface here.
 *
 * Note: this test runs `node publish/bin/pi-forge.mjs` while still
 * inside the repo, so Node's module resolution finds the server's
 * runtime deps via the hoisted root `node_modules/`. A real `npm i
 * pi-forge` install gets its deps from the synthetic package.json's
 * `dependencies` field — which we assert separately by shape.
 *
 * Builds the workspace + assembles publish/ on every run (~5s warm,
 * ~30s cold). Costly but we want the assertion that "the publish
 * artifact is bootable" to be green every CI run, not just on tag.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");
const publishDir = resolve(repoRoot, "publish");
const binPath = resolve(publishDir, "bin/pi-forge.mjs");
const synthPkgPath = resolve(publishDir, "package.json");
const rootPkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")) as {
  version: string;
};
const serverPkg = JSON.parse(
  readFileSync(resolve(repoRoot, "packages/server/package.json"), "utf8"),
) as { dependencies: Record<string, string> };

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

async function pickFreePort(): Promise<number> {
  return new Promise((resolveFn, rejectFn) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rejectFn);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr === null || typeof addr === "string") {
        rejectFn(new Error("failed to acquire free port"));
        return;
      }
      const { port } = addr;
      srv.close(() => resolveFn(port));
    });
  });
}

async function waitForHealth(url: string, timeoutMs: number): Promise<Response> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      return await fetch(url);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error(`server did not respond on ${url} within ${timeoutMs}ms: ${String(lastErr)}`);
}

function killServer(child: ChildProcess): Promise<void> {
  return new Promise((resolveFn) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveFn();
      return;
    }
    child.once("exit", () => resolveFn());
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, 2000).unref();
  });
}

async function main(): Promise<void> {
  console.log("[test-publish-package] building workspace…");
  const build = spawnSync("npm", ["run", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  assert("npm run build exits 0", build.status === 0, `exit=${build.status ?? "null"}`);
  if (build.status !== 0) process.exit(1);

  console.log("[test-publish-package] assembling publish/…");
  const assemble = spawnSync("npm", ["run", "build:publish"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  assert(
    "npm run build:publish exits 0",
    assemble.status === 0,
    `exit=${assemble.status ?? "null"}`,
  );
  if (assemble.status !== 0) process.exit(1);

  // --- Layout assertions ---------------------------------------------
  for (const path of [
    binPath,
    synthPkgPath,
    resolve(publishDir, "dist/server/index.js"),
    resolve(publishDir, "dist/client/index.html"),
    resolve(publishDir, "README.md"),
    resolve(publishDir, "LICENSE"),
  ]) {
    assert(`publish/ contains ${path.slice(publishDir.length + 1)}`, existsSync(path));
  }

  // --- Synthetic package.json shape ----------------------------------
  const synth = JSON.parse(readFileSync(synthPkgPath, "utf8")) as {
    name: string;
    version: string;
    bin: Record<string, string>;
    dependencies: Record<string, string>;
    files: string[];
    publishConfig: { access?: string; provenance?: boolean };
    engines: { node?: string };
    type: string;
  };
  assert("synth name === 'pi-forge'", synth.name === "pi-forge", synth.name);
  assert(
    "synth version matches root version",
    synth.version === rootPkg.version,
    `${synth.version} vs ${rootPkg.version}`,
  );
  assert(
    "synth bin entry points at bin/pi-forge.mjs",
    synth.bin["pi-forge"] === "bin/pi-forge.mjs",
    JSON.stringify(synth.bin),
  );
  assert("synth type === 'module'", synth.type === "module");
  assert("synth files includes bin/", synth.files.includes("bin/"));
  assert("synth files includes dist/", synth.files.includes("dist/"));
  assert(
    "synth publishConfig.access === 'public'",
    synth.publishConfig.access === "public",
    JSON.stringify(synth.publishConfig),
  );
  assert(
    "synth publishConfig.provenance === true",
    synth.publishConfig.provenance === true,
    JSON.stringify(synth.publishConfig),
  );
  assert(
    "synth engines.node specified",
    typeof synth.engines.node === "string" && synth.engines.node.length > 0,
    JSON.stringify(synth.engines),
  );
  // Every server runtime dep must be present in the synthetic package
  // (we hoist verbatim — a missing entry means the bin would fail to
  // import on a real `npm i pi-forge` install).
  for (const [dep, version] of Object.entries(serverPkg.dependencies)) {
    assert(
      `synth dependencies has ${dep}@${version}`,
      synth.dependencies[dep] === version,
      `got ${synth.dependencies[dep] ?? "<missing>"}`,
    );
  }

  // --- Boot the bin shim ---------------------------------------------
  // Use isolated dirs so this test doesn't touch the user's real
  // ~/.pi-forge or ~/.pi/agent.
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-forge-pub-ws-"));
  const piConfigDir = await mkdtemp(join(tmpdir(), "pi-forge-pub-pi-"));
  const forgeDataDir = await mkdtemp(join(tmpdir(), "pi-forge-pub-data-"));
  const port = await pickFreePort();
  console.log(`[test-publish-package] launching publish/bin/pi-forge.mjs on :${port}`);

  const child = spawn(process.execPath, [binPath], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(port),
      WORKSPACE_PATH: workspacePath,
      PI_CONFIG_DIR: piConfigDir,
      FORGE_DATA_DIR: forgeDataDir,
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  let exitedEarly = false;
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal === null) {
      exitedEarly = true;
      console.log(`[test-publish-package] bin exited unexpectedly with code=${code ?? "null"}`);
    }
  });

  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/api/v1/health`, 20_000);
    assert("GET /api/v1/health returns 200", health.status === 200, `status=${health.status}`);
    const healthBody = (await health.json()) as { status?: string };
    assert("health body.status === 'ok'", healthBody.status === "ok", JSON.stringify(healthBody));

    // The shim's reason for existing: pointing CLIENT_DIST_PATH at the
    // bundled SPA so `/` serves the workbench. If the shim broke or the
    // copy missed index.html, this 200 would become a 404.
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert("GET / returns 200 (SPA index served)", root.status === 200, `status=${root.status}`);
    const html = await root.text();
    assert(
      "GET / body looks like an HTML document",
      html.toLowerCase().includes("<!doctype html") || html.toLowerCase().includes("<html"),
      html.slice(0, 80),
    );

    assert("bin did not exit during test", !exitedEarly);
  } finally {
    await killServer(child);
    await rm(workspacePath, { recursive: true, force: true });
    await rm(piConfigDir, { recursive: true, force: true });
    await rm(forgeDataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-publish-package] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-publish-package] PASS");
}

main().catch((err) => {
  console.error("[test-publish-package] uncaught error:", err);
  process.exit(1);
});

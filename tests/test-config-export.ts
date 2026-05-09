/**
 * Phase 7+ config export/import integration test.
 *
 * Boots the server in-process with a temp PI_CONFIG_DIR and
 * FORGE_DATA_DIR, seeds the three exported files, exercises
 * round-trip GET /config/export → POST /config/import, and confirms
 * the on-disk content matches.
 *
 * Coverage:
 *   - GET /config/export with all three files present → 200, gzip
 *     stream, X-Pi-Forge-Files header lists all three.
 *   - GET /config/export with only some files present → tar contains
 *     only the existing ones; missing files are silently skipped.
 *   - POST /config/import round-trips: export buffer fed back imports
 *     cleanly, on-disk content matches what was exported.
 *   - Import rejects bogus filenames (entry not in the allow-list)
 *     while still importing the valid ones — `skipped` reflects the
 *     rejected entries.
 *   - Import rejects malformed JSON: ALL files fail validation, NONE
 *     are written to disk (atomicity guarantee).
 *   - Import without a multipart file body → 400.
 *   - Auth.json is NOT included in exports (the entire reason exports
 *     can be shared as backup files).
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { create as tarCreate, list as tarList } from "tar";
import { Readable } from "node:stream";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

interface JsonResponse {
  status: number;
  body: unknown;
  headers: Headers;
}

async function getRaw(
  base: string,
  path: string,
): Promise<{ status: number; buf: Buffer; headers: Headers }> {
  const res = await fetch(`${base}${path}`);
  const ab = await res.arrayBuffer();
  return { status: res.status, buf: Buffer.from(ab), headers: res.headers };
}

async function postMultipart(
  base: string,
  path: string,
  field: string,
  filename: string,
  contentType: string,
  body: Buffer,
): Promise<JsonResponse> {
  const fd = new FormData();
  fd.append(field, new Blob([body], { type: contentType }), filename);
  const res = await fetch(`${base}${path}`, { method: "POST", body: fd });
  const text = await res.text();
  return {
    status: res.status,
    body: text === "" ? undefined : JSON.parse(text),
    headers: res.headers,
  };
}

/**
 * Build a tar.gz in memory containing the named files with the given
 * payloads. Stages them under a temp dir then tars from there — same
 * shape the production export takes.
 */
async function makeTarGz(entries: Record<string, string>): Promise<Buffer> {
  const stage = await mkdtemp(join(tmpdir(), "pi-test-tar-make-"));
  try {
    for (const [name, payload] of Object.entries(entries)) {
      await writeFile(join(stage, name), payload, "utf8");
    }
    const chunks: Buffer[] = [];
    const pack = tarCreate({ gzip: true, cwd: stage }, Object.keys(entries));
    await new Promise<void>((res, rej) => {
      pack.on("data", (c: Buffer) => chunks.push(c));
      pack.on("end", () => res());
      pack.on("error", rej);
    });
    return Buffer.concat(chunks);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * List filenames inside a tar.gz buffer. Returns top-level names only;
 * we only care about the export contract (flat layout, no dirs).
 */
async function listTarEntries(buf: Buffer): Promise<string[]> {
  const stage = await mkdtemp(join(tmpdir(), "pi-test-tar-list-"));
  try {
    const names: string[] = [];
    await new Promise<void>((res, rej) => {
      const lister = tarList({
        cwd: stage,
        onReadEntry: (entry) => {
          names.push(entry.path);
        },
      });
      lister.on("error", rej);
      lister.on("end", () => res());
      Readable.from(buf).pipe(lister);
    });
    return names;
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const workspacePath = await mkdtemp(join(tmpdir(), "pi-config-export-ws-"));
  const configDir = await mkdtemp(join(tmpdir(), "pi-config-export-cfg-"));
  const dataDir = await mkdtemp(join(tmpdir(), "pi-config-export-data-"));
  process.env.WORKSPACE_PATH = workspacePath;
  process.env.PI_CONFIG_DIR = configDir;
  process.env.FORGE_DATA_DIR = dataDir;
  process.env.SESSION_DIR = join(workspacePath, ".pi", "sessions");
  process.env.NODE_ENV = "test";
  delete process.env.UI_PASSWORD;
  delete process.env.JWT_SECRET;
  delete process.env.API_KEY;

  console.log(`[test-config-export] PI_CONFIG_DIR=${configDir}`);
  console.log(`[test-config-export] FORGE_DATA_DIR=${dataDir}`);

  // Seed the five exportable files PLUS auth.json (which we expect
  // the export to deliberately exclude). The two `*-overrides.json`
  // files live under FORGE_DATA_DIR (dataDir), not PI_CONFIG_DIR
  // (configDir) — pi-forge-private state.
  await mkdir(configDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  const seedSettings = { defaultProvider: "anthropic", defaultThinkingLevel: "high" };
  const seedModels = {
    providers: { vllm: { baseUrl: "http://x:8000/v1", apiKey: "fake-1" } },
  };
  const seedMcp = {
    servers: { example: { url: "http://localhost:9000/sse" } },
  };
  const seedSkillsOverrides = {
    projects: {
      "00000000-0000-0000-0000-000000000001": { enable: ["foo-skill"], disable: ["bar-skill"] },
    },
  };
  const seedToolOverrides = {
    projects: {
      "00000000-0000-0000-0000-000000000001": {
        builtin: { enable: [], disable: ["bash"] },
        mcp: {},
        extension: {},
      },
    },
  };
  const seedAuth = { providers: { anthropic: { apiKey: "sk-ant-secret-do-not-export" } } };
  await writeFile(join(configDir, "settings.json"), JSON.stringify(seedSettings), "utf8");
  await writeFile(join(configDir, "models.json"), JSON.stringify(seedModels), "utf8");
  await writeFile(join(configDir, "auth.json"), JSON.stringify(seedAuth), "utf8");
  await writeFile(join(dataDir, "mcp.json"), JSON.stringify(seedMcp), "utf8");
  await writeFile(
    join(dataDir, "skills-overrides.json"),
    JSON.stringify(seedSkillsOverrides),
    "utf8",
  );
  await writeFile(join(dataDir, "tool-overrides.json"), JSON.stringify(seedToolOverrides), "utf8");

  const buildModule = (await import(
    resolve(repoRoot, "packages/server/dist/index.js")
  )) as unknown as {
    buildServer: () => Promise<{
      listen: (opts: { port: number; host: string }) => Promise<string>;
      close: () => Promise<void>;
    }>;
  };
  const fastify = await buildModule.buildServer();
  const base = await fastify.listen({ port: 0, host: "127.0.0.1" });

  try {
    // ---- 1. Export with all three present ----
    let exportedBuf: Buffer;
    {
      const r = await getRaw(base, "/api/v1/config/export");
      assert("GET /config/export → 200", r.status === 200);
      assert(
        "  Content-Type is application/gzip",
        r.headers.get("content-type") === "application/gzip",
        r.headers.get("content-type") ?? "(none)",
      );
      const filesHeader = r.headers.get("x-pi-forge-files") ?? "";
      const filesList = filesHeader
        .split(",")
        .filter((s) => s.length > 0)
        .sort();
      assert(
        "  X-Pi-Forge-Files lists all five files",
        JSON.stringify(filesList) ===
          JSON.stringify([
            "mcp.json",
            "models.json",
            "settings.json",
            "skills-overrides.json",
            "tool-overrides.json",
          ]),
        filesHeader,
      );
      assert(
        "  Content-Disposition is attachment with timestamped filename",
        (r.headers.get("content-disposition") ?? "").includes("pi-forge-config-"),
        r.headers.get("content-disposition") ?? "(none)",
      );
      exportedBuf = r.buf;
      // Sanity: gzip magic bytes 0x1f 0x8b
      assert(
        "  body starts with gzip magic",
        exportedBuf[0] === 0x1f && exportedBuf[1] === 0x8b,
        `bytes[0..2]=${exportedBuf[0]?.toString(16)} ${exportedBuf[1]?.toString(16)}`,
      );

      const entries = (await listTarEntries(exportedBuf)).sort();
      assert(
        "  tar contents match the five exportable files",
        JSON.stringify(entries) ===
          JSON.stringify([
            "mcp.json",
            "models.json",
            "settings.json",
            "skills-overrides.json",
            "tool-overrides.json",
          ]),
        JSON.stringify(entries),
      );
      assert(
        "  auth.json is NOT in the tar (provider keys excluded by design)",
        !entries.includes("auth.json"),
      );
    }

    // ---- 2. Round-trip: import the freshly exported tar ----
    {
      // Wipe the on-disk files so we can prove the import is what
      // restores them.
      await rm(join(configDir, "settings.json"));
      await rm(join(configDir, "models.json"));
      await rm(join(dataDir, "mcp.json"));
      await rm(join(dataDir, "skills-overrides.json"));
      await rm(join(dataDir, "tool-overrides.json"));

      const r = await postMultipart(
        base,
        "/api/v1/config/import",
        "file",
        "config.tar.gz",
        "application/gzip",
        exportedBuf,
      );
      assert("POST /config/import → 200", r.status === 200, JSON.stringify(r.body));
      const summary = r.body as { imported: string[]; skipped: string[]; errors: unknown[] };
      assert(
        "  imported lists all five",
        summary.imported.sort().join(",") ===
          "mcp.json,models.json,settings.json,skills-overrides.json,tool-overrides.json",
        JSON.stringify(summary),
      );
      assert("  no skipped entries", summary.skipped.length === 0, JSON.stringify(summary.skipped));
      assert("  no errors", summary.errors.length === 0, JSON.stringify(summary.errors));

      // Verify on-disk content matches what we seeded originally.
      const settingsBack = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
      assert(
        "  settings.json content round-trips",
        JSON.stringify(settingsBack) === JSON.stringify(seedSettings),
        JSON.stringify(settingsBack),
      );
      const modelsBack = JSON.parse(await readFile(join(configDir, "models.json"), "utf8"));
      assert(
        "  models.json content round-trips",
        JSON.stringify(modelsBack) === JSON.stringify(seedModels),
      );
      const mcpBack = JSON.parse(await readFile(join(dataDir, "mcp.json"), "utf8"));
      assert("  mcp.json content round-trips", JSON.stringify(mcpBack) === JSON.stringify(seedMcp));
      const skillsOverridesBack = JSON.parse(
        await readFile(join(dataDir, "skills-overrides.json"), "utf8"),
      );
      assert(
        "  skills-overrides.json content round-trips",
        JSON.stringify(skillsOverridesBack) === JSON.stringify(seedSkillsOverrides),
        JSON.stringify(skillsOverridesBack),
      );
      const toolOverridesBack = JSON.parse(
        await readFile(join(dataDir, "tool-overrides.json"), "utf8"),
      );
      assert(
        "  tool-overrides.json content round-trips",
        JSON.stringify(toolOverridesBack) === JSON.stringify(seedToolOverrides),
        JSON.stringify(toolOverridesBack),
      );

      // auth.json was NEVER touched by the import path.
      const authBack = JSON.parse(await readFile(join(configDir, "auth.json"), "utf8"));
      assert(
        "  auth.json untouched on disk after import",
        JSON.stringify(authBack) === JSON.stringify(seedAuth),
      );
    }

    // ---- 3. Import rejects bogus filenames; valid files still land ----
    {
      // makeTarGz writes each entry to the staging dir before tar'ing,
      // so the entry NAMES must be plain filenames — anything with a
      // `/` or `..` would resolve outside stage and EACCES on Linux
      // CI. The allow-list filter rejects evil-script.sh by name; the
      // separate `..` / absolute-path traversal cases are covered by
      // tar's own `strict: true` extraction (config-export.ts) plus
      // the filter's path-segment check, neither of which we can drive
      // through writeFile-based tar staging without bypassing the OS
      // path validation. Worth knowing: a hand-crafted tar with a
      // header path of `../../etc/passwd` would still be refused by
      // both layers; we just can't conveniently produce one here.
      const tar = await makeTarGz({
        "settings.json": JSON.stringify({ defaultProvider: "openai" }),
        "evil-script.sh": "#!/bin/sh\nrm -rf /\n",
      });
      const r = await postMultipart(
        base,
        "/api/v1/config/import",
        "file",
        "config.tar.gz",
        "application/gzip",
        tar,
      );
      assert("POST /config/import (mixed) → 200", r.status === 200);
      const summary = r.body as { imported: string[]; skipped: string[]; errors: unknown[] };
      assert(
        "  settings.json imported",
        summary.imported.includes("settings.json"),
        JSON.stringify(summary),
      );
      assert(
        "  evil-script.sh skipped",
        summary.skipped.some((s) => s.includes("evil-script.sh")),
        JSON.stringify(summary.skipped),
      );
      const settingsBack = JSON.parse(await readFile(join(configDir, "settings.json"), "utf8"));
      assert(
        "  settings.json on disk reflects the new content",
        settingsBack.defaultProvider === "openai",
        JSON.stringify(settingsBack),
      );
    }

    // ---- 4. Import with malformed JSON → entire import fails atomically ----
    {
      // Snapshot current state so we can prove the failed import
      // didn't mutate anything.
      const settingsBefore = await readFile(join(configDir, "settings.json"), "utf8");
      const modelsBefore = await readFile(join(configDir, "models.json"), "utf8");
      const mcpBefore = await readFile(join(dataDir, "mcp.json"), "utf8");

      const tar = await makeTarGz({
        "settings.json": JSON.stringify({ defaultProvider: "anthropic" }),
        "models.json": "{ this is not, valid json",
        "mcp.json": JSON.stringify({ servers: {} }),
      });
      const r = await postMultipart(
        base,
        "/api/v1/config/import",
        "file",
        "config.tar.gz",
        "application/gzip",
        tar,
      );
      assert("POST /config/import (bad json) → 200 with errors", r.status === 200);
      const summary = r.body as {
        imported: string[];
        skipped: string[];
        errors: { file: string }[];
      };
      assert(
        "  imported is empty (atomic failure)",
        summary.imported.length === 0,
        JSON.stringify(summary),
      );
      assert(
        "  errors mentions models.json",
        summary.errors.some((e) => e.file === "models.json"),
        JSON.stringify(summary.errors),
      );

      // Confirm the disk state is unchanged.
      assert(
        "  settings.json on disk unchanged",
        (await readFile(join(configDir, "settings.json"), "utf8")) === settingsBefore,
      );
      assert(
        "  models.json on disk unchanged",
        (await readFile(join(configDir, "models.json"), "utf8")) === modelsBefore,
      );
      assert(
        "  mcp.json on disk unchanged",
        (await readFile(join(dataDir, "mcp.json"), "utf8")) === mcpBefore,
      );
    }

    // ---- 5. Import with no file in the multipart → 400 ----
    {
      const fd = new FormData();
      fd.append("notafile", "hi");
      const res = await fetch(`${base}/api/v1/config/import`, { method: "POST", body: fd });
      assert("POST /config/import (no file) → 400", res.status === 400, `status=${res.status}`);
    }

    // ---- 6. Import a non-gzip body → 400/500 with a parseable error ----
    {
      // Plain (un-gzipped) tar still has a tar header but our buffer
      // here is just gibberish — parse failure should be surfaced as
      // a 400 (invalid_multipart) or 500 (internal) with a clean JSON
      // body, NEVER an unhandled rejection that crashes the route.
      const bogus = Buffer.from("this is definitely not a tar.gz file at all");
      const r = await postMultipart(
        base,
        "/api/v1/config/import",
        "file",
        "config.tar.gz",
        "application/gzip",
        bogus,
      );
      assert(
        "POST /config/import (gibberish) returns a structured error",
        r.status === 400 || r.status === 500,
        `status=${r.status} body=${JSON.stringify(r.body)}`,
      );
      assert(
        "  body has an `error` field",
        typeof (r.body as { error?: unknown })?.error === "string",
        JSON.stringify(r.body),
      );
    }

    // ---- 7. Export with one file missing on disk → tar omits it ----
    {
      await rm(join(dataDir, "mcp.json"));
      const r = await getRaw(base, "/api/v1/config/export");
      assert("GET /config/export (missing mcp.json) → 200", r.status === 200);
      const filesList = (r.headers.get("x-pi-forge-files") ?? "")
        .split(",")
        .filter((s) => s.length > 0)
        .sort();
      // The two `*-overrides.json` files were re-imported in step 2
      // and again touched by step 3, so they're still on disk and
      // included in this missing-mcp.json export.
      assert(
        "  X-Pi-Forge-Files omits missing mcp.json",
        JSON.stringify(filesList) ===
          JSON.stringify([
            "models.json",
            "settings.json",
            "skills-overrides.json",
            "tool-overrides.json",
          ]),
        JSON.stringify(filesList),
      );
      const entries = (await listTarEntries(r.buf)).sort();
      assert(
        "  tar contents omit missing mcp.json",
        JSON.stringify(entries) ===
          JSON.stringify([
            "models.json",
            "settings.json",
            "skills-overrides.json",
            "tool-overrides.json",
          ]),
        JSON.stringify(entries),
      );
    }

    // Squash an unused-import warning when zlib helpers aren't reached
    // by every assertion path above.
    void gunzipSync;
    void gzipSync;
  } finally {
    await fastify.close();
    await rm(workspacePath, { recursive: true, force: true });
    await rm(configDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.log(`\n[test-config-export] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-config-export] all assertions passed");
}

main()
  .then(() => {
    // tar's Pack/Parse streams + undici's keep-alive agent can leave
    // the event loop with refs that never resolve, hanging the
    // process even after fastify.close() and tmp-dir cleanup.
    // Explicit exit avoids leaving the runner waiting.
    process.exit(0);
  })
  .catch((err) => {
    console.log(`[test-config-export] uncaught: ${(err as Error).stack ?? String(err)}`);
    process.exit(1);
  });

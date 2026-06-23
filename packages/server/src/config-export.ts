/**
 * Config export / import as a flat `.tar.gz`.
 *
 * What's included (and why):
 *   - `mcp.json`              — pi-forge-owned MCP server registry
 *   - `settings.json`         — pi-owned defaults (model, thinking level, skills patterns)
 *   - `models.json`           — pi-owned custom providers
 *   - `skills-overrides.json` — pi-forge-private per-project skill enable/disable state
 *   - `tool-overrides.json`   — pi-forge-private per-project tool enable/disable state
 *   - `theme.json`            — pi-forge-private global UI color theme
 *
 * The two `*-overrides.json` files live in `${FORGE_DATA_DIR}` (not
 * `${PI_CONFIG_DIR}` like the other three). They're included because
 * the user's per-project tool/skill toggle decisions are part of "the
 * pi-forge config a power-user wants to carry across installations" —
 * pairing a backup of `settings.json` (global skill patterns) without
 * also backing up the per-project overrides loses information.
 * `projectId`s in the overrides files are local UUIDs — re-importing
 * onto an installation with a different `projects.json` will leave
 * orphan entries that are silently ignored at session-create time.
 * Acceptable trade-off; the alternative (refusing to import overrides
 * when project IDs don't match) would defeat the point of carrying
 * per-project config across installs that share workspaces.
 *
 * What's deliberately EXCLUDED:
 *   - `auth.json` — provider API keys + OAuth tokens. OAuth tokens are
 *     installation-bound (a token issued for one pi-forge instance is
 *     not portable), and inline API keys are sensitive enough that
 *     bundling them into a download the user might forward by accident
 *     (Slack, Drive, ticket attachment) outweighs the convenience. The
 *     import flow tells the user to re-authenticate providers
 *     afterwards.
 *   - `projects.json` — installation-bound (project paths reference
 *     local disk locations that won't exist on the target machine).
 *   - The auto-generated `jwt-secret` and `password-hash` files —
 *     installation-bound, intentionally not portable.
 *
 * Archive layout: a flat tar with the files at the top level (no
 * leading directory). Importing rejects any entry that isn't one of
 * the allow-listed names — this is the only validation that matters
 * for safety, since the names map deterministically to disk targets.
 *
 * Atomic writes: each imported file lands in `<dst>.import.tmp` first,
 * then `rename`s into place — same shape config-manager / project-
 * manager already use, so a crash mid-import never produces a half-
 * written config file.
 */
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { create as tarCreate, extract as tarExtract } from "tar";
import { config } from "./config.js";

/**
 * The exact set of filenames we accept on import and emit on export.
 * Anything else in an uploaded tar is silently ignored (reported in
 * `skipped`). Defined as a `Set` so the import filter is O(1) per
 * entry and we can't accidentally accept a near-miss like
 * `Settings.json` on a case-sensitive filesystem.
 */
const ALLOWED_FILES = [
  "mcp.json",
  "settings.json",
  "models.json",
  "skills-overrides.json",
  "tool-overrides.json",
  "theme.json",
] as const;
type AllowedFile = (typeof ALLOWED_FILES)[number];
const ALLOWED_SET: ReadonlySet<string> = new Set<string>(ALLOWED_FILES);

/**
 * Map each allowed name to its on-disk target. Functions (not
 * constants) so changes to `config.piConfigDir` / `config.forgeDataDir`
 * / `config.mcpConfigFile` at test time take effect. The two
 * `*-overrides.json` files live under FORGE_DATA_DIR, NOT PI_CONFIG_DIR
 * — pi-forge-private state, intentionally not commingled with the
 * SDK's directory.
 */
const TARGETS: Record<AllowedFile, () => string> = {
  "mcp.json": () => config.mcpConfigFile,
  "settings.json": () => join(config.piConfigDir, "settings.json"),
  "models.json": () => join(config.piConfigDir, "models.json"),
  "skills-overrides.json": () => config.skillOverridesFile,
  "tool-overrides.json": () => config.toolOverridesFile,
  "theme.json": () => join(config.forgeDataDir, "theme.json"),
};

export interface ExportResult {
  /** Names of files actually included (missing-on-disk files are omitted). */
  files: string[];
  /** Gzipped tar stream — pipe to the HTTP response. */
  stream: Readable;
}

export interface ImportSummary {
  /** Names that were extracted, validated, and renamed into place. */
  imported: string[];
  /**
   * Entries the tar contained that we refused. Two reasons surface here:
   * (a) the entry name isn't in `ALLOWED_FILES`; (b) the entry isn't a
   * regular file (directories, symlinks, hard links, devices). We don't
   * distinguish — the reason isn't actionable for the user beyond
   * "re-export with a real pi-forge instance."
   */
  skipped: string[];
  /**
   * Allowed-name entries that PARSED but FAILED VALIDATION (e.g. not
   * valid JSON). These are NOT imported — partial imports can leave
   * the pi-forge in worse shape than no import.
   */
  errors: { file: string; reason: string }[];
}

/**
 * Hard cap on uploaded tar size. Far above the realistic config size
 * (the three files together are usually <50 KB) but low enough that a
 * malicious or accidental large upload can't DoS the import path
 * (which extracts to a tmp dir before validating). Also matches the
 * route's multipart `fileSize` cap so the two layers agree.
 */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

/**
 * Build the export tar. Stages each existing config file into a tmp
 * directory and tars from there — emitting straight from
 * `config.piConfigDir` would also pick up `auth.json` and any other
 * pi-owned files that aren't part of our export contract.
 *
 * Returns the gzipped readable stream + a summary of what was
 * included. Caller pipes the stream to the HTTP response and consumes
 * `files` for the response header / log line.
 *
 * The temp staging dir is cleaned up on stream `end` / `error`. If
 * the stream is abandoned (caller never reads it), the dir leaks —
 * acceptable for an interactive download path that completes in ms.
 */
export async function buildExportTar(): Promise<ExportResult> {
  const stage = await mkdtemp(join(tmpdir(), "pi-config-export-"));
  const files: string[] = [];
  for (const name of ALLOWED_FILES) {
    const src = TARGETS[name]();
    try {
      const data = await readFile(src);
      await writeFile(join(stage, name), data);
      files.push(name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        await rm(stage, { recursive: true, force: true }).catch(() => undefined);
        throw err;
      }
      // Missing on disk — silently skip. An empty tar is valid.
    }
  }
  // tar's `Pack` extends `Minipass`, which is API-compatible with
  // node:stream Readable but typed independently. Cast at the
  // boundary so the public return type is the standard one.
  const pack = tarCreate({ gzip: true, cwd: stage }, files);
  const stream = pack as unknown as Readable;
  const cleanup = (): void => {
    void rm(stage, { recursive: true, force: true }).catch(() => undefined);
  };
  stream.once("end", cleanup);
  stream.once("error", cleanup);
  stream.once("close", cleanup);
  return { files, stream };
}

/**
 * Extract a previously-exported tar from a Buffer and write any
 * allowed files atomically into their on-disk targets.
 *
 * Two-phase, by design:
 *   1. Extract entire archive to a private temp dir, refusing any
 *      entry name that isn't in `ALLOWED_FILES`.
 *   2. Validate each accepted file (JSON.parse). Files that fail
 *      validation never make it to disk.
 *   3. Atomic rename per file from temp into target.
 *
 * The "validate before any disk write" ordering matters: a partial
 * import (e.g. `mcp.json` good, `settings.json` corrupt) would leave
 * the pi-forge in worse shape than before the user clicked Import.
 * Either everything valid lands, or nothing does — per file, ALL
 * pass validation before ANY rename runs.
 *
 * Caller is responsible for the upload size cap on the route side;
 * we double-check here against `MAX_IMPORT_BYTES` so a direct caller
 * (test, future route) can't bypass the limit.
 */
export async function importConfigFromBuffer(buf: Buffer): Promise<ImportSummary> {
  if (buf.byteLength > MAX_IMPORT_BYTES) {
    throw new Error(
      `tar exceeds ${MAX_IMPORT_BYTES} bytes (got ${buf.byteLength}); refusing to import`,
    );
  }
  const stage = await mkdtemp(join(tmpdir(), "pi-config-import-"));
  try {
    const accepted: string[] = [];
    const skipped: string[] = [];

    // tar.extract consumes a stream. Wrap the buffer as a Readable.
    // The `filter` callback fires per-entry BEFORE bytes are written,
    // so a rejected entry never touches disk.
    await new Promise<void>((resolve, reject) => {
      const extractStream = tarExtract({
        cwd: stage,
        // Reject absolute paths and `..` segments at the tar layer;
        // belt-and-suspenders since our filter also enforces it.
        strict: true,
        filter: (path, entry) => {
          // path comes through as the entry name verbatim; reject
          // anything that smells like a directory traversal or a
          // non-file. Matching against the exact ALLOWED_SET is the
          // primary safety boundary.
          //
          // `entry` is typed as `ReadEntry | Stats` because `tar` reuses
          // this filter for both pack and unpack; on extract it's
          // always a `ReadEntry` carrying `.type`. Narrow defensively.
          const entryType = (entry as { type?: string }).type;
          if (entryType !== undefined && entryType !== "File") {
            skipped.push(path);
            return false;
          }
          if (
            path.includes("/") ||
            path.includes("\\") ||
            path.includes("..") ||
            path.startsWith(".")
          ) {
            skipped.push(path);
            return false;
          }
          if (!ALLOWED_SET.has(path)) {
            skipped.push(path);
            return false;
          }
          accepted.push(path);
          return true;
        },
      });
      extractStream.on("error", reject);
      extractStream.on("finish", () => resolve());
      Readable.from(buf).pipe(extractStream);
    });

    // Validate every accepted file before ANY rename. JSON.parse is
    // the contract — pi's loaders all assume parseable JSON, and an
    // import that lands invalid JSON would brick the next agent
    // session create.
    const errors: { file: string; reason: string }[] = [];
    const valid: string[] = [];
    for (const name of accepted) {
      try {
        const raw = await readFile(join(stage, name), "utf8");
        JSON.parse(raw);
        valid.push(name);
      } catch (err) {
        errors.push({ file: name, reason: err instanceof Error ? err.message : String(err) });
      }
    }
    if (errors.length > 0) {
      // Fail the whole import on any per-file validation error so the
      // user gets a single clear failure, not "imported half, broke
      // half." The summary still surfaces every error so the user
      // knows which file was bad.
      return { imported: [], skipped, errors };
    }

    // Atomic move. mkdir parent dirs since pi config dir might not
    // exist on a fresh deploy that's only setting these via import.
    const imported: string[] = [];
    for (const name of valid) {
      const src = join(stage, name);
      const dst = TARGETS[name as AllowedFile]();
      await mkdir(dirname(dst), { recursive: true });
      const tmpDst = `${dst}.${Date.now()}.import.tmp`;
      await rename(src, tmpDst);
      await rename(tmpDst, dst);
      imported.push(name);
    }
    return { imported, skipped, errors };
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

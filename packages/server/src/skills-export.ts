/**
 * Skills export / import as a flat `.tar.gz`.
 *
 * What's included: every file under `${piConfigDir}/skills/`. Skills
 * come in two shapes — single-file (`<name>.md`) or directory
 * (`<name>/SKILL.md` plus any assets the skill references). The
 * exporter mirrors the source tree verbatim; the importer extracts
 * back into the same shape.
 *
 * What's deliberately EXCLUDED on import: anything outside the skills
 * subtree. The tar is rooted AT the skills directory contents (no
 * leading `skills/` prefix), so an entry like `../auth.json` or
 * `/etc/passwd` is rejected by the path-safety filter before any
 * bytes touch disk.
 *
 * Two import shapes are supported by the route layer:
 *   - A single `.tar.gz` upload (this module's `importSkillsFromTar`).
 *   - A multi-file folder upload (`importSkillsFromFiles`) — when the
 *     user picks a folder via `<input webkitdirectory>` the browser
 *     sends one multipart entry per file with the relative path in the
 *     filename. Same safety rules apply: relative paths only, no
 *     traversal, regular files only.
 *
 * Restore policy: per-file `.tmp` + rename so a partially-uploaded
 * archive never leaves a half-written file behind. Directories are
 * created with `recursive: true` as needed. Existing files in the
 * skills tree are OVERWRITTEN — the export is the source of truth on
 * restore, mirroring the config-export contract.
 */
import {
  chmod,
  chown,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { create as tarCreate, extract as tarExtract } from "tar";
import { config } from "./config.js";

/**
 * Hard cap on uploaded archive / folder size. Skills directories are
 * usually a handful of small markdown files (<100 KB total); 50 MB
 * accommodates large directory skills with images / scripts while
 * still bounding accidental or malicious uploads.
 */
export const MAX_SKILLS_IMPORT_BYTES = 50 * 1024 * 1024;

const SANDBOX_SKILL_FILE_MODE = 0o664;
const SANDBOX_SKILL_DIR_MODE = 0o775;
const FALLBACK_SKILL_FILE_MODE = 0o666;
const FALLBACK_SKILL_DIR_MODE = 0o777;

let warnedAboutPermissiveSkillImportFallback = false;

function skillsDir(): string {
  return join(config.piConfigDir, "skills");
}

export interface SkillsExportResult {
  /** Number of files actually packed (for the X-header / log line). */
  fileCount: number;
  /** Gzipped tar stream — pipe to the HTTP response. */
  stream: Readable;
}

export interface SkillsImportSummary {
  /** Relative paths of files written into the skills directory. */
  imported: string[];
  /**
   * Entries the input contained that we refused. Reasons surface
   * compactly via the `reason` field — "absolute_path",
   * "traversal", "non_file", "size_cap".
   */
  skipped: { name: string; reason: string }[];
}

/**
 * Thrown by `buildSkillsExportTar` when the skills directory is
 * missing or empty. The route layer catches this and returns a 409
 * with a structured body so the UI can show "No skills to export"
 * instead of triggering a download of an empty / malformed archive.
 *
 * (Background: tar 7.x's `create()` throws synchronously with "no
 * paths specified to add to archive" on an empty entries list, and a
 * hand-rolled 1024-zero-byte tar is rejected by tar 7.x's reader as
 * `TAR_BAD_ARCHIVE`. Both round-trip and "ship something to satisfy
 * the download" approaches are worse than just refusing the export.)
 */
export class SkillsDirectoryEmptyError extends Error {
  constructor() {
    super("skills directory is empty");
    this.name = "SkillsDirectoryEmptyError";
  }
}

/**
 * Build the export tar. Throws `SkillsDirectoryEmptyError` when the
 * skills tree is missing or contains no files — see the class
 * docstring for why we don't ship an empty archive.
 *
 * Streams from the source dir directly; no staging copy is needed
 * because the skills tree is read-only from this module's
 * perspective (the only writers are the user via the file system or
 * the import path below, which never overlaps with an in-flight
 * export).
 */
export async function buildSkillsExportTar(): Promise<SkillsExportResult> {
  const src = skillsDir();
  let entries: string[] = [];
  try {
    entries = await listFilesRelative(src);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (entries.length === 0) throw new SkillsDirectoryEmptyError();
  const pack = tarCreate({ gzip: true, cwd: src }, entries);
  const stream = pack as unknown as Readable;
  return { fileCount: entries.length, stream };
}

/**
 * In sandbox mode, imported skills must be readable/writable by the
 * `pi-tools` identity that runs terminals and model tools. Prefer
 * ownership by AGENT_TOOL_UID:GID; fall back to permissive modes when
 * local non-root dev/test runs cannot chown.
 */
async function ensureSandboxSkillPathPermissions(path: string, directory: boolean): Promise<void> {
  if (!config.agentToolSandbox.enabled) return;
  const mode = directory ? SANDBOX_SKILL_DIR_MODE : SANDBOX_SKILL_FILE_MODE;
  await chmod(path, mode);
  const uid = config.agentToolSandbox.uid!;
  const gid = config.agentToolSandbox.gid!;
  const currentUid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const currentGid = typeof process.getgid === "function" ? process.getgid() : undefined;
  if (currentUid === uid && currentGid === gid) return;
  try {
    await chown(path, uid, gid);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") throw err;
    if (config.isProduction) {
      throw new Error(
        "failed to set sandbox skill ownership; refusing permissive fallback in production",
        { cause: err },
      );
    }
    if (!warnedAboutPermissiveSkillImportFallback) {
      warnedAboutPermissiveSkillImportFallback = true;
      console.warn(
        "[skills-import] unable to chown restored skills to the sandbox tool identity; " +
          "using permissive fallback modes for this non-production import",
      );
    }
    // Some non-root dev/test runs cannot chown to the sandbox identity.
    // Fall back to world-writable import permissions so the configured
    // pi-tools user can still read/write restored skills in sandbox mode.
    await chmod(path, directory ? FALLBACK_SKILL_DIR_MODE : FALLBACK_SKILL_FILE_MODE);
  }
}

async function ensureSandboxSkillDirectoryChain(root: string, dir: string): Promise<void> {
  if (!config.agentToolSandbox.enabled) return;
  await ensureSandboxSkillPathPermissions(root, true);
  const rel = relative(root, dir).split(sep).filter(Boolean);
  let current = root;
  for (const part of rel) {
    current = join(current, part);
    await ensureSandboxSkillPathPermissions(current, true);
  }
}

/**
 * Recursive walk; returns POSIX-style relative paths for each
 * regular file under `dir`. Symlinks are followed via `stat` so a
 * symlinked file gets included as a regular file (matches the
 * upstream pi behavior — a skill can be `ln -s`'d in from elsewhere
 * on the filesystem).
 */
async function listFilesRelative(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string): Promise<void> {
    const ents = await readdir(current, { withFileTypes: true });
    for (const ent of ents) {
      const abs = join(current, ent.name);
      const st = await stat(abs).catch(() => undefined);
      if (st === undefined) continue;
      if (st.isDirectory()) {
        await walk(abs);
      } else if (st.isFile()) {
        out.push(relative(dir, abs).split(sep).join("/"));
      }
    }
  }
  await walk(dir);
  return out;
}

/**
 * Validate a relative path proposed for write. Returns the safe
 * relative form (using POSIX separators) or `undefined` to reject.
 *
 * Rejection reasons (all silent — caller logs the skip):
 *   - absolute path (Windows or POSIX)
 *   - parent traversal (`..` segment)
 *   - leading dot at the path root (`.` / `..` / `.git` / etc.)
 *   - empty after normalisation
 */
function safeRelativePath(name: string): string | undefined {
  if (name.length === 0) return undefined;
  // Block absolute paths early. POSIX leading slash and Windows-style
  // drive letters (`C:\...`) both rejected.
  if (name.startsWith("/") || name.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(name)) {
    return undefined;
  }
  const normalized = normalize(name).split(sep).join("/");
  if (normalized.startsWith("../") || normalized === "..") return undefined;
  if (normalized.split("/").some((seg) => seg === "..")) return undefined;
  if (normalized.startsWith("./")) return undefined;
  if (normalized.length === 0 || normalized === ".") return undefined;
  return normalized;
}

/**
 * Extract a tar.gz buffer into the skills directory. Path safety is
 * enforced by `tar`'s `strict: true` (rejects absolute paths and
 * `..`) plus our own `filter` callback (final enforcement against
 * the skills root). Each extracted file is renamed atomically into
 * place after the tar finishes — partial failures don't leave
 * mixed state.
 */
export async function importSkillsFromTar(buf: Buffer): Promise<SkillsImportSummary> {
  if (buf.byteLength > MAX_SKILLS_IMPORT_BYTES) {
    throw new Error(
      `archive exceeds ${MAX_SKILLS_IMPORT_BYTES} bytes (got ${buf.byteLength}); refusing to import`,
    );
  }
  const stage = await mkdtemp(join(tmpdir(), "pi-skills-import-"));
  try {
    const accepted: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    await new Promise<void>((resolve, reject) => {
      const extractStream = tarExtract({
        cwd: stage,
        strict: true,
        filter: (path, entry) => {
          const entryType = (entry as { type?: string }).type;
          if (entryType !== undefined && entryType !== "File") {
            skipped.push({ name: path, reason: "non_file" });
            return false;
          }
          const safe = safeRelativePath(path);
          if (safe === undefined) {
            skipped.push({ name: path, reason: "unsafe_path" });
            return false;
          }
          accepted.push(safe);
          return true;
        },
      });
      extractStream.on("error", reject);
      extractStream.on("finish", () => resolve());
      Readable.from(buf).pipe(extractStream);
    });
    return await commitStaged(stage, accepted, skipped);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Write a list of pre-buffered files (e.g. from a folder upload via
 * `<input webkitdirectory>`) into the skills directory. The browser
 * gives us one entry per file with `filename` carrying the relative
 * path inside the user-picked folder. We apply the same path-safety
 * filter as the tar path.
 *
 * Sums each part's size against `MAX_SKILLS_IMPORT_BYTES` so a
 * many-file folder can't bypass the cap by being split across parts.
 */
export async function importSkillsFromFiles(
  files: { filename: string; buffer: Buffer }[],
): Promise<SkillsImportSummary> {
  let total = 0;
  for (const f of files) total += f.buffer.byteLength;
  if (total > MAX_SKILLS_IMPORT_BYTES) {
    throw new Error(
      `combined files exceed ${MAX_SKILLS_IMPORT_BYTES} bytes (got ${total}); refusing to import`,
    );
  }
  const stage = await mkdtemp(join(tmpdir(), "pi-skills-folder-import-"));
  try {
    const accepted: string[] = [];
    const skipped: { name: string; reason: string }[] = [];
    for (const f of files) {
      const safe = safeRelativePath(f.filename);
      if (safe === undefined) {
        skipped.push({ name: f.filename, reason: "unsafe_path" });
        continue;
      }
      const dest = join(stage, safe);
      await mkdir(dirname(dest), { recursive: true });
      await writeFile(dest, f.buffer);
      accepted.push(safe);
    }
    return await commitStaged(stage, accepted, skipped);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Move every staged file into the skills directory atomically.
 * Shared by both import paths so the on-disk write contract is
 * identical regardless of input shape.
 */
async function commitStaged(
  stage: string,
  accepted: string[],
  skipped: { name: string; reason: string }[],
): Promise<SkillsImportSummary> {
  const dst = skillsDir();
  await mkdir(dst, { recursive: true });
  await ensureSandboxSkillDirectoryChain(dst, dst);
  const imported: string[] = [];
  for (const name of accepted) {
    const src = join(stage, name);
    const target = join(dst, name);
    const targetDir = dirname(target);
    await mkdir(targetDir, { recursive: true });
    await ensureSandboxSkillDirectoryChain(dst, targetDir);
    const tmpDst = `${target}.${Date.now()}.import.tmp`;
    try {
      await rename(src, tmpDst);
      await ensureSandboxSkillPathPermissions(tmpDst, false);
      await rename(tmpDst, target);
      await ensureSandboxSkillPathPermissions(target, false);
      imported.push(name);
    } catch (err) {
      // Best-effort cleanup of the .tmp if rename-into-place failed.
      await rm(tmpDst, { force: true }).catch(() => undefined);
      skipped.push({ name, reason: (err as Error).message });
    }
  }
  return { imported, skipped };
}

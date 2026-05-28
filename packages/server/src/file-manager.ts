import {
  mkdir,
  open as fsOpen,
  readFile as fsReadFile,
  readdir,
  realpath,
  rename as fsRename,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile as fsWriteFile,
} from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { once } from "node:events";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { create as tarCreate } from "tar";
import type { Readable } from "node:stream";

/**
 * Filesystem operations bounded by a per-call project root.
 *
 * The route layer passes a `rootPath` (the project's absolute path) to each
 * function. Every public function resolves the input path and asserts it is
 * inside that root before touching disk; otherwise it throws
 * `PathOutsideRootError`. Routes catch that and return 403.
 *
 * This is the ONLY module that should call `fs.*` for filesystem
 * operations rooted in a project. Route handlers must not import `node:fs`
 * directly — every disk write/read goes through here so the path-traversal
 * checks can't be skipped.
 */

/* ----------------------------- errors ----------------------------- */

export class PathOutsideRootError extends Error {
  constructor(target: string, root: string) {
    super(`path outside project root: ${target} (root=${root})`);
    this.name = "PathOutsideRootError";
  }
}

export class NotFoundError extends Error {
  constructor(path: string) {
    super(`not found: ${path}`);
    this.name = "NotFoundError";
  }
}

export class NotAFileError extends Error {
  constructor(path: string) {
    super(`not a file: ${path}`);
    this.name = "NotAFileError";
  }
}

export class FileTooLargeError extends Error {
  readonly size: number;
  readonly limit: number;
  constructor(path: string, size: number, limit: number) {
    super(`file too large: ${path} (${size} > ${limit})`);
    this.name = "FileTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

export class DirectoryNotEmptyError extends Error {
  constructor(path: string) {
    super(`directory not empty: ${path}`);
    this.name = "DirectoryNotEmptyError";
  }
}

export class InvalidNameError extends Error {
  constructor(message = "invalid file name") {
    super(message);
    this.name = "InvalidNameError";
  }
}

export class ChecksumMismatchError extends Error {
  readonly target: string;
  readonly expected: string;
  readonly actual: string;
  constructor(target: string, expected: string, actual: string) {
    super(`checksum mismatch at ${target} (expected ${expected}, got ${actual})`);
    this.name = "ChecksumMismatchError";
    this.target = target;
    this.expected = expected;
    this.actual = actual;
  }
}

export class TargetExistsError extends Error {
  constructor(path: string) {
    super(`target already exists: ${path}`);
    this.name = "TargetExistsError";
  }
}

/* ----------------------------- limits ----------------------------- */

/**
 * Hard cap on a single read. The editor would not give a useful experience
 * for anything larger, and the JSON encoding of a multi-MB file blows past
 * Fastify's default body limit on the round-trip back. Mirrors the
 * `CLAUDE.md` 5 MB ceiling.
 */
export const MAX_READ_BYTES = 5 * 1024 * 1024;

/**
 * Directory names skipped by `getTree`. Same set as pi's session-discovery
 * + a few editor-specific ones. Hidden dotfiles below the root are NOT
 * skipped (a `.env` should still appear), but `.git` itself is — the
 * editor has no use for the object database, and walking it dwarfs every
 * other dir.
 */
const TREE_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  ".next",
  ".nuxt",
  "coverage",
  ".vite",
  ".turbo",
  ".cache",
]);

/**
 * Re-export the directory exclusion list so file-searcher.ts can
 * apply the same filter when ripgrep is unavailable. Keeping a
 * single source of truth here avoids drift between the file-tree
 * view and the in-process search results.
 */
export const SEARCH_SKIP_DIRS: ReadonlySet<string> = TREE_SKIP_DIRS;

const DEFAULT_TREE_DEPTH = 6;

/* ----------------------------- guards ----------------------------- */

/**
 * Resolve `target` and assert it is inside `root` (or equal to it). Returns
 * the resolved absolute path on success; throws PathOutsideRootError on a
 * traversal attempt. Use this on every entry point — never trust route
 * input. `relative()` returning a path that starts with `..` is the
 * canonical post-resolution traversal signal.
 *
 * NOTE: this is a LEXICAL check only (`resolve()` doesn't follow
 * symlinks). For ops that touch disk, prefer `resolveAndCheck` which
 * additionally `realpath`s the target so a symlink-out-of-root can't
 * sneak past.
 *
 * NUL bytes are rejected here too: `fs.*` APIs throw a non-Error.code
 * shape ("string contains null bytes") for paths containing `\0`,
 * which falls through `mapError` to a 500. We turn it into a 403
 * `path_not_allowed` instead so the wire shape matches every other
 * traversal attempt.
 */
export function assertInsideRoot(target: string, root: string): string {
  if (target.includes("\0")) throw new PathOutsideRootError(target, root);
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return resolvedTarget;
  const rel = relative(resolvedRoot, resolvedTarget);
  if (rel.length === 0 || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw new PathOutsideRootError(target, root);
  }
  return resolvedTarget;
}

/**
 * Lexical-check + realpath-resolve `target`, ensuring the FINAL
 * (symlink-followed) path is still inside `root`. This is what
 * disk-touching ops should use — `assertInsideRoot` alone misses
 * symlinks (a symlink inside the project pointing OUT escapes the
 * lexical check).
 *
 * Handles both existing and not-yet-existing targets in one pass:
 * walks UP from the target until it finds a path that exists,
 * realpaths that ancestor, and verifies it's inside realpath(root).
 * If any ancestor along the way is a symlink that escapes, we catch
 * it. For non-existent leaf paths (creates), the caller still passes
 * the lexical absolute path to the eventual `fs.*` call — the safety
 * guarantee is on the parent chain, not the target itself.
 *
 * Returns the lexically-resolved absolute path on success, which is
 * what the caller passes to fs ops.
 *
 * TOCTOU: between this check and the eventual `fs.*` call, an attacker
 * could swap a real dir for a symlink. In a single-tenant model where
 * attacker = user, this is acceptable; the SDK ships under the same
 * threat model.
 */
async function verifyPathSafe(target: string, root: string): Promise<string> {
  // Lexical pre-check (cheap, fails fast — also handles NUL byte
  // rejection so fs.* doesn't throw a non-Error.code shape that
  // mapError would surface as a 500).
  assertInsideRoot(target, root);
  const realRoot = await realpath(root);
  const lexicalTarget = resolve(target);
  let cursor = lexicalTarget;
  while (true) {
    try {
      const real = await realpath(cursor);
      assertInsideRoot(real, realRoot);
      return lexicalTarget;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
      const parent = dirname(cursor);
      if (parent === cursor) {
        // Walked up to filesystem root and every ancestor ENOENT'd.
        // Shouldn't happen in practice (root itself exists at startup
        // — index.ts mkdir's it).
        throw new PathOutsideRootError(target, root);
      }
      cursor = parent;
    }
  }
}

/**
 * File-name validation for create / rename targets. Rejects empty strings,
 * path separators (a "name" must be a single segment), and the `.` / `..`
 * special entries. Trailing whitespace is stripped, but interior spaces and
 * dots are allowed (e.g. ".env", "tsconfig.json", "my file.txt").
 */
function validateName(name: string): string {
  const trimmed = name.trim();
  if (
    trimmed.length === 0 ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new InvalidNameError();
  }
  return trimmed;
}

/* ----------------------------- tree ----------------------------- */

export interface TreeNode {
  name: string;
  /** Path RELATIVE to the project root (no leading slash). */
  path: string;
  type: "file" | "directory";
  /** Present on `directory` nodes only. */
  children?: TreeNode[];
  /** True when the node is a directory we declined to recurse into (depth cap or skip set). */
  truncated?: boolean;
}

export interface GetTreeOptions {
  maxDepth?: number;
}

export async function getTree(rootPath: string, opts: GetTreeOptions = {}): Promise<TreeNode> {
  const root = resolve(rootPath);
  // Verify root exists + is a directory; the caller already filtered by
  // project, so this is a sanity check, not a security check.
  const st = await stat(root).catch(() => undefined);
  if (!st?.isDirectory()) {
    throw new NotFoundError(root);
  }
  const maxDepth = opts.maxDepth ?? DEFAULT_TREE_DEPTH;
  return walk(root, root, "", 0, maxDepth);
}

async function walk(
  dir: string,
  root: string,
  relPath: string,
  depth: number,
  maxDepth: number,
): Promise<TreeNode> {
  const name = relPath === "" ? "" : (relPath.split(sep).pop() ?? "");
  const node: TreeNode = {
    name,
    path: relPath,
    type: "directory",
    children: [],
  };
  if (depth >= maxDepth) {
    node.truncated = true;
    delete node.children;
    return node;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    // unreadable subtree — surface as truncated rather than throwing the
    // whole tree request away. The route still gets a useful response.
    node.truncated = true;
    delete node.children;
    return node;
  }
  // Sort: directories first, then files; within each, case-insensitive.
  entries.sort((a, b) => {
    const da = a.isDirectory() ? 0 : 1;
    const db = b.isDirectory() ? 0 : 1;
    if (da !== db) return da - db;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  });
  for (const ent of entries) {
    if (ent.isDirectory() && TREE_SKIP_DIRS.has(ent.name)) continue;
    const childRel = relPath === "" ? ent.name : `${relPath}${sep}${ent.name}`;
    const childAbs = join(dir, ent.name);
    if (ent.isDirectory()) {
      const sub = await walk(childAbs, root, childRel, depth + 1, maxDepth);
      node.children?.push(sub);
    } else if (ent.isFile()) {
      node.children?.push({
        name: ent.name,
        path: childRel,
        type: "file",
      });
    } else if (ent.isSymbolicLink()) {
      const linked = await safeLinkedStat(childAbs, root).catch(() => undefined);
      if (linked?.isDirectory()) {
        if (TREE_SKIP_DIRS.has(ent.name)) continue;
        const sub = await walk(childAbs, root, childRel, depth + 1, maxDepth);
        node.children?.push(sub);
      } else if (linked?.isFile()) {
        node.children?.push({
          name: ent.name,
          path: childRel,
          type: "file",
        });
      }
    }
    // Sockets, fifos, devices, and symlinks that resolve outside the
    // project root are skipped silently. Safe in-root symlinks are
    // listed as their target kind so the editor can open linked files.
  }
  return node;
}

async function safeLinkedStat(path: string, root: string) {
  await verifyPathSafe(path, root);
  return stat(path);
}

/* ----------------------------- read ----------------------------- */

export interface ReadResult {
  path: string;
  /** Decoded UTF-8 content. */
  content: string;
  size: number;
  language: string;
  /** True when the file was read but identified as binary (content blank). */
  binary: boolean;
}

/**
 * Flat list of every file under `root` (recursive) used by the
 * chat-input `@` autocomplete. Skips the same directories `getTree`
 * does. Returns POSIX-style paths RELATIVE to `root` so a single
 * project's listing transports / sorts predictably; the caller joins
 * back to `root` when actually reading a file.
 *
 * No max-depth — `@` completion is meant to find anything in the
 * tree. The skip-list keeps `node_modules` etc. out, so the walk
 * terminates in a reasonable time on real projects. For a 50k-file
 * monorepo this is probably tens of milliseconds; cache at the
 * caller (or per-project) if it shows up in profiles.
 */
export async function listAllFiles(rootPath: string): Promise<string[]> {
  const root = resolve(rootPath);
  const st = await stat(root).catch(() => undefined);
  if (!st?.isDirectory()) throw new NotFoundError(root);
  const out: string[] = [];
  await walkFlat(root, root, "", out);
  return out;
}

/**
 * Recursive walk that emits BOTH files and directories. Directories
 * are emitted with a trailing `/` so the chat input's `@` autocomplete
 * (and any other consumer) can tell them apart at a glance — same
 * convention as `ls -F`. Files have no trailing slash. The
 * skip-list (`node_modules`, `.git`, etc.) still applies — those
 * dirs aren't emitted nor descended into.
 */
async function walkFlat(dir: string, root: string, relPath: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const name = entry.name;
    if (entry.isDirectory()) {
      if (TREE_SKIP_DIRS.has(name)) continue;
      const dirRel = relPath === "" ? name : `${relPath}/${name}`;
      // Emit the directory itself (with trailing `/`) so chat
      // `@`-autocomplete can offer folder references that the LLM
      // explores via its read/grep/find tools — see
      // `expandFileReferences` for the directory-marker handling.
      out.push(`${dirRel}/`);
      await walkFlat(join(dir, name), root, dirRel, out);
    } else if (entry.isFile()) {
      out.push(relPath === "" ? name : `${relPath}/${name}`);
    }
    // Symlinks are intentionally skipped — file-manager's read path
    // realpaths to defeat sym-out-of-root, but the listing surface
    // doesn't need to invite the failure mode.
  }
}

export async function readFile(absPath: string, root: string): Promise<ReadResult> {
  const resolved = await verifyPathSafe(absPath, root);
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (!st.isFile()) throw new NotAFileError(resolved);
  if (st.size > MAX_READ_BYTES) throw new FileTooLargeError(resolved, st.size, MAX_READ_BYTES);
  const buf = await fsReadFile(resolved);
  const binary = looksBinary(buf);
  return {
    path: resolved,
    content: binary ? "" : buf.toString("utf8"),
    size: st.size,
    language: detectLanguage(resolved),
    binary,
  };
}

/**
 * NUL-byte heuristic for binary detection — same approach git uses. Avoids
 * trying to UTF-8-decode (and corrupt) images, archives, and compiled
 * binaries that the editor can't render anyway.
 */
function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/**
 * Lightweight existence + safety + binary-sniff for `@<path>` chat
 * references. Doesn't read the whole file — just verifies the path is
 * safe, stats it, and (for files) peeks the first 8 KB for the binary
 * heuristic.
 *
 * Used by `expandFileReferences` so we can leave a literal `@<path>`
 * marker in the prompt (the model handles loading content via its
 * read/ls/find tools) without burning the read on attestable text
 * files of any size.
 *
 * Returns a discriminated kind so `expandFileReferences` can branch
 * on file-vs-directory. Directories no longer throw — they were
 * previously rejected (`NotAFileError` → "path is a directory"
 * error message), but the model already has tools for exploring
 * directory contents, so passing the path through as a literal
 * marker is more useful.
 *
 * Still throws PathOutsideRootError / NotFoundError for anything
 * that isn't a regular file or directory under the root.
 */
export type ReferenceCheckResult =
  | { kind: "file"; path: string; size: number; binary: boolean }
  | { kind: "directory"; path: string };

export async function checkFileReference(
  absPath: string,
  root: string,
): Promise<ReferenceCheckResult> {
  const resolved = await verifyPathSafe(absPath, root);
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (st.isDirectory()) {
    return { kind: "directory", path: resolved };
  }
  if (!st.isFile()) throw new NotAFileError(resolved);
  // Real partial read — open the file and read just the first 8 KB
  // for the NUL-byte heuristic. Avoids slurping the whole file just
  // to peek at its prefix.
  const fh = await fsOpen(resolved, "r");
  try {
    const buf = Buffer.alloc(8000);
    const { bytesRead } = await fh.read(buf, 0, 8000, 0);
    return {
      kind: "file",
      path: resolved,
      size: st.size,
      binary: looksBinary(buf.subarray(0, bytesRead)),
    };
  } finally {
    await fh.close();
  }
}

/* ----------------------------- write ----------------------------- */

export async function writeFile(absPath: string, root: string, content: string): Promise<void> {
  const resolved = await verifyPathSafe(absPath, root);
  // Recursively mkdir the parent so writes to a brand-new nested path
  // succeed (`/foo/bar/baz.ts` works even if `/foo/bar` doesn't exist).
  // Safe AFTER verifyPathSafe: the deepest existing ancestor was
  // proven inside `root`, so any dirs we create are under it.
  await mkdir(dirname(resolved), { recursive: true });
  // Atomic-ish write. tmp + rename keeps a partially-written file from
  // ever existing under the target name; same pattern config-manager and
  // project-manager use.
  const tmp = `${resolved}.${randomUUID()}.tmp`;
  await fsWriteFile(tmp, content, "utf8");
  await fsRename(tmp, resolved);
}

/**
 * Open a download stream for `absPath`. For a regular file: a plain
 * read stream + the size for the Content-Length header. For a
 * directory: a streamed gzip-tar of the directory contents (filename
 * is `<dir>.tar.gz`, no Content-Length because we're streaming).
 *
 * Skips the same noise dirs as the file tree (node_modules, .git,
 * dist, build, etc.) so a "download project" doesn't ship hundreds
 * of MB of generated artefacts.
 */
export async function downloadStream(
  absPath: string,
  root: string,
): Promise<
  | { kind: "file"; filename: string; size: number; stream: Readable }
  | { kind: "directory"; filename: string; stream: Readable }
> {
  const resolved = await verifyPathSafe(absPath, root);
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (st.isFile()) {
    return {
      kind: "file",
      filename: basename(resolved),
      size: st.size,
      stream: createReadStream(resolved),
    };
  }
  if (st.isDirectory()) {
    const dirName = basename(resolved).length > 0 ? basename(resolved) : "project";
    // tar's `cwd` is the parent — entries inside the archive are
    // prefixed with `<dirName>/...` so unpacking creates a real
    // top-level directory instead of dumping files into the user's
    // Downloads folder.
    const stream = tarCreate(
      {
        gzip: true,
        cwd: dirname(resolved),
        portable: true,
        // Explicitly preserve symlinks AS symlinks rather than dereferencing
        // them. The default in tar@7 is already false, but state it here
        // so a future major bump or copy/paste can't silently flip the
        // behavior — a project containing a symlink to /etc/passwd would
        // otherwise silently archive that file's contents.
        follow: false,
        filter: (path: string) => {
          for (const part of path.split(/[/\\]/)) {
            if (TREE_SKIP_DIRS.has(part)) return false;
          }
          return true;
        },
      },
      [dirName],
    ) as unknown as Readable;
    return { kind: "directory", filename: `${dirName}.tar.gz`, stream };
  }
  throw new NotFoundError(resolved);
}

/**
 * Stream `source` into `<parentAbsPath>/<name>`, computing SHA-256 as
 * bytes flow. Atomic via tmp-file + rename. The temp file lives in the
 * same directory as the target so the rename is on the same filesystem
 * (cross-fs renames silently fall back to copy+unlink and break the
 * "either old or new — never half" invariant we rely on elsewhere).
 *
 * `expectedSha256` (lowercase hex) is verified BEFORE the swap-in:
 * mismatched uploads never become visible under the target name. The
 * tmp file is unlinked on any error path so we don't leak debris into
 * the project tree.
 *
 * `name` must be a basename (no path separators, no `..`); use the
 * caller's separate `parentAbsPath` to land in nested directories.
 */
export async function writeFileBytes(
  parentAbsPath: string,
  name: string,
  root: string,
  source: AsyncIterable<Buffer | Uint8Array>,
  opts?: { expectedSha256?: string; overwrite?: boolean },
): Promise<{ path: string; size: number; sha256: string }> {
  const parent = await verifyPathSafe(parentAbsPath, root);
  const trimmed = validateName(name);
  const target = await verifyPathSafe(join(parent, trimmed), root);
  const existing = await stat(target).catch(() => undefined);
  if (existing !== undefined) {
    if (opts?.overwrite !== true) throw new TargetExistsError(target);
    if (!existing.isFile()) throw new InvalidNameError("target is a directory");
  }
  await mkdir(parent, { recursive: true });
  const tmp = `${target}.${randomUUID()}.upload.tmp`;
  const hash = createHash("sha256");
  let size = 0;
  const out = createWriteStream(tmp);
  try {
    for await (const chunk of source) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buf);
      size += buf.byteLength;
      if (!out.write(buf)) await once(out, "drain");
    }
    out.end();
    await once(out, "close");
  } catch (err) {
    out.destroy();
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
  const actual = hash.digest("hex");
  const expected = opts?.expectedSha256?.toLowerCase();
  if (expected !== undefined && expected !== actual) {
    await unlink(tmp).catch(() => undefined);
    throw new ChecksumMismatchError(target, expected, actual);
  }
  await fsRename(tmp, target);
  return { path: target, size, sha256: actual };
}

/* ----------------------------- mkdir ----------------------------- */

export async function makeDirectory(
  parentAbsPath: string,
  root: string,
  name: string,
): Promise<string> {
  const trimmed = validateName(name);
  const parent = await verifyPathSafe(parentAbsPath, root);
  const target = await verifyPathSafe(join(parent, trimmed), root);
  // recursive:false — surface "already exists" as a real conflict so the
  // UI can prompt the user instead of silently no-op'ing.
  const exists = await stat(target).catch(() => undefined);
  if (exists !== undefined) throw new TargetExistsError(target);
  await mkdir(target, { recursive: false });
  return target;
}

/* ----------------------------- rename / move ----------------------------- */

export async function renameEntry(absPath: string, root: string, newName: string): Promise<string> {
  const resolved = await verifyPathSafe(absPath, root);
  const trimmed = validateName(newName);
  const target = await verifyPathSafe(join(dirname(resolved), trimmed), root);
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (resolved === target) return target;
  // Case-only rename on a case-insensitive filesystem (macOS HFS+/APFS,
  // Windows NTFS in default mode): `Foo.ts` → `foo.ts` resolves to the
  // SAME inode, so a stat on the target still finds the source file
  // and we'd 409 with "target_exists" even though the user is just
  // rewriting the casing of their own file. Detect this — same path,
  // different case — and route through a tmp-name two-step rename.
  //
  // The tmp name uses `crypto.randomUUID()` for collision resistance
  // against another process racing to create the same path. There IS
  // a TOCTOU window between our rename(resolved → tmp) and rename(
  // tmp → target) where another process could create `target`; POSIX
  // rename atomically replaces it. Single-tenant by design so the
  // attacker = user, but we still stat the target right before the
  // second rename and bail with TargetExistsError if a squatter
  // appeared.
  if (resolved.toLowerCase() === target.toLowerCase()) {
    const tmp = `${resolved}.casefix-${randomUUID()}`;
    await fsRename(resolved, tmp);
    try {
      // Recheck the target now that source is at `tmp` — on a
      // case-insensitive FS the original `stat(target)` above would
      // have hit the same inode as source, so this is the first
      // honest "is target empty?" check.
      const squatter = await stat(target).catch(() => undefined);
      if (squatter !== undefined) throw new TargetExistsError(target);
      await fsRename(tmp, target);
    } catch (err) {
      // Best-effort rollback: if the second rename fails (or the
      // squatter check trips), put the file back under its original
      // name. If THAT fails too, surface the original error — the
      // file is at `tmp` and the user can recover via the file
      // browser.
      await fsRename(tmp, resolved).catch(() => undefined);
      throw err;
    }
    return target;
  }
  const exists = await stat(target).catch(() => undefined);
  if (exists !== undefined) throw new TargetExistsError(target);
  await fsRename(resolved, target);
  return target;
}

export async function moveEntry(
  srcAbsPath: string,
  destAbsPath: string,
  root: string,
): Promise<string> {
  const src = await verifyPathSafe(srcAbsPath, root);
  const dest = await verifyPathSafe(destAbsPath, root);
  const st = await stat(src).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(src);
  // Forbid moving a directory under itself — a classic foot-gun.
  if (st.isDirectory()) {
    const rel = relative(src, dest);
    if (rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${sep}`))) {
      throw new InvalidNameError("cannot move a directory into itself");
    }
  }
  const exists = await stat(dest).catch(() => undefined);
  if (exists !== undefined) throw new TargetExistsError(dest);
  await mkdir(dirname(dest), { recursive: true });
  await fsRename(src, dest);
  return dest;
}

/* ----------------------------- delete ----------------------------- */

export async function deleteEntry(
  absPath: string,
  root: string,
  opts?: { recursive?: boolean },
): Promise<void> {
  const resolved = await verifyPathSafe(absPath, root);
  // Defense in depth: never let a delete reach the project root itself
  // even if it slips past assertInsideRoot's "equal-to-root" allowance.
  if (resolved === resolve(root)) {
    throw new PathOutsideRootError(absPath, root);
  }
  const st = await stat(resolved).catch(() => undefined);
  if (st === undefined) throw new NotFoundError(resolved);
  if (st.isDirectory()) {
    // Empty dirs are always safe to remove. Non-empty dirs require an
    // explicit `recursive: true` from the caller — the route plumbs
    // this from a `?recursive=true` query param which the UI sets only
    // after a second confirmation prompt. Without the flag, a non-
    // empty dir surfaces DirectoryNotEmptyError so the UI can prompt.
    if (opts?.recursive === true) {
      await rm(resolved, { recursive: true, force: false });
      return;
    }
    try {
      await rmdir(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        throw new DirectoryNotEmptyError(resolved);
      }
      throw err;
    }
  } else {
    await rm(resolved, { force: false });
  }
}

/* ----------------------------- language detection ----------------------------- */

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".pyi": "python",
  ".rs": "rust",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".cxx": "cpp",
  ".c": "c",
  ".h": "c",
  ".hpp": "cpp",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".go": "go",
  ".rb": "ruby",
  ".php": "php",
  ".cs": "csharp",
  ".swift": "swift",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".less": "css",
  ".html": "html",
  ".htm": "html",
  ".xml": "xml",
  ".svg": "xml",
  ".plist": "xml",
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".markdown": "markdown",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".fish": "shell",
  ".sql": "sql",
  ".dockerfile": "dockerfile",
  // Templating
  ".jinja": "jinja2",
  ".jinja2": "jinja2",
  ".j2": "jinja2",
  // Config / properties
  ".env": "properties",
  ".ini": "properties",
  ".cfg": "properties",
  ".conf": "properties",
  ".properties": "properties",
  ".toml.lock": "toml",
  // Scripting / data
  ".lua": "lua",
  ".pl": "perl",
  ".pm": "perl",
  ".r": "r",
  ".ps1": "powershell",
  ".psm1": "powershell",
  // Diff / patch
  ".diff": "diff",
  ".patch": "diff",
  // JVM / functional
  ".clj": "clojure",
  ".cljs": "clojure",
  ".cljc": "clojure",
  ".edn": "clojure",
  ".scala": "scala",
  ".sc": "scala",
  ".groovy": "groovy",
  ".gradle": "groovy",
  ".hs": "haskell",
  ".ml": "ocaml",
  ".mli": "ocaml",
  // Schema / IDL
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  // Build
  ".cmake": "cmake",
  ".mk": "makefile",
};

function detectLanguage(absPath: string): string {
  const base = absPath.split(sep).pop() ?? absPath;
  // Basename-first checks: dotfiles and conventionally-named files
  // don't carry a useful extension, so map them by exact name.
  if (base === "Dockerfile" || base.endsWith(".Dockerfile")) return "dockerfile";
  if (base === "Makefile" || base === "makefile" || base === "GNUmakefile") return "makefile";
  if (base === "nginx.conf") return "nginx";
  if (base === ".env" || base.startsWith(".env.")) return "properties";
  if (
    base === ".gitignore" ||
    base === ".dockerignore" ||
    base === ".npmignore" ||
    base === ".prettierignore" ||
    base === ".eslintignore"
  ) {
    return "properties";
  }
  if (base === "CMakeLists.txt") return "cmake";
  const ext = extname(base).toLowerCase();
  return LANG_BY_EXT[ext] ?? "plaintext";
}

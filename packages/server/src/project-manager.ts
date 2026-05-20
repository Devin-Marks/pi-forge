import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";
import { clearProjectOverrides as clearProjectSkillOverrides } from "./skill-overrides.js";
import { clearProjectPromptOverrides } from "./prompt-overrides.js";
import { clearProjectSystemPromptAddendum } from "./system-prompt-overrides.js";

/**
 * Project ids are always `randomUUID()` output. Mirrors the same
 * regex used in session-registry's `sessionDirFor()` validator.
 * Codified here too because the cascade rm path builds a
 * filesystem destination from the id and should reject anything
 * that could escape `${SESSION_DIR}`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export class PathOutsideWorkspaceError extends Error {
  constructor(path: string) {
    super(`path outside workspace: ${path}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

export class NotADirectoryError extends Error {
  constructor(path: string) {
    super(`not a directory: ${path}`);
    this.name = "NotADirectoryError";
  }
}

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`project not found: ${id}`);
    this.name = "ProjectNotFoundError";
  }
}

export class InvalidNameError extends Error {
  constructor(message = "invalid name") {
    super(message);
    this.name = "InvalidNameError";
  }
}

export class InvalidDirectoryNameError extends Error {
  constructor(message = "invalid directory name") {
    super(message);
    this.name = "InvalidDirectoryNameError";
  }
}

export class DuplicatePathError extends Error {
  constructor(path: string) {
    super(`a project already points at: ${path}`);
    this.name = "DuplicatePathError";
  }
}

const PROJECTS_FILE = (): string => join(config.forgeDataDir, "projects.json");

/** True iff `target` is the same path as `root` or strictly inside it. */
export function isInsideWorkspace(target: string, root: string = config.workspacePath): boolean {
  const resolvedTarget = resolve(target);
  const resolvedRoot = resolve(root);
  if (resolvedTarget === resolvedRoot) return true;
  const rel = relative(resolvedRoot, resolvedTarget);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
}

async function ensureConfigDir(): Promise<void> {
  await mkdir(config.forgeDataDir, { recursive: true });
}

/**
 * Run `fn` over each item with at most `limit` in flight at once. Order of
 * results matches the input order, including `undefined` inputs (the fn is
 * still invoked — the helper does not silently skip holes).
 *
 * Errors propagate via `Promise.all`: the first rejecting worker fails the
 * whole call. Wrap `fn` in your own try/catch if you need partial results.
 */
async function mapBounded<T, U>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  };
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

/**
 * Serialise all read-modify-write sequences over projects.json. Without this,
 * two concurrent POST /projects requests can read the same baseline and race
 * the rename(), losing one write. Single-process / single-tenant only — there
 * is no file lock; we don't need cross-process safety.
 */
let projectsLock: Promise<unknown> = Promise.resolve();
function withProjectsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = projectsLock.then(fn, fn);
  // Keep the chain alive but don't propagate failures into subsequent waiters.
  projectsLock = next.catch(() => undefined);
  return next;
}

export async function readProjects(): Promise<Project[]> {
  await ensureConfigDir();
  try {
    const raw = await readFile(PROJECTS_FILE(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isProject);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function isProject(v: unknown): v is Project {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.path === "string" &&
    typeof r.createdAt === "string"
  );
}

async function writeProjects(projects: Project[]): Promise<void> {
  await ensureConfigDir();
  const target = PROJECTS_FILE();
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(projects, null, 2), "utf8");
  try {
    await rename(tmp, target);
  } catch (err) {
    // See atomicWriteJson in config-manager.ts: same tmp-file leak
    // cleanup. Without this, a rename failure (cross-fs, perms,
    // target locked on Windows) leaves the .tmp orphan.
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export async function createProject(name: string, path: string): Promise<Project> {
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    throw new InvalidNameError("project name cannot be empty");
  }
  const lexicalPath = resolve(path);
  // Realpath both sides before the inside-workspace check. The lexical
  // check alone accepts a symlink under WORKSPACE_PATH that points
  // OUTSIDE the realpath bound — e.g. `~/.pi-forge/workspace/external
  // -> /etc` — and registers `/external` (the symlink target) as a
  // legitimate project root. Subsequent file-manager ops would then
  // realpath-bound to the symlink target, NOT to WORKSPACE_PATH.
  // Catch here so a missing target throws NotADirectoryError below
  // rather than the more confusing realpath ENOENT.
  const realPath = await realpath(lexicalPath).catch(() => lexicalPath);
  const realWorkspaceRoot = await realpath(config.workspacePath).catch(() => config.workspacePath);
  if (!isInsideWorkspace(realPath, realWorkspaceRoot)) {
    throw new PathOutsideWorkspaceError(realPath);
  }
  // Persist the canonical (real) path so future operations are
  // consistent and `isInsideWorkspace` in file-manager and elsewhere
  // sees the same shape.
  const resolvedPath = realPath;
  const st = await stat(resolvedPath).catch(() => undefined);
  if (!st?.isDirectory()) {
    throw new NotADirectoryError(resolvedPath);
  }
  return withProjectsLock(async () => {
    const projects = await readProjects();
    if (projects.some((p) => p.path === resolvedPath)) {
      throw new DuplicatePathError(resolvedPath);
    }
    const project: Project = {
      id: randomUUID(),
      name: trimmedName,
      path: resolvedPath,
      createdAt: new Date().toISOString(),
    };
    projects.push(project);
    await writeProjects(projects);
    return project;
  });
}

export async function renameProject(id: string, name: string): Promise<Project> {
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    throw new InvalidNameError("project name cannot be empty");
  }
  return withProjectsLock(async () => {
    const projects = await readProjects();
    const idx = projects.findIndex((p) => p.id === id);
    if (idx === -1) throw new ProjectNotFoundError(id);
    const existing = projects[idx];
    if (existing === undefined) throw new ProjectNotFoundError(id);
    const updated: Project = { ...existing, name: trimmed };
    projects[idx] = updated;
    await writeProjects(projects);
    return updated;
  });
}

/**
 * Caller-supplied warn channel. Routes pass `req.log.warn.bind(req.log)`
 * so cascade-rm warnings flow through pino's structured JSON instead of
 * the bare `console.warn` that would otherwise interleave with
 * structured logs and break log parsers (Loki, Datadog).
 */
type WarnFn = (obj: object, msg: string) => void;
const noopWarn: WarnFn = () => undefined;

export async function deleteProject(
  id: string,
  opts: { cascadeSessionDir?: boolean; logWarn?: WarnFn } = {},
): Promise<{ cascaded: boolean }> {
  const warn = opts.logWarn ?? noopWarn;
  let cascaded = false;
  await withProjectsLock(async () => {
    const projects = await readProjects();
    const next = projects.filter((p) => p.id !== id);
    if (next.length === projects.length) throw new ProjectNotFoundError(id);
    await writeProjects(next);
  });
  // Drop any per-project skill overrides for the deleted project.
  // Best-effort — a failure here doesn't undo the deletion (project
  // is already gone). The orphan would just be cosmetic in the UI's
  // cascade view; it's harmless to read but pointless to keep.
  await clearProjectSkillOverrides(id).catch((err: unknown) => {
    warn({ err, id }, "skill-overrides cleanup failed");
  });
  await clearProjectPromptOverrides(id).catch((err: unknown) => {
    warn({ err, id }, "prompt-overrides cleanup failed");
  });
  await clearProjectSystemPromptAddendum(id).catch((err: unknown) => {
    warn({ err, id }, "system-prompt-overrides cleanup failed");
  });
  if (opts.cascadeSessionDir === true) {
    // Wipe the project's session directory. Best-effort — a missing
    // dir (no sessions ever recorded) is not an error.
    //
    // SAFETY: validate the id is UUID-shaped (the only shape
    // `createProject()` ever produces) BEFORE building the path.
    // `rm({ recursive: true, force: true })` is destructive enough
    // that any path-traversal in `id` would be catastrophic — a
    // hypothetical `id === ".."` would resolve to the parent of
    // `${SESSION_DIR}` and wipe it. Today the only id source is
    // `randomUUID()`, but the validator codifies that invariant
    // against any future code path that imports/restores ids from
    // the wire or a manually-edited projects.json.
    if (!UUID_RE.test(id)) {
      // Should be unreachable — the project record we just deleted
      // had this id, so it passed creation-time validation. Log and
      // skip the cascade rather than rm something dangerous.
      warn({ id }, "refusing cascade rm for non-UUID id");
      return { cascaded };
    }
    const dir = join(config.sessionDir, id);
    try {
      await rm(dir, { recursive: true, force: true });
      cascaded = true;
    } catch (err) {
      // Don't fail the delete itself if cascade cleanup fails — the
      // project record is gone, the session files are just orphaned
      // (the same state that exists when cascade isn't requested).
      // But DO log so a permissions issue isn't silently invisible.
      warn({ err, dir }, "cascade rm failed");
    }
  }
  return { cascaded };
}

export async function getProject(id: string): Promise<Project | undefined> {
  const projects = await readProjects();
  return projects.find((p) => p.id === id);
}

export interface BrowseEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface BrowseResult {
  path: string;
  /** Resolved parent path. `undefined` when `path` is the workspace root. */
  parentPath: string | undefined;
  entries: BrowseEntry[];
}

export async function browseDirectory(requested: string | undefined): Promise<BrowseResult> {
  const target = resolve(requested ?? config.workspacePath);
  if (!isInsideWorkspace(target)) {
    throw new PathOutsideWorkspaceError(target);
  }
  const st = await stat(target).catch(() => undefined);
  if (!st?.isDirectory()) {
    throw new NotADirectoryError(target);
  }
  const dirents = await readdir(target, { withFileTypes: true });
  const dirEntries = dirents.filter((d) => d.isDirectory() && !d.name.startsWith("."));
  // Stat .git children with a bounded concurrency cap — unbounded Promise.all
  // could exhaust the libuv FD pool on a node_modules-shaped tree (closes the
  // Phase-10 deferred item). 16 concurrent stats is plenty for any realistic
  // workspace and well below the default ulimit on macOS/Linux.
  const entries: BrowseEntry[] = await mapBounded(dirEntries, 16, async (ent) => {
    const childPath = join(target, ent.name);
    const gitStat = await stat(join(childPath, ".git")).catch(() => undefined);
    return { name: ent.name, path: childPath, isGitRepo: gitStat !== undefined };
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  const resolvedRoot = resolve(config.workspacePath);
  const parentPath = target === resolvedRoot ? undefined : dirname(target);
  return { path: target, parentPath, entries };
}

export async function createDirectory(parentPath: string, name: string): Promise<string> {
  const trimmed = name.trim();
  if (trimmed.length === 0 || trimmed.includes("/") || trimmed.includes("\\") || trimmed === "..") {
    throw new InvalidDirectoryNameError();
  }
  const parent = resolve(parentPath);
  if (!isInsideWorkspace(parent)) {
    throw new PathOutsideWorkspaceError(parent);
  }
  const target = join(parent, trimmed);
  if (!isInsideWorkspace(target)) {
    throw new PathOutsideWorkspaceError(target);
  }
  await mkdir(target, { recursive: false });
  return target;
}

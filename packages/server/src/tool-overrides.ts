/**
 * pi-forge-private per-tool overrides at
 * `${FORGE_DATA_DIR}/tool-overrides.json`.
 *
 * Two layers, both allow-by-default:
 *
 *   1. **Global** — flat sets `builtin` / `mcp`. A tool whose name
 *      appears in the relevant set is disabled for every project
 *      that doesn't override it.
 *   2. **Per-project** — tri-state. For each project the user can
 *      explicitly enable a tool (overrides global disable),
 *      explicitly disable it (overrides global enable), or stay
 *      silent (= inherit global).
 *
 * Effective state for a tool in project P:
 *
 *   project[P].enable.includes(name)   → enabled  (project override wins)
 *   project[P].disable.includes(name)  → disabled (project override wins)
 *   otherwise                          → !global[family].includes(name)
 *
 * Same shape as `skill-overrides.ts` for the per-project layer; the
 * difference is the global layer (skills don't have one — pi's
 * `settings.skills` lives in pi config, not in this file). Same
 * atomic-write shape (.tmp + rename, mode 0600). Empty arrays /
 * empty project entries are pruned so the file doesn't grow with
 * stale keys after a series of toggles back to inherit.
 *
 * Naming convention matches the names pi sees on the wire:
 *   - builtin:  bare tool name (`bash`, `read`, `grep`, …)
 *   - mcp:      bridged tool name `<server>__<tool>` (the same format
 *               `mcp/manager.bridgeMcpTool` produces; pi never sees
 *               the un-prefixed inner name from the MCP server)
 *
 * Lives outside `${PI_CONFIG_DIR}` because pi's SDK has no native
 * concept of per-tool toggles — this is purely a pi-forge filter
 * applied to the `tools` allowlist passed to `createAgentSession`.
 */
import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

export type ToolFamily = "builtin" | "mcp" | "extension";
export type ToolOverrideState = "enabled" | "disabled";

interface ProjectFamilyOverrides {
  /** Tools this project actively wants ON, regardless of global. */
  enable: string[];
  /** Tools this project actively wants OFF, regardless of global. */
  disable: string[];
}

interface ProjectOverrides {
  builtin: ProjectFamilyOverrides;
  mcp: ProjectFamilyOverrides;
  extension: ProjectFamilyOverrides;
}

export interface ToolOverrides {
  /** Builtin tool names the user has explicitly disabled GLOBALLY. */
  builtin: string[];
  /** Bridged MCP tool names disabled GLOBALLY. */
  mcp: string[];
  /** Pi-extension-registered tool names disabled GLOBALLY. */
  extension: string[];
  /** Map from projectId → that project's tri-state overrides. */
  projects: Record<string, ProjectOverrides>;
}

const EMPTY: ToolOverrides = { builtin: [], mcp: [], extension: [], projects: {} };

function emptyProject(): ProjectOverrides {
  return {
    builtin: { enable: [], disable: [] },
    mcp: { enable: [], disable: [] },
    extension: { enable: [], disable: [] },
  };
}

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.toolOverridesFile), { recursive: true });
}

async function atomicWrite(data: ToolOverrides): Promise<void> {
  await ensureDir();
  const path = config.toolOverridesFile;
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // best-effort
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function normalizeFamilyOverrides(v: unknown): ProjectFamilyOverrides {
  if (typeof v !== "object" || v === null) return { enable: [], disable: [] };
  const obj = v as { enable?: unknown; disable?: unknown };
  return {
    enable: Array.isArray(obj.enable)
      ? obj.enable.filter((n): n is string => typeof n === "string")
      : [],
    disable: Array.isArray(obj.disable)
      ? obj.disable.filter((n): n is string => typeof n === "string")
      : [],
  };
}

/**
 * Read the current overrides from disk. Returns an empty shape if
 * the file is missing, malformed, or has unexpected fields — same
 * "errors don't bubble" posture as skill-overrides, so a corrupt
 * file at boot doesn't block session creation. Backwards-compatible
 * with files written by the pre-per-project version (no `projects`
 * key).
 */
export async function readToolOverrides(): Promise<ToolOverrides> {
  try {
    const raw = await readFile(config.toolOverridesFile, "utf8");
    if (raw.trim().length === 0) {
      return { builtin: [], mcp: [], extension: [], projects: {} };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) {
      return { builtin: [], mcp: [], extension: [], projects: {} };
    }
    const obj = parsed as {
      builtin?: unknown;
      mcp?: unknown;
      extension?: unknown;
      projects?: unknown;
    };
    const builtin = Array.isArray(obj.builtin)
      ? obj.builtin.filter((n): n is string => typeof n === "string")
      : [];
    const mcp = Array.isArray(obj.mcp)
      ? obj.mcp.filter((n): n is string => typeof n === "string")
      : [];
    // `extension` is a new family added alongside the existing
    // builtin/mcp pair. Backwards-compatible: an older overrides
    // file with no `extension` key parses to the empty list, so
    // every extension tool is enabled by default until the user
    // explicitly disables it.
    const extension = Array.isArray(obj.extension)
      ? obj.extension.filter((n): n is string => typeof n === "string")
      : [];
    const projects: Record<string, ProjectOverrides> = {};
    if (typeof obj.projects === "object" && obj.projects !== null) {
      for (const [pid, val] of Object.entries(obj.projects as Record<string, unknown>)) {
        if (typeof val !== "object" || val === null) continue;
        const v = val as { builtin?: unknown; mcp?: unknown; extension?: unknown };
        projects[pid] = {
          builtin: normalizeFamilyOverrides(v.builtin),
          mcp: normalizeFamilyOverrides(v.mcp),
          extension: normalizeFamilyOverrides(v.extension),
        };
      }
    }
    return { builtin, mcp, extension, projects };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { builtin: [], mcp: [], extension: [], projects: {} };
    }
    throw err;
  }
}

/**
 * Toggle a tool's GLOBAL state. `enabled: false` adds the name to
 * the disabled set; `enabled: true` removes it (returning to the
 * implicit-enabled default). Idempotent.
 */
export async function setToolEnabled(
  family: ToolFamily,
  name: string,
  enabled: boolean,
): Promise<ToolOverrides> {
  const cur = await readToolOverrides();
  const list = familyList(cur, family);
  const idx = list.indexOf(name);
  if (enabled) {
    if (idx === -1) return cur; // already enabled (not in disabled set)
    list.splice(idx, 1);
  } else {
    if (idx !== -1) return cur; // already disabled
    list.push(name);
  }
  await atomicWrite(cur);
  return cur;
}

function familyList(cur: ToolOverrides, family: ToolFamily): string[] {
  if (family === "builtin") return cur.builtin;
  if (family === "mcp") return cur.mcp;
  return cur.extension;
}

function projectFamily(entry: ProjectOverrides, family: ToolFamily): ProjectFamilyOverrides {
  if (family === "builtin") return entry.builtin;
  if (family === "mcp") return entry.mcp;
  return entry.extension;
}

/**
 * Set or clear a per-project override for a single tool.
 * `state: "enabled" | "disabled"` adds an explicit override;
 * `state: undefined` clears any existing override (= inherit
 * global). Empty project entries are pruned.
 */
export async function setProjectToolOverride(
  projectId: string,
  family: ToolFamily,
  name: string,
  state: ToolOverrideState | undefined,
): Promise<ToolOverrides> {
  const cur = await readToolOverrides();
  const entry = cur.projects[projectId] ?? emptyProject();
  const fam = projectFamily(entry, family);
  // Remove from BOTH lists first — flipping enable→disable or vice
  // versa is just remove + maybe add. Same dance as
  // skill-overrides.setProjectSkillOverride.
  fam.enable = fam.enable.filter((n) => n !== name);
  fam.disable = fam.disable.filter((n) => n !== name);
  if (state === "enabled") fam.enable.push(name);
  else if (state === "disabled") fam.disable.push(name);

  // Prune the project entry if every family is empty after the
  // toggle. Keeps the file from accumulating stale keys after the
  // user toggles back to inherit.
  const empty =
    entry.builtin.enable.length === 0 &&
    entry.builtin.disable.length === 0 &&
    entry.mcp.enable.length === 0 &&
    entry.mcp.disable.length === 0 &&
    entry.extension.enable.length === 0 &&
    entry.extension.disable.length === 0;
  if (empty) {
    delete cur.projects[projectId];
  } else {
    cur.projects[projectId] = entry;
  }
  await atomicWrite(cur);
  return cur;
}

/**
 * Look up a project's explicit position on a tool. Returns
 * `undefined` when the project has no opinion (= inherit from
 * global).
 */
export function getProjectToolState(
  overrides: ToolOverrides,
  projectId: string,
  family: ToolFamily,
  name: string,
): ToolOverrideState | undefined {
  const entry = overrides.projects[projectId];
  if (entry === undefined) return undefined;
  const fam = projectFamily(entry, family);
  if (fam.enable.includes(name)) return "enabled";
  if (fam.disable.includes(name)) return "disabled";
  return undefined;
}

/**
 * Compute whether a tool is effective (enabled) for a project,
 * combining the global default with any per-project override.
 * Pass `projectId === undefined` to evaluate global state only.
 */
export function isToolEffective(
  overrides: ToolOverrides,
  projectId: string | undefined,
  family: ToolFamily,
  name: string,
): boolean {
  if (projectId !== undefined) {
    const state = getProjectToolState(overrides, projectId, family, name);
    if (state === "enabled") return true;
    if (state === "disabled") return false;
  }
  return !familyList(overrides, family).includes(name);
}

/**
 * Apply the overrides as a filter over a candidate tool list.
 * Returns the names that should remain ACTIVE for the given
 * project (or globally if `projectId === undefined`).
 *
 * Used at every `createAgentSession` call site to filter the
 * allowlist passed as `tools: [...]`. Builds the family-sets once
 * per call so the filter is O(1) per tool.
 */
export function filterEnabledTools(
  overrides: ToolOverrides,
  projectId: string | undefined,
  candidates: { family: ToolFamily; name: string }[],
): string[] {
  return candidates
    .filter(({ family, name }) => isToolEffective(overrides, projectId, family, name))
    .map(({ name }) => name);
}

/**
 * Cascade-view payload: every per-project override across every
 * project, split per family. Mirrors `getAllSkillOverrides()` so the
 * Settings UI can show a "+ Add override for…" picker for projects
 * that don't currently override a given tool. Empty entries are
 * excluded — only projects with at least one explicit enable or
 * disable show up.
 */
export interface ToolOverridesCascade {
  projects: Record<
    string,
    {
      builtin: { enable: string[]; disable: string[] };
      mcp: { enable: string[]; disable: string[] };
      extension: { enable: string[]; disable: string[] };
    }
  >;
}

export async function getAllToolOverrides(): Promise<ToolOverridesCascade> {
  const cur = await readToolOverrides();
  return { projects: cur.projects };
}

/**
 * Drop every override mention of a deleted project so the file
 * doesn't accumulate orphaned entries. Called from project-manager
 * on project delete (parallels `skill-overrides.clearProjectOverrides`).
 */
export async function clearProjectOverrides(projectId: string): Promise<void> {
  const cur = await readToolOverrides();
  if (cur.projects[projectId] === undefined) return;
  delete cur.projects[projectId];
  await atomicWrite(cur);
}

/** Suppress unused-export warning for tests that import EMPTY. */
export const _EMPTY_FOR_TESTS = EMPTY;

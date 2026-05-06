import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * pi-forge-private per-project skill overrides at
 * `${FORGE_DATA_DIR}/skills-overrides.json`. Each project keeps a
 * tri-state position on every skill: enabled / disabled / inherit
 * (the absent case). The effective skills list a session sees is
 * `(global ∪ project.enabled) − project.disabled`.
 *
 * Lives outside `${PI_CONFIG_DIR}` because pi's `settings.skills` is a
 * single global list — we can't safely share that file with the pi
 * TUI when per-project semantics differ. Lives outside the project
 * tree (NOT in `<project>/.pi/`) because the user picked the
 * pi-forge-private location: per-installation preference, not
 * checked-in team policy.
 *
 * Single file (vs a dir of per-project files): simpler atomic write,
 * one read at session create, easier full-listing fetch for the UI's
 * cascade view that shows ALL projects' overrides for a given skill.
 */

export type SkillOverrideState = "enabled" | "disabled";

interface ProjectOverrides {
  /** Skill names this project actively wants ON, regardless of global. */
  enable: string[];
  /** Skill names this project actively wants OFF, regardless of global. */
  disable: string[];
}

export interface SkillOverrides {
  /** Map from projectId → that project's per-skill overrides. */
  projects: Record<string, ProjectOverrides>;
}

const EMPTY: SkillOverrides = { projects: {} };

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.skillOverridesFile), { recursive: true });
}

async function atomicWrite(data: SkillOverrides): Promise<void> {
  await ensureDir();
  const path = config.skillOverridesFile;
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

export async function readSkillOverrides(): Promise<SkillOverrides> {
  try {
    const raw = await readFile(config.skillOverridesFile, "utf8");
    if (raw.trim().length === 0) return { projects: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("projects" in parsed)) {
      return { projects: {} };
    }
    const projects = (parsed as { projects?: unknown }).projects;
    if (typeof projects !== "object" || projects === null) return { projects: {} };
    // Normalize each project entry — stale/malformed entries silently
    // become empty rather than throwing.
    const out: SkillOverrides = { projects: {} };
    for (const [pid, val] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null) continue;
      const enable = Array.isArray((val as ProjectOverrides).enable)
        ? (val as ProjectOverrides).enable.filter((s) => typeof s === "string")
        : [];
      const disable = Array.isArray((val as ProjectOverrides).disable)
        ? (val as ProjectOverrides).disable.filter((s) => typeof s === "string")
        : [];
      out.projects[pid] = { enable, disable };
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    throw err;
  }
}

/**
 * Tri-state set: pass `state = undefined` to clear (inherit). Empty
 * project entries are pruned so the file doesn't grow with stale
 * keys after a series of toggles back to inherit.
 */
export async function setProjectSkillOverride(
  projectId: string,
  skillName: string,
  state: SkillOverrideState | undefined,
): Promise<void> {
  const cur = await readSkillOverrides();
  const entry = cur.projects[projectId] ?? { enable: [], disable: [] };
  // Always remove from both lists first — flipping enabled→disabled
  // or vice versa is just remove + maybe add.
  entry.enable = entry.enable.filter((n) => n !== skillName);
  entry.disable = entry.disable.filter((n) => n !== skillName);
  if (state === "enabled") entry.enable.push(skillName);
  else if (state === "disabled") entry.disable.push(skillName);
  if (entry.enable.length === 0 && entry.disable.length === 0) {
    delete cur.projects[projectId];
  } else {
    cur.projects[projectId] = entry;
  }
  await atomicWrite(cur);
}

/**
 * Lookup helper used by the UI. Returns `undefined` when the project
 * has no opinion on this skill (= inherit from global).
 */
export function getProjectSkillState(
  overrides: SkillOverrides,
  projectId: string,
  skillName: string,
): SkillOverrideState | undefined {
  const entry = overrides.projects[projectId];
  if (entry === undefined) return undefined;
  if (entry.enable.includes(skillName)) return "enabled";
  if (entry.disable.includes(skillName)) return "disabled";
  return undefined;
}

/**
 * Return the set of skill names this project has explicitly disabled.
 * Used by the resource-loader's `skillsOverride` hook to filter out
 * skills that pi's pattern system can't reach — specifically
 * package-contributed skills, which `DefaultPackageManager` registers
 * as `enabled: true` regardless of `settings.skills` patterns. The
 * pattern-based override path in `effectiveSkillsForProject` still
 * handles top-level (auto-discovered) skills; this helper backstops
 * everything pi loads.
 */
export async function getProjectDisabledSkillNames(projectId: string): Promise<Set<string>> {
  const cur = await readSkillOverrides();
  const entry = cur.projects[projectId];
  if (entry === undefined) return new Set();
  return new Set(entry.disable);
}

/**
 * Drop every override mention of a deleted project so the file
 * doesn't accumulate orphaned entries. Called from project-manager
 * on project delete.
 */
export async function clearProjectOverrides(projectId: string): Promise<void> {
  const cur = await readSkillOverrides();
  if (cur.projects[projectId] === undefined) return;
  delete cur.projects[projectId];
  await atomicWrite(cur);
}

/**
 * Compute the effective skills list a session in `projectId` should
 * see, given the global enabled list (from pi's settings.skills).
 * Project enables ADD to the global list; project disables SUBTRACT.
 * The result is the runtime-override input for SettingsManager
 * (see session-registry.applySkillOverrides).
 */
export function effectiveSkillsForProject(
  globalEnabled: readonly string[],
  overrides: SkillOverrides,
  projectId: string,
): string[] {
  const entry = overrides.projects[projectId];
  if (entry === undefined) return [...globalEnabled];
  const enabled = new Set(globalEnabled);
  for (const name of entry.enable) enabled.add(name);
  for (const name of entry.disable) enabled.delete(name);
  return Array.from(enabled);
}

/** Suppress an unused-export warning if EMPTY isn't referenced
 *  by the importing module — the constant is exported for tests. */
export const _EMPTY_FOR_TESTS = EMPTY;

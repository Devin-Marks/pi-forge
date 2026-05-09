import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * pi-forge-private per-project prompt overrides at
 * `${FORGE_DATA_DIR}/prompts-overrides.json`. Mirrors the
 * skill-overrides shape and rationale: each project keeps a tri-state
 * position on every prompt (enabled / disabled / inherit), the
 * effective list a session sees is `(global ∪ project.enabled) −
 * project.disabled`, file lives outside `${PI_CONFIG_DIR}` because pi's
 * `settings.prompts` is a single global pattern list, single file (vs
 * per-project) so the cascade view across all projects is one read.
 *
 * The pi SDK's prompt patterns share the same prefix grammar as skills:
 * `!name` excludes, `+name` force-includes. See `effectivePromptsForProject`
 * for the merge semantics.
 */

export type PromptOverrideState = "enabled" | "disabled";

interface ProjectOverrides {
  /** Prompt names this project actively wants ON, regardless of global. */
  enable: string[];
  /** Prompt names this project actively wants OFF, regardless of global. */
  disable: string[];
}

export interface PromptOverrides {
  /** Map from projectId → that project's per-prompt overrides. */
  projects: Record<string, ProjectOverrides>;
}

const EMPTY: PromptOverrides = { projects: {} };

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.promptOverridesFile), { recursive: true });
}

async function atomicWrite(data: PromptOverrides): Promise<void> {
  await ensureDir();
  const path = config.promptOverridesFile;
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

export async function readPromptOverrides(): Promise<PromptOverrides> {
  try {
    const raw = await readFile(config.promptOverridesFile, "utf8");
    if (raw.trim().length === 0) return { projects: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("projects" in parsed)) {
      return { projects: {} };
    }
    const projects = (parsed as { projects?: unknown }).projects;
    if (typeof projects !== "object" || projects === null) return { projects: {} };
    // Normalize each project entry — stale/malformed entries silently
    // become empty rather than throwing.
    const out: PromptOverrides = { projects: {} };
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
export async function setProjectPromptOverride(
  projectId: string,
  promptName: string,
  state: PromptOverrideState | undefined,
): Promise<void> {
  const cur = await readPromptOverrides();
  const entry = cur.projects[projectId] ?? { enable: [], disable: [] };
  // Always remove from both lists first — flipping enabled→disabled
  // or vice versa is just remove + maybe add.
  entry.enable = entry.enable.filter((n) => n !== promptName);
  entry.disable = entry.disable.filter((n) => n !== promptName);
  if (state === "enabled") entry.enable.push(promptName);
  else if (state === "disabled") entry.disable.push(promptName);
  if (entry.enable.length === 0 && entry.disable.length === 0) {
    delete cur.projects[projectId];
  } else {
    cur.projects[projectId] = entry;
  }
  await atomicWrite(cur);
}

/**
 * Lookup helper used by the UI. Returns `undefined` when the project
 * has no opinion on this prompt (= inherit from global).
 */
export function getProjectPromptState(
  overrides: PromptOverrides,
  projectId: string,
  promptName: string,
): PromptOverrideState | undefined {
  const entry = overrides.projects[projectId];
  if (entry === undefined) return undefined;
  if (entry.enable.includes(promptName)) return "enabled";
  if (entry.disable.includes(promptName)) return "disabled";
  return undefined;
}

/**
 * Return the set of prompt names this project has explicitly
 * disabled. Used by the resource-loader's `promptsOverride` hook to
 * filter out prompts that pi's pattern system can't reach (parallel
 * to `getProjectDisabledSkillNames`). Today the SDK has no
 * package-contributed prompts, but the hook is plumbed for symmetry
 * with skills + future-proofing.
 */
export async function getProjectDisabledPromptNames(projectId: string): Promise<Set<string>> {
  const cur = await readPromptOverrides();
  const entry = cur.projects[projectId];
  if (entry === undefined) return new Set();
  return new Set(entry.disable);
}

/**
 * Drop every override mention of a deleted project so the file
 * doesn't accumulate orphaned entries. Called from project-manager
 * on project delete (parallel to the skill-overrides version).
 */
export async function clearProjectPromptOverrides(projectId: string): Promise<void> {
  const cur = await readPromptOverrides();
  if (cur.projects[projectId] === undefined) return;
  delete cur.projects[projectId];
  await atomicWrite(cur);
}

/** Suppress an unused-export warning if EMPTY isn't referenced
 *  by the importing module — the constant is exported for tests. */
export const _EMPTY_FOR_TESTS = EMPTY;

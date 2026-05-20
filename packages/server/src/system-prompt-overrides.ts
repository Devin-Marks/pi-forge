import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * pi-forge-private per-project system-prompt addendum at
 * `${FORGE_DATA_DIR}/system-prompt-overrides.json`. Each project can
 * store a free-form text block that is appended (via pi's
 * `appendSystemPrompt` extension hook) to the agent's base system
 * prompt for every session created in that project. Pi's base prompt
 * defines the tool-calling protocol — REPLACING it would break tool
 * use, so this surface is APPEND-only, the same hook
 * `FORGE_SECRET_HYGIENE_RULE` rides through.
 *
 * Lives in the data dir for the same reasons skill-overrides does:
 * install-private, not team-shared; pi's SDK has no per-project
 * concept here so we can't safely co-tenant with `settings.json`.
 *
 * Single file (vs a dir of per-project files): matches the
 * skill/tool/prompt-overrides shape — one atomic write, one read
 * at session create.
 */

interface SystemPromptOverrides {
  /** Map from projectId → that project's addendum text. */
  projects: Record<string, string>;
}

/** Hard cap on the stored addendum. Keeps a runaway paste from
 * silently bloating every system prompt by tens of KB and matches
 * what users will realistically write (a paragraph or two). The
 * route layer enforces the same cap so the wire surface fails
 * fast with 400 rather than persisting unbounded text. */
export const MAX_ADDENDUM_BYTES = 20_000;

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.systemPromptOverridesFile), { recursive: true });
}

async function atomicWrite(data: SystemPromptOverrides): Promise<void> {
  await ensureDir();
  const path = config.systemPromptOverridesFile;
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

async function readAll(): Promise<SystemPromptOverrides> {
  try {
    const raw = await readFile(config.systemPromptOverridesFile, "utf8");
    if (raw.trim().length === 0) return { projects: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("projects" in parsed)) {
      return { projects: {} };
    }
    const projects = (parsed as { projects?: unknown }).projects;
    if (typeof projects !== "object" || projects === null) return { projects: {} };
    const out: SystemPromptOverrides = { projects: {} };
    for (const [pid, val] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof val !== "string") continue;
      out.projects[pid] = val;
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    throw err;
  }
}

/**
 * Return the project's saved addendum, or an empty string if the
 * project has no override. Empty string and "no entry at all" are
 * intentionally collapsed — the wire surface treats both as "no
 * addendum to append" and there is no third tri-state to preserve.
 */
export async function getProjectSystemPromptAddendum(projectId: string): Promise<string> {
  const cur = await readAll();
  return cur.projects[projectId] ?? "";
}

/**
 * Set the project's addendum. Passing an empty string (or a string
 * that trims to empty) clears the entry so the file doesn't grow
 * with effectively-empty keys after a user clears the textbox.
 *
 * Caller is responsible for length validation — the route layer does
 * this against `MAX_ADDENDUM_BYTES` before writing.
 */
export async function setProjectSystemPromptAddendum(
  projectId: string,
  text: string,
): Promise<void> {
  const cur = await readAll();
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    if (cur.projects[projectId] === undefined) return;
    delete cur.projects[projectId];
  } else {
    cur.projects[projectId] = text;
  }
  await atomicWrite(cur);
}

/**
 * Drop the project's addendum entry — called from the project
 * delete path so the overrides file doesn't accumulate orphaned
 * entries after a project is removed.
 */
export async function clearProjectSystemPromptAddendum(projectId: string): Promise<void> {
  const cur = await readAll();
  if (cur.projects[projectId] === undefined) return;
  delete cur.projects[projectId];
  await atomicWrite(cur);
}

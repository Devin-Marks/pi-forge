import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { config } from "./config.js";

/**
 * Forge-private "quick action" registry — the clickable chips that
 * live on the chat-view toolbar. Two kinds, presence-discriminated
 * the same way `McpServerConfig` is (no `kind` field on the wire):
 *
 *   - command: `command` is a non-empty string. Runs in the project's
 *     cwd via `bash -c`, stdout/stderr captured.
 *   - prompt:  `text` is a non-empty string. Either auto-sends to the
 *     active session (`mode: "send"`) or prefills the composer
 *     (`mode: "insert"`).
 *
 * Stored as a flat array (not a map) so the file's order = display
 * order. The route layer is the only validator — this module trusts
 * the shapes it persists.
 */

export interface QuickAction {
  id: string;
  name: string;
  enabled?: boolean;
  // command-only
  command?: string;
  timeoutMs?: number;
  // prompt-only
  text?: string;
  mode?: "send" | "insert";
}

export class QuickActionNotFoundError extends Error {
  constructor(id: string) {
    super(`quick action not found: ${id}`);
    this.name = "QuickActionNotFoundError";
  }
}

/** Hard cap on a single command string. Mirrors the system-prompt
 * addendum cap — large enough for a multi-line shell snippet, small
 * enough to keep the wire surface bounded. */
export const MAX_COMMAND_BYTES = 20_000;

/** Hard cap on a single prompt template. Pi compaction lives further
 * down the stack, but bounding here keeps an accidental megabyte paste
 * from silently landing in the composer. */
export const MAX_PROMPT_BYTES = 50_000;

/** Default command timeout (30 s) and absolute ceiling (5 min). A
 * five-minute build is the upper end of "still feels like a chip";
 * past that, the user should be using the terminal. */
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MAX_TIMEOUT_MS = 300_000;

export function isCommandAction(a: QuickAction): boolean {
  return typeof a.command === "string" && a.command.length > 0;
}

export function isPromptAction(a: QuickAction): boolean {
  return typeof a.text === "string" && a.text.length > 0;
}

async function ensureDir(): Promise<void> {
  await mkdir(dirname(config.quickActionsFile), { recursive: true });
}

async function atomicWrite(actions: QuickAction[]): Promise<void> {
  await ensureDir();
  const target = config.quickActionsFile;
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(actions, null, 2), { mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

function isAction(v: unknown): v is QuickAction {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.name !== "string") return false;
  const hasCmd = typeof r.command === "string" && r.command.length > 0;
  const hasText = typeof r.text === "string" && r.text.length > 0;
  // Drop entries that look corrupted (neither kind, or both) rather
  // than surfacing them to the route layer, which would have to
  // re-validate. Strict-on-read keeps the in-memory shape clean.
  return hasCmd !== hasText;
}

/**
 * Serialise all read-modify-write sequences over quick-actions.json
 * — same pattern as projects.json. Without it, concurrent
 * POST /quick-actions calls can race the rename().
 */
let lock: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = lock.then(fn, fn);
  lock = next.catch(() => undefined);
  return next;
}

export async function readQuickActions(): Promise<QuickAction[]> {
  try {
    const raw = await readFile(config.quickActionsFile, "utf8");
    if (raw.trim().length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAction);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function getQuickAction(id: string): Promise<QuickAction | undefined> {
  const list = await readQuickActions();
  return list.find((a) => a.id === id);
}

/**
 * Create a new action. The caller (route layer) is responsible for
 * shape validation (one-of command/text, byte caps, etc.) — this
 * function only assigns the id and persists.
 */
export async function createQuickAction(input: Omit<QuickAction, "id">): Promise<QuickAction> {
  return withLock(async () => {
    const list = await readQuickActions();
    const action: QuickAction = { ...input, id: randomUUID() };
    list.push(action);
    await atomicWrite(list);
    return action;
  });
}

export async function updateQuickAction(
  id: string,
  patch: Partial<Omit<QuickAction, "id">>,
): Promise<QuickAction> {
  return withLock(async () => {
    const list = await readQuickActions();
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) throw new QuickActionNotFoundError(id);
    const existing = list[idx];
    if (existing === undefined) throw new QuickActionNotFoundError(id);
    // Build the merged record explicitly so a switch from command to
    // prompt (or vice-versa) drops the now-unused fields rather than
    // carrying them as dead weight. The caller passes the FULL desired
    // shape on every update; the patch arg is union-typed for ergonomic
    // partial calls but the route layer always sends the complete form.
    const merged: QuickAction = { ...existing, ...patch, id };
    if (typeof patch.command === "string" && patch.command.length > 0) {
      delete merged.text;
      delete merged.mode;
    } else if (typeof patch.text === "string" && patch.text.length > 0) {
      delete merged.command;
      delete merged.timeoutMs;
    }
    list[idx] = merged;
    await atomicWrite(list);
    return merged;
  });
}

export async function deleteQuickAction(id: string): Promise<void> {
  await withLock(async () => {
    const list = await readQuickActions();
    const next = list.filter((a) => a.id !== id);
    if (next.length === list.length) throw new QuickActionNotFoundError(id);
    await atomicWrite(next);
  });
}

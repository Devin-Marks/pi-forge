/**
 * Disk-backed persistence for orchestration metadata.
 *
 * Two files in `${FORGE_DATA_DIR}/`:
 *   - `session-orchestration.json` — supervisor opt-in + supervisor↔worker links
 *   - `orchestrator-inbox.json`    — per-supervisor pending event queue
 *
 * Separate files so the chatty inbox writes don't fight the rare
 * topology mutations. Same atomic-write + in-process lock pattern as
 * `webhooks/store.ts` and `project-manager.ts`. Single-tenant /
 * single-process assumption — cross-process safety would need a real
 * file lock.
 *
 * Mode 0600 on both: the link file has no secrets but the inbox can
 * carry assistant-message previews (which can contain anything the
 * agent has been working on); both should be unreadable to other
 * users on shared boxes.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import {
  emptyInboxStore,
  emptyStore,
  type InboxItem,
  type InboxStore,
  isInboxEventType,
  MAX_INBOX_ITEMS,
  ORCHESTRATION_VERSION,
  type OrchestrationStore,
  type SupervisorRecord,
  type WorkerLifecycleState,
  type WorkerRecord,
} from "./types.js";

const STORE_FILE = (): string => join(config.forgeDataDir, "session-orchestration.json");
const INBOX_FILE = (): string => join(config.forgeDataDir, "orchestrator-inbox.json");

async function ensureDir(): Promise<void> {
  await mkdir(config.forgeDataDir, { recursive: true });
}

async function atomicWriteJson(target: string, data: unknown, mode: number): Promise<void> {
  await ensureDir();
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// ---- session-orchestration.json (topology) ----

let storeLock: Promise<unknown> = Promise.resolve();
function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = storeLock.then(fn, fn);
  storeLock = next.catch(() => undefined);
  return next;
}

function isSupervisorRecord(v: unknown): v is SupervisorRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.enabledAt === "string" &&
    Array.isArray(r.workerIds) &&
    r.workerIds.every((id) => typeof id === "string")
  );
}

const WORKER_LIFECYCLE_STATES = new Set<WorkerLifecycleState>([
  "idle",
  "running",
  "ended",
  "errored",
  "stopped",
  "deleted",
  "awaiting_question",
]);

function isWorkerLifecycleState(v: unknown): v is WorkerLifecycleState {
  return typeof v === "string" && WORKER_LIFECYCLE_STATES.has(v as WorkerLifecycleState);
}

function isWorkerRecord(v: unknown): v is WorkerRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (typeof r.supervisorId !== "string" || typeof r.spawnedAt !== "string") return false;
  if (r.spawnedFrom !== undefined) {
    const sf = r.spawnedFrom as Record<string, unknown>;
    if (typeof sf.sessionId !== "string") return false;
    if (sf.mode !== "fresh" && sf.mode !== "summary") return false;
  }
  if (r.state !== undefined && !isWorkerLifecycleState(r.state)) return false;
  if (r.turnOpen !== undefined && typeof r.turnOpen !== "boolean") return false;
  for (const key of ["lastStateAt", "lastAgentStartAt", "lastAgentEndAt"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "string") return false;
  }
  for (const key of ["stopReason", "errorMessage"] as const) {
    if (r[key] !== undefined && r[key] !== null && typeof r[key] !== "string") return false;
  }
  return true;
}

async function readStoreFile(): Promise<OrchestrationStore> {
  await ensureDir();
  try {
    const raw = await readFile(STORE_FILE(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptyStore();
    const r = parsed as Record<string, unknown>;
    const supervisors: Record<string, SupervisorRecord> = {};
    const workers: Record<string, WorkerRecord> = {};
    if (typeof r.supervisors === "object" && r.supervisors !== null) {
      for (const [id, rec] of Object.entries(r.supervisors as Record<string, unknown>)) {
        if (isSupervisorRecord(rec)) supervisors[id] = rec;
      }
    }
    if (typeof r.workers === "object" && r.workers !== null) {
      for (const [id, rec] of Object.entries(r.workers as Record<string, unknown>)) {
        if (isWorkerRecord(rec)) workers[id] = rec;
      }
    }
    return { version: ORCHESTRATION_VERSION, supervisors, workers };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw err;
  }
}

async function writeStoreFile(s: OrchestrationStore): Promise<void> {
  await atomicWriteJson(STORE_FILE(), s, 0o600);
}

export async function readStore(): Promise<OrchestrationStore> {
  return readStoreFile();
}

/**
 * Mark a session as a supervisor. Idempotent — calling on an
 * already-enabled session updates nothing. Rejects if the session
 * is currently registered as a worker (depth=1 limit).
 */
export class OrchestrationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "OrchestrationError";
  }
}

export async function enableSupervisor(sessionId: string): Promise<SupervisorRecord> {
  return withStoreLock(async () => {
    const s = await readStoreFile();
    if (s.workers[sessionId] !== undefined) {
      throw new OrchestrationError(
        "depth_limit_exceeded",
        `Session ${sessionId} is a worker and cannot become a supervisor (depth=1).`,
      );
    }
    const existing = s.supervisors[sessionId];
    if (existing !== undefined) return existing;
    const rec: SupervisorRecord = {
      enabledAt: new Date().toISOString(),
      workerIds: [],
    };
    s.supervisors[sessionId] = rec;
    await writeStoreFile(s);
    return rec;
  });
}

/**
 * Remove a session's supervisor mode. Detaches every worker so they
 * become standalone (their session records are left alone on disk).
 * No-op if the session wasn't a supervisor.
 */
export async function disableSupervisor(sessionId: string): Promise<void> {
  await withStoreLock(async () => {
    const s = await readStoreFile();
    const rec = s.supervisors[sessionId];
    if (rec === undefined) return;
    for (const workerId of rec.workerIds) {
      delete s.workers[workerId];
    }
    delete s.supervisors[sessionId];
    await writeStoreFile(s);
  });
}

/**
 * Register a new worker session under a supervisor. Caller is
 * responsible for actually creating the session (via createSession
 * in session-registry); this just records the link. Rejects if the
 * supervisor doesn't exist or the worker is already linked
 * elsewhere. Concurrency-safe (single store lock).
 */
export async function registerWorker(opts: {
  supervisorId: string;
  workerId: string;
  spawnedFrom?: { sessionId: string; mode: "fresh" | "summary" };
}): Promise<void> {
  await withStoreLock(async () => {
    const s = await readStoreFile();
    const sup = s.supervisors[opts.supervisorId];
    if (sup === undefined) {
      throw new OrchestrationError(
        "supervisor_not_found",
        `No supervisor record for ${opts.supervisorId}.`,
      );
    }
    if (s.workers[opts.workerId] !== undefined) {
      throw new OrchestrationError(
        "worker_already_linked",
        `Worker ${opts.workerId} is already linked to a supervisor.`,
      );
    }
    if (s.supervisors[opts.workerId] !== undefined) {
      throw new OrchestrationError(
        "depth_limit_exceeded",
        `Session ${opts.workerId} is already a supervisor; cannot also be a worker.`,
      );
    }
    sup.workerIds.push(opts.workerId);
    const now = new Date().toISOString();
    const wrec: WorkerRecord = {
      supervisorId: opts.supervisorId,
      spawnedAt: now,
      state: "idle",
      turnOpen: false,
      lastStateAt: now,
    };
    if (opts.spawnedFrom !== undefined) wrec.spawnedFrom = opts.spawnedFrom;
    s.workers[opts.workerId] = wrec;
    await writeStoreFile(s);
  });
}

/**
 * Drop a worker's link to its supervisor. Idempotent — no-op if the
 * worker wasn't registered. Used by `orchestrate_detach_worker`
 * and as the cleanup step when a worker is killed.
 */
export async function unregisterWorker(workerId: string): Promise<void> {
  await withStoreLock(async () => {
    const s = await readStoreFile();
    const wrec = s.workers[workerId];
    if (wrec === undefined) return;
    const sup = s.supervisors[wrec.supervisorId];
    if (sup !== undefined) {
      sup.workerIds = sup.workerIds.filter((id) => id !== workerId);
    }
    delete s.workers[workerId];
    await writeStoreFile(s);
  });
}

/**
 * Resolve the supervisor ID for a worker session, or undefined if
 * the session isn't a registered worker. Read-only — no lock
 * needed because we tolerate stale reads (the event bridge reads
 * this on every event and just skips when the link has been torn
 * down mid-flight).
 */
export async function getSupervisorIdForWorker(workerId: string): Promise<string | undefined> {
  const s = await readStoreFile();
  return s.workers[workerId]?.supervisorId;
}

export async function isSupervisor(sessionId: string): Promise<boolean> {
  const s = await readStoreFile();
  return s.supervisors[sessionId] !== undefined;
}

export async function isWorker(sessionId: string): Promise<boolean> {
  const s = await readStoreFile();
  return s.workers[sessionId] !== undefined;
}

export async function getWorkerIds(supervisorId: string): Promise<string[]> {
  const s = await readStoreFile();
  return [...(s.supervisors[supervisorId]?.workerIds ?? [])];
}

export async function getWorkerRecord(workerId: string): Promise<WorkerRecord | undefined> {
  const s = await readStoreFile();
  return s.workers[workerId];
}

export async function updateWorkerLifecycle(
  workerId: string,
  patch: Partial<
    Pick<
      WorkerRecord,
      | "state"
      | "turnOpen"
      | "lastStateAt"
      | "lastAgentStartAt"
      | "lastAgentEndAt"
      | "stopReason"
      | "errorMessage"
    >
  >,
): Promise<WorkerRecord | undefined> {
  return withStoreLock(async () => {
    const s = await readStoreFile();
    const rec = s.workers[workerId];
    if (rec === undefined) return undefined;
    Object.assign(rec, patch);
    await writeStoreFile(s);
    return { ...rec };
  });
}

// ---- orchestrator-inbox.json (queue) ----

let inboxLock: Promise<unknown> = Promise.resolve();
function withInboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = inboxLock.then(fn, fn);
  inboxLock = next.catch(() => undefined);
  return next;
}

function isInboxItem(v: unknown): v is InboxItem {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    isInboxEventType(r.type) &&
    typeof r.workerId === "string" &&
    typeof r.occurredAt === "string" &&
    typeof r.data === "object" &&
    r.data !== null &&
    typeof r.delivered === "boolean"
  );
}

async function readInboxFile(): Promise<InboxStore> {
  await ensureDir();
  try {
    const raw = await readFile(INBOX_FILE(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return emptyInboxStore();
    const r = parsed as Record<string, unknown>;
    const inboxes: Record<string, InboxItem[]> = {};
    if (typeof r.inboxes === "object" && r.inboxes !== null) {
      for (const [supId, items] of Object.entries(r.inboxes as Record<string, unknown>)) {
        if (Array.isArray(items)) {
          inboxes[supId] = items.filter(isInboxItem);
        }
      }
    }
    return { version: ORCHESTRATION_VERSION, inboxes };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyInboxStore();
    throw err;
  }
}

async function writeInboxFile(s: InboxStore): Promise<void> {
  await atomicWriteJson(INBOX_FILE(), s, 0o600);
}

/**
 * Append an inbox item for the supervisor. FIFO-evicts items beyond
 * `MAX_INBOX_ITEMS`. Caller is responsible for resolving the
 * supervisor ID (via `getSupervisorIdForWorker`) — this is a raw
 * write that doesn't check the topology.
 */
export async function enqueueInboxItem(
  supervisorId: string,
  item: Omit<InboxItem, "id" | "delivered"> & { delivered?: boolean },
): Promise<InboxItem> {
  return withInboxLock(async () => {
    const s = await readInboxFile();
    const existing = s.inboxes[supervisorId] ?? [];
    const { delivered = false, ...rest } = item;
    const full: InboxItem = { id: randomUUID(), delivered, ...rest };
    existing.push(full);
    // FIFO trim from the front so the most recent N stay.
    const trimmed =
      existing.length > MAX_INBOX_ITEMS
        ? existing.slice(existing.length - MAX_INBOX_ITEMS)
        : existing;
    s.inboxes[supervisorId] = trimmed;
    await writeInboxFile(s);
    return full;
  });
}

/**
 * Read pending (undelivered) items for the supervisor. Optionally
 * mark them delivered as part of the same lock window so the
 * agent-facing tool can advance the cursor atomically.
 *
 * Returns the items in chronological order (oldest first) — the
 * supervisor LLM should process them in arrival order so a "ended"
 * event after an "ask_user" doesn't get acted on first.
 */
export async function readPendingInbox(
  supervisorId: string,
  opts: { markDelivered?: boolean } = {},
): Promise<InboxItem[]> {
  return withInboxLock(async () => {
    const s = await readInboxFile();
    const items = s.inboxes[supervisorId] ?? [];
    const pending = items.filter((it) => !it.delivered);
    if (opts.markDelivered === true && pending.length > 0) {
      for (const it of pending) it.delivered = true;
      s.inboxes[supervisorId] = items;
      await writeInboxFile(s);
    }
    return pending.map((it) => ({ ...it }));
  });
}

/**
 * Return ALL inbox items for the supervisor (delivered + pending),
 * newest first. Powers the REST UI; capped by the per-supervisor
 * FIFO already, so safe to send wholesale.
 */
export async function readAllInbox(supervisorId: string): Promise<InboxItem[]> {
  const s = await readInboxFile();
  const items = s.inboxes[supervisorId] ?? [];
  return items.slice().reverse();
}

export async function pendingInboxCount(supervisorId: string): Promise<number> {
  const s = await readInboxFile();
  const items = s.inboxes[supervisorId] ?? [];
  return items.filter((it) => !it.delivered).length;
}

/**
 * Drop a supervisor's worker-event history entirely. Called when
 * supervisor mode is disabled or the supervisor session is deleted.
 */
export async function clearInbox(supervisorId: string): Promise<void> {
  await withInboxLock(async () => {
    const s = await readInboxFile();
    if (s.inboxes[supervisorId] === undefined) return;
    delete s.inboxes[supervisorId];
    await writeInboxFile(s);
  });
}

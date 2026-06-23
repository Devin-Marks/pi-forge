import {
  deleteColdSession,
  disposeSession,
  findProjectIdForSession,
  getSession,
} from "../session-registry.js";
import { bridgeWorkerDeleted } from "./event-bridge.js";
import { disableSupervisor, getWorkerIds, unregisterWorker } from "./store.js";

export type WorkerArchiveStatus = "archived" | "not_found";

export interface KillWorkerResult {
  wasLive: boolean;
  archiveStatus: WorkerArchiveStatus;
}

export interface CleanupSupervisorWorkersResult {
  workerIds: string[];
  results: Record<string, KillWorkerResult>;
}

function notifySupervisorSessionListChanged(args: {
  supervisorId: string;
  workerId: string;
  projectId?: string;
  reason: string;
}): void {
  const supervisor = getSession(args.supervisorId);
  if (supervisor === undefined) return;
  const projectId = args.projectId ?? supervisor.projectId;
  for (const client of supervisor.clients) {
    try {
      client.send({
        type: "session_list_changed",
        reason: args.reason,
        projectId,
        sessionId: args.workerId,
      });
    } catch {
      // SSE client already dropped; the registry will prune it on the next event.
    }
  }
}

/**
 * Kill a worker and move its transcript out of the live session tree.
 *
 * Orchestration workers are top-level pi sessions on disk. Merely disposing and
 * unregistering one turns it into a standalone cold session, which leaves it in
 * the sidebar. The intended kill semantics are "not live and not listed", while
 * still preserving the JSONL via deleteColdSession's 7-day archive.
 */
export async function killWorkerAndArchive(args: {
  supervisorId: string;
  workerId: string;
  notifySupervisor?: boolean;
}): Promise<KillWorkerResult> {
  const projectId =
    (await findProjectIdForSession(args.workerId)) ??
    (await findProjectIdForSession(args.supervisorId));
  const wasLive = await disposeSession(args.workerId);

  let archive = await deleteColdSession(args.workerId);
  if (archive === "live") {
    await disposeSession(args.workerId);
    archive = await deleteColdSession(args.workerId);
  }

  // Fire before unregistering so the bridge can still resolve the supervisor.
  await bridgeWorkerDeleted(args.workerId, {
    wasLive,
    reason: "killed",
    ...(args.notifySupervisor !== undefined ? { notifySupervisor: args.notifySupervisor } : {}),
  }).catch(() => undefined);
  await unregisterWorker(args.workerId);
  notifySupervisorSessionListChanged({
    supervisorId: args.supervisorId,
    workerId: args.workerId,
    ...(projectId !== undefined ? { projectId } : {}),
    reason: "kill_worker",
  });

  return {
    wasLive,
    archiveStatus: archive === "deleted" ? "archived" : "not_found",
  };
}

/**
 * Delete every registered worker under a supervisor, then remove the
 * supervisor topology record. Used when the supervisor session itself is
 * deleted through the normal session DELETE route.
 */
export async function cleanupWorkersForDeletedSupervisor(
  supervisorId: string,
): Promise<CleanupSupervisorWorkersResult> {
  const workerIds = await getWorkerIds(supervisorId);
  const results: Record<string, KillWorkerResult> = {};
  for (const workerId of workerIds) {
    results[workerId] = await killWorkerAndArchive({
      supervisorId,
      workerId,
      notifySupervisor: false,
    });
  }
  await disableSupervisor(supervisorId);
  return { workerIds, results };
}

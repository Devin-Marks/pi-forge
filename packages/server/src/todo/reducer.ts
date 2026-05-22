import { isTransitionValid } from "./invariants.js";
import { detectCycle } from "./task-graph.js";
import type { Task, TaskAction, TaskMutationParams, TaskState, TaskStatus } from "./types.js";

/**
 * Reducer outcome. Closed tagged union — adding a new action
 * requires extending this union AND the envelope's `formatContent`
 * switch (compiler-enforced exhaustive).
 *
 * `error` carries the message in-band so callers can pattern-match
 * on `op.kind === "error"` without a side-channel boolean.
 */
export type Op =
  | { kind: "create"; taskId: number }
  | { kind: "update"; id: number; fromStatus: TaskStatus; toStatus: TaskStatus }
  | { kind: "delete"; id: number; subject: string }
  | { kind: "list"; statusFilter?: TaskStatus; includeDeleted: boolean }
  | { kind: "get"; task: Task }
  | { kind: "clear"; count: number }
  | { kind: "error"; message: string };

export interface ApplyResult {
  state: TaskState;
  op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
  return { state, op: { kind: "error", message } };
}

/**
 * Pure reducer: `(state, action, params) → (state, op)`. Validation
 * is in-line: structural guards (`subject required`, `id required`,
 * `at least one mutable field`) plus state-aware checks (transition
 * legality, dangling/deleted blockedBy, self-block, cycles).
 *
 * Error messages are intentionally kept in the plugin's voice so
 * existing agent prompts that grep on the error text continue to
 * match. The wire shape (`details.error` string) is the structured
 * channel; the text is the human/LLM-readable channel.
 */
export function applyTaskMutation(
  state: TaskState,
  action: TaskAction,
  params: TaskMutationParams,
): ApplyResult {
  switch (action) {
    case "create":
      return reduceCreate(state, params);
    case "update":
      return reduceUpdate(state, params);
    case "list":
      return {
        state,
        op: {
          kind: "list",
          includeDeleted: params.includeDeleted === true,
          ...(params.status !== undefined ? { statusFilter: params.status } : {}),
        },
      };
    case "get":
      return reduceGet(state, params);
    case "delete":
      return reduceDelete(state, params);
    case "clear":
      return {
        state: { tasks: [], nextId: 1 },
        op: { kind: "clear", count: state.tasks.length },
      };
  }
}

function reduceCreate(state: TaskState, params: TaskMutationParams): ApplyResult {
  if (params.subject === undefined || params.subject.trim().length === 0) {
    return errorResult(state, "subject required for create");
  }
  if (params.blockedBy !== undefined && params.blockedBy.length > 0) {
    for (const dep of params.blockedBy) {
      const depTask = state.tasks.find((t) => t.id === dep);
      if (depTask === undefined) return errorResult(state, `blockedBy: #${dep} not found`);
      if (depTask.status === "deleted") return errorResult(state, `blockedBy: #${dep} is deleted`);
    }
  }
  const newTask: Task = {
    id: state.nextId,
    subject: params.subject,
    status: "pending",
  };
  if (params.description !== undefined) newTask.description = params.description;
  if (params.activeForm !== undefined) newTask.activeForm = params.activeForm;
  if (params.blockedBy !== undefined && params.blockedBy.length > 0) {
    newTask.blockedBy = [...params.blockedBy];
  }
  if (params.owner !== undefined) newTask.owner = params.owner;
  if (params.metadata !== undefined) newTask.metadata = { ...params.metadata };
  return {
    state: { tasks: [...state.tasks, newTask], nextId: state.nextId + 1 },
    op: { kind: "create", taskId: newTask.id },
  };
}

function reduceUpdate(state: TaskState, params: TaskMutationParams): ApplyResult {
  if (params.id === undefined) return errorResult(state, "id required for update");
  const idx = state.tasks.findIndex((t) => t.id === params.id);
  if (idx === -1) return errorResult(state, `#${params.id} not found`);
  const current = state.tasks[idx]!;

  const hasMutation =
    params.subject !== undefined ||
    params.description !== undefined ||
    params.activeForm !== undefined ||
    params.status !== undefined ||
    params.owner !== undefined ||
    params.metadata !== undefined ||
    (params.addBlockedBy !== undefined && params.addBlockedBy.length > 0) ||
    (params.removeBlockedBy !== undefined && params.removeBlockedBy.length > 0);
  if (!hasMutation) {
    return errorResult(state, "update requires at least one mutable field");
  }

  let newStatus = current.status;
  if (params.status !== undefined) {
    if (!isTransitionValid(current.status, params.status)) {
      return errorResult(state, `illegal transition ${current.status} → ${params.status}`);
    }
    newStatus = params.status;
  }

  let newBlockedBy = current.blockedBy ? [...current.blockedBy] : [];
  if (params.removeBlockedBy !== undefined && params.removeBlockedBy.length > 0) {
    const toRemove = new Set(params.removeBlockedBy);
    newBlockedBy = newBlockedBy.filter((dep) => !toRemove.has(dep));
  }
  if (params.addBlockedBy !== undefined && params.addBlockedBy.length > 0) {
    for (const dep of params.addBlockedBy) {
      if (dep === current.id) {
        return errorResult(state, `cannot block #${current.id} on itself`);
      }
      const depTask = state.tasks.find((t) => t.id === dep);
      if (depTask === undefined) return errorResult(state, `addBlockedBy: #${dep} not found`);
      if (depTask.status === "deleted") {
        return errorResult(state, `addBlockedBy: #${dep} is deleted`);
      }
      if (!newBlockedBy.includes(dep)) newBlockedBy.push(dep);
    }
    if (detectCycle(state.tasks, current.id, newBlockedBy)) {
      return errorResult(state, "addBlockedBy would create a cycle in the blockedBy graph");
    }
  }

  // Metadata merge: pass `null` for a key to delete it; otherwise
  // shallow merge atop existing metadata. Result with zero keys
  // collapses to undefined so the persisted shape stays clean.
  let newMetadata: Record<string, unknown> | undefined = current.metadata;
  if (params.metadata !== undefined) {
    const merged: Record<string, unknown> = { ...(current.metadata ?? {}) };
    for (const [k, v] of Object.entries(params.metadata)) {
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    newMetadata = Object.keys(merged).length > 0 ? merged : undefined;
  }

  const updated: Task = { ...current, status: newStatus };
  if (params.subject !== undefined) updated.subject = params.subject;
  if (params.description !== undefined) updated.description = params.description;
  if (params.activeForm !== undefined) updated.activeForm = params.activeForm;
  if (params.owner !== undefined) updated.owner = params.owner;
  if (newBlockedBy.length > 0) updated.blockedBy = newBlockedBy;
  else delete updated.blockedBy;
  if (newMetadata === undefined) delete updated.metadata;
  else updated.metadata = newMetadata;

  const newTasks = [...state.tasks];
  newTasks[idx] = updated;
  return {
    state: { tasks: newTasks, nextId: state.nextId },
    op: { kind: "update", id: updated.id, fromStatus: current.status, toStatus: newStatus },
  };
}

function reduceGet(state: TaskState, params: TaskMutationParams): ApplyResult {
  if (params.id === undefined) return errorResult(state, "id required for get");
  const task = state.tasks.find((t) => t.id === params.id);
  if (task === undefined) return errorResult(state, `#${params.id} not found`);
  return { state, op: { kind: "get", task } };
}

function reduceDelete(state: TaskState, params: TaskMutationParams): ApplyResult {
  if (params.id === undefined) return errorResult(state, "id required for delete");
  const idx = state.tasks.findIndex((t) => t.id === params.id);
  if (idx === -1) return errorResult(state, `#${params.id} not found`);
  const current = state.tasks[idx]!;
  if (current.status === "deleted") {
    return errorResult(state, `#${current.id} is already deleted`);
  }
  const updated: Task = { ...current, status: "deleted" };
  const newTasks = [...state.tasks];
  newTasks[idx] = updated;
  return {
    state: { tasks: newTasks, nextId: state.nextId },
    op: { kind: "delete", id: updated.id, subject: updated.subject },
  };
}

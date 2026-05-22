import type { Op } from "./reducer.js";
import { deriveBlocks } from "./task-graph.js";
import type {
  AskUserQuestionStyleResult,
  Task,
  TaskAction,
  TaskDetails,
  TaskMutationParams,
  TaskState,
} from "./types.js";

/**
 * Per-task one-liner rendered by the `list` content branch.
 * `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 */
function formatListLine(t: Task): string {
  const block =
    t.blockedBy && t.blockedBy.length > 0
      ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}`
      : "";
  const form = t.status === "in_progress" && t.activeForm !== undefined ? ` (${t.activeForm})` : "";
  return `[${t.status}] #${t.id} ${t.subject}${form}${block}`;
}

/**
 * Multi-line presentation for the `get` action — header line plus
 * description / activeForm / blockedBy / blocks / owner rows.
 */
function formatGetLines(task: Task, state: TaskState): string {
  const blocks = deriveBlocks(state.tasks).get(task.id) ?? [];
  const lines = [`#${task.id} [${task.status}] ${task.subject}`];
  if (task.description !== undefined) lines.push(`  description: ${task.description}`);
  if (task.activeForm !== undefined) lines.push(`  activeForm: ${task.activeForm}`);
  if (task.blockedBy !== undefined && task.blockedBy.length > 0) {
    lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
  }
  if (blocks.length > 0) {
    lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
  }
  if (task.owner !== undefined) lines.push(`  owner: ${task.owner}`);
  return lines.join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind`;
 * adding a new Op variant fails to compile here until a branch is
 * added. Output strings are kept stable so existing model prompts
 * that parse the tool result format don't break.
 */
export function formatContent(op: Op, state: TaskState): string {
  switch (op.kind) {
    case "create": {
      const t = state.tasks.find((x) => x.id === op.taskId);
      if (t === undefined) return `Created #${op.taskId}`;
      return `Created #${t.id}: ${t.subject} (pending)`;
    }
    case "update": {
      const transition =
        op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
      return `Updated #${op.id}${transition}`;
    }
    case "delete":
      return `Deleted #${op.id}: ${op.subject}`;
    case "clear":
      return `Cleared ${op.count} tasks`;
    case "list": {
      let view = state.tasks;
      if (!op.includeDeleted) view = view.filter((t) => t.status !== "deleted");
      if (op.statusFilter !== undefined) view = view.filter((t) => t.status === op.statusFilter);
      return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
    }
    case "get":
      return formatGetLines(op.task, state);
    case "error":
      return `Error: ${op.message}`;
  }
}

/**
 * Build the agent-facing tool envelope after the reducer has
 * produced a new state. `details.tasks` + `details.nextId` is the
 * full snapshot — `replay.ts` consumes this shape when rebuilding
 * state on session lifecycle events.
 */
export function buildToolResult(
  action: TaskAction,
  params: TaskMutationParams,
  state: TaskState,
  op: Op,
): AskUserQuestionStyleResult {
  const text = formatContent(op, state);
  const details: TaskDetails = {
    action,
    params: params,
    tasks: state.tasks,
    nextId: state.nextId,
    ...(op.kind === "error" ? { error: op.message } : {}),
  };
  return { content: [{ type: "text", text }], details };
}

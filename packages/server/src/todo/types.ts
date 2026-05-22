/**
 * Shape definitions for the `todo` tool. The wire contract — tool
 * name (`"todo"`), input enum (`create | update | list | get |
 * delete | clear`), 4-state machine (`pending | in_progress |
 * completed | deleted`), dependency model (blockedBy + add/remove
 * variants on update), and response envelope (`{content:[{type:
 * "text", text}], details:{action, params, tasks, nextId, error?}}`)
 * — is contract-compatible with `@juicesharp/rpiv-todo`. An agent
 * prompt authored against the plugin works against this
 * implementation unchanged.
 *
 * Implementation is independent; constants and validation rules were
 * derived from the plugin's published schema descriptions and tests
 * rather than copied. See `docs/todo.md` for the cross-reference.
 *
 * The tool name "todo" is the persistence key for branch replay
 * (we filter `toolResult.toolName === "todo"` to reconstruct state)
 * — DO NOT rename without a migration story for existing sessions.
 */

export const TOOL_NAME = "todo";
export const TOOL_LABEL = "Todo";

export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export type TaskAction = "create" | "update" | "list" | "get" | "delete" | "clear";

export interface Task {
  id: number;
  subject: string;
  description?: string;
  activeForm?: string;
  status: TaskStatus;
  blockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Persistence + replay snapshot. Every successful `todo` tool call
 * returns this shape under `details`; `replay.ts` reads the latest
 * one from the branch to reconstruct state. Field order is pinned
 * by cross-version replay compatibility — adding fields is safe,
 * renaming is not.
 */
export interface TaskDetails {
  action: TaskAction;
  params: Record<string, unknown>;
  tasks: Task[];
  nextId: number;
  error?: string;
}

export interface TaskState {
  tasks: Task[];
  nextId: number;
}

export const EMPTY_STATE: TaskState = { tasks: [], nextId: 1 };

/**
 * Input bag the reducer accepts. Open-shape so the reducer doesn't
 * have to defensively narrow each field — the JSON Schema layer
 * (Fastify body validation against `inputSchema` in tool.ts) is the
 * first line of structural defense; the reducer enforces the
 * semantic rules (transition legality, dangling deps, cycles).
 */
export interface TaskMutationParams {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: TaskStatus;
  blockedBy?: number[];
  addBlockedBy?: number[];
  removeBlockedBy?: number[];
  owner?: string;
  metadata?: Record<string, unknown>;
  id?: number;
  includeDeleted?: boolean;
  [key: string]: unknown;
}

export interface AskUserQuestionStyleResult {
  content: { type: "text"; text: string }[];
  details: TaskDetails;
}

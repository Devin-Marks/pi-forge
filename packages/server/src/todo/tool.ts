import { Type } from "typebox";
import type { SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { buildToolResult } from "./envelope.js";
import {
  DEFAULT_PROMPT_GUIDELINES,
  DEFAULT_PROMPT_SNIPPET,
  TOOL_DESCRIPTION,
} from "./prompt-strings.js";
import { applyTaskMutation } from "./reducer.js";
import { commitState, getState } from "./store.js";
import { TOOL_LABEL, TOOL_NAME, type TaskAction, type TaskMutationParams } from "./types.js";

/**
 * JSON Schema for `todo` tool params. Hand-written (not via the
 * TypeBox DSL) so the shape matches the upstream plugin field-for-
 * field. Structural caps act as a fast pre-filter; the reducer
 * runs after for semantic checks (transition legality, dangling
 * deps, cycles) the schema can't express.
 *
 * Type.Unsafe wraps the raw JSON Schema as a TypeBox schema so it
 * satisfies ToolDefinition.parameters without bringing the rest of
 * the TypeBox DSL into our code.
 */
const inputSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["create", "update", "list", "get", "delete", "clear"],
    },
    subject: { type: "string", description: "Task subject line (required for create)" },
    description: { type: "string", description: "Long-form task description" },
    activeForm: {
      type: "string",
      description:
        "Present-continuous spinner label shown while status is in_progress (e.g. 'writing tests')",
    },
    status: {
      type: "string",
      enum: ["pending", "in_progress", "completed", "deleted"],
      description: "Target status (update) or list filter (list)",
    },
    blockedBy: {
      type: "array",
      items: { type: "number" },
      description: "Initial blockedBy ids (create only)",
    },
    addBlockedBy: {
      type: "array",
      items: { type: "number" },
      description: "Task ids to add to blockedBy (update only, additive merge)",
    },
    removeBlockedBy: {
      type: "array",
      items: { type: "number" },
      description: "Task ids to remove from blockedBy (update only, additive merge)",
    },
    owner: { type: "string", description: "Agent/owner assigned to this task" },
    metadata: {
      type: "object",
      additionalProperties: true,
      description: "Arbitrary metadata; pass null value for a key to delete that key on update",
    },
    id: { type: "number", description: "Task id (required for update, get, delete)" },
    includeDeleted: {
      type: "boolean",
      description:
        "If true, list action returns deleted (tombstoned) tasks as well. Default: false.",
    },
  },
} as const;

/**
 * Build the per-session `todo` tool. Contract-compatible with
 * `@juicesharp/rpiv-todo` — same tool name, input schema, response
 * envelope (`{content:[{type:"text",text}], details:{action,
 * params, tasks, nextId, error?}}`), 4-state machine, and
 * blockedBy semantics. An agent prompt authored against the plugin
 * works against this implementation unchanged.
 *
 * Bound to one session so `execute()` can resolve the right cache
 * key and the right sessionManager (for branch replay).
 */
export function createTodoTool(sessionId: string, sessionManager: SessionManager): ToolDefinition {
  return {
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description: TOOL_DESCRIPTION,
    promptSnippet: DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: DEFAULT_PROMPT_GUIDELINES,
    parameters: Type.Unsafe<Record<string, unknown>>(inputSchema),
    async execute(_toolCallId, params) {
      const typed = params as { action: TaskAction } & TaskMutationParams;
      // Cache-first read; getState replays from the branch on miss
      // so a server restart doesn't lose state mid-session.
      const current = getState(sessionId, sessionManager);
      const result = applyTaskMutation(current, typed.action, typed);
      commitState(sessionId, result.state);
      return buildToolResult(typed.action, typed, result.state, result.op);
    },
  } satisfies ToolDefinition;
}

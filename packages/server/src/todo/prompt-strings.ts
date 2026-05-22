/**
 * Prompt snippet, guidelines, and tool description for the `todo`
 * tool.
 *
 * ─────────────────────────────────────────────────────────────────────
 * Adapted from @juicesharp/rpiv-todo (MIT).
 * Copyright (c) 2026 juicesharp.
 * https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo
 * ─────────────────────────────────────────────────────────────────────
 *
 * The wording is preserved because it's been tuned against real
 * model behavior — the plugin author's hard-won rules on "exactly one
 * task in_progress at a time" and "never mark completed if tests are
 * failing" are exactly the kind of guidance that's costly to rederive
 * and easy to regress on. The reducer, envelope builder, replay logic,
 * and React UI are independent implementations.
 */

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";

export const DEFAULT_PROMPT_GUIDELINES: string[] = [
  "Use `todo` for complex work with 3+ steps, when the user gives you a list of tasks, or immediately after receiving new instructions to capture requirements. Skip it for single trivial tasks and purely conversational requests.",
  "When starting any task, mark it in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done — never batch completions. Exactly one task should be in_progress at a time.",
  "Never mark a task completed if tests are failing, the implementation is partial, or you hit unresolved errors — keep it in_progress and create a new task for the blocker instead.",
  "Task status is a 4-state machine: pending → in_progress → completed, plus deleted as a tombstone. Pass activeForm (present-continuous label, e.g. 'researching existing tool') when marking in_progress.",
  "Use blockedBy to express dependencies (A is blocked by B). On create, pass blockedBy as the initial set. On update, use addBlockedBy / removeBlockedBy (additive merge — do not resend the full array). Cycles are rejected.",
  "list hides tombstoned (deleted) tasks by default; pass includeDeleted:true to see them. Pass status to filter by a single status.",
  "Subject must be short and imperative (e.g. 'Research existing tool'); description is for long-form detail. activeForm is a present-continuous label shown while in_progress.",
];

export const TOOL_DESCRIPTION =
  "Manage a task list for tracking multi-step progress. Actions: create (new task), update (change status/fields/dependencies), list (all tasks, optionally filtered by status), get (single task details), delete (tombstone), clear (reset all). Status: pending → in_progress → completed, plus deleted tombstone. Use this to plan and track multi-step work like research, design, and implementation.";

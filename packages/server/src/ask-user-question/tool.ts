import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerPending } from "./registry.js";
import { validateQuestionnaire } from "./validate.js";
import { buildResult } from "./envelope.js";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET, TOOL_DESCRIPTION } from "./prompt-strings.js";
import {
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
} from "./types.js";

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/**
 * JSON Schema for the tool's params. We hand-write the schema
 * (rather than reaching for TypeBox) so the shape matches what the
 * upstream plugin advertises field-for-field. The structural caps
 * (1..MAX_QUESTIONS, MIN..MAX_OPTIONS, maxLength) act as a fast
 * pre-filter; `validateQuestionnaire` runs after for semantic
 * checks the schema can't express (reserved labels, dupes).
 *
 * Type.Unsafe wraps the raw JSON Schema as a TypeBox schema so it
 * satisfies the ToolDefinition.parameters type without dragging
 * the rest of the TypeBox DSL into our code.
 */
const inputSchema = {
  type: "object",
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      minItems: 1,
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        required: ["question", "header", "options"],
        properties: {
          question: { type: "string", minLength: 1 },
          header: { type: "string", minLength: 1, maxLength: MAX_HEADER_LENGTH },
          multiSelect: { type: "boolean" },
          options: {
            type: "array",
            minItems: MIN_OPTIONS,
            maxItems: MAX_OPTIONS,
            items: {
              type: "object",
              required: ["label", "description"],
              properties: {
                label: { type: "string", minLength: 1, maxLength: MAX_LABEL_LENGTH },
                description: { type: "string", minLength: 1 },
                preview: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

/**
 * Build the per-session `ask_user_question` tool. Bound to one
 * session so `execute()` knows which browser to push the
 * questions to.
 *
 * The tool is contract-compatible with
 * `@juicesharp/rpiv-ask-user-question` — agents prompted to use
 * `ask_user_question` get the same input schema, the same
 * response envelope (`{content:[{type:"text",text}], details:{
 * answers, cancelled, error?}}`), and the same answer-kind
 * vocabulary (`option | custom | chat | multi`). Implementation
 * is independent; the contract is reproduced via the published
 * schema descriptions.
 */
export function createAskUserQuestionTool(sessionId: string): ToolDefinition {
  return {
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: "Ask User Question",
    description: TOOL_DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: Type.Unsafe<Record<string, unknown>>(inputSchema),
    async execute(_toolCallId, params, signal) {
      const validation = validateQuestionnaire(params);
      if (!validation.ok) {
        // Validation failure is communicated to the agent in the
        // same shape the plugin uses — `details.error` carries the
        // discriminated code, `details.cancelled` is true, and the
        // text block summarises so the model has something to read.
        return buildResult([], {
          cancelled: true,
          error: validation.error,
          questionCount: 0,
        });
      }
      const { params: q } = validation;
      try {
        const args: { sessionId: string; questions: typeof q.questions; signal?: AbortSignal } = {
          sessionId,
          questions: q.questions,
        };
        if (signal !== undefined) args.signal = signal;
        const { result } = registerPending(args);
        return await result;
      } catch (err) {
        // Abort path — `registerPending` rejects with Error("aborted")
        // when the agent's signal fires. Return a clean cancelled
        // envelope so the agent sees a tool result rather than an
        // unhandled exception in its loop.
        const message = err instanceof Error ? err.message : String(err);
        return buildResult([], {
          cancelled: true,
          error: message,
          questionCount: q.questions.length,
        });
      }
    },
  } satisfies ToolDefinition;
}

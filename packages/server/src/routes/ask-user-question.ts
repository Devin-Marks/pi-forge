import type { FastifyPluginAsync } from "fastify";
import { getSession } from "../session-registry.js";
import { answerPending, getPendingForSession } from "../ask-user-question/registry.js";
import { buildResult } from "../ask-user-question/envelope.js";
import type { QuestionAnswer } from "../ask-user-question/types.js";
import { errorSchema } from "./_schemas.js";

/**
 * POST /sessions/:id/ask-user-question/answer
 *
 * The browser modal calls this with the user's answers (or with
 * `cancelled: true` when they pick "Chat about this" / close the
 * modal). Resolves the pending entry in the registry, which
 * propagates back to the tool's awaiting `execute()` — the agent
 * gets a clean tool result and continues.
 *
 * Per-call ownership is enforced by matching `requestId` against
 * this session's pending list. A spoofed requestId from a session
 * the caller doesn't own returns 404.
 */
const answerBodySchema = {
  type: "object",
  required: ["requestId"],
  additionalProperties: false,
  properties: {
    requestId: { type: "string", minLength: 1 },
    cancelled: { type: "boolean" },
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["questionIndex", "question", "kind"],
        properties: {
          questionIndex: { type: "integer", minimum: 0 },
          question: { type: "string" },
          kind: { type: "string", enum: ["option", "custom", "chat", "multi"] },
          answer: { type: ["string", "null"] },
          selected: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
          preview: { type: "string" },
        },
      },
    },
  },
} as const;

interface AnswerBody {
  requestId: string;
  cancelled?: boolean;
  answers?: QuestionAnswer[];
}

export const askUserQuestionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/ask-user-question/pending",
    {
      schema: {
        description:
          "List ask_user_question requests currently waiting on an answer " +
          "for this session. The browser modal uses this on initial mount " +
          "as a fallback to the SSE snapshot re-delivery path.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["pending"],
            properties: {
              pending: {
                type: "array",
                items: {
                  type: "object",
                  required: ["requestId", "questions"],
                  properties: {
                    requestId: { type: "string" },
                    questions: { type: "array" },
                  },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const pending = getPendingForSession(req.params.id).map((p) => ({
        requestId: p.requestId,
        questions: p.questions,
      }));
      return { pending };
    },
  );

  fastify.post<{ Params: { id: string }; Body: AnswerBody }>(
    "/sessions/:id/ask-user-question/answer",
    {
      schema: {
        description:
          "Submit a user's answers to an in-flight ask_user_question " +
          "tool call. Pass `cancelled: true` (with or without partial " +
          "answers) when the user dismissed the modal or picked the " +
          "'Chat about this' escape. The tool's execute() resolves " +
          "with the constructed envelope; the agent then continues.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: answerBodySchema,
        response: {
          204: { type: "null" },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const cancelled = req.body.cancelled === true;
      const answers = Array.isArray(req.body.answers) ? req.body.answers : [];
      // Total question count is whatever the registry has on file —
      // the envelope's "partial cancel" summary line reads it from
      // here to phrase correctly. Look it up before answering since
      // the registry entry vanishes on resolve.
      const pending = getPendingForSession(req.params.id).find(
        (p) => p.requestId === req.body.requestId,
      );
      const questionCount = pending?.questions.length ?? answers.length;
      const envelope = buildResult(answers, { cancelled, questionCount });
      const ok = answerPending(req.body.requestId, req.params.id, envelope);
      if (!ok) {
        // Either unknown requestId or one that belongs to another
        // session (defense against cross-session spoofing).
        return reply.code(404).send({ error: "request_not_found" });
      }
      return reply.code(204).send();
    },
  );
};

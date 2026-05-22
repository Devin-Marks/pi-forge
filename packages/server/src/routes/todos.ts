import type { FastifyPluginAsync } from "fastify";
import { getSession } from "../session-registry.js";
import { getState } from "../todo/store.js";
import { errorSchema } from "./_schemas.js";

/**
 * GET /sessions/:id/todos
 *
 * Returns the current todo state for a session. Used by the UI
 * panel as the initial fetch when an SSE snapshot hasn't landed
 * yet (cold load, cross-tab join). The store's `getState` is
 * cache-first with replay-on-miss, so this is honest after a
 * server restart even if the cache is empty.
 *
 * The wire shape mirrors the SSE `todo_update` event so the
 * client can use one normaliser for both paths.
 */
const taskSchema = {
  type: "object",
  required: ["id", "subject", "status"],
  additionalProperties: true,
  properties: {
    id: { type: "integer" },
    subject: { type: "string" },
    description: { type: "string" },
    activeForm: { type: "string" },
    status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
    blockedBy: { type: "array", items: { type: "integer" } },
    owner: { type: "string" },
    metadata: { type: "object", additionalProperties: true },
  },
} as const;

export const todoRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/todos",
    {
      schema: {
        description:
          "Return the current todo list for this session. Cache-first; " +
          "rebuilds from the session branch on cache miss so a server " +
          "restart doesn't lie about state.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["tasks", "nextId"],
            properties: {
              tasks: { type: "array", items: taskSchema },
              nextId: { type: "integer" },
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
      // AgentSession.sessionManager is the public accessor (see
      // agent-session.d.ts). getState is cache-first with replay-
      // on-miss, so this stays honest after a server restart.
      const state = getState(req.params.id, live.session.sessionManager);
      return { tasks: state.tasks, nextId: state.nextId };
    },
  );
};

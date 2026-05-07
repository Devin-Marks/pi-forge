import type { FastifyPluginAsync } from "fastify";
import {
  resumeSessionById,
  SessionNotFoundError,
  SessionTombstonedError,
} from "../session-registry.js";
import { createSSEClient } from "../sse-bridge.js";
import { errorSchema } from "./_schemas.js";

/**
 * SSE stream for a session. If the session is in the live registry, attach
 * directly; otherwise auto-resume from disk via resumeSessionById (which
 * walks projects to find the .jsonl and rehydrates an AgentSession). 404
 * only when no project on disk owns the id; 500 with a stable code when
 * the resume itself fails (corrupt JSONL, SDK error).
 */
export const streamRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/stream",
    {
      schema: {
        description:
          "Open an SSE stream for a session. Sends a `snapshot` event on " +
          "connect, then forwards filtered AgentSessionEvents until the " +
          "client disconnects. Auto-resumes the session from disk if it's " +
          "not already live.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        // SSE responses don't fit Fastify's response-schema model — see the
        // Phase-5 review notes in REVIEW_FIXES.md. Only the error shapes are
        // declared; the catalog of SSE event types lives in
        // docs/sse-events.md (Phase 17).
        response: {
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      // Diagnostic: stream-route entry. Pairs with subagent-discovery /
      // resume-session-found logs in session-registry — seeing all
      // three lines together for a click confirms the click reached
      // the server, found the session, and attached the SSE.
      process.stderr.write(
        JSON.stringify({
          level: "info",
          time: new Date().toISOString(),
          msg: "stream-route-hit",
          sessionId: req.params.id,
        }) + "\n",
      );
      let live;
      try {
        live = await resumeSessionById(req.params.id);
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          return reply.code(404).send({ error: "session_not_found" });
        }
        if (err instanceof SessionTombstonedError) {
          // The session was disposed within the tombstone window
          // (typically: the operator just deleted it from another
          // tab). 410 Gone tells the SSE client to stop reconnecting
          // — sse-client.ts treats 410 as terminal.
          return reply.code(410).send({ error: "session_tombstoned" });
        }
        // Corrupt JSONL, SDK error during createAgentSession, etc. Log the
        // detail server-side; client gets a stable code without the SDK
        // string in the body.
        req.log.error({ err, sessionId: req.params.id }, "stream resume failed");
        return reply.code(500).send({ error: "resume_failed" });
      }
      createSSEClient(reply, live);
      return reply;
    },
  );
};

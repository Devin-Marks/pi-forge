import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import { searchSessions } from "../session-searcher.js";
import { errorSchema } from "./_schemas.js";

/**
 * Cross-session text search. Backed by the session-searcher module
 * which ripgreps every JSONL under `${SESSION_DIR}` and parses each
 * hit to surface user / assistant messages and tool-call invocations
 * (tool results are intentionally skipped — they're noisy and can
 * be megabytes of file content).
 *
 * The dropdown bar in the top-of-app calls this route on debounced
 * input. Caps default to 50 sessions × 5 matches with a 2-second
 * timeout — comfortably fast for the live "type to find" UX while
 * still bounding worst-case work.
 */
export const searchRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{
    Querystring: {
      q: string;
      sessionLimit?: string;
      matchesPerSession?: string;
    };
  }>(
    "/search/sessions",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.searchMax,
          timeWindow: config.rateLimits.searchWindowMs,
        },
      },
      schema: {
        description:
          "Cross-session text search. Returns sessions whose JSONL " +
          "contains a case-insensitive substring match in user / " +
          "assistant text or in an assistant tool-call invocation. " +
          "Tool results, session metadata events, and thinking blocks " +
          "are filtered out to keep the dropdown snippets readable.",
        tags: ["sessions"],
        querystring: {
          type: "object",
          required: ["q"],
          properties: {
            q: { type: "string", minLength: 1, maxLength: 256 },
            sessionLimit: { type: "string", pattern: "^[0-9]+$" },
            matchesPerSession: { type: "string", pattern: "^[0-9]+$" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["engine", "results", "truncated"],
            properties: {
              engine: { type: "string", enum: ["ripgrep", "node"] },
              truncated: { type: "boolean" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  required: ["sessionId", "projectId", "projectName", "modifiedAt", "matches"],
                  properties: {
                    sessionId: { type: "string" },
                    projectId: { type: "string" },
                    projectName: { type: "string" },
                    sessionName: { type: "string" },
                    modifiedAt: { type: "string", format: "date-time" },
                    matches: {
                      type: "array",
                      items: {
                        type: "object",
                        required: ["messageIndex", "kind", "snippet", "matchOffset", "matchLength"],
                        properties: {
                          messageIndex: { type: "integer", minimum: 0 },
                          messageEnvelopeId: { type: "string" },
                          kind: {
                            type: "string",
                            enum: ["user", "assistant", "tool_call"],
                          },
                          snippet: { type: "string" },
                          matchOffset: { type: "integer", minimum: 0 },
                          matchLength: { type: "integer", minimum: 0 },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          400: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const { q } = req.query;
      const sessionLimit =
        req.query.sessionLimit !== undefined
          ? Math.min(200, Math.max(1, Number.parseInt(req.query.sessionLimit, 10)))
          : 50;
      const matchesPerSession =
        req.query.matchesPerSession !== undefined
          ? Math.min(50, Math.max(1, Number.parseInt(req.query.matchesPerSession, 10)))
          : 5;
      try {
        const result = await searchSessions({
          query: q,
          sessionLimit,
          matchesPerSession,
          timeoutMs: 2_000,
        });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : "search failed";
        return reply.code(500).send({ error: "search_failed", message });
      }
    },
  );
};

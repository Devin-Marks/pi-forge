import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { exportAsJsonl, exportAsMarkdown, SessionNotFoundError } from "../session-exporter.js";
import { errorSchema } from "./_schemas.js";

/**
 * Single-session conversation export. Two formats:
 *
 *   - `jsonl` — raw on-disk session JSONL with subagent children
 *     inlined between the parent's `subagent` tool call and its
 *     matching tool result, bracketed by synthetic
 *     `subagent_inline_start` / `subagent_inline_end` envelopes.
 *   - `markdown` — flat human-readable transcript: user / assistant
 *     bubbles, tool calls as fenced code blocks, tool results as
 *     blockquotes (capped per-result), subagent children nested
 *     under the parent's tool call.
 *
 * Triggered from the chat-view toolbar in the browser UI; usable
 * programmatically for backups / archiving.
 */
export const exportRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get<{
    Params: { sessionId: string };
    Querystring: { format: "jsonl" | "markdown" };
  }>(
    "/sessions/:sessionId/export",
    {
      schema: {
        description:
          "Export a single conversation as JSONL or Markdown. Subagent " +
          "children are inlined into the parent export. Returns the file " +
          "as an attachment with a filename derived from the session name " +
          "(or session id when unnamed).",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["sessionId"],
          properties: { sessionId: { type: "string", minLength: 1 } },
        },
        querystring: {
          type: "object",
          required: ["format"],
          properties: {
            format: { type: "string", enum: ["jsonl", "markdown"] },
          },
        },
        response: {
          // Body is binary-ish (utf-8 text but with attachment headers);
          // schema-less response keeps Fastify from second-guessing the
          // string body. 4xx are JSON envelopes per the project standard.
          400: errorSchema,
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const artifact =
          req.query.format === "jsonl"
            ? await exportAsJsonl(req.params.sessionId)
            : await exportAsMarkdown(req.params.sessionId);
        reply
          .header("Content-Type", artifact.contentType)
          .header("Content-Disposition", `attachment; filename="${artifact.filename}"`);
        return reply.send(artifact.content);
      } catch (err) {
        if (err instanceof SessionNotFoundError) {
          return reply.code(404).send({ error: "session_not_found", message: err.message });
        }
        const message = err instanceof Error ? err.message : "export failed";
        return reply.code(500).send({ error: "export_failed", message });
      }
    },
  );
};

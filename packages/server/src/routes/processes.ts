import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyPluginAsync } from "fastify";
import { processManager } from "../processes/manager.js";
import { getSession } from "../session-registry.js";
import { errorSchema } from "./_schemas.js";

/**
 * REST surface for the processes panel. Routes are session-scoped
 * (`/sessions/:id/...`) so the registry lookup gates each call:
 * unknown sessionId → 404, no cross-session spoofing.
 *
 * SSE is the authoritative live channel; these endpoints exist for:
 *  - Cold load (panel mounts before snapshot lands → GET list)
 *  - Log streaming (the full file on disk, not just the ring tail)
 *  - User actions (kill, clear, write stdin)
 */

const processInfoSchema = {
  type: "object",
  required: ["id", "name", "pid", "command", "cwd", "startTime", "status"],
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    pid: { type: "integer" },
    command: { type: "string" },
    cwd: { type: "string" },
    startTime: { type: "integer" },
    endTime: { type: ["integer", "null"] },
    status: {
      type: "string",
      enum: ["running", "terminating", "terminate_timeout", "exited", "killed"],
    },
    exitCode: { type: ["integer", "null"] },
    success: { type: ["boolean", "null"] },
    stdoutFile: { type: "string" },
    stderrFile: { type: "string" },
    alertOnSuccess: { type: "boolean" },
    alertOnFailure: { type: "boolean" },
    alertOnKill: { type: "boolean" },
  },
} as const;

export const processesRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/processes",
    {
      schema: {
        description:
          "List the session's managed background processes (running + " +
          "finished). Used by the processes panel on mount when the SSE " +
          "snapshot hasn't landed yet.",
        tags: ["sessions"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["processes"],
            properties: { processes: { type: "array", items: processInfoSchema } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return reply.code(404).send({ error: "session_not_found" });
      return { processes: processManager.list(req.params.id) };
    },
  );

  fastify.get<{
    Params: { id: string; processId: string };
    Querystring: { stream?: "stdout" | "stderr"; tail?: string };
  }>(
    "/sessions/:id/processes/:processId/output",
    {
      schema: {
        description:
          "Return the recent in-memory tail (default 200 lines) of stdout " +
          "and stderr for one process. The full history lives on disk; use " +
          "GET /logs/file for streaming the whole file.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id", "processId"],
          properties: { id: { type: "string" }, processId: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: {
            stream: { type: "string", enum: ["stdout", "stderr"] },
            tail: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["stdout", "stderr", "status"],
            properties: {
              stdout: { type: "array", items: { type: "string" } },
              stderr: { type: "array", items: { type: "string" } },
              status: { type: "string" },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return reply.code(404).send({ error: "session_not_found" });
      const tail = req.query.tail !== undefined ? Number.parseInt(req.query.tail, 10) : 200;
      const out = processManager.output(
        req.params.id,
        req.params.processId,
        Number.isFinite(tail) ? tail : 200,
      );
      if (out === undefined) return reply.code(404).send({ error: "process_not_found" });
      return out;
    },
  );

  fastify.get<{
    Params: { id: string; processId: string };
    Querystring: { stream?: "stdout" | "stderr" };
  }>(
    "/sessions/:id/processes/:processId/logs/file",
    {
      schema: {
        description:
          "Stream the full on-disk log file for one process stream " +
          "(default: stdout). Useful for the panel's 'view full log' view " +
          "when the in-memory ring tail isn't enough.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id", "processId"],
          properties: { id: { type: "string" }, processId: { type: "string" } },
        },
        querystring: {
          type: "object",
          properties: { stream: { type: "string", enum: ["stdout", "stderr"] } },
        },
        response: { 404: errorSchema },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return reply.code(404).send({ error: "session_not_found" });
      const files = processManager.logFiles(req.params.id, req.params.processId);
      if (files === undefined) return reply.code(404).send({ error: "process_not_found" });
      const path = req.query.stream === "stderr" ? files.stderrFile : files.stdoutFile;
      // Existence check before hijacking the reply — a missing file
      // (rare race: process just started, no output yet) should
      // 200 with an empty body, not 500.
      const exists = await stat(path).catch(() => undefined);
      if (exists === undefined) {
        reply.header("Content-Type", "text/plain; charset=utf-8");
        return "";
      }
      reply.header("Content-Type", "text/plain; charset=utf-8");
      return reply.send(createReadStream(path));
    },
  );

  fastify.post<{ Params: { id: string; processId: string } }>(
    "/sessions/:id/processes/:processId/kill",
    {
      schema: {
        description:
          "Terminate a running process: SIGTERM, 5s grace, SIGKILL. " +
          "Returns immediately once the signal is sent; the SSE " +
          "process_update event fans out when the OS reports exit.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id", "processId"],
          properties: { id: { type: "string" }, processId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" }, reason: { type: "string" } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return reply.code(404).send({ error: "session_not_found" });
      const result = await processManager.kill(req.params.id, req.params.processId);
      if (!result.ok && result.reason === "not_found") {
        return reply.code(404).send({ error: "process_not_found" });
      }
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id/processes",
    {
      schema: {
        description: "Drop all FINISHED processes from the session's list. Live ones remain.",
        tags: ["sessions"],
        params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["cleared"],
            properties: { cleared: { type: "integer" } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return reply.code(404).send({ error: "session_not_found" });
      const cleared = processManager.clear(req.params.id);
      return { cleared };
    },
  );

  fastify.post<{
    Params: { id: string; processId: string };
    Body: { input: string; end?: boolean };
  }>(
    "/sessions/:id/processes/:processId/stdin",
    {
      schema: {
        description:
          "Pipe `input` to a live process's stdin. `end: true` closes stdin " +
          "after writing (use for programs reading until EOF).",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id", "processId"],
          properties: { id: { type: "string" }, processId: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["input"],
          additionalProperties: false,
          properties: { input: { type: "string" }, end: { type: "boolean" } },
        },
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" }, reason: { type: "string" } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return reply.code(404).send({ error: "session_not_found" });
      const result = await processManager.write(
        req.params.id,
        req.params.processId,
        req.body.input,
        req.body.end === true,
      );
      if (!result.ok && result.reason === "not_found") {
        return reply.code(404).send({ error: "process_not_found" });
      }
      return result.ok ? { ok: true } : { ok: false, reason: result.reason };
    },
  );
};

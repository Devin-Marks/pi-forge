/**
 * REST surface for session orchestration.
 *
 * Routes (all under `/api/v1/`):
 *   GET    /orchestration/config                          — instance flag + caps
 *   GET    /orchestration/sessions/:id                    — role + linkage for a session
 *   POST   /orchestration/sessions/:id/enable             — make session a supervisor
 *   POST   /orchestration/sessions/:id/disable            — remove supervisor mode
 *   GET    /orchestration/sessions/:id/workers            — list workers for a supervisor
 *   GET    /orchestration/sessions/:id/inbox              — full inbox history (newest first)
 *   POST   /orchestration/sessions/:id/inbox/clear        — wipe inbox
 *   POST   /orchestration/sessions/:id/workers/:wid/detach — drop supervisor link
 *   POST   /orchestration/sessions/:id/workers/:wid/kill   — dispose worker (UI control)
 *
 * Every route is gated by `isOrchestrationEnabled()` — returns 403
 * `orchestration_disabled` or `minimal_ui_disabled` based on which
 * gate is closed. The instance-level env flag is the kill switch;
 * MINIMAL_UI is a hard secondary gate (orchestration never surfaces
 * under MINIMAL_UI even with the env flag on, same posture as the
 * webhooks mutation gate).
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  findProjectIdForSession,
  getSession,
  rebuildAgentSessionForTools,
  resumeSessionById,
} from "../session-registry.js";
import {
  isOrchestrationEnabled,
  maxWorkersPerSupervisor,
  orchestrationDisabledReason,
} from "../orchestration/config.js";
import {
  disableSupervisor,
  enableSupervisor,
  getWorkerIds,
  getWorkerRecord,
  isSupervisor,
  isWorker,
  OrchestrationError,
  unregisterWorker,
} from "../orchestration/store.js";
import { clearInbox, pendingInboxCount, readAllInbox } from "../orchestration/store.js";
import { MAX_DEPTH } from "../orchestration/types.js";
import { killWorkerAndArchive } from "../orchestration/worker-lifecycle.js";
import { errorSchema } from "./_schemas.js";

function gate(reply: FastifyReply): FastifyReply | undefined {
  if (isOrchestrationEnabled()) return undefined;
  const reason = orchestrationDisabledReason();
  const message =
    reason === "minimal_ui_disabled"
      ? "Session orchestration is disabled under MINIMAL_UI."
      : "Session orchestration is disabled. Set ORCHESTRATION_ENABLED=true to enable.";
  return reply.code(403).send({ error: reason, message });
}

function handleStoreError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof OrchestrationError) {
    // Map specific codes to HTTP — depth_limit and validation
    // failures are 400s (client mistake); supervisor_not_found
    // is a 404 only when the SESSION exists but isn't a supervisor,
    // which is its own thing. We rely on the code field.
    if (err.code === "depth_limit_exceeded" || err.code === "worker_already_linked") {
      return reply.code(400).send({ error: err.code, message: err.message });
    }
    if (err.code === "supervisor_not_found") {
      return reply.code(404).send({ error: err.code, message: err.message });
    }
    return reply.code(400).send({ error: err.code, message: err.message });
  }
  reply.log.error({ err }, "orchestration route error");
  return reply.code(500).send({ error: "internal_error" });
}

const sessionLinkSchema = {
  type: "object",
  required: ["sessionId", "role"],
  properties: {
    sessionId: { type: "string" },
    role: { type: "string", enum: ["supervisor", "worker", "standalone"] },
    supervisorId: { type: "string" },
    workerIds: { type: "array", items: { type: "string" } },
    pendingInbox: { type: "integer", minimum: 0 },
    enabledAt: { type: "string" },
    spawnedAt: { type: "string" },
    spawnedFrom: {
      type: "object",
      required: ["sessionId", "mode"],
      properties: {
        sessionId: { type: "string" },
        mode: { type: "string", enum: ["fresh", "summary"] },
      },
    },
  },
} as const;

const workerSummarySchema = {
  type: "object",
  required: ["workerId", "isLive"],
  properties: {
    workerId: { type: "string" },
    isLive: { type: "boolean" },
    isStreaming: { type: "boolean" },
    name: { type: "string" },
    state: { type: "string", enum: ["streaming", "idle", "cold"] },
    lastActivityAt: { type: "string" },
    messageCount: { type: "integer", minimum: 0 },
    projectId: { type: "string" },
    spawnedAt: { type: "string" },
    spawnedFrom: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        mode: { type: "string" },
      },
    },
  },
} as const;

const inboxItemSchema = {
  type: "object",
  required: ["id", "type", "workerId", "occurredAt", "data", "delivered"],
  properties: {
    id: { type: "string" },
    type: { type: "string" },
    workerId: { type: "string" },
    occurredAt: { type: "string" },
    data: { type: "object", additionalProperties: true },
    delivered: { type: "boolean" },
  },
} as const;

export const orchestrationRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/orchestration/config",
    {
      schema: {
        description:
          "Return whether orchestration is enabled on this instance plus the " +
          "current caps. Always available (no auth surface beyond the standard " +
          "API auth gate); the UI uses this to decide whether to render the " +
          "supervisor toggle and Workers panel.",
        tags: ["orchestration"],
        response: {
          200: {
            type: "object",
            required: ["enabled", "maxWorkersPerSupervisor", "maxDepth", "disabledReason"],
            properties: {
              enabled: { type: "boolean" },
              maxWorkersPerSupervisor: { type: "integer", minimum: 1 },
              maxDepth: { type: "integer", minimum: 1 },
              disabledReason: {
                type: "string",
                enum: ["", "minimal_ui_disabled", "orchestration_disabled"],
              },
            },
          },
        },
      },
    },
    async () => {
      const enabled = isOrchestrationEnabled();
      return {
        enabled,
        maxWorkersPerSupervisor: maxWorkersPerSupervisor(),
        maxDepth: MAX_DEPTH,
        disabledReason: enabled ? "" : orchestrationDisabledReason(),
      };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/orchestration/sessions/:id",
    {
      schema: {
        description:
          "Return the orchestration role of a session: 'supervisor', 'worker', " +
          "or 'standalone'. For supervisors, includes the worker list + pending " +
          "inbox count; for workers, includes the supervisor id + handoff lineage.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: sessionLinkSchema,
          403: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      const sessionId = req.params.id;
      if (await isSupervisor(sessionId)) {
        const workerIds = await getWorkerIds(sessionId);
        const pending = await pendingInboxCount(sessionId);
        return {
          sessionId,
          role: "supervisor",
          workerIds,
          pendingInbox: pending,
        };
      }
      if (await isWorker(sessionId)) {
        const rec = await getWorkerRecord(sessionId);
        const out: Record<string, unknown> = {
          sessionId,
          role: "worker",
        };
        if (rec !== undefined) {
          out.supervisorId = rec.supervisorId;
          out.spawnedAt = rec.spawnedAt;
          if (rec.spawnedFrom !== undefined) out.spawnedFrom = rec.spawnedFrom;
        }
        return out;
      }
      return { sessionId, role: "standalone" };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/orchestration/sessions/:id/enable",
    {
      schema: {
        description:
          "Mark the session as a supervisor AND rebuild its live agent " +
          "session in-place so the orchestrate_* tools become available " +
          "immediately. The SDK only builds its tool list at " +
          "AgentSession-creation time, so an enable without rebuild would " +
          "leave a running session toolless until the user manually closed " +
          "and reopened it. The rebuild keeps the SSE attached — the " +
          "browser sees no reconnect, the new tools just appear on the " +
          "next turn.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: sessionLinkSchema,
          400: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      try {
        const rec = await enableSupervisor(req.params.id);
        // Rebuild AFTER the store write so the new AgentSession's
        // `customTools` resolution sees the supervisor flag and
        // adds the orchestrate_* tools. Best-effort — if the
        // session isn't live (browser opened a cold session, never
        // attached SSE), there's nothing to rebuild and the next
        // resume will pick up the tools naturally.
        try {
          await rebuildAgentSessionForTools(req.params.id);
        } catch (err) {
          req.log.warn(
            { err, sessionId: req.params.id },
            "orchestration enable: rebuild failed (non-fatal — next resume will pick up tools)",
          );
        }
        return {
          sessionId: req.params.id,
          role: "supervisor",
          workerIds: rec.workerIds,
          enabledAt: rec.enabledAt,
          pendingInbox: 0,
        };
      } catch (err) {
        return handleStoreError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/orchestration/sessions/:id/disable",
    {
      schema: {
        description:
          "Remove supervisor mode. Detaches every linked worker (they survive " +
          "as standalone sessions), clears the supervisor's inbox, AND " +
          "rebuilds the supervisor's live agent session in-place so the " +
          "orchestrate_* tools disappear immediately. Same rebuild rationale " +
          "as /enable — the SDK's tool list is fixed at agent-session " +
          "creation time, so the tools would otherwise linger until the " +
          "session was reloaded.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          403: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      await disableSupervisor(req.params.id);
      await clearInbox(req.params.id);
      try {
        await rebuildAgentSessionForTools(req.params.id);
      } catch (err) {
        req.log.warn(
          { err, sessionId: req.params.id },
          "orchestration disable: rebuild failed (non-fatal — next resume drops the tools)",
        );
      }
      return reply.code(204).send();
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/orchestration/sessions/:id/workers",
    {
      schema: {
        description:
          "Return the worker list for a supervisor with live state (streaming/" +
          "idle/cold) and metadata. The UI renders this as the supervisor's " +
          "Workers side panel.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["workers"],
            properties: { workers: { type: "array", items: workerSummarySchema } },
          },
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      if (!(await isSupervisor(req.params.id))) {
        return reply.code(404).send({ error: "not_a_supervisor" });
      }
      const ids = await getWorkerIds(req.params.id);
      const workers = await Promise.all(
        ids.map(async (workerId) => {
          const rec = await getWorkerRecord(workerId);
          const live = getSession(workerId);
          const base: Record<string, unknown> = { workerId, isLive: live !== undefined };
          if (rec !== undefined) {
            base.spawnedAt = rec.spawnedAt;
            if (rec.spawnedFrom !== undefined) base.spawnedFrom = rec.spawnedFrom;
          }
          if (live !== undefined) {
            base.isStreaming = live.session.isStreaming;
            base.state = live.session.isStreaming ? "streaming" : "idle";
            base.name = live.session.sessionName ?? undefined;
            base.messageCount = live.session.messages.length;
            base.lastActivityAt = live.lastActivityAt.toISOString();
            base.projectId = live.projectId;
          } else {
            base.state = "cold";
            const projectId = await findProjectIdForSession(workerId);
            if (projectId !== undefined) base.projectId = projectId;
          }
          return base;
        }),
      );
      return { workers };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/orchestration/sessions/:id/inbox",
    {
      schema: {
        description:
          "Return the supervisor's inbox history — every event the bridge " +
          "captured (delivered + pending), newest first. Capped at 200 items " +
          "per supervisor via FIFO eviction.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["items"],
            properties: { items: { type: "array", items: inboxItemSchema } },
          },
          403: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      const items = await readAllInbox(req.params.id);
      return { items };
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/orchestration/sessions/:id/inbox/clear",
    {
      schema: {
        description: "Wipe the supervisor's inbox (history + pending).",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          403: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      await clearInbox(req.params.id);
      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { id: string; wid: string } }>(
    "/orchestration/sessions/:id/workers/:wid/detach",
    {
      schema: {
        description:
          "UI control: drop the supervisor→worker link without killing the " +
          "worker. The worker continues running as a standalone session. " +
          "Refuses if the worker isn't linked to this supervisor.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id", "wid"],
          properties: { id: { type: "string" }, wid: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      const rec = await getWorkerRecord(req.params.wid);
      if (rec === undefined || rec.supervisorId !== req.params.id) {
        return reply.code(404).send({ error: "worker_not_linked" });
      }
      await unregisterWorker(req.params.wid);
      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { id: string; wid: string } }>(
    "/orchestration/sessions/:id/workers/:wid/kill",
    {
      schema: {
        description:
          "UI control: dispose the worker session, move its transcript into " +
          "the 7-day archive so it disappears from the live session list, " +
          "and unregister it from this supervisor.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id", "wid"],
          properties: { id: { type: "string" }, wid: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["wasLive"],
            properties: {
              wasLive: { type: "boolean" },
              archiveStatus: { type: "string", enum: ["archived", "not_found"] },
            },
          },
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      const rec = await getWorkerRecord(req.params.wid);
      if (rec === undefined || rec.supervisorId !== req.params.id) {
        return reply.code(404).send({ error: "worker_not_linked" });
      }
      return killWorkerAndArchive({ supervisorId: req.params.id, workerId: req.params.wid });
    },
  );

  // Used by the UI "Resume worker" button when the worker is cold.
  // No body — just a hint to the registry to load the session from
  // disk so subsequent UI calls (read transcript, send message) hit
  // a live session.
  fastify.post<{ Params: { id: string; wid: string } }>(
    "/orchestration/sessions/:id/workers/:wid/resume",
    {
      schema: {
        description:
          "Force-resume a cold worker into the live registry. Idempotent on " +
          "already-live workers.",
        tags: ["orchestration"],
        params: {
          type: "object",
          required: ["id", "wid"],
          properties: { id: { type: "string" }, wid: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["resumed"],
            properties: { resumed: { type: "boolean" } },
          },
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const g = gate(reply);
      if (g !== undefined) return g;
      const rec = await getWorkerRecord(req.params.wid);
      if (rec === undefined || rec.supervisorId !== req.params.id) {
        return reply.code(404).send({ error: "worker_not_linked" });
      }
      const existing = getSession(req.params.wid);
      if (existing !== undefined) return { resumed: false };
      try {
        await resumeSessionById(req.params.wid);
      } catch (err) {
        req.log.warn({ err, workerId: req.params.wid }, "resume worker failed");
        return reply.code(404).send({ error: "resume_failed" });
      }
      return { resumed: true };
    },
  );
};

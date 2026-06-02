import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { getProject, readProjects } from "../project-manager.js";
import {
  createSession,
  deleteColdSession,
  disposeSession,
  ExternalSubagentActiveError,
  findProjectIdForSession,
  findSessionLocation,
  getSession,
  listSessionsForProject,
  rejectOrDisposeExternallyActiveSession,
  resumeSessionById,
  type UnifiedSession,
} from "../session-registry.js";
import { bridgeSessionDeleted } from "../webhooks/event-bridge.js";
import { isSupervisor, getWorkerRecord } from "../orchestration/store.js";
import {
  cleanupWorkersForDeletedSupervisor,
  killWorkerAndArchive,
} from "../orchestration/worker-lifecycle.js";
import { errorSchema, liveSummaryBody, liveSummarySchema } from "./_schemas.js";
import { buildTurnDiff } from "../turn-diff-builder.js";
import { buildCompactionHistory } from "../compaction-history.js";
import {
  getExternalSubagentStatusForSession,
  readSessionMessagesFromDisk,
} from "../subagents-external.js";

const unifiedSchema = {
  type: "object",
  required: [
    "sessionId",
    "projectId",
    "isLive",
    "workspacePath",
    "lastActivityAt",
    "createdAt",
    "messageCount",
    "firstMessage",
  ],
  properties: {
    sessionId: { type: "string" },
    projectId: { type: "string" },
    isLive: { type: "boolean" },
    name: { type: "string" },
    workspacePath: { type: "string" },
    lastActivityAt: { type: "string", format: "date-time" },
    createdAt: { type: "string", format: "date-time" },
    messageCount: { type: "integer", minimum: 0 },
    firstMessage: { type: "string" },
    /**
     * Set when this row is nested under another session (pi-subagents child
     * or orchestration worker). Drives the sidebar's parent-row chevron
     * grouping.
     */
    parentSessionId: { type: "string" },
    /** pi-subagents run id when this is a child session. */
    runId: { type: "string" },
    isExternalLive: { type: "boolean" },
    externalState: { type: "string", enum: ["queued", "running", "complete", "failed", "paused"] },
    /**
     * Absolute disk path to the session JSONL — used by the
     * SubagentResultCard to resolve a result's `sessionFile` reference
     * back to the canonical sessionId (since pi-subagents writes
     * children as a literal `session.jsonl` filename, not `<uuid>.jsonl`).
     */
    path: { type: "string" },
  },
} as const;

function unifiedFromUnified(u: UnifiedSession): Record<string, unknown> {
  // Fastify's response serializer drops `undefined`-valued keys, but emit a
  // stable shape: convert dates to ISO strings + only include optional
  // fields (`name`, sub-agent linkage) when set.
  const out: Record<string, unknown> = {
    sessionId: u.sessionId,
    projectId: u.projectId,
    isLive: u.isLive,
    workspacePath: u.workspacePath,
    lastActivityAt: u.lastActivityAt.toISOString(),
    createdAt: u.createdAt.toISOString(),
    messageCount: u.messageCount,
    firstMessage: u.firstMessage,
  };
  if (u.name !== undefined) out.name = u.name;
  if (u.parentSessionId !== undefined) out.parentSessionId = u.parentSessionId;
  if (u.runId !== undefined) out.runId = u.runId;
  if (u.path !== undefined) out.path = u.path;
  if (u.isExternalLive !== undefined) out.isExternalLive = u.isExternalLive;
  if (u.externalState !== undefined) out.externalState = u.externalState;
  return out;
}

/**
 * Truncated text preview of a message's content for the session
 * tree. Mirrors the SDK's `_extractUserMessageText` shape: strings
 * pass through; arrays of content blocks join the `text` parts.
 * Returns undefined when the content has no extractable text (e.g.
 * an image-only message), so the caller can omit the field.
 */
const PREVIEW_MAX_CHARS = 200;
function previewOfMessageContent(content: unknown): string | undefined {
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      const o = c as { type?: unknown; text?: unknown };
      if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
    }
    text = parts.join("\n");
  } else {
    return undefined;
  }
  text = text.trim();
  if (text.length === 0) return undefined;
  if (text.length <= PREVIEW_MAX_CHARS) return text;
  return text.slice(0, PREVIEW_MAX_CHARS - 1) + "…";
}

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "session_not_found" });
}

async function rejectExternalIfNeeded(
  sessionId: string,
  projectId: string,
  workspacePath: string,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    await rejectOrDisposeExternallyActiveSession(sessionId, projectId, workspacePath);
    return false;
  } catch (err) {
    if (!(err instanceof ExternalSubagentActiveError)) throw err;
    reply.code(409).send({
      error: "external_subagent_active",
      message: "This pi-subagents child is still running externally and is read-only in pi-forge.",
    });
    return true;
  }
}

export const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/sessions",
    {
      schema: {
        description:
          "List sessions for a project (live and on-disk merged, deduped by " +
          "id, sorted by recency). Without `projectId`, returns sessions from " +
          "every project the pi-forge knows about.",
        tags: ["sessions"],
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["sessions"],
            properties: {
              sessions: { type: "array", items: unifiedSchema },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const projectId = req.query.projectId;
      if (projectId !== undefined) {
        const project = await getProject(projectId);
        if (project === undefined) {
          return reply.code(404).send({ error: "project_not_found" });
        }
        const sessions = await listSessionsForProject(projectId, project.path);
        return { sessions: sessions.map(unifiedFromUnified) };
      }
      // Cross-project: fan out in parallel — each project's listing is
      // independent disk I/O. Use Promise.allSettled so one corrupt
      // project's session dir doesn't take down the whole sidebar; the
      // failure is logged and that project's sessions are skipped.
      const projects = await readProjects();
      const settled = await Promise.all(
        projects.map(async (p) => {
          try {
            return await listSessionsForProject(p.id, p.path);
          } catch (err) {
            req.log.warn(
              { err: err instanceof Error ? err.message : String(err), projectId: p.id },
              "listSessionsForProject failed; skipping project in cross-project listing",
            );
            return [] as UnifiedSession[];
          }
        }),
      );
      const all: UnifiedSession[] = settled.flat();
      all.sort((a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime());
      return { sessions: all.map(unifiedFromUnified) };
    },
  );

  fastify.post<{ Body: { projectId: string } }>(
    "/sessions",
    {
      schema: {
        description: "Create a new session in the given project.",
        tags: ["sessions"],
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: { projectId: { type: "string" } },
        },
        response: {
          201: liveSummarySchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const project = await getProject(req.body.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const live = await createSession(project.id, project.path);
      return reply.code(201).send(
        liveSummaryBody({
          sessionId: live.sessionId,
          projectId: live.projectId,
          workspacePath: live.workspacePath,
          createdAt: live.createdAt,
          lastActivityAt: live.lastActivityAt,
          name: live.session.sessionName,
          messageCount: live.session.messages.length,
          isStreaming: live.session.isStreaming,
          thinkingLevel: live.session.thinkingLevel,
          modelProvider: live.session.model?.provider,
          modelId: live.session.model?.id,
        }),
      );
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id",
    {
      schema: {
        description:
          "Get session metadata. Looks up live sessions first, falls back to " +
          "the on-disk index. Does not load the session into memory.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: liveSummarySchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live !== undefined) {
        try {
          await rejectOrDisposeExternallyActiveSession(
            req.params.id,
            live.projectId,
            live.workspacePath,
          );
        } catch (err) {
          if (!(err instanceof ExternalSubagentActiveError)) throw err;
          const loc = await findSessionLocation(req.params.id);
          if (loc === undefined) return notFound(reply);
          const list = await listSessionsForProject(loc.projectId, loc.workspacePath);
          const match = list.find((s) => s.sessionId === req.params.id);
          if (match === undefined) return notFound(reply);
          const external = await getExternalSubagentStatusForSession({
            runId: match.runId,
            path: match.path,
          });
          const bodyArgs: Parameters<typeof liveSummaryBody>[0] = {
            sessionId: match.sessionId,
            projectId: match.projectId,
            workspacePath: match.workspacePath,
            createdAt: match.createdAt,
            lastActivityAt: match.lastActivityAt,
            name: match.name,
            messageCount: match.messageCount,
            isStreaming: false,
            isLive: false,
          };
          if (external !== undefined) {
            bodyArgs.isExternalLive = external.isExternalLive;
            bodyArgs.externalState = external.state;
          }
          return liveSummaryBody(bodyArgs);
        }
        return liveSummaryBody({
          sessionId: live.sessionId,
          projectId: live.projectId,
          workspacePath: live.workspacePath,
          createdAt: live.createdAt,
          lastActivityAt: live.lastActivityAt,
          name: live.session.sessionName,
          messageCount: live.session.messages.length,
          isStreaming: live.session.isStreaming,
          thinkingLevel: live.session.thinkingLevel,
          modelProvider: live.session.model?.provider,
          modelId: live.session.model?.id,
        });
      }
      const loc = await findSessionLocation(req.params.id);
      if (loc === undefined) return notFound(reply);
      // On-disk only — pull metadata via the unified merge for this project.
      const list = await listSessionsForProject(loc.projectId, loc.workspacePath);
      const match = list.find((s) => s.sessionId === req.params.id);
      if (match === undefined) return notFound(reply);
      const external = await getExternalSubagentStatusForSession({
        runId: match.runId,
        path: match.path,
      });
      const bodyArgs: Parameters<typeof liveSummaryBody>[0] = {
        sessionId: match.sessionId,
        projectId: match.projectId,
        workspacePath: match.workspacePath,
        createdAt: match.createdAt,
        lastActivityAt: match.lastActivityAt,
        name: match.name,
        messageCount: match.messageCount,
        isStreaming: false,
        isLive: false,
      };
      if (external !== undefined) {
        bodyArgs.isExternalLive = external.isExternalLive;
        bodyArgs.externalState = external.state;
      }
      return liveSummaryBody(bodyArgs);
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/messages",
    {
      schema: {
        description:
          "Return the live session's full messages array — the same shape " +
          "the SSE stream sends in its `snapshot` event. Used by the chat " +
          "view to refresh after `agent_end` without reconnecting the SSE. " +
          "404 if the session isn't currently live in the registry.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["messages"],
            properties: {
              messages: {
                type: "array",
                items: { type: "object", additionalProperties: true },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live !== undefined) {
        try {
          await rejectOrDisposeExternallyActiveSession(
            req.params.id,
            live.projectId,
            live.workspacePath,
          );
          return { messages: live.session.messages };
        } catch (err) {
          if (!(err instanceof ExternalSubagentActiveError)) throw err;
        }
      }
      const loc = await findSessionLocation(req.params.id);
      if (loc === undefined) return notFound(reply);
      const list = await listSessionsForProject(loc.projectId, loc.workspacePath);
      const match = list.find((s) => s.sessionId === req.params.id);
      if (match?.path === undefined) return notFound(reply);
      const external = await getExternalSubagentStatusForSession({
        runId: match.runId,
        path: match.path,
      });
      if (external?.isExternalLive !== true) return notFound(reply);
      return { messages: readSessionMessagesFromDisk(match.path, loc.workspacePath) };
    },
  );

  // Compaction history. Returns the per-compaction archive that the SDK
  // strips out of `live.session.messages` after each compact() call, so
  // the chat view can render a "compacted N messages → Y tokens" card
  // at each compaction point with the archived messages one click away.
  // Server-side derivation keeps the entry-id arithmetic out of the
  // client. See packages/server/src/compaction-history.ts for the
  // shape contract.
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/compactions",
    {
      schema: {
        description:
          "Per-compaction archive for the live session. Each entry " +
          "carries the SDK-generated summary, the pre-compaction " +
          "token count, and the AgentMessage[] that was archived (no " +
          "longer in the LLM's context window). `insertBeforeIndex` " +
          "tells the client where to splice a card into the post-" +
          "compaction `messages` array. 404 if the session isn't " +
          "currently live.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["compactions"],
            properties: {
              compactions: {
                type: "array",
                items: {
                  type: "object",
                  required: [
                    "id",
                    "timestamp",
                    "summary",
                    "tokensBefore",
                    "insertBeforeIndex",
                    "archivedMessages",
                  ],
                  properties: {
                    id: { type: "string" },
                    timestamp: { type: "string" },
                    summary: { type: "string" },
                    tokensBefore: { type: "integer", minimum: 0 },
                    insertBeforeIndex: { type: "integer", minimum: 0 },
                    archivedMessages: {
                      type: "array",
                      items: { type: "object", additionalProperties: true },
                    },
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
      if (live === undefined) return notFound(reply);
      if (await rejectExternalIfNeeded(req.params.id, live.projectId, live.workspacePath, reply)) {
        return reply;
      }
      return { compactions: buildCompactionHistory(live.session) };
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/turn-diff",
    {
      schema: {
        description:
          "Aggregate every write/edit tool result from the session's most " +
          "recent turn into one reviewable changeset. Returns " +
          "`{ entries: [{ file, tool, diff, additions, deletions, isPureAddition }] }`. " +
          "Prefers the tool result's turn-scoped diff; falls back to " +
          "`git diff HEAD -- <path>` and then a pure-addition diff when " +
          "needed. 404 if the session isn't currently live.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["entries"],
            properties: {
              entries: {
                type: "array",
                items: {
                  type: "object",
                  required: ["file", "tool", "diff", "additions", "deletions", "isPureAddition"],
                  properties: {
                    file: { type: "string" },
                    tool: { type: "string", enum: ["write", "edit"] },
                    diff: { type: "string" },
                    additions: { type: "integer", minimum: 0 },
                    deletions: { type: "integer", minimum: 0 },
                    isPureAddition: { type: "boolean" },
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
      if (live === undefined) return notFound(reply);
      if (await rejectExternalIfNeeded(req.params.id, live.projectId, live.workspacePath, reply)) {
        return reply;
      }
      const entries = await buildTurnDiff(
        live.session,
        live.workspacePath,
        live.lastAgentStartIndex,
      );
      return { entries };
    },
  );

  // Phase 15 — session tree. Returns the full branching history of a
  // session so the client can render a SessionTreePanel and let the
  // user navigate or fork from any prior entry. Cold sessions get
  // lazy-resumed via resumeSessionById so the SDK can read the JSONL
  // and build the tree in memory.
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/tree",
    {
      schema: {
        description:
          "Branching history of the session. Returns every entry on the " +
          "tree (across all branches) plus the current leaf id and the " +
          "set of entry ids on the active branch path. Message entries " +
          "include a truncated `preview` (first 200 chars of the text " +
          "content); other entry types carry just the type + timestamp. " +
          "Lazy-resumes cold sessions on demand so the route works " +
          "without a prior SSE connect.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["leafId", "branchIds", "entries"],
            properties: {
              leafId: { type: ["string", "null"] },
              branchIds: { type: "array", items: { type: "string" } },
              entries: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "parentId", "type", "timestamp"],
                  properties: {
                    id: { type: "string" },
                    parentId: { type: ["string", "null"] },
                    type: { type: "string" },
                    timestamp: { type: "string" },
                    role: { type: "string" },
                    preview: { type: "string" },
                    label: { type: "string" },
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
      let live = getSession(req.params.id);
      if (live !== undefined) {
        if (
          await rejectExternalIfNeeded(req.params.id, live.projectId, live.workspacePath, reply)
        ) {
          return reply;
        }
      }
      if (live === undefined) {
        try {
          live = await resumeSessionById(req.params.id);
        } catch {
          // SessionNotFoundError, SessionTombstonedError, or SDK
          // resume failure all collapse to 404 here — the tree route
          // doesn't need to distinguish (clients can't act on it
          // differently). The SSE stream route DOES distinguish
          // (it returns 410 on tombstone) since that signals "stop
          // reconnecting" specifically.
          return notFound(reply);
        }
      }
      const sm = live.session.sessionManager;
      const all = sm.getEntries();
      const leafId = sm.getLeafId();
      // The "active branch path" — every entry from the leaf back to
      // the root. Used by the client to dim off-path nodes.
      const branchIds = sm.getBranch().map((e) => e.id);
      const entries = all.map((e) => {
        const out: Record<string, unknown> = {
          id: e.id,
          parentId: e.parentId,
          type: e.type,
          timestamp: e.timestamp,
        };
        const label = sm.getLabel(e.id);
        if (label !== undefined) out.label = label;
        if (e.type === "message") {
          // BashExecutionMessage and CustomMessage variants share
          // `role` but differ on the content field — narrow via a
          // generic record-shape probe so we don't have to import
          // the union and discriminate. Bash entries fall through
          // with no preview, which is the right outcome (they're a
          // tool invocation, not user-authored prose).
          const m = e.message as { role?: unknown; content?: unknown };
          if (typeof m.role === "string") out.role = m.role;
          const preview = previewOfMessageContent(m.content);
          if (preview !== undefined) out.preview = preview;
        }
        return out;
      });
      return { leafId, branchIds, entries };
    },
  );

  // Phase 16 — Context & Token Inspector. Returns the messages the
  // agent will send to the LLM, plus a per-turn token + cost
  // breakdown derived from each AssistantMessage.usage. The SDK
  // already populates .usage on every assistant message; we just
  // aggregate. Cold sessions lazy-resume so the route works without
  // a prior SSE connect.
  fastify.get<{ Params: { id: string } }>(
    "/sessions/:id/context",
    {
      schema: {
        description:
          "Token + message inspector for a session. Returns the full " +
          "AgentMessage[] (the LLM's view, post-compaction), aggregate " +
          "token + cost totals, a per-turn breakdown derived from each " +
          "AssistantMessage.usage, and the SDK's contextUsage (current " +
          "context window utilization). Lazy-resumes cold sessions so " +
          "the route works without a prior SSE connect.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: [
              "messages",
              "totalInputTokens",
              "totalOutputTokens",
              "totalCacheReadTokens",
              "totalCacheWriteTokens",
              "totalTokens",
              "totalCost",
              "turns",
              "contextUsage",
            ],
            properties: {
              messages: { type: "array", items: { type: "object", additionalProperties: true } },
              totalInputTokens: { type: "integer", minimum: 0 },
              totalOutputTokens: { type: "integer", minimum: 0 },
              totalCacheReadTokens: { type: "integer", minimum: 0 },
              totalCacheWriteTokens: { type: "integer", minimum: 0 },
              totalTokens: { type: "integer", minimum: 0 },
              totalCost: { type: "number", minimum: 0 },
              turns: {
                type: "array",
                items: {
                  type: "object",
                  required: [
                    "index",
                    "inputTokens",
                    "outputTokens",
                    "cacheReadTokens",
                    "cacheWriteTokens",
                    "totalTokens",
                    "cost",
                    "model",
                    "provider",
                    "timestamp",
                  ],
                  properties: {
                    index: { type: "integer", minimum: 0 },
                    inputTokens: { type: "integer", minimum: 0 },
                    outputTokens: { type: "integer", minimum: 0 },
                    cacheReadTokens: { type: "integer", minimum: 0 },
                    cacheWriteTokens: { type: "integer", minimum: 0 },
                    totalTokens: { type: "integer", minimum: 0 },
                    cost: { type: "number", minimum: 0 },
                    model: { type: "string" },
                    provider: { type: "string" },
                    timestamp: { type: "integer", minimum: 0 },
                    stopReason: { type: "string" },
                  },
                },
              },
              contextUsage: {
                type: "object",
                required: ["contextWindow"],
                properties: {
                  // tokens / percent are nullable per the SDK
                  // (unknown right after compaction, before next LLM
                  // response). JSONSchema 7 doesn't have a clean
                  // nullable; using `["integer","null"]` would block
                  // Fastify's serializer, so we omit them entirely
                  // when null and document the absence here.
                  tokens: { type: "integer", minimum: 0 },
                  percent: { type: "number", minimum: 0 },
                  contextWindow: { type: "integer", minimum: 0 },
                },
              },
            },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      let live = getSession(req.params.id);
      if (live !== undefined) {
        if (
          await rejectExternalIfNeeded(req.params.id, live.projectId, live.workspacePath, reply)
        ) {
          return reply;
        }
      }
      if (live === undefined) {
        try {
          live = await resumeSessionById(req.params.id);
        } catch {
          // Same handling as the /tree route above — collapse all
          // resume failures (not_found, tombstoned, SDK throw) to a
          // 404. The /context route's caller can't act on the
          // distinction.
          return notFound(reply);
        }
      }
      const messages = live.session.messages;
      const turns: Record<string, unknown>[] = [];
      let totalInput = 0;
      let totalOutput = 0;
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalCost = 0;
      messages.forEach((m, index) => {
        // Probe the union via record-shape rather than discriminating
        // the AgentMessage union here — keeps the route decoupled from
        // SDK type internals (same approach used in /tree).
        const obj = m as { role?: unknown; usage?: unknown };
        if (obj.role !== "assistant") return;
        const u = obj.usage as
          | {
              input?: unknown;
              output?: unknown;
              cacheRead?: unknown;
              cacheWrite?: unknown;
              totalTokens?: unknown;
              cost?: { total?: unknown };
            }
          | undefined;
        if (u === undefined) return;
        const inputT = typeof u.input === "number" ? u.input : 0;
        const outputT = typeof u.output === "number" ? u.output : 0;
        const cacheR = typeof u.cacheRead === "number" ? u.cacheRead : 0;
        const cacheW = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
        const totalT =
          typeof u.totalTokens === "number" ? u.totalTokens : inputT + outputT + cacheR + cacheW;
        const cost = typeof u.cost?.total === "number" ? u.cost.total : 0;
        const am = m as {
          provider?: unknown;
          model?: unknown;
          timestamp?: unknown;
          stopReason?: unknown;
        };
        const turn: Record<string, unknown> = {
          index,
          inputTokens: inputT,
          outputTokens: outputT,
          cacheReadTokens: cacheR,
          cacheWriteTokens: cacheW,
          totalTokens: totalT,
          cost,
          model: typeof am.model === "string" ? am.model : "unknown",
          provider: typeof am.provider === "string" ? am.provider : "unknown",
          timestamp: typeof am.timestamp === "number" ? am.timestamp : 0,
        };
        if (typeof am.stopReason === "string") turn.stopReason = am.stopReason;
        turns.push(turn);
        totalInput += inputT;
        totalOutput += outputT;
        totalCacheRead += cacheR;
        totalCacheWrite += cacheW;
        totalCost += cost;
      });
      const totalTokens = totalInput + totalOutput + totalCacheRead + totalCacheWrite;
      const cu = live.session.getContextUsage();
      const contextUsage: Record<string, unknown> = {
        // contextWindow is the only required field. Fall back to 0
        // when SDK reports undefined; client renders an "unknown"
        // state at the cap.
        contextWindow:
          cu !== undefined && typeof cu.contextWindow === "number" ? cu.contextWindow : 0,
      };
      if (cu !== undefined && cu.tokens !== null) contextUsage.tokens = cu.tokens;
      if (cu !== undefined && cu.percent !== null) contextUsage.percent = cu.percent;
      return {
        messages,
        totalInputTokens: totalInput,
        totalOutputTokens: totalOutput,
        totalCacheReadTokens: totalCacheRead,
        totalCacheWriteTokens: totalCacheWrite,
        totalTokens,
        totalCost,
        turns,
        contextUsage,
      };
    },
  );

  fastify.post<{ Params: { id: string }; Body: { name: string } }>(
    "/sessions/:id/name",
    {
      schema: {
        description:
          "Rename the session. Calls the SDK's `setSessionName` which appends " +
          "a `session_info` entry to the JSONL. The new name is the user-visible " +
          "title in the sidebar; the empty string clears any prior name. Session " +
          "must be live; open the SSE stream first to auto-resume from disk.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string", maxLength: 200 } },
        },
        response: {
          200: liveSummarySchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      if (await rejectExternalIfNeeded(req.params.id, live.projectId, live.workspacePath, reply)) {
        return reply;
      }
      live.session.setSessionName(req.body.name);
      return liveSummaryBody({
        sessionId: live.sessionId,
        projectId: live.projectId,
        workspacePath: live.workspacePath,
        createdAt: live.createdAt,
        lastActivityAt: live.lastActivityAt,
        name: live.session.sessionName,
        messageCount: live.session.messages.length,
        isStreaming: live.session.isStreaming,
        thinkingLevel: live.session.thinkingLevel,
        modelProvider: live.session.model?.provider,
        modelId: live.session.model?.id,
      });
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/sessions/:id",
    {
      schema: {
        description:
          "Dispose the live session and archive the on-disk JSONL (plus " +
          "any pi-subagents child JSONLs nested under it) for 7 days. The " +
          "session disappears from the sidebar immediately, but the files are " +
          "kept in the server-side archive until cleanup purges them.\n" +
          "  - live → dispose AND archive the JSONL → 204\n" +
          "  - cold → archive the JSONL → 204\n" +
          "  - not found anywhere → 404\n" +
          "There is intentionally no browser UI for immediate permanent " +
          "delete; cleanup removes archived sessions after the retention window.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      // Capture projectId BEFORE the dispose/delete tears down the
      // session — both `getSession` and the on-disk lookup go away
      // mid-flow. Used for the session_deleted webhook payload.
      const projectIdForWebhook = await findProjectIdForSession(req.params.id);
      const workerRecord = await getWorkerRecord(req.params.id);
      if (workerRecord !== undefined) {
        try {
          const result = await killWorkerAndArchive({
            supervisorId: workerRecord.supervisorId,
            workerId: req.params.id,
          });
          bridgeSessionDeleted({
            sessionId: req.params.id,
            ...(projectIdForWebhook !== undefined ? { projectId: projectIdForWebhook } : {}),
            wasLive: result.wasLive,
          });
          return reply.code(204).send();
        } catch (err) {
          req.log.error({ err }, "killWorkerAndArchive failed during session delete");
          return reply.code(500).send({ error: "session_delete_failed" });
        }
      }

      if (await isSupervisor(req.params.id)) {
        try {
          await cleanupWorkersForDeletedSupervisor(req.params.id);
        } catch (err) {
          req.log.error({ err }, "cleanupWorkersForDeletedSupervisor failed during session delete");
          return reply.code(500).send({ error: "session_delete_failed" });
        }
      }

      const wasLive = await disposeSession(req.params.id);
      // Always soft-delete: dispose (above) + move JSONL into the 7-day
      // archive (below). After dispose, the registry no longer has the entry;
      // deleteColdSession's "live" guard doesn't trip on the ordinary case.
      let r: "deleted" | "live" | "not_found";
      try {
        r = await deleteColdSession(req.params.id);
      } catch (err) {
        // Real fs failure (permissions, IO) — distinguish from
        // not_found so the operator sees a 500 not a misleading 404.
        req.log.error({ err }, "deleteColdSession failed");
        return reply.code(500).send({ error: "session_delete_failed" });
      }
      if (r === "deleted") {
        bridgeSessionDeleted({
          sessionId: req.params.id,
          ...(projectIdForWebhook !== undefined ? { projectId: projectIdForWebhook } : {}),
          wasLive,
        });
        return reply.code(204).send();
      }
      if (r === "live") {
        // Race: another client resumed the session between our
        // dispose and the cold-delete file lookup. The user asked
        // to delete/archive it; honor that by retrying once.
        // (As of the tombstone fix in session-registry, this path is
        // very rare — disposeSession sets a 1.5s no-revive window
        // that resumeSession enforces. The retry stays as defense
        // in depth for any non-SSE revival path.)
        const live2 = await disposeSession(req.params.id);
        if (live2) {
          try {
            const r2 = await deleteColdSession(req.params.id);
            if (r2 === "deleted" || r2 === "not_found") {
              bridgeSessionDeleted({
                sessionId: req.params.id,
                ...(projectIdForWebhook !== undefined ? { projectId: projectIdForWebhook } : {}),
                wasLive: true,
              });
              return reply.code(204).send();
            }
          } catch (err) {
            req.log.error({ err }, "deleteColdSession failed on retry");
            return reply.code(500).send({ error: "session_delete_failed" });
          }
        }
        // Couldn't reach a steady state — the resumer keeps winning.
        // Single-tenant + this race is extremely rare; surface as 500
        // rather than silently lying about the outcome.
        return reply.code(500).send({ error: "session_delete_failed" });
      }
      // r === "not_found"
      if (wasLive) {
        // Dispose succeeded but no JSONL on disk — the live session
        // had no persisted entries (nothing was written). Treat as
        // success; the live state IS gone. Still fire the webhook
        // since "session went away" is the user-visible outcome.
        bridgeSessionDeleted({
          sessionId: req.params.id,
          ...(projectIdForWebhook !== undefined ? { projectId: projectIdForWebhook } : {}),
          wasLive: true,
        });
        return reply.code(204).send();
      }
      return notFound(reply);
    },
  );
};

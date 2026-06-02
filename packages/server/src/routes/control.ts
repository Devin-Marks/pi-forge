import type { FastifyPluginAsync, FastifyReply } from "fastify";
import {
  EntryNotFoundError,
  forkSession,
  getSession,
  SessionNotFoundError,
} from "../session-registry.js";
import {
  liveModelRegistry,
  readSettings,
  withSettingsLock,
  writeSettings,
} from "../config-manager.js";
import { config } from "../config.js";
import { expandFileReferences } from "../file-references.js";
import { bridgeWorkerExecutionStopped } from "../orchestration/event-bridge.js";
import { errorSchema, liveSummaryBody, liveSummarySchema } from "./_schemas.js";

/**
 * Wrap a Promise in a timeout. The SDK's compact / navigateTree calls
 * await an LLM round-trip; without a timeout, a hung provider holds
 * the HTTP request open indefinitely with no client cancellation path
 * (the chat input shows "Compacting…" forever). We surface 504 on
 * timeout so the client can recover by reload.
 *
 * Note: this does NOT abort the underlying SDK call — that needs an
 * AbortSignal threaded through, which the current SDK API doesn't
 * fully expose. The in-flight LLM call will eventually resolve or
 * reject server-side; the route just returns to the client first.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TimeoutError";
  }
}

const COMPACT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const NAVIGATE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (with summarize)

function notFound(reply: FastifyReply): FastifyReply {
  return reply.code(404).send({ error: "session_not_found" });
}

/**
 * Map SDK throws — which are plain `Error` with English messages — to stable
 * error codes the API contract documents. The SDK has no typed error classes
 * for these cases, so message-substring matching is the best we can do; if
 * any message ever changes the route falls back to a generic 500 with no
 * SDK string in the body.
 */
function mapSdkError(reply: FastifyReply, err: unknown): FastifyReply {
  if (!(err instanceof Error)) {
    reply.log.error({ err }, "unexpected non-Error throw");
    return reply.code(500).send({ error: "internal_error" });
  }
  const m = err.message;
  if (/entry .* not found/i.test(m)) {
    return reply.code(400).send({ error: "entry_not_found" });
  }
  if (/already compacted/i.test(m)) {
    return reply.code(400).send({ error: "already_compacted" });
  }
  if (/nothing to compact/i.test(m)) {
    return reply.code(400).send({ error: "nothing_to_compact" });
  }
  if (/no model/i.test(m)) {
    return reply.code(400).send({ error: "no_model_configured" });
  }
  if (/no api key found/i.test(m)) {
    return reply.code(400).send({ error: "no_api_key" });
  }
  // SDK 0.75.x replaces the old "No API key found" wording on a
  // session with no auth/model configured with "No API provider
  // registered for api: <name>" (thrown out of the provider
  // registry, not the auth layer). Semantically the same operator-
  // facing problem — "you haven't set up an LLM provider" — so
  // map to the same typed code.
  if (/no api provider registered/i.test(m)) {
    return reply.code(400).send({ error: "no_api_key" });
  }
  if (/compaction cancelled/i.test(m)) {
    // User-driven abort during compact — not an internal error. The route
    // itself returned 200/202 successfully; this catch path is for the
    // cancellation propagating up from session.compact().
    return reply.code(409).send({ error: "compaction_cancelled" });
  }
  reply.log.error({ err: m }, "unmapped SDK error");
  return reply.code(500).send({ error: "internal_error" });
}

export const controlRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{
    Params: { id: string };
    Body: { text: string; mode?: "steer" | "followUp" };
  }>(
    "/sessions/:id/steer",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.promptMax,
          timeWindow: config.rateLimits.promptWindowMs,
        },
      },
      schema: {
        description:
          'Queue a message for an in-progress agent run. `mode: "steer"` ' +
          "(default) interrupts the current turn after its tool calls finish; " +
          '`mode: "followUp"` waits for the agent to go fully idle. The SDK ' +
          "queues regardless of streaming state — a steer/followUp on an idle " +
          "session sits on the queue and is delivered when the next prompt runs.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["text"],
          additionalProperties: false,
          properties: {
            text: { type: "string", minLength: 1 },
            mode: { type: "string", enum: ["steer", "followUp"] },
          },
        },
        response: {
          202: {
            type: "object",
            required: ["accepted"],
            properties: { accepted: { type: "boolean", const: true } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      const mode = req.body.mode ?? "steer";
      // Same `@<path>` expansion as the prompt route — steer/followUp
      // text is conversationally identical to a fresh prompt; the user
      // expects file references to work in both places.
      const text = await expandFileReferences(req.body.text, live.workspacePath);
      // Fire-and-forget: steer/followUp resolve when the message is delivered,
      // which can be many seconds out. The route returns immediately.
      const target = mode === "followUp" ? live.session.followUp(text) : live.session.steer(text);
      target.catch((err: unknown) => {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err), sessionId: req.params.id, mode },
          "session.steer/followUp rejected",
        );
      });
      return reply.code(202).send({ accepted: true });
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/sessions/:id/abort",
    {
      schema: {
        description:
          "Abort the agent's current operation and wait for it to become " +
          "idle. Idempotent on already-idle sessions (resolves immediately). " +
          "Session must be live; open the SSE stream first to auto-resume " +
          "from disk if it isn't.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      await live.session.abort();
      await bridgeWorkerExecutionStopped(req.params.id, { wasLive: true, reason: "aborted" });
      return reply.code(204).send();
    },
  );

  fastify.post<{ Params: { id: string }; Body: { entryId: string } }>(
    "/sessions/:id/fork",
    {
      schema: {
        description:
          "Create a new session from an entry on the current session's " +
          "tree. Writes a new .jsonl file containing the path-to-leaf and " +
          "registers it as a fresh live session in the same project. The " +
          "source session is left live and untouched.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["entryId"],
          additionalProperties: false,
          properties: { entryId: { type: "string" } },
        },
        response: {
          201: liveSummarySchema,
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      try {
        const forked = await forkSession(req.params.id, req.body.entryId);
        return reply.code(201).send(
          liveSummaryBody({
            sessionId: forked.sessionId,
            projectId: forked.projectId,
            workspacePath: forked.workspacePath,
            createdAt: forked.createdAt,
            lastActivityAt: forked.lastActivityAt,
            name: forked.session.sessionName,
            thinkingLevel: forked.session.thinkingLevel,
            modelProvider: forked.session.model?.provider,
            modelId: forked.session.model?.id,
            messageCount: forked.session.messages.length,
            isStreaming: forked.session.isStreaming,
          }),
        );
      } catch (err) {
        if (err instanceof SessionNotFoundError) return notFound(reply);
        if (err instanceof EntryNotFoundError) {
          return reply.code(400).send({ error: "entry_not_found" });
        }
        if (err instanceof Error && err.message === "fork_failed") {
          return reply.code(400).send({ error: "fork_failed" });
        }
        return mapSdkError(reply, err);
      }
    },
  );

  fastify.post<{
    Params: { id: string };
    Body: {
      entryId: string;
      summarize?: boolean;
      customInstructions?: string;
      label?: string;
    };
  }>(
    "/sessions/:id/navigate",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.promptMax,
          timeWindow: config.rateLimits.promptWindowMs,
        },
      },
      schema: {
        description:
          "Navigate the session leaf to a different entry on its tree. " +
          "Operates IN-PLACE on the same session file (unlike fork which " +
          "creates a new file). Returns the navigation result; check " +
          "`cancelled` to detect user-driven aborts. Returns 400 if " +
          "`entryId` doesn't exist on the session's tree.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["entryId"],
          additionalProperties: false,
          properties: {
            entryId: { type: "string" },
            summarize: { type: "boolean" },
            customInstructions: { type: "string" },
            label: { type: "string" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["cancelled"],
            properties: {
              cancelled: { type: "boolean" },
              aborted: { type: "boolean" },
              editorText: { type: "string" },
            },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      const opts: Parameters<typeof live.session.navigateTree>[1] = {};
      if (req.body.summarize !== undefined) opts.summarize = req.body.summarize;
      if (req.body.customInstructions !== undefined)
        opts.customInstructions = req.body.customInstructions;
      if (req.body.label !== undefined) opts.label = req.body.label;
      try {
        const result = await withTimeout(
          live.session.navigateTree(req.body.entryId, opts),
          NAVIGATE_TIMEOUT_MS,
          "navigateTree",
        );
        const out: Record<string, unknown> = { cancelled: result.cancelled };
        if (result.aborted !== undefined) out.aborted = result.aborted;
        if (result.editorText !== undefined) out.editorText = result.editorText;
        return out;
      } catch (err) {
        if (err instanceof TimeoutError) {
          req.log.warn({ err, sessionId: req.params.id }, "navigateTree timed out");
          return reply.code(504).send({ error: "navigate_timeout", message: err.message });
        }
        return mapSdkError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { customInstructions?: string } }>(
    "/sessions/:id/compact",
    {
      config: {
        rateLimit: {
          max: config.rateLimits.promptMax,
          timeWindow: config.rateLimits.promptWindowMs,
        },
      },
      schema: {
        description:
          "Manually compact the session context. Aborts any in-flight " +
          "agent operation first. Returns 400 with a stable error code if " +
          "the session is too small to compact, has already been compacted, " +
          "or has no model configured.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: { customInstructions: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            properties: {
              summary: { type: "string" },
              tokensBefore: { type: "integer", minimum: 0 },
              tokensAfter: { type: "integer", minimum: 0 },
            },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      try {
        const result = await withTimeout(
          live.session.compact(req.body.customInstructions),
          COMPACT_TIMEOUT_MS,
          "compact",
        );
        // Build the response shape explicitly (rather than the prior
        // `result as unknown as Record<string, unknown>` cast). If the
        // SDK adds new fields to its compact result, Fastify's
        // serializer would otherwise strip them silently — and an
        // undefined `summary` would surface as the string "undefined"
        // in the chat banner. Defaulting + explicit cast keeps the
        // wire shape stable and the response-schema validation honest.
        const r = result as { summary?: unknown; tokensBefore?: unknown; tokensAfter?: unknown };
        return {
          summary: typeof r.summary === "string" ? r.summary : "",
          tokensBefore: typeof r.tokensBefore === "number" ? r.tokensBefore : 0,
          tokensAfter: typeof r.tokensAfter === "number" ? r.tokensAfter : 0,
        };
      } catch (err) {
        if (err instanceof TimeoutError) {
          req.log.warn({ err, sessionId: req.params.id }, "compact timed out");
          return reply.code(504).send({ error: "compact_timeout", message: err.message });
        }
        return mapSdkError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { provider: string; modelId: string } }>(
    "/sessions/:id/model",
    {
      schema: {
        description:
          "Set the active model for the session. Body: `{ provider, modelId }`. " +
          'Returns 400 with `error: "unknown_model"` if the provider/model isn\'t ' +
          'registered, or `error: "set_model_failed"` if no auth is configured.',
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["provider", "modelId"],
          additionalProperties: false,
          properties: {
            provider: { type: "string", minLength: 1 },
            modelId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["provider", "modelId"],
            properties: {
              provider: { type: "string" },
              modelId: { type: "string" },
            },
          },
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      // Look up the model in the SDK's ModelRegistry — it merges built-in
      // providers (Anthropic, OpenAI, Google, etc.) with anything defined in
      // models.json. The previous version called pi-ai's static `getModel`,
      // which knows only built-ins and returned undefined for every custom
      // models.json entry, surfacing as "unknown_model" even when the model
      // appeared in the picker.
      //
      // Two-stage lookup so a typo in the provider name produces a different
      // diagnostic from a typo in the model id. Without this, both cases
      // collapsed to `unknown_model` and the user had no hint which side
      // was wrong.
      const registry = liveModelRegistry();
      const providerKnown = registry.getAll().some((m) => m.provider === req.body.provider);
      if (!providerKnown) {
        return reply.code(400).send({ error: "unknown_provider" });
      }
      const model = registry.find(req.body.provider, req.body.modelId);
      if (model === undefined) {
        return reply.code(400).send({ error: "unknown_model" });
      }
      // The SDK's `session.setModel(...)` has a side effect that's
      // wrong for our use case: it calls
      // `settingsManager.setDefaultModelAndProvider(...)` AND
      // `setThinkingLevel(...)` which both write to
      // PI_CONFIG_DIR/settings.json — picking a model for one session
      // would otherwise mutate the global default for every NEW
      // session and every other client. Model choice is per-session
      // here, so we snapshot the ENTIRE settings.json before the
      // call and atomically replace it afterwards. A previous
      // version of this fix only restored defaultProvider/defaultModel,
      // which left SDK-injected defaultThinkingLevel behind and
      // visibly reset users' settings to a stub. The full-snapshot
      // approach undoes every side effect cleanly.
      //
      // The whole snapshot → setModel → restore sequence runs under
      // withSettingsLock so two concurrent setModel calls (rapid
      // session switching, or a setModel + a PUT /config/settings
      // overlapping) can't capture each other's mid-flight value as
      // "prior" and silently overwrite the user's manually-curated
      // global default. Without the lock, the failure is permanent
      // settings.json corruption that survives restarts.
      type SetModelResult =
        | { ok: true }
        | { ok: false; status: number; body: { error: string; message?: string } };
      const result = await withSettingsLock<SetModelResult>(async () => {
        let priorSettings: Awaited<ReturnType<typeof readSettings>> | undefined;
        try {
          priorSettings = await readSettings();
        } catch {
          // settings.json missing / unreadable — leave priorSettings
          // undefined so we don't try to restore a phantom snapshot.
        }
        try {
          // The live AgentSession was created with a ModelRegistry
          // snapshot of auth.json + models.json at session-create time;
          // the SDK never re-reads either file on its own. If the user
          // added a provider/key AFTER this session was created, the
          // SDK's `setModel` -> `_modelRegistry.hasConfiguredAuth(...)`
          // check would fail against the stale snapshot even though
          // our route-level `liveModelRegistry()` validation just
          // passed (it reads fresh each call).
          //
          // TWO reloads are needed, in this order: ModelRegistry's
          // `refresh()` re-reads models.json + resets API/OAuth
          // provider registrations, but does NOT touch AuthStorage —
          // the AuthStorage.data map (what `hasAuth(provider)` queries)
          // stays frozen at session-create time. Without the explicit
          // `authStorage.reload()`, refresh() alone closes only half
          // the staleness gap and `set_model_failed` still fires for
          // any provider whose key was added post-create.
          //
          // Both calls mutate in place, so every subsequent SDK use
          // inside this session (turn execution, per-request auth
          // lookup, model picker enumeration) also picks up the new
          // keys without restarting the session.
          live.session.modelRegistry.authStorage.reload();
          live.session.modelRegistry.refresh();
          // Wrap in withTimeout so a hung SDK setModel can't hold the
          // settings lock indefinitely. Without this, a single hung
          // setModel blocks every subsequent PUT /config/settings,
          // every other setModel, and every setSkillEnabled (they all
          // share withSettingsLock) until process restart. 30s is
          // plenty for an in-memory + disk write; longer means
          // something is wrong.
          await withTimeout(
            live.session.setModel(model as Parameters<typeof live.session.setModel>[0]),
            30_000,
            "setModel",
          );
        } catch (err) {
          if (err instanceof TimeoutError) {
            req.log.warn({ err, sessionId: req.params.id }, "setModel timed out");
            return {
              ok: false,
              status: 504,
              body: { error: "set_model_timeout", message: err.message },
            };
          }
          return {
            ok: false,
            status: 400,
            body: {
              error: "set_model_failed",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        // Best-effort restore. We don't fail the route on a settings
        // write error — the per-session model change already succeeded
        // and is the user-visible action; a stale default at worst
        // surfaces on the NEXT new session, which the per-session
        // override on each chat input then corrects. writeSettings
        // would re-acquire the lock; call atomicWriteJson via
        // writeSettings is fine because makeLock chains thenables on
        // the same chain — but to keep the critical section single
        // we inline the write here under our already-held lock.
        if (priorSettings !== undefined) {
          try {
            await writeSettings(priorSettings);
          } catch (err) {
            req.log.warn({ err }, "failed to restore prior settings after per-session setModel");
          }
        }
        return { ok: true };
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return { provider: req.body.provider, modelId: req.body.modelId };
    },
  );

  // Per-session thinking-level override. The SDK persists thinkingLevel as
  // first-class session state — it appends a thinkingLevel entry to the
  // JSONL and reconstructs the value on replay/resume — so this route is
  // a thin pass-through, no pi-forge-side storage.
  //
  // BUT setThinkingLevel has the same settings.json side effect as
  // setModel: it calls settingsManager.setDefaultThinkingLevel(...), which
  // would mutate the GLOBAL default on every per-session change. Same
  // snapshot-and-restore-under-lock pattern as setModel below — without
  // it, two users on the same instance switching thinking levels would
  // overwrite each other's "default for new sessions" repeatedly.
  fastify.post<{ Params: { id: string }; Body: { level: string } }>(
    "/sessions/:id/thinking-level",
    {
      schema: {
        description:
          "Set the active thinking level for the session. Body: `{ level }` " +
          "where level is one of pi's ModelThinkingLevel union " +
          '("off" | "minimal" | "low" | "medium" | "high" | "xhigh"). The ' +
          "SDK clamps to the current model's supported levels — picking a " +
          "level the model doesn't support is not an error, it just gets " +
          'downgraded. Returns `error: "set_thinking_level_failed"` on ' +
          "underlying SDK throw.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["level"],
          additionalProperties: false,
          properties: {
            level: {
              type: "string",
              enum: ["off", "minimal", "low", "medium", "high", "xhigh"],
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["level"],
            properties: { level: { type: "string" } },
          },
          400: errorSchema,
          404: errorSchema,
          504: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) return notFound(reply);
      type SetThinkingResult =
        | { ok: true; level: string }
        | { ok: false; status: number; body: { error: string; message?: string } };
      const result = await withSettingsLock<SetThinkingResult>(async () => {
        let priorSettings: Awaited<ReturnType<typeof readSettings>> | undefined;
        try {
          priorSettings = await readSettings();
        } catch {
          // settings.json missing / unreadable — leave priorSettings
          // undefined so we don't try to restore a phantom snapshot.
        }
        try {
          await withTimeout(
            Promise.resolve(
              live.session.setThinkingLevel(
                req.body.level as Parameters<typeof live.session.setThinkingLevel>[0],
              ),
            ),
            30_000,
            "setThinkingLevel",
          );
        } catch (err) {
          if (err instanceof TimeoutError) {
            req.log.warn({ err, sessionId: req.params.id }, "setThinkingLevel timed out");
            return {
              ok: false,
              status: 504,
              body: { error: "set_thinking_level_timeout", message: err.message },
            };
          }
          return {
            ok: false,
            status: 400,
            body: {
              error: "set_thinking_level_failed",
              message: err instanceof Error ? err.message : String(err),
            },
          };
        }
        if (priorSettings !== undefined) {
          try {
            await writeSettings(priorSettings);
          } catch (err) {
            req.log.warn(
              { err },
              "failed to restore prior settings after per-session setThinkingLevel",
            );
          }
        }
        // SDK clamps; surface the effective value so the client can
        // reflect any downgrade in the picker without a follow-up GET.
        return { ok: true, level: live.session.thinkingLevel };
      });
      if (!result.ok) return reply.code(result.status).send(result.body);
      return { level: result.level };
    },
  );
};

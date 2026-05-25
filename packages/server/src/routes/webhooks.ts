/**
 * REST surface for webhook configuration and delivery history.
 *
 * Routes (all under `/api/v1/`):
 *   GET    /webhooks                        — list (optional ?projectId= filter)
 *   POST   /webhooks                        — create
 *   PATCH  /webhooks/:id                    — update (partial)
 *   DELETE /webhooks/:id                    — remove (also prunes deliveries)
 *   POST   /webhooks/:id/test               — fire a synthetic `webhook.test` event
 *   GET    /webhooks/:id/deliveries         — recent delivery records (newest first)
 *
 * MINIMAL_UI gate: the mutation routes (POST / PATCH / DELETE /
 * test) refuse with 403 when `MINIMAL_UI=1`. Webhooks let the
 * server make arbitrary HTTPS calls to user-supplied URLs — under
 * MINIMAL_UI (locked-down deploys) only the operator should
 * configure that, via env or direct file edits. The GET routes
 * stay available so an admin can verify what's currently wired
 * up.
 */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { config } from "../config.js";
import { dispatch } from "../webhooks/dispatcher.js";
import {
  createWebhook,
  deleteWebhook,
  getWebhook,
  InvalidWebhookError,
  readDeliveriesForWebhook,
  readWebhooks,
  redactHeaders,
  updateWebhook,
  WebhookNotFoundError,
} from "../webhooks/store.js";
import { isWebhookEvent, WEBHOOK_EVENTS, type WebhookScope } from "../webhooks/types.js";
import { errorSchema } from "./_schemas.js";

const webhookEventsEnum = WEBHOOK_EVENTS as readonly string[] as string[];

const scopeSchema = {
  oneOf: [
    {
      type: "object",
      required: ["kind"],
      additionalProperties: false,
      properties: { kind: { const: "global" } },
    },
    {
      type: "object",
      required: ["kind", "projectId"],
      additionalProperties: false,
      properties: { kind: { const: "project" }, projectId: { type: "string", minLength: 1 } },
    },
  ],
} as const;

/**
 * Webhook config returned by the API. Secret is intentionally
 * REDACTED on the wire — the client doesn't need it, and
 * accidentally surfacing it in a logged response body would be
 * the kind of breach we wrote pi-forge to avoid. `hasSecret` is
 * the boolean presence map equivalent (same pattern as
 * `readAuthSummary` for provider keys).
 */
const webhookSchema = {
  type: "object",
  required: ["id", "name", "url", "events", "scope", "enabled", "hasSecret", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    url: { type: "string" },
    events: { type: "array", items: { type: "string", enum: webhookEventsEnum } },
    scope: scopeSchema,
    enabled: { type: "boolean" },
    hasSecret: { type: "boolean" },
    headers: { type: "object", additionalProperties: { type: "string" } },
    insecureTls: { type: "boolean" },
    createdAt: { type: "string" },
  },
} as const;

const deliverySchema = {
  type: "object",
  required: [
    "id",
    "webhookId",
    "deliveryId",
    "event",
    "attempt",
    "status",
    "durationMs",
    "requestedAt",
  ],
  properties: {
    id: { type: "string" },
    webhookId: { type: "string" },
    deliveryId: { type: "string" },
    event: { type: "string" },
    sessionId: { type: "string" },
    projectId: { type: "string" },
    attempt: { type: "integer" },
    status: { type: "string", enum: ["delivered", "failed", "error"] },
    statusCode: { type: "integer" },
    durationMs: { type: "integer" },
    errorPreview: { type: "string" },
    requestedAt: { type: "string" },
  },
} as const;

interface WireWebhook {
  id: string;
  name: string;
  url: string;
  events: string[];
  scope: WebhookScope;
  enabled: boolean;
  hasSecret: boolean;
  headers?: Record<string, string>;
  insecureTls?: boolean;
  createdAt: string;
}

function toWire(w: Awaited<ReturnType<typeof readWebhooks>>[number]): WireWebhook {
  const out: WireWebhook = {
    id: w.id,
    name: w.name,
    url: w.url,
    events: [...w.events],
    scope: w.scope,
    enabled: w.enabled,
    hasSecret: w.secret !== undefined && w.secret.length > 0,
    createdAt: w.createdAt,
  };
  // Header NAMES are returned so the UI can show "this webhook has
  // an Authorization header configured." VALUES are redacted to
  // the same `***REDACTED***` sentinel `config-manager.ts` uses
  // for inline `apiKey` in models.json — the wire never carries
  // the real header value, and an unchanged sentinel on the way
  // back through PATCH means "keep the existing value" (see
  // mergeHeadersOnWrite in store.ts).
  const redacted = redactHeaders(w.headers);
  if (redacted !== undefined) out.headers = redacted;
  if (w.insecureTls === true) out.insecureTls = true;
  return out;
}

function handleStoreError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof InvalidWebhookError) {
    return reply.code(400).send({ error: err.code, message: err.message });
  }
  if (err instanceof WebhookNotFoundError) {
    return reply.code(404).send({ error: err.code, message: err.message });
  }
  reply.log.error({ err }, "webhooks route error");
  return reply.code(500).send({ error: "internal_error" });
}

function minimalUiGate(reply: FastifyReply): FastifyReply | undefined {
  if (config.minimalUi) {
    return reply.code(403).send({
      error: "minimal_ui_disabled",
      message: "Webhook configuration is disabled under MINIMAL_UI.",
    });
  }
  return undefined;
}

export const webhookRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get<{ Querystring: { projectId?: string } }>(
    "/webhooks",
    {
      schema: {
        description:
          "List configured webhooks. Optional `?projectId=` filter returns only " +
          "global webhooks plus per-project webhooks scoped to that project (the " +
          "set that would actually fire for that project's sessions). Without the " +
          "filter, returns every webhook regardless of scope.",
        tags: ["webhooks"],
        querystring: {
          type: "object",
          properties: { projectId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["webhooks"],
            properties: { webhooks: { type: "array", items: webhookSchema } },
          },
        },
      },
    },
    async (req) => {
      const all = await readWebhooks();
      const filtered =
        req.query.projectId === undefined
          ? all
          : all.filter(
              (w) =>
                w.scope.kind === "global" ||
                (w.scope.kind === "project" && w.scope.projectId === req.query.projectId),
            );
      return { webhooks: filtered.map(toWire) };
    },
  );

  fastify.post<{
    Body: {
      name: string;
      url: string;
      events: string[];
      scope: WebhookScope;
      secret?: string;
      headers?: Record<string, string>;
      insecureTls?: boolean;
      enabled?: boolean;
    };
  }>(
    "/webhooks",
    {
      schema: {
        description:
          "Create a webhook. Validates HTTPS-only URL, non-empty event subscription, " +
          "and known event types. The created webhook's secret is stored on disk in " +
          "`webhooks.json` (mode 0600) and never returned on the wire.\n\n" +
          "Disabled under MINIMAL_UI (403 `minimal_ui_disabled`).",
        tags: ["webhooks"],
        body: {
          type: "object",
          required: ["name", "url", "events", "scope"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            url: { type: "string", minLength: 1 },
            events: {
              type: "array",
              minItems: 1,
              items: { type: "string", enum: webhookEventsEnum },
            },
            scope: scopeSchema,
            secret: { type: "string", maxLength: 256 },
            headers: { type: "object", additionalProperties: { type: "string" } },
            insecureTls: { type: "boolean" },
            enabled: { type: "boolean" },
          },
        },
        response: {
          201: webhookSchema,
          400: errorSchema,
          403: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const gate = minimalUiGate(reply);
      if (gate !== undefined) return gate;
      try {
        const w = await createWebhook({
          name: req.body.name,
          url: req.body.url,
          events: req.body.events.filter(isWebhookEvent),
          scope: req.body.scope,
          ...(req.body.secret !== undefined ? { secret: req.body.secret } : {}),
          ...(req.body.headers !== undefined ? { headers: req.body.headers } : {}),
          ...(req.body.insecureTls !== undefined ? { insecureTls: req.body.insecureTls } : {}),
          ...(req.body.enabled !== undefined ? { enabled: req.body.enabled } : {}),
        });
        return reply.code(201).send(toWire(w));
      } catch (err) {
        return handleStoreError(reply, err);
      }
    },
  );

  fastify.patch<{
    Params: { id: string };
    Body: {
      name?: string;
      url?: string;
      events?: string[];
      scope?: WebhookScope;
      secret?: string;
      headers?: Record<string, string>;
      insecureTls?: boolean;
      enabled?: boolean;
    };
  }>(
    "/webhooks/:id",
    {
      schema: {
        description:
          "Update a webhook. All fields are optional; omitted fields are left " +
          "untouched. For `secret`/`headers`, an empty value clears the field; " +
          "to leave them unchanged, omit them entirely.\n\nDisabled under MINIMAL_UI.",
        tags: ["webhooks"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            url: { type: "string", minLength: 1 },
            events: {
              type: "array",
              minItems: 1,
              items: { type: "string", enum: webhookEventsEnum },
            },
            scope: scopeSchema,
            secret: { type: "string", maxLength: 256 },
            headers: { type: "object", additionalProperties: { type: "string" } },
            insecureTls: { type: "boolean" },
            enabled: { type: "boolean" },
          },
        },
        response: {
          200: webhookSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const gate = minimalUiGate(reply);
      if (gate !== undefined) return gate;
      try {
        const patch: Parameters<typeof updateWebhook>[1] = {};
        if (req.body.name !== undefined) patch.name = req.body.name;
        if (req.body.url !== undefined) patch.url = req.body.url;
        if (req.body.events !== undefined) patch.events = req.body.events.filter(isWebhookEvent);
        if (req.body.scope !== undefined) patch.scope = req.body.scope;
        if (req.body.secret !== undefined) patch.secret = req.body.secret;
        if (req.body.headers !== undefined) patch.headers = req.body.headers;
        if (req.body.insecureTls !== undefined) patch.insecureTls = req.body.insecureTls;
        if (req.body.enabled !== undefined) patch.enabled = req.body.enabled;
        const w = await updateWebhook(req.params.id, patch);
        return reply.code(200).send(toWire(w));
      } catch (err) {
        return handleStoreError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/webhooks/:id",
    {
      schema: {
        description: "Delete a webhook and prune its delivery history. Disabled under MINIMAL_UI.",
        tags: ["webhooks"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          204: { type: "null" },
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const gate = minimalUiGate(reply);
      if (gate !== undefined) return gate;
      try {
        await deleteWebhook(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return handleStoreError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string } }>(
    "/webhooks/:id/test",
    {
      schema: {
        description:
          "Fire a synthetic `webhook.test` event at the target webhook. Bypasses " +
          "the event/scope filter — the test always reaches the targeted webhook. " +
          "Useful for verifying URL + signature wiring before waiting for a real " +
          "event. Returns immediately after queuing; the delivery record (with " +
          "outcome) shows up in `/webhooks/:id/deliveries` once the request " +
          "completes.\n\nDisabled under MINIMAL_UI.",
        tags: ["webhooks"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["queued"],
            properties: { queued: { type: "boolean" } },
          },
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const gate = minimalUiGate(reply);
      if (gate !== undefined) return gate;
      const w = await getWebhook(req.params.id);
      if (w === undefined) {
        return reply.code(404).send({ error: "webhook_not_found" });
      }
      await dispatch(
        {
          event: "webhook.test",
          data: {
            message: "This is a test event from pi-forge.",
            webhookId: w.id,
            webhookName: w.name,
          },
        },
        { onlyWebhookId: w.id },
      );
      return reply.code(200).send({ queued: true });
    },
  );

  fastify.get<{ Params: { id: string } }>(
    "/webhooks/:id/deliveries",
    {
      schema: {
        description:
          "Return recent delivery records for a webhook, newest first. Capped at " +
          "100 per webhook (rolling FIFO). Available regardless of MINIMAL_UI so " +
          "an operator can audit delivery health without disabling the gate.",
        tags: ["webhooks"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["deliveries"],
            properties: { deliveries: { type: "array", items: deliverySchema } },
          },
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const w = await getWebhook(req.params.id);
      if (w === undefined) {
        return reply.code(404).send({ error: "webhook_not_found" });
      }
      const records = await readDeliveriesForWebhook(req.params.id);
      return { deliveries: records };
    },
  );
};

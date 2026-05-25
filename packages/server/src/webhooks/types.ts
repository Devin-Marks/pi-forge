/**
 * Wire-shape definitions for the webhook feature. The config file
 * (`${FORGE_DATA_DIR}/webhooks.json`) and the rolling delivery log
 * (`${FORGE_DATA_DIR}/webhook-deliveries.json`) both serialize using
 * these types directly. Adding fields is safe (older
 * configs/deliveries deserialize with the new fields undefined);
 * renaming or removing requires a migration step.
 */

/** Events a webhook can subscribe to. Deliberately a small,
 *  curated set rather than every SSE event — the chatty ones
 *  (message_update, turn_start/end, tool_execution_*) would flood
 *  any consumer and the user wants the SSE stream for those, not
 *  webhooks. See WEBHOOK_EVENTS below for the catalog. */
export type WebhookEvent =
  | "agent_end"
  | "ask_user_question"
  | "process_alert"
  | "auto_retry_end"
  | "compaction_end"
  | "session_created"
  | "session_deleted";

/**
 * Canonical event list. Iteration order matches the UI's checklist
 * order; the order is part of the user-visible surface (the
 * Settings tab renders checkboxes in this order).
 */
export const WEBHOOK_EVENTS: readonly WebhookEvent[] = [
  "agent_end",
  "ask_user_question",
  "process_alert",
  "auto_retry_end",
  "compaction_end",
  "session_created",
  "session_deleted",
] as const;

export function isWebhookEvent(v: unknown): v is WebhookEvent {
  return typeof v === "string" && (WEBHOOK_EVENTS as readonly string[]).includes(v);
}

/**
 * Scope determines which session/project events fire a given
 * webhook:
 *   - "global"        → every session in every project.
 *   - { projectId }   → only sessions whose projectId matches.
 *
 * Events that aren't session-bound (e.g. `session_created`)
 * still respect project scope when applicable — that event
 * carries a projectId and per-project webhooks only fire when it
 * matches. Events with no projectId at all (currently none, but
 * reserved for future use) fire for global webhooks only.
 */
export type WebhookScope = { kind: "global" } | { kind: "project"; projectId: string };

export interface WebhookConfig {
  id: string;
  name: string;
  url: string;
  events: WebhookEvent[];
  scope: WebhookScope;
  /** HMAC-SHA256 shared secret. When set, every delivery includes
   *  `X-Pi-Forge-Signature: sha256=<hex>` computed over the raw
   *  JSON body. Absent => no signature header. */
  secret?: string;
  /** Custom headers merged into every delivery's request. Useful
   *  for static Authorization headers (Bearer tokens, etc.).
   *  Reserved `X-Pi-Forge-*` headers cannot be overridden. */
  headers?: Record<string, string>;
  /** When true, the dispatcher uses `https.Agent({rejectUnauthorized:false})`
   *  for this webhook's requests. Necessary for internal hosts
   *  with self-signed certs; logged on every fire to stderr so
   *  the relaxed security is visible in `docker logs`. */
  insecureTls?: boolean;
  /** Disabled webhooks stay in storage but don't dispatch. Lets
   *  the user pause a noisy integration without losing config. */
  enabled: boolean;
  createdAt: string;
}

/**
 * Recorded outcome of one delivery attempt. Multiple records may
 * share `webhookId` + `deliveryId` (one per retry attempt). Stored
 * in `webhook-deliveries.json` as a flat array, capped at 100 per
 * webhook (rolling FIFO).
 *
 * Response body bytes are NOT persisted — only `statusCode`, the
 * first 200 chars of any error text, and timing. Avoids surprise
 * PII leaks if a buggy webhook server echoes payloads.
 */
export interface DeliveryRecord {
  id: string;
  webhookId: string;
  /** Same id across retries of one logical delivery. Used as the
   *  `X-Pi-Forge-Delivery` request header so consumers can dedupe. */
  deliveryId: string;
  event: WebhookEvent | "webhook.test";
  sessionId?: string;
  projectId?: string;
  attempt: number;
  /** "delivered" → 2xx response. "failed" → 4xx (no retry). "error"
   *  → network error or 5xx (eligible for retry until attempt cap). */
  status: "delivered" | "failed" | "error";
  statusCode?: number;
  durationMs: number;
  errorPreview?: string;
  requestedAt: string;
}

/** Body of every webhook POST. Consumers should switch on `event`. */
export interface WebhookPayload {
  deliveryId: string;
  event: WebhookEvent | "webhook.test";
  timestamp: string;
  sessionId?: string;
  projectId?: string;
  /** Event-specific fields. Shape varies by event — see
   *  packages/server/src/webhooks/event-bridge.ts for the per-event
   *  builders. */
  data: Record<string, unknown>;
}

/**
 * Cap on persisted delivery records per webhook. Older deliveries
 * roll off FIFO. 100 is enough for "did my last few fires work?"
 * debugging without letting the file grow unbounded.
 */
export const MAX_DELIVERIES_PER_WEBHOOK = 100;

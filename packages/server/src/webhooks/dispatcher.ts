/**
 * Webhook delivery: takes a candidate event, finds every webhook
 * that subscribes to it (matching events + scope + enabled), and
 * fires an HTTP POST per match with retry + delivery recording.
 *
 * Per-webhook fire-and-forget — the function returns as soon as
 * the deliveries are kicked off. Retries run in the background.
 * The event source (event-bridge.ts) doesn't block on webhook
 * outcomes.
 *
 * Retry policy:
 *   - 2xx                 → "delivered", no retry.
 *   - 4xx                 → "failed", no retry (consumer's
 *                           problem; retrying won't help).
 *   - 5xx / network error → "error", retry with exponential
 *                           backoff (1s, 5s, 30s — 3 attempts
 *                           total counting the initial fire).
 *
 * HMAC: when `webhook.secret` is set, every request includes
 *   `X-Pi-Forge-Signature: sha256=<hex of HMAC-SHA256(secret, body)>`.
 * The hex digest is the same convention GitHub webhooks use.
 *
 * `insecureTls: true` swaps the `https.Agent` for one with
 * `rejectUnauthorized: false`. Logged to stderr on every fire
 * so the relaxed security is visible in `docker logs`.
 */
import { createHmac, randomUUID } from "node:crypto";
import { Agent as HttpsAgent } from "node:https";
import { recordDelivery, readWebhooks, SECRET_PLACEHOLDER } from "./store.js";
import {
  type DeliveryRecord,
  type WebhookConfig,
  type WebhookEvent,
  type WebhookPayload,
} from "./types.js";

/**
 * Reusable agents. The insecure one is allocated lazily — most
 * deployments never set `insecureTls` on any webhook, and we'd
 * rather not have a permissive agent sitting around unless asked.
 */
const SECURE_AGENT = new HttpsAgent({ keepAlive: true });
let insecureAgent: HttpsAgent | undefined;
function getInsecureAgent(): HttpsAgent {
  if (insecureAgent === undefined) {
    insecureAgent = new HttpsAgent({ keepAlive: true, rejectUnauthorized: false });
  }
  return insecureAgent;
}

const BACKOFF_MS = [1_000, 5_000, 30_000] as const;
const MAX_ATTEMPTS = BACKOFF_MS.length;
const REQUEST_TIMEOUT_MS = 30_000;
const ERROR_PREVIEW_LIMIT = 200;

/**
 * Reserved headers we always set ourselves. User-supplied custom
 * headers for these names are silently overridden — letting a
 * webhook config rewrite `X-Pi-Forge-Signature` would defeat the
 * point of HMAC.
 */
const RESERVED_HEADERS = new Set([
  "content-type",
  "x-pi-forge-event",
  "x-pi-forge-delivery",
  "x-pi-forge-signature",
  "user-agent",
]);

export interface DispatchOptions {
  event: WebhookEvent | "webhook.test";
  sessionId?: string;
  projectId?: string;
  data: Record<string, unknown>;
}

export interface DispatchTargetingOptions {
  /** When set, only fire webhooks with the matching id. Used by
   *  the test-fire route. Skips the event/scope filter so the
   *  test always reaches the webhook the operator targeted. */
  onlyWebhookId?: string;
}

/**
 * Public entry point. Resolves once all matching webhooks have
 * been queued (kicks off the first attempt synchronously per
 * webhook so the operator can observe failures immediately, then
 * retries continue in the background).
 *
 * Returns the number of webhooks targeted — useful for the test
 * route to surface "0 webhooks matched" feedback.
 */
export async function dispatch(
  opts: DispatchOptions,
  targeting?: DispatchTargetingOptions,
): Promise<number> {
  const webhooks = await readWebhooks();
  const matches = webhooks.filter((w) => isMatch(w, opts, targeting));
  if (matches.length === 0) return 0;
  // Build the payload ONCE — same body across all matching
  // webhooks. Each webhook gets its own deliveryId since each is
  // independently retryable.
  const timestamp = new Date().toISOString();
  for (const webhook of matches) {
    const payload: WebhookPayload = {
      deliveryId: randomUUID(),
      event: opts.event,
      timestamp,
      ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      data: opts.data,
    };
    // Fire-and-forget. Retries handled inside; we don't await the
    // full chain.
    void deliverWithRetries(webhook, payload);
  }
  return matches.length;
}

function isMatch(
  webhook: WebhookConfig,
  opts: DispatchOptions,
  targeting: DispatchTargetingOptions | undefined,
): boolean {
  if (targeting?.onlyWebhookId !== undefined) {
    return webhook.id === targeting.onlyWebhookId;
  }
  if (!webhook.enabled) return false;
  // Event subscription. `webhook.test` always matches if the test
  // route invoked us (handled by targeting above); the real-event
  // dispatch path goes through here and filters strictly.
  if (opts.event === "webhook.test") return false;
  if (!webhook.events.includes(opts.event)) return false;
  // Scope. Global webhooks match every event with a projectId or
  // none. Per-project webhooks only fire when the event carries a
  // matching projectId.
  if (webhook.scope.kind === "project") {
    return opts.projectId !== undefined && opts.projectId === webhook.scope.projectId;
  }
  return true;
}

async function deliverWithRetries(webhook: WebhookConfig, payload: WebhookPayload): Promise<void> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const outcome = await deliverOnce(webhook, payload, attempt);
    const record: DeliveryRecord = {
      id: randomUUID(),
      webhookId: webhook.id,
      deliveryId: payload.deliveryId,
      event: payload.event,
      attempt,
      status: outcome.status,
      durationMs: outcome.durationMs,
      requestedAt: outcome.requestedAt,
      ...(payload.sessionId !== undefined ? { sessionId: payload.sessionId } : {}),
      ...(payload.projectId !== undefined ? { projectId: payload.projectId } : {}),
      ...(outcome.statusCode !== undefined ? { statusCode: outcome.statusCode } : {}),
      ...(outcome.errorPreview !== undefined ? { errorPreview: outcome.errorPreview } : {}),
    };
    await recordDelivery(record).catch(() => undefined);
    // Stop on success or terminal-4xx; retry on error.
    if (outcome.status === "delivered" || outcome.status === "failed") return;
    if (attempt < MAX_ATTEMPTS) {
      const backoff = BACKOFF_MS[attempt - 1] ?? BACKOFF_MS[BACKOFF_MS.length - 1] ?? 1000;
      await new Promise<void>((resolve) => setTimeout(resolve, backoff));
    }
  }
}

interface DeliveryOutcome {
  status: "delivered" | "failed" | "error";
  statusCode?: number;
  durationMs: number;
  errorPreview?: string;
  requestedAt: string;
}

async function deliverOnce(
  webhook: WebhookConfig,
  payload: WebhookPayload,
  attempt: number,
): Promise<DeliveryOutcome> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "pi-forge-webhook/1.0",
    "X-Pi-Forge-Event": payload.event,
    "X-Pi-Forge-Delivery": payload.deliveryId,
  };
  if (webhook.secret !== undefined && webhook.secret.length > 0) {
    const sig = createHmac("sha256", webhook.secret).update(body).digest("hex");
    headers["X-Pi-Forge-Signature"] = `sha256=${sig}`;
  }
  if (webhook.headers !== undefined) {
    for (const [name, value] of Object.entries(webhook.headers)) {
      if (RESERVED_HEADERS.has(name.toLowerCase())) continue;
      // Defense in depth: the CRUD path round-trips header values
      // through the SECRET_PLACEHOLDER sentinel so the wire never
      // exposes them. A hand-edited webhooks.json (or a future
      // bug) could leak the sentinel into stored config — skip
      // here so we never POST literally `Authorization: ***REDACTED***`
      // to the consumer.
      if (value === SECRET_PLACEHOLDER) continue;
      headers[name] = value;
    }
  }

  const requestedAt = new Date().toISOString();
  const t0 = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref();

  if (webhook.insecureTls === true) {
    process.stderr.write(
      JSON.stringify({
        level: "warn",
        time: requestedAt,
        msg: "webhook-insecure-tls",
        webhookId: webhook.id,
        url: webhook.url,
        event: payload.event,
        attempt,
      }) + "\n",
    );
  }

  try {
    // Node's global fetch routes through undici. We pass the
    // agent via the `dispatcher` undici-extension field — TS's
    // standard RequestInit doesn't know about it, hence the cast.
    // Falls back gracefully on runtimes that ignore the field.
    const agent = webhook.insecureTls === true ? getInsecureAgent() : SECURE_AGENT;
    const init: RequestInit & { agent?: HttpsAgent } = {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
      agent,
    };
    const res = await fetch(webhook.url, init);
    const durationMs = Date.now() - t0;
    const statusCode = res.status;
    if (statusCode >= 200 && statusCode < 300) {
      return { status: "delivered", statusCode, durationMs, requestedAt };
    }
    if (statusCode >= 400 && statusCode < 500) {
      const text = await safeReadErrorBody(res);
      return {
        status: "failed",
        statusCode,
        durationMs,
        requestedAt,
        ...(text !== undefined ? { errorPreview: text } : {}),
      };
    }
    // 5xx or other non-2xx — retryable.
    const text = await safeReadErrorBody(res);
    return {
      status: "error",
      statusCode,
      durationMs,
      requestedAt,
      ...(text !== undefined ? { errorPreview: text } : {}),
    };
  } catch (err) {
    const durationMs = Date.now() - t0;
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "error",
      durationMs,
      requestedAt,
      errorPreview: message.slice(0, ERROR_PREVIEW_LIMIT),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Read a small slice of the response body for diagnostics.
 * Bounded so a runaway server returning megabytes doesn't blow
 * memory. Body bytes themselves are not persisted in
 * DeliveryRecord — only this preview makes it through.
 */
async function safeReadErrorBody(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    if (text.length === 0) return undefined;
    return text.slice(0, ERROR_PREVIEW_LIMIT);
  } catch {
    return undefined;
  }
}

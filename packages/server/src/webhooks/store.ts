/**
 * Disk-backed store for webhook configs + delivery history.
 *
 * Two files in `${FORGE_DATA_DIR}/`:
 *   - `webhooks.json`            — config (one entry per webhook)
 *   - `webhook-deliveries.json`  — rolling history (FIFO capped per webhook)
 *
 * Separated so config writes (rare, single-tenant operator) don't
 * fight delivery writes (frequent, fired by the agent loop). Same
 * atomic-write + per-file lock pattern as `project-manager.ts`.
 *
 * Single-process / single-tenant: locks are in-process promises,
 * not file locks. Cross-process safety would need a real flock.
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import {
  isWebhookEvent,
  MAX_DELIVERIES_PER_WEBHOOK,
  type DeliveryRecord,
  type WebhookConfig,
  type WebhookScope,
} from "./types.js";

const WEBHOOKS_FILE = (): string => join(config.forgeDataDir, "webhooks.json");
const DELIVERIES_FILE = (): string => join(config.forgeDataDir, "webhook-deliveries.json");

async function ensureDir(): Promise<void> {
  await mkdir(config.forgeDataDir, { recursive: true });
}

/**
 * Atomic JSON write: tmp file → fsync → rename. The temp filename
 * embeds a uuid so concurrent calls (which shouldn't happen under
 * the lock, but defense in depth) don't collide. The `chmod 0600`
 * after creation matters for `webhooks.json` specifically because
 * it can contain HMAC secrets — same posture as `jwt-secret` /
 * `password-hash`.
 */
async function atomicWriteJson(target: string, data: unknown, mode: number): Promise<void> {
  await ensureDir();
  const tmp = `${target}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
  try {
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// ---- webhooks.json (config) ----

let configLock: Promise<unknown> = Promise.resolve();
function withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = configLock.then(fn, fn);
  configLock = next.catch(() => undefined);
  return next;
}

function isScope(v: unknown): v is WebhookScope {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  if (r.kind === "global") return true;
  if (r.kind === "project" && typeof r.projectId === "string") return true;
  return false;
}

function isWebhookConfig(v: unknown): v is WebhookConfig {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.url === "string" &&
    Array.isArray(r.events) &&
    r.events.every((e) => isWebhookEvent(e)) &&
    isScope(r.scope) &&
    typeof r.enabled === "boolean" &&
    typeof r.createdAt === "string"
  );
}

export async function readWebhooks(): Promise<WebhookConfig[]> {
  await ensureDir();
  try {
    const raw = await readFile(WEBHOOKS_FILE(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWebhookConfig);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeWebhooks(webhooks: WebhookConfig[]): Promise<void> {
  // mode 0o600 — webhooks.json holds HMAC secrets. Same posture as
  // ~/.pi-forge/jwt-secret and ~/.pi-forge/password-hash.
  await atomicWriteJson(WEBHOOKS_FILE(), webhooks, 0o600);
}

export class WebhookNotFoundError extends Error {
  readonly code = "webhook_not_found";
  constructor(id: string) {
    super(`Webhook not found: ${id}`);
    this.name = "WebhookNotFoundError";
  }
}

export class InvalidWebhookError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "InvalidWebhookError";
  }
}

/**
 * Same `***REDACTED***` sentinel `config-manager.ts` uses for inline
 * `apiKey` in models.json. The webhook headers map can hold things
 * like `Authorization: Bearer …` — we round-trip header VALUES
 * through this sentinel so the wire never carries the real value
 * and editing in the UI doesn't overwrite the stored secret with
 * the sentinel string. Header NAMES stay visible (knowing a webhook
 * has an `Authorization` header isn't sensitive; the value is).
 */
export const SECRET_PLACEHOLDER = "***REDACTED***";

/**
 * Build the wire-safe headers object: same keys, every value
 * replaced with the sentinel. The persisted file stays unchanged;
 * this redaction is purely on the read path. The companion
 * `mergeHeadersOnWrite` below restores the real values when the
 * client PATCHes back unchanged headers.
 */
export function redactHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (headers === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const name of Object.keys(headers)) {
    out[name] = SECRET_PLACEHOLDER;
  }
  return out;
}

/**
 * On PATCH, treat any header VALUE that's literally the sentinel
 * as "keep the existing value." Same semantics as the apiKey
 * round-trip in writeModelsJson. New headers (typed-in values, not
 * sentinel) replace; header NAMES that were dropped from the
 * incoming map are dropped from storage.
 *
 * Returns `undefined` for the empty case so the caller can drop
 * the field entirely from the stored config (rather than persist
 * an empty object).
 */
export function mergeHeadersOnWrite(
  incoming: Record<string, string>,
  existing: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === SECRET_PLACEHOLDER) {
      const prior = existing?.[name];
      if (prior !== undefined) out[name] = prior;
      // No prior value → silently drop. The sentinel was sent
      // because the UI showed it, but if there's nothing to keep
      // (e.g. the existing config was just deleted), skip.
    } else {
      out[name] = value;
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Validate a webhook URL: HTTPS only (same rationale as the clone
 * route — embedding secrets / tokens over cleartext is asking for
 * trouble). HTTP is rejected even on the explicit insecureTls
 * path; `insecureTls` only relaxes cert validation, not the
 * scheme.
 */
export function validateWebhookUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InvalidWebhookError("invalid_url", `Not a valid URL: ${raw}`);
  }
  if (parsed.protocol !== "https:") {
    throw new InvalidWebhookError(
      "unsupported_protocol",
      `Only HTTPS webhook URLs are supported (got ${parsed.protocol}).`,
    );
  }
  if (parsed.hostname.length === 0) {
    throw new InvalidWebhookError("invalid_url", "URL is missing a host.");
  }
  return parsed;
}

export interface CreateWebhookInput {
  name: string;
  url: string;
  events: WebhookConfig["events"];
  scope: WebhookScope;
  secret?: string;
  headers?: Record<string, string>;
  insecureTls?: boolean;
  enabled?: boolean;
}

export async function createWebhook(input: CreateWebhookInput): Promise<WebhookConfig> {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new InvalidWebhookError("invalid_name", "Webhook name cannot be empty.");
  }
  validateWebhookUrl(input.url);
  if (input.events.length === 0) {
    throw new InvalidWebhookError("no_events", "Webhook must subscribe to at least one event.");
  }
  if (input.secret === SECRET_PLACEHOLDER) {
    throw new InvalidWebhookError("invalid_secret", "Secret cannot be the redaction sentinel.");
  }
  if (input.headers !== undefined) {
    for (const value of Object.values(input.headers)) {
      if (value === SECRET_PLACEHOLDER) {
        // No prior config exists on create — a sentinel value here
        // would persist as a literal "***REDACTED***" header value
        // and confuse subsequent edits. Reject explicitly.
        throw new InvalidWebhookError(
          "invalid_header",
          "Header values cannot be the redaction sentinel on create.",
        );
      }
    }
  }
  return withConfigLock(async () => {
    const list = await readWebhooks();
    const webhook: WebhookConfig = {
      id: randomUUID(),
      name,
      url: input.url,
      events: [...input.events],
      scope: input.scope,
      enabled: input.enabled ?? true,
      createdAt: new Date().toISOString(),
    };
    if (input.secret !== undefined && input.secret.length > 0) webhook.secret = input.secret;
    if (input.headers !== undefined && Object.keys(input.headers).length > 0)
      webhook.headers = { ...input.headers };
    if (input.insecureTls === true) webhook.insecureTls = true;
    list.push(webhook);
    await writeWebhooks(list);
    return webhook;
  });
}

export type UpdateWebhookInput = Partial<CreateWebhookInput>;

export async function updateWebhook(id: string, patch: UpdateWebhookInput): Promise<WebhookConfig> {
  if (patch.url !== undefined) validateWebhookUrl(patch.url);
  if (patch.events !== undefined && patch.events.length === 0) {
    throw new InvalidWebhookError("no_events", "Webhook must subscribe to at least one event.");
  }
  if (patch.name !== undefined && patch.name.trim().length === 0) {
    throw new InvalidWebhookError("invalid_name", "Webhook name cannot be empty.");
  }
  return withConfigLock(async () => {
    const list = await readWebhooks();
    const idx = list.findIndex((w) => w.id === id);
    if (idx === -1) throw new WebhookNotFoundError(id);
    const existing = list[idx]!;
    const updated: WebhookConfig = {
      ...existing,
      ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
      ...(patch.url !== undefined ? { url: patch.url } : {}),
      ...(patch.events !== undefined ? { events: [...patch.events] } : {}),
      ...(patch.scope !== undefined ? { scope: patch.scope } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    };
    // Optional fields: explicit-undefined-in-patch means "clear it".
    // We can't tell `undefined` from "not provided" in a JSON body,
    // so opt for "absent in body = leave alone, empty-string = clear"
    // for secret/headers; insecureTls is a boolean toggle so any
    // explicit value wins.
    //
    // Secret: empty-string clears; the SECRET_PLACEHOLDER sentinel
    // means "keep the existing secret" (the wire never exposes the
    // real value, so a UI round-trip would otherwise overwrite the
    // stored secret with the literal "***REDACTED***" string).
    if (patch.secret !== undefined) {
      if (patch.secret.length === 0) delete updated.secret;
      else if (patch.secret === SECRET_PLACEHOLDER) {
        // Leave `updated.secret` whatever the spread of `existing`
        // carried — i.e., no change.
      } else updated.secret = patch.secret;
    }
    if (patch.headers !== undefined) {
      // Round-trip protection for header VALUES (Bearer tokens
      // etc.). Per-name: sentinel → keep prior; new value → use;
      // missing-from-incoming → drop. `mergeHeadersOnWrite`
      // returns undefined when the merged map is empty, which
      // collapses to "no headers configured."
      const merged = mergeHeadersOnWrite(patch.headers, existing.headers);
      if (merged === undefined) delete updated.headers;
      else updated.headers = merged;
    }
    if (patch.insecureTls !== undefined) {
      if (patch.insecureTls) updated.insecureTls = true;
      else delete updated.insecureTls;
    }
    list[idx] = updated;
    await writeWebhooks(list);
    return updated;
  });
}

export async function deleteWebhook(id: string): Promise<void> {
  await withConfigLock(async () => {
    const list = await readWebhooks();
    const next = list.filter((w) => w.id !== id);
    if (next.length === list.length) throw new WebhookNotFoundError(id);
    await writeWebhooks(next);
  });
  // Best-effort: prune this webhook's delivery records too. A
  // failure here just leaves orphan records that nothing reads;
  // the deletion of the config itself is already done.
  await withDeliveriesLock(async () => {
    const records = await readDeliveriesRaw();
    const pruned = records.filter((r) => r.webhookId !== id);
    if (pruned.length !== records.length) {
      await writeDeliveries(pruned);
    }
  }).catch(() => undefined);
}

export async function getWebhook(id: string): Promise<WebhookConfig | undefined> {
  const list = await readWebhooks();
  return list.find((w) => w.id === id);
}

// ---- webhook-deliveries.json (history) ----

let deliveriesLock: Promise<unknown> = Promise.resolve();
function withDeliveriesLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = deliveriesLock.then(fn, fn);
  deliveriesLock = next.catch(() => undefined);
  return next;
}

function isDeliveryRecord(v: unknown): v is DeliveryRecord {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.webhookId === "string" &&
    typeof r.deliveryId === "string" &&
    typeof r.event === "string" &&
    typeof r.attempt === "number" &&
    (r.status === "delivered" || r.status === "failed" || r.status === "error") &&
    typeof r.durationMs === "number" &&
    typeof r.requestedAt === "string"
  );
}

async function readDeliveriesRaw(): Promise<DeliveryRecord[]> {
  await ensureDir();
  try {
    const raw = await readFile(DELIVERIES_FILE(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isDeliveryRecord);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

async function writeDeliveries(records: DeliveryRecord[]): Promise<void> {
  // Deliveries don't contain secrets but mode 0600 anyway: the
  // file lives alongside webhooks.json and there's no reason for
  // anything outside the pi-forge process to read it.
  await atomicWriteJson(DELIVERIES_FILE(), records, 0o600);
}

/**
 * Append a delivery record and trim the per-webhook history to the
 * latest `MAX_DELIVERIES_PER_WEBHOOK` entries. FIFO eviction so
 * the most recent N stays visible in the UI.
 */
export async function recordDelivery(record: DeliveryRecord): Promise<void> {
  await withDeliveriesLock(async () => {
    const list = await readDeliveriesRaw();
    list.push(record);
    // Trim per-webhook. Walk newest-to-oldest, keep first N per id.
    // Cheaper than groupBy on small N (cap=100, total ~few-hundred).
    const kept: DeliveryRecord[] = [];
    const counts = new Map<string, number>();
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i]!;
      const n = (counts.get(r.webhookId) ?? 0) + 1;
      counts.set(r.webhookId, n);
      if (n <= MAX_DELIVERIES_PER_WEBHOOK) kept.push(r);
    }
    kept.reverse();
    await writeDeliveries(kept);
  });
}

/**
 * Return delivery records for one webhook, newest first. Bounded
 * by the per-webhook cap so this is cheap to call from the UI.
 */
export async function readDeliveriesForWebhook(webhookId: string): Promise<DeliveryRecord[]> {
  const all = await readDeliveriesRaw();
  return all.filter((r) => r.webhookId === webhookId).reverse();
}

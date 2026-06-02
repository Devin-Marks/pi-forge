import { ApiError, UNAUTHORIZED_EVENT } from "./api-client";
import { clearStoredToken, getStoredToken } from "./auth-client";

/**
 * Minimal SSE reader that uses fetch + ReadableStream so we can send the
 * `Authorization` header. The native `EventSource` API does not support
 * custom headers, so we cannot use it for our bearer-auth model.
 *
 * What this handles:
 *   - Connect with bearer token (or skip when auth is disabled).
 *   - Parse `data: <json>\n\n` framed events; ignore comment/keepalive
 *     lines; accept `\r\n\r\n` separators per the W3C SSE spec.
 *   - Surface ApiError(0, "network_error") on connection failure and
 *     ApiError(status, ...) on non-2xx responses, mirroring api-client.
 *   - Auto-reconnect with exponential backoff on transient failures
 *     (network drop, server restart, EOF without prior abort).
 *   - Clean teardown when the caller aborts via AbortSignal — abort
 *     suppresses reconnect.
 *
 * Reconnect policy:
 *   - 401 / 404 / 409 are treated as terminal (auth gone, session deleted,
 *     or externally active read-only subagent) — do not retry; reject immediately.
 *   - Any other non-2xx, network-level error, or post-200 stream EOF
 *     triggers a backoff (1s → 2s → 4s → 8s → 16s, capped at 30s).
 *     `onReconnect` is invoked between attempts so the UI can show a
 *     "Reconnecting…" banner.
 *   - The user's AbortSignal cancels any in-flight backoff sleep too.
 */
export interface StreamSSEOptions<T> {
  signal?: AbortSignal;
  /** Called once per parsed event. Sync or async — the reader awaits. */
  onEvent: (event: T) => void | Promise<void>;
  /** Called once when the stream ends cleanly (server EOF, no reconnect). */
  onClose?: () => void;
  /**
   * Called whenever the reader is about to wait `delayMs` then attempt
   * reconnect #`attempt` (1-indexed). UI can render a banner from here.
   */
  onReconnect?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  /**
   * Maximum number of reconnect attempts before giving up. Default 0 = no
   * cap (retry indefinitely with the capped backoff). Test rigs set this
   * to a small number to bound test duration.
   */
  maxReconnects?: number;
}

const TERMINAL_STATUS = new Set([401, 404, 409]);
const MAX_BACKOFF_MS = 30_000;

function backoffDelay(attempt: number): number {
  // 1, 2, 4, 8, 16, 30, 30, ...
  return Math.min(2 ** attempt * 1000, MAX_BACKOFF_MS);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run one SSE attempt: fetch, read, parse, dispatch.
 * Resolves with `"eof"` on a clean stream end (server closed),
 * `"aborted"` if the caller aborted, or rejects with an ApiError or
 * underlying error on transient/terminal failure. The caller decides
 * whether to retry based on the rejection.
 */
async function runOneAttempt<T extends { type: string }>(
  path: string,
  opts: StreamSSEOptions<T>,
): Promise<"eof" | "aborted"> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  const stored = getStoredToken();
  if (stored) headers.Authorization = `Bearer ${stored.token}`;

  const init: RequestInit = { method: "GET", headers };
  if (opts.signal !== undefined) init.signal = opts.signal;

  let res: Response;
  try {
    res = await fetch(path, init);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return "aborted";
    throw new ApiError(0, "network_error", (err as Error).message);
  }

  if (res.status === 401) {
    clearStoredToken();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }

  if (!res.ok || res.body === null) {
    let code = "stream_open_failed";
    try {
      const body = (await res.clone().json()) as { error?: unknown };
      if (typeof body.error === "string") code = body.error;
    } catch {
      // Non-JSON error body: keep generic stream_open_failed.
    }
    throw new ApiError(res.status, code);
  }

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return "eof";
      buffer += value.replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const message = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLines: string[] = [];
        for (const line of message.split("\n")) {
          if (line.startsWith(":")) continue;
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length > 0) {
          const payload = dataLines.join("\n");
          try {
            const parsed = JSON.parse(payload) as T;
            await opts.onEvent(parsed);
          } catch {
            // Malformed frame — drop it. Per dev plan: unknown event types
            // and bad payloads must not crash the client.
          }
        }
        sep = buffer.indexOf("\n\n");
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return "aborted";
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

export async function streamSSE<T extends { type: string }>(
  path: string,
  opts: StreamSSEOptions<T>,
): Promise<void> {
  let attempt = 0;
  while (true) {
    let outcome: "eof" | "aborted";
    try {
      outcome = await runOneAttempt(path, opts);
    } catch (err) {
      // Terminal codes — don't retry; surface to the caller.
      if (err instanceof ApiError && TERMINAL_STATUS.has(err.status)) {
        throw err;
      }
      // Anything else is transient: backoff + retry. Cap respected via
      // maxReconnects; default 0 means unlimited.
      attempt += 1;
      if (
        opts.maxReconnects !== undefined &&
        opts.maxReconnects > 0 &&
        attempt > opts.maxReconnects
      ) {
        throw err;
      }
      const delayMs = backoffDelay(attempt);
      const reason = err instanceof Error ? err.message : String(err);
      opts.onReconnect?.({ attempt, delayMs, reason });
      try {
        await abortableSleep(delayMs, opts.signal);
      } catch {
        // Aborted during backoff — clean exit.
        return;
      }
      continue;
    }
    if (outcome === "aborted") return;
    // Server closed the stream cleanly. In our deployment this still
    // means "the session went away" or "the server restarted" — try to
    // reconnect rather than giving up. The next attempt will hit a 404
    // if the session is gone, which the terminal-status check catches.
    attempt += 1;
    if (
      opts.maxReconnects !== undefined &&
      opts.maxReconnects > 0 &&
      attempt > opts.maxReconnects
    ) {
      opts.onClose?.();
      return;
    }
    const delayMs = backoffDelay(attempt);
    opts.onReconnect?.({ attempt, delayMs, reason: "server closed stream" });
    try {
      await abortableSleep(delayMs, opts.signal);
    } catch {
      // abortableSleep throws on signal abort — exit the reconnect
      // loop cleanly. The caller sees this as a normal Promise
      // resolution (no rejection).
      return;
    }
  }
}

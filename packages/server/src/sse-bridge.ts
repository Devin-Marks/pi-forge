import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { LiveSession, SSEClient } from "./session-registry.js";
import { getSession } from "./session-registry.js";
import {
  getPendingForSession as getPendingAskQuestions,
  subscribe as subscribeAskQuestions,
} from "./ask-user-question/registry.js";
import { peekCached as peekCachedTodo, subscribe as subscribeTodo } from "./todo/store.js";

/**
 * Per-client outbound-buffer cap. When Node's internal socket buffer
 * for a given client exceeds this many bytes, we drop the client
 * rather than retain it indefinitely. A wedged consumer (paused tab,
 * stopped-reading client, ws-proxy that buffers without flushing)
 * can otherwise balloon resident memory by hundreds of MB during a
 * verbose tool execution before the kernel forces socket close.
 *
 * 256 KB matches roughly 50-100 typical events worth of unflushed
 * data — well above any legitimate transient buffering and below
 * the threshold where memory pressure starts mattering.
 */
const BACKPRESSURE_LIMIT_BYTES = 256 * 1024;

/**
 * Cadence at which we send an SSE comment line (`: heartbeat\n\n`) on
 * every open stream. EventSource ignores comment lines silently, so the
 * browser sees nothing — but the bytes reset any idle-connection timer
 * sitting between us and the client. OpenShift's HAProxy router defaults
 * `timeout server` to 30s for HTTP routes, and any L7 proxy / load
 * balancer enforces a similar window; with no agent activity between
 * turns, an idle SSE stream gets killed by the middlebox and the
 * browser shows "reconnecting." 20s gives us comfortable margin under
 * the typical 30s default.
 */
const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * One-shot snapshot event sent immediately on SSE connect so the browser can
 * hydrate full session state without a separate HTTP round-trip.
 */
export interface SnapshotEvent {
  type: "snapshot";
  sessionId: string;
  projectId: string;
  messages: AgentMessage[];
  isStreaming: boolean;
}

/**
 * Event types we forward to browser clients. Anything else from the SDK is
 * dropped on the floor — keeps the wire stream stable across SDK upgrades and
 * matches the dev-plan catalog.
 */
const ALLOWED_EVENT_TYPES = new Set<string>([
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "tool_call",
  "tool_result",
  "queue_update",
  "compaction_start",
  "compaction_end",
  "auto_retry_start",
  "auto_retry_end",
  "snapshot",
  // Forge-native events for the ask_user_question tool. Not part of
  // the SDK's AgentSessionEvent union — emitted by the
  // ask-user-question registry and fanned out by initAskUserQuestionFanout
  // (below) to every live SSE client of the affected session.
  "ask_user_question",
  "ask_user_question_cancelled",
  // Forge-native event for the `todo` tool — emitted by the todo
  // store after every successful tool call so the UI panel updates
  // live. Also re-emitted on SSE snapshot with the cached state.
  "todo_update",
]);

export function isAllowedEvent(event: { type: string }): boolean {
  return ALLOWED_EVENT_TYPES.has(event.type);
}

/**
 * Wire the ask-user-question registry's per-session events into the
 * SSE bridge. Called once at server boot from index.ts. The returned
 * unsubscribe is exposed for tests; production never tears it down.
 */
export function initAskUserQuestionFanout(): () => void {
  return subscribeAskQuestions((event) => {
    const live = getSession(event.sessionId);
    if (live === undefined) return;
    for (const c of live.clients) {
      try {
        c.send(event);
      } catch {
        // Best-effort fanout — client drop is handled by sse-bridge close.
      }
    }
  });
}

/**
 * Wire the todo store's per-session change-listener into the SSE
 * bridge. Called once at server boot from index.ts. Mirrors the
 * ask-user-question fanout: every commit pushes a `todo_update`
 * to every live client of that session.
 */
export function initTodoFanout(): () => void {
  return subscribeTodo((change) => {
    const live = getSession(change.sessionId);
    if (live === undefined) return;
    const frame = {
      type: "todo_update" as const,
      sessionId: change.sessionId,
      tasks: change.state.tasks,
      nextId: change.state.nextId,
    };
    for (const c of live.clients) {
      try {
        c.send(frame);
      } catch {
        // best-effort fanout
      }
    }
  });
}

/**
 * Serialize an event into the SSE wire format. Returns the full chunk
 * including the trailing blank line that delimits messages.
 */
export function serializeSSE(event: { type: string; [k: string]: unknown }): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * Build a snapshot from the current LiveSession state. Pulled out so callers
 * (and tests) can assert the same shape the bridge sends on connect.
 */
export function buildSnapshot(live: LiveSession): SnapshotEvent {
  return {
    type: "snapshot",
    sessionId: live.sessionId,
    projectId: live.projectId,
    messages: live.session.messages,
    isStreaming: live.session.isStreaming,
  };
}

/**
 * Hijack the Fastify reply and turn it into a long-lived SSE stream attached
 * to `live.clients`. Sends a snapshot immediately, forwards filtered
 * AgentSessionEvents, and unregisters on socket close.
 *
 * The caller's route handler should NOT call `reply.send()` — `hijack()`
 * tells Fastify the response is being driven manually.
 *
 * Throws if the prelude (writeHead / snapshot write) fails. The caller is a
 * route handler that has already hijacked, so Fastify's reply.send(err)
 * fallback is a no-op; this function destroys the underlying socket on
 * failure so the client doesn't hang waiting for headers.
 */
export function createSSEClient(reply: FastifyReply, live: LiveSession): SSEClient {
  reply.hijack();
  const raw = reply.raw;

  // Closure state — declared up here so the prelude's catch can clean up
  // even if `client` was never finalized.
  let registeredClient: SSEClient | undefined;
  let closed = false;

  // The whole prelude (headers, registration, snapshot) is guarded as one
  // unit. Anything that throws here would otherwise hang the client socket:
  // after hijack() Fastify's wrap-thenable.js catches the throw and calls
  // reply.send(err), which is a no-op because reply.sent === true post-hijack.
  // Net result without this guard: no headers, no body, no end → connection
  // hangs until the OS times out. So on any prelude failure we destroy the
  // raw socket and remove the partially-registered client from the registry.
  try {
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx, Caddy) so events flush immediately.
      "X-Accel-Buffering": "no",
    });

    const id = randomUUID();

    /**
     * Direct raw write that bypasses the event filter. Used for synthetic
     * frames the bridge owns (snapshot today; heartbeats / keepalive in
     * later phases). Filter-bypass cannot leak SDK events because callers
     * supply already-shaped objects.
     */
    let heartbeatTimer: NodeJS.Timeout | undefined;

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (registeredClient !== undefined) live.clients.delete(registeredClient);
      try {
        raw.end();
      } catch {
        // socket already torn down — fine
      }
    };

    const writeRaw = (chunk: string): void => {
      if (closed) return;
      // Backpressure guard: if the OS-side socket buffer has accumulated
      // more than BACKPRESSURE_LIMIT_BYTES of unwritten bytes, the
      // consumer is wedged (slow network, paused tab, hostile client
      // that opened the SSE stream and stopped reading). Drop the
      // client rather than letting Node's internal buffer grow without
      // bound — `live.clients` retains the SSEClient object until
      // socket close fires, and a wedged TCP socket can take 30+
      // seconds to time out. Without this, repeated events on a
      // verbose tool execution can balloon resident memory by hundreds
      // of MB before the kernel forces the close.
      if (raw.writableLength > BACKPRESSURE_LIMIT_BYTES) {
        close();
        return;
      }
      try {
        raw.write(chunk);
      } catch {
        // Socket already torn down (client dropped, network blip).
        // Close cleans up the registry entry + ends the response.
        close();
      }
    };

    const send = (event: AgentSessionEvent | { type: string; [k: string]: unknown }): void => {
      if (closed) return;
      if (!isAllowedEvent(event)) return;
      writeRaw(serializeSSE(event));
    };

    const client: SSEClient = { id, send, close };
    registeredClient = client;

    // Order matters: write the snapshot BEFORE adding to live.clients.
    // The registry's subscribe handler (session-registry.ts:makeSubscribeHandler)
    // fans events out to live.clients synchronously inside the SDK's emit
    // call. If we registered first, an SDK event firing in the window
    // between live.clients.add and the snapshot write would land on the
    // wire BEFORE the snapshot — and the browser treats `snapshot` as
    // authoritative (replaces messagesBySession), so a streaming token
    // delta arriving before the snapshot would be wiped on the
    // snapshot's arrival. Snapshot first → register second → events
    // start flowing in the correct order.
    //
    // Snapshot bypass — uses writeRaw, the same surface a future heartbeat
    // would use. Server-issued synthetic frames flow through writeRaw;
    // SDK-relayed events flow through send (which applies the filter).
    writeRaw(
      serializeSSE(buildSnapshot(live) as unknown as { type: string; [k: string]: unknown }),
    );
    live.clients.add(client);

    // Re-deliver any in-flight ask_user_question requests so a
    // reconnect (browser refresh, network drop) resurfaces the
    // modal. Order: AFTER the snapshot, since the snapshot is
    // authoritative for message state — these events are separate
    // and won't be clobbered.
    for (const p of getPendingAskQuestions(live.sessionId)) {
      writeRaw(
        serializeSSE({
          type: "ask_user_question",
          sessionId: p.sessionId,
          requestId: p.requestId,
          questions: p.questions,
        }),
      );
    }

    // Re-emit the latest todo state on connect so the UI panel
    // hydrates without a separate GET. Empty state (no tasks) is
    // still sent — the client treats `tasks: []` as "no badge" and
    // hides the toggle icon.
    const cachedTodo = peekCachedTodo(live.sessionId);
    writeRaw(
      serializeSSE({
        type: "todo_update",
        sessionId: live.sessionId,
        tasks: cachedTodo.tasks,
        nextId: cachedTodo.nextId,
      }),
    );

    // Wire close listeners AFTER the snapshot write so an immediate socket
    // close can't double-fire close() before the registry is in a coherent
    // state. Node's 'close' event fires next-tick anyway, but explicit
    // ordering is cheap insurance.
    raw.on("close", close);
    raw.on("error", close);

    // Idle-timer reset for L7 proxies (OpenShift HAProxy router, nginx,
    // ALB, etc.). Comment line, no `data:` field — EventSource skips it.
    // Uses writeRaw so the same backpressure guard applies; if the socket
    // is wedged the heartbeat will trip the limit and call close(), which
    // tears the timer down.
    heartbeatTimer = setInterval(() => {
      writeRaw(": heartbeat\n\n");
    }, HEARTBEAT_INTERVAL_MS);
    // Don't keep the Node event loop alive just for heartbeats — when
    // the socket closes the close handler clears the timer anyway.
    heartbeatTimer.unref();

    return client;
  } catch (err) {
    // Prelude failure — clean up partial state and tear the socket down so
    // the client gets a connection drop instead of a hung half-open socket.
    closed = true;
    if (registeredClient !== undefined) live.clients.delete(registeredClient);
    try {
      raw.destroy();
    } catch {
      // already destroyed
    }
    throw err;
  }
}

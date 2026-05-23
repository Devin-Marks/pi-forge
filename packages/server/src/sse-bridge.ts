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
import { processManager } from "./processes/manager.js";

/**
 * Per-client outbound-buffer cap. When Node's internal socket buffer
 * for a given client exceeds this many bytes, we drop the client
 * rather than retain it indefinitely. A wedged consumer (paused tab,
 * stopped-reading client, ws-proxy that buffers without flushing)
 * can otherwise balloon resident memory by hundreds of MB during a
 * verbose tool execution before the kernel forces socket close.
 *
 * 8 MB is well above any realistic transient burst: a `tool_result`
 * for an 11k-token tool output serializes to ~80-150 KB, and the
 * subsequent stream of `message_update` token deltas can pile more
 * on top before the client drains. The earlier 256 KB cap was
 * tripping mid-session on legitimate slow consumers (mobile, slow
 * Wi-Fi) and producing a misleading "Reconnecting — server closed
 * stream" banner. The cap still bounds the wedged-tab case — at a
 * sustained 1 MB/s of events it fires within ~8s of zero consumption.
 */
const BACKPRESSURE_LIMIT_BYTES = 8 * 1024 * 1024;

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
 * One-shot padding flush we send right after the `compaction_start`
 * event. Defeats response buffering at L7 proxies (OpenShift's
 * HAProxy router most painfully) that hold small writes until either
 * an internal buffer threshold is hit or the connection closes.
 *
 * The `compaction_start` event itself is ~150 bytes, well below any
 * proxy's flush threshold. Without padding, that event sits in the
 * router's response buffer for the entire duration of the compaction
 * LLM call (several seconds) — by which point `compaction_end`
 * arrives and the client sees both events fire back-to-back with no
 * banner in between. With padding, the cumulative write pushes past
 * HAProxy's default ~2KB threshold and the router flushes everything
 * (including the compaction_start frame) immediately.
 *
 * Comment-line format (`: <bytes>\n\n`) — EventSource ignores
 * comment lines silently, so the browser sees nothing visible. The
 * `pad-flush` marker is included so an operator inspecting raw SSE
 * frames in `tcpdump` / `curl -N` can tell what they're looking at.
 *
 * 2KB is the smallest size that reliably crosses the HAProxy default;
 * tuning higher costs more bytes per compaction but doesn't change
 * correctness. Only emitted on compaction_start (a per-turn event,
 * not per-token), so the bandwidth impact is negligible.
 */
const COMPACTION_START_PADDING_BYTES = 2048;
const COMPACTION_START_PADDING_LINE = `: pad-flush ${"_".repeat(COMPACTION_START_PADDING_BYTES - 14)}\n\n`;

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
  // Forge-native events for the `process` tool. process_update
  // fans out the full snapshot on any lifecycle change (start /
  // exit / kill / clear) and re-emits on snapshot connect.
  // process_output is throttled per process to avoid flooding
  // SSE on chatty processes. process_watch is the agent-alerting
  // channel for log-watch matches.
  "process_update",
  "process_output",
  "process_watch",
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
 * Wire the processes manager's per-session events into the SSE
 * bridge. Called once at server boot. `process_update` carries
 * the full per-session snapshot — clients don't have to
 * reconcile partial updates. `process_output` is a thin pointer
 * (just the changed process's id) so the client can decide
 * whether to refetch a tail; flooding the full output on every
 * write would saturate SSE for chatty processes. `process_watch`
 * forwards the watch-match event verbatim for the agent-alerting
 * UI to render.
 */
export function initProcessesFanout(): () => void {
  return processManager.subscribe((event) => {
    const live = getSession(event.sessionId);
    if (live === undefined) return;
    if (event.type === "process_watch_matched") {
      const frame = {
        type: "process_watch" as const,
        sessionId: event.sessionId,
        match: event.match,
      };
      for (const c of live.clients) {
        try {
          c.send(frame);
        } catch {
          // best-effort fanout
        }
      }
      return;
    }
    if (event.type === "process_output_changed") {
      const frame = {
        type: "process_output" as const,
        sessionId: event.sessionId,
        id: event.id,
      };
      for (const c of live.clients) {
        try {
          c.send(frame);
        } catch {
          // best-effort fanout
        }
      }
      return;
    }
    // Lifecycle events all carry a full-snapshot update on the
    // wire — clients only need this one type to render the panel.
    const snapshot = {
      type: "process_update" as const,
      sessionId: event.sessionId,
      processes: processManager.list(event.sessionId),
    };
    for (const c of live.clients) {
      try {
        c.send(snapshot);
      } catch {
        // best-effort fanout
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
        // Operator-visible: this is the only reason the client sees a
        // "server closed stream" mid-session despite no socket-level
        // error. Bypass pino (same rationale as session-registry's
        // logAgentEvent) so a LOG_LEVEL=warn deploy still surfaces it.
        process.stderr.write(
          JSON.stringify({
            level: "warn",
            time: new Date().toISOString(),
            msg: "sse-client-dropped-backpressure",
            sessionId: live.sessionId,
            bufferedBytes: raw.writableLength,
            limitBytes: BACKPRESSURE_LIMIT_BYTES,
          }) + "\n",
        );
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
      // After compaction_start, follow with a padding flush so L7
      // proxies (notably the OpenShift HAProxy router) release the
      // event immediately rather than holding it through the
      // multi-second compaction LLM call. See
      // COMPACTION_START_PADDING_LINE doc-comment for the rationale.
      // Cheap — fires at most once per compaction, ~2KB on the wire.
      if (event.type === "compaction_start") {
        writeRaw(COMPACTION_START_PADDING_LINE);
      }
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

    // Same re-deliver for processes — empty list is still sent so
    // the client knows to hide the chat-input badge if a prior
    // tab left it visible. Manager.list() is cheap (in-memory
    // map walk + clone).
    writeRaw(
      serializeSSE({
        type: "process_update",
        sessionId: live.sessionId,
        processes: processManager.list(live.sessionId),
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

import type { FastifyPluginAsync } from "fastify";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { errorSchema } from "./_schemas.js";
import { getSession } from "../session-registry.js";
import { createForgeBashOperations } from "../agent-bash-operations.js";

/**
 * One-shot user bash execution — the chat input's `!` / `!!` prefix.
 *
 * Mirrors pi-tui's UserBashEvent semantics:
 *  - `!cmd`  → output appended to the session's message history as a
 *             BashExecutionMessage; the next agent turn sees it in
 *             LLM context.
 *  - `!!cmd` → same render, `excludeFromContext: true` keeps it out
 *             of the next turn's prompt. Local convenience only.
 *
 * Implementation uses the SDK's `AgentSession.executeBash()` directly.
 * That call:
 *   1. Spawns the command via the BashOperations we hand it
 *   2. Pushes a BashExecutionMessage into `agent.state.messages` so
 *      the next prompt's context window includes it (or skips it
 *      when excludeFromContext is true)
 *   3. Persists the message via `sessionManager.appendMessage` so the
 *      session JSONL captures it on agent_end (pi defers session
 *      writes until at least one assistant message has landed —
 *      our message is held in the in-memory list until then)
 *
 * Hand-rolling the spawn would let us emit ANSI-stripped output and
 * apply our own timeout, but it would NOT update agent.state.messages
 * (that's a private field). The SDK's path is the supported way to
 * inject context.
 *
 * Security posture: BashOperations is overridden to inject our
 * `toolShellEnv()` — an allowlist-based filter that only passes
 * known-harmless system vars (PATH, HOME, TERM, locales, …), with HOME
 * rewritten to the sandbox tool home when the identity sandbox is enabled.
 * pi-forge
 * secrets, provider keys, cloud credentials, and any other host-env
 * vars are dropped unless the operator opts them back in via
 * `TERMINAL_PASSTHROUGH_ENV`. Matches the integrated terminal's
 * posture. The agent's own bash TOOL may still have an env-exposure
 * surface — that's a separate fix for a separate code path.
 */

const DEFAULT_TIMEOUT_MS = 30_000;

interface ExecBody {
  command: string;
  excludeFromContext?: boolean;
}

/**
 * Wrap a BashOperations so that `options.signal` is the union of the
 * caller's signal and our own timeout signal. The SDK's executeBash
 * passes its abort controller as `options.signal`; we still need our
 * 30s wall-clock cap, so this union forwards an abort from EITHER
 * source to the inner exec.
 */
function timeoutOperations(inner: BashOperations, timeoutSignal: AbortSignal): BashOperations {
  return {
    exec: (command, cwd, options) => {
      const merged =
        options.signal !== undefined ? mergeSignals(options.signal, timeoutSignal) : timeoutSignal;
      return inner.exec(command, cwd, { ...options, signal: merged });
    },
  };
}

function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (a.aborted || b.aborted) {
    controller.abort();
  } else {
    a.addEventListener("abort", onAbort, { once: true });
    b.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

export const execRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.post<{ Params: { id: string }; Body: ExecBody }>(
    "/sessions/:id/exec",
    {
      schema: {
        description:
          "Run a one-shot bash command in the session's project cwd " +
          "(the chat input's `!` / `!!` prefix dispatches here). The " +
          "result is added to the session's in-memory context AND " +
          "persisted to the session JSONL (deferred until the next " +
          "agent turn finalizes — pi's session-write is gated on " +
          "having at least one assistant message). With " +
          "`excludeFromContext: true` (the `!!` prefix) the result " +
          "is recorded but kept out of the next turn's LLM input. " +
          "Output is captured whole — no streaming for v1. The " +
          "spawned shell inherits a scrubbed env (no pi-forge / " +
          "provider secrets), same posture as the integrated " +
          "terminal.",
        tags: ["sessions"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["command"],
          additionalProperties: false,
          properties: {
            command: { type: "string", minLength: 1, maxLength: 4096 },
            excludeFromContext: { type: "boolean" },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["exitCode", "output", "durationMs", "truncated", "cancelled"],
            properties: {
              exitCode: { type: ["integer", "null"] },
              output: { type: "string" },
              durationMs: { type: "integer" },
              truncated: { type: "boolean" },
              cancelled: { type: "boolean" },
            },
          },
          404: errorSchema,
          500: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const live = getSession(req.params.id);
      if (live === undefined) {
        return reply.code(404).send({ error: "session_not_found" });
      }
      const { command, excludeFromContext = false } = req.body;
      const started = Date.now();
      // Defense-in-depth timeout — the SDK's bash executor has its
      // own truncation behavior but no time cap. We pre-bake an abort
      // signal that fires after DEFAULT_TIMEOUT_MS so a runaway loop
      // can't tie up the request handler indefinitely.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => timeoutController.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const result = await live.session.executeBash(command, undefined, {
          excludeFromContext,
          operations: timeoutOperations(
            createForgeBashOperations(live.workspacePath),
            timeoutController.signal,
          ),
        });
        const durationMs = Date.now() - started;
        live.lastActivityAt = new Date();

        // Cross-tab refetch trigger — every other browser viewing this
        // session schedules a getMessages refetch on `user_bash_result`.
        // The acting tab refetches off the HTTP response directly.
        for (const c of live.clients) {
          try {
            c.send({ type: "user_bash_result" });
          } catch {
            // best-effort fan-out; sse-bridge handles client drop on its own
          }
        }

        return {
          exitCode: result.exitCode === undefined ? null : result.exitCode,
          output: result.output,
          durationMs,
          truncated: result.truncated,
          cancelled: result.cancelled,
        };
      } catch (err) {
        return reply.code(500).send({
          error: "exec_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  );
};

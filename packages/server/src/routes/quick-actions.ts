import { spawn } from "node:child_process";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { config } from "../config.js";
import { getProject } from "../project-manager.js";
import { scrubbedEnv } from "../pty-manager.js";
import {
  createQuickAction,
  DEFAULT_TIMEOUT_MS,
  deleteQuickAction,
  getQuickAction,
  isCommandAction,
  isPromptAction,
  MAX_COMMAND_BYTES,
  MAX_PROMPT_BYTES,
  MAX_TIMEOUT_MS,
  QuickActionNotFoundError,
  readQuickActions,
  updateQuickAction,
  type QuickAction,
} from "../quick-actions.js";
import { errorSchema } from "./_schemas.js";

/**
 * Wire shape — same on the way in (POST/PUT body) and out
 * (GET response). Discriminator is presence of `command` vs `text`;
 * the validator below rejects both/neither with 400.
 */
const quickActionSchema = {
  type: "object",
  required: ["id", "name"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    enabled: { type: "boolean" },
    command: { type: "string" },
    timeoutMs: { type: "integer" },
    text: { type: "string" },
    mode: { type: "string", enum: ["send", "insert"] },
  },
} as const;

const runResultSchema = {
  type: "object",
  required: ["success", "exitCode", "stdout", "stderr", "durationMs", "timedOut", "truncated"],
  properties: {
    success: { type: "boolean" },
    exitCode: { type: ["integer", "null"] },
    stdout: { type: "string" },
    stderr: { type: "string" },
    durationMs: { type: "integer" },
    timedOut: { type: "boolean" },
    truncated: { type: "boolean" },
  },
} as const;

/** Per-stream output cap. A chip that prints 100 MB of node_modules
 * paths shouldn't drag the request handler down — truncate and flag
 * it; the user can re-run in the integrated terminal if they need the
 * full output. */
const MAX_OUTPUT_BYTES = 1_000_000;

interface ActionBody {
  name: string;
  enabled?: boolean;
  command?: string;
  timeoutMs?: number;
  text?: string;
  mode?: "send" | "insert";
}

/**
 * Normalise + validate one wire body into a QuickAction-shaped patch.
 * Centralises the one-of discriminator + byte caps so POST and PUT
 * both produce identical 400s on the same bad input.
 */
function validateBody(body: ActionBody, reply: FastifyReply): Omit<QuickAction, "id"> | undefined {
  const trimmedName = body.name.trim();
  if (trimmedName.length === 0) {
    reply.code(400).send({ error: "invalid_name" });
    return undefined;
  }
  const hasCmd = typeof body.command === "string" && body.command.length > 0;
  const hasText = typeof body.text === "string" && body.text.length > 0;
  if (hasCmd === hasText) {
    reply.code(400).send({
      error: "invalid_action",
      message: "exactly one of `command` or `text` is required",
    });
    return undefined;
  }
  const out: Omit<QuickAction, "id"> = { name: trimmedName };
  if (body.enabled !== undefined) out.enabled = body.enabled;
  if (hasCmd) {
    const cmd = body.command!;
    if (Buffer.byteLength(cmd, "utf8") > MAX_COMMAND_BYTES) {
      reply.code(400).send({ error: "command_too_large" });
      return undefined;
    }
    out.command = cmd;
    if (body.timeoutMs !== undefined) {
      const t = body.timeoutMs;
      if (!Number.isInteger(t) || t <= 0) {
        reply.code(400).send({ error: "invalid_timeout" });
        return undefined;
      }
      out.timeoutMs = Math.min(t, MAX_TIMEOUT_MS);
    }
  } else {
    const text = body.text!;
    if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) {
      reply.code(400).send({ error: "prompt_too_large" });
      return undefined;
    }
    out.text = text;
    out.mode = body.mode ?? "send";
  }
  return out;
}

function handleError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof QuickActionNotFoundError) {
    return reply.code(404).send({ error: "action_not_found" });
  }
  reply.log.error({ err }, "quick-actions route error");
  return reply.code(500).send({ error: "internal_error" });
}

/**
 * Spawn the command under `/bin/sh -c` with a scrubbed env (same
 * posture as the integrated terminal — no pi-forge / provider
 * secrets leak into chip output). stdout and stderr are captured
 * separately so the chat card can render them in distinct blocks.
 */
async function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}> {
  return new Promise((resolve) => {
    const proc = spawn("/bin/sh", ["-c", command], {
      cwd,
      env: scrubbedEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutLen = 0;
    let stderrLen = 0;
    let truncated = false;
    let timedOut = false;

    proc.stdout?.on("data", (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - stdoutLen;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutLen += remaining;
        truncated = true;
      } else {
        stdoutChunks.push(chunk);
        stdoutLen += chunk.length;
      }
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      const remaining = MAX_OUTPUT_BYTES - stderrLen;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrLen += remaining;
        truncated = true;
      } else {
        stderrChunks.push(chunk);
        stderrLen += chunk.length;
      }
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGTERM");
      } catch {
        // best-effort
      }
      // SIGKILL grace — match the exec-route convention.
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // best-effort
        }
      }, 2000);
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      // Spawn error (ENOENT on `/bin/sh`, etc.) — surface as a failed
      // run with the error on stderr so the chat card shows it.
      resolve({
        exitCode: null,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: err.message,
        timedOut,
        truncated,
      });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        truncated,
      });
    });
  });
}

export const quickActionRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    "/quick-actions",
    {
      schema: {
        description:
          "List all quick-action chips. Global (not per-project) — chips " +
          "are operator-personal, same install-private rationale as the " +
          "other forge-owned config files.",
        tags: ["config"],
        response: {
          200: {
            type: "object",
            required: ["actions"],
            properties: {
              actions: { type: "array", items: quickActionSchema },
            },
          },
        },
      },
    },
    async () => ({ actions: await readQuickActions() }),
  );

  fastify.post<{ Body: ActionBody }>(
    "/quick-actions",
    {
      schema: {
        description:
          "Create a quick-action chip. Exactly one of `command` or `text` " +
          "must be set — presence is the kind discriminator (no `kind` " +
          "field on the wire, matches the MCP server-config convention). " +
          "400 on both/neither, 400 on byte-cap overflow.",
        tags: ["config"],
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            enabled: { type: "boolean" },
            command: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1 },
            text: { type: "string" },
            mode: { type: "string", enum: ["send", "insert"] },
          },
        },
        response: {
          201: quickActionSchema,
          400: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const validated = validateBody(req.body, reply);
      if (validated === undefined) return reply;
      try {
        const created = await createQuickAction(validated);
        return reply.code(201).send(created);
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.put<{ Params: { id: string }; Body: ActionBody }>(
    "/quick-actions/:id",
    {
      schema: {
        description:
          "Replace a quick-action chip. Full record on the body — switching " +
          "kind (command ↔ prompt) drops the now-unused fields. Same " +
          "validation rules as POST.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["name"],
          additionalProperties: false,
          properties: {
            name: { type: "string", minLength: 1, maxLength: 200 },
            enabled: { type: "boolean" },
            command: { type: "string" },
            timeoutMs: { type: "integer", minimum: 1 },
            text: { type: "string" },
            mode: { type: "string", enum: ["send", "insert"] },
          },
        },
        response: {
          200: quickActionSchema,
          400: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const validated = validateBody(req.body, reply);
      if (validated === undefined) return reply;
      try {
        const updated = await updateQuickAction(req.params.id, validated);
        return updated;
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.delete<{ Params: { id: string } }>(
    "/quick-actions/:id",
    {
      schema: {
        description: "Delete a quick-action chip.",
        tags: ["config"],
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
      try {
        await deleteQuickAction(req.params.id);
        return reply.code(204).send();
      } catch (err) {
        return handleError(reply, err);
      }
    },
  );

  fastify.post<{ Params: { id: string }; Body: { projectId: string } }>(
    "/quick-actions/:id/run",
    {
      schema: {
        description:
          "Execute a command-kind quick action in the named project's " +
          "cwd. Returns captured stdout/stderr and the exit code. The " +
          "spawned shell inherits a SCRUBBED env (same as the " +
          "integrated terminal — no pi-forge or provider secrets). " +
          "Hard-gated under MINIMAL_UI: command runs return 403 " +
          "`command_actions_disabled_in_minimal` regardless of who " +
          "is calling. Prompt-kind actions are not executable here " +
          "(420-style validation error) — those are a pure client " +
          "concern that route through the composer or sendPrompt.",
        tags: ["config"],
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          required: ["projectId"],
          additionalProperties: false,
          properties: {
            projectId: { type: "string", minLength: 1 },
          },
        },
        response: {
          200: runResultSchema,
          400: errorSchema,
          403: errorSchema,
          404: errorSchema,
        },
      },
    },
    async (req, reply) => {
      // Defense in depth — the client also hides command chips
      // under MINIMAL_UI, but a stale tab or scripted caller could
      // still POST here. Refuse at the route.
      if (config.minimalUi) {
        return reply.code(403).send({ error: "command_actions_disabled_in_minimal" });
      }
      const action = await getQuickAction(req.params.id);
      if (action === undefined) {
        return reply.code(404).send({ error: "action_not_found" });
      }
      if (isPromptAction(action)) {
        return reply.code(400).send({
          error: "not_a_command_action",
          message: "prompt actions are dispatched client-side, not via this route",
        });
      }
      if (!isCommandAction(action)) {
        return reply.code(400).send({ error: "invalid_action" });
      }
      const project = await getProject(req.body.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: "project_not_found" });
      }
      const timeoutMs = Math.min(action.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const started = Date.now();
      const result = await runCommand(action.command!, project.path, timeoutMs);
      const durationMs = Date.now() - started;
      return {
        success: result.exitCode === 0 && !result.timedOut,
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        durationMs,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
    },
  );
};

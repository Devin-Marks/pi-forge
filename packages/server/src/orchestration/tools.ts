/**
 * Agent-facing tool surface for supervisor sessions.
 *
 * Eight `orchestrate_*` tools, registered onto a session ONLY when
 * that session has supervisor mode enabled AND the instance-level
 * `ORCHESTRATION_ENABLED` flag is on AND MINIMAL_UI is off. Wired
 * through `createAgentSession({ customTools })` in session-registry.
 *
 * Topology is hub-and-spoke by tool surface: workers don't get
 * these tools, so there's no way to express worker→worker comms.
 * Same-project enforcement: spawn_worker creates in the supervisor's
 * project; cross-project is intentionally out of scope for v1.
 *
 * Every tool that names a workerId verifies ownership against the
 * store before acting — defense in depth so a confused supervisor
 * LLM can't reach into another supervisor's worker by id-guessing.
 */
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  createSession,
  disposeSession,
  findSessionLocation,
  getSession,
  resumeSessionById,
  SessionNotFoundError,
  deleteColdSession,
} from "../session-registry.js";
import { maxWorkersPerSupervisor } from "./config.js";
import { drainInbox } from "./inbox.js";
import {
  getWorkerIds,
  getWorkerRecord,
  OrchestrationError,
  registerWorker,
  unregisterWorker,
} from "./store.js";
import { killWorkerAndArchive } from "./worker-lifecycle.js";

// ---- result shape helpers ----

/**
 * Build a tool result. CRITICAL: the `text` field is what the
 * supervisor LLM actually sees on its next turn. `details` is
 * structured metadata for downstream consumers (REST, tests) but is
 * NOT in the agent's context window. So every tool that wants the
 * orchestrator to make decisions on real data has to encode that
 * data into the text — putting it only in `details` is the same as
 * not returning it at all from the LLM's perspective.
 */
function ok(payload: Record<string, unknown>, text: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details: payload,
  };
}

function err(code: string, message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: `[error: ${code}] ${message}` }],
    details: { error: code, message },
  };
}

// ---- message serialization for the supervisor LLM ----

/**
 * Per-message hard cap when serializing a worker transcript for the
 * supervisor. Long bash outputs / write tool results blow up the
 * supervisor's context fast otherwise. 1.2k chars ≈ 400 tokens is
 * enough for the model to see the gist of any single step; the
 * supervisor can always call `orchestrate_read_worker` with a
 * tighter `limit` to focus on fewer messages in full.
 */
const PER_MESSAGE_CAP = 1_200;

/**
 * Total cap across all serialized messages in one read_worker call.
 * 24k chars ≈ 8k tokens. Bigger than `PER_MESSAGE_CAP × default
 * limit (20)`, so the default-limit case fits comfortably; if the
 * caller bumps limit, we still bound the total to protect the
 * supervisor's context budget.
 */
const TOTAL_TRANSCRIPT_CAP = 24_000;

interface SerializedBlock {
  text?: string;
  toolCalls?: string[];
  toolResults?: string[];
  imageCount?: number;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

function previewArgs(input: unknown): string {
  try {
    const j = JSON.stringify(input);
    return truncate(j, 200);
  } catch {
    return "(unserializable)";
  }
}

function extractFromContent(content: unknown): SerializedBlock {
  const out: SerializedBlock = {};
  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (!Array.isArray(content)) return out;
  const textParts: string[] = [];
  const toolCalls: string[] = [];
  const toolResults: string[] = [];
  let imageCount = 0;
  for (const raw of content) {
    const b = raw as {
      type?: string;
      text?: string;
      name?: string;
      input?: unknown;
      tool_use_id?: string;
      content?: unknown;
      is_error?: boolean;
    };
    if (b.type === "text" && typeof b.text === "string") {
      textParts.push(b.text);
      continue;
    }
    if (b.type === "tool_use" && typeof b.name === "string") {
      toolCalls.push(`${b.name}(${previewArgs(b.input)})`);
      continue;
    }
    if (b.type === "tool_result") {
      // tool_result.content can itself be a string or an array of
      // content blocks. Flatten to a short preview either way so the
      // supervisor sees what the worker's tool actually returned —
      // that's often the load-bearing signal for "did the worker
      // succeed."
      let resultText = "";
      if (typeof b.content === "string") resultText = b.content;
      else if (Array.isArray(b.content)) {
        const inner: string[] = [];
        for (const c of b.content as { type?: string; text?: string }[]) {
          if (c.type === "text" && typeof c.text === "string") inner.push(c.text);
        }
        resultText = inner.join("\n");
      }
      const prefix = b.is_error === true ? "[error] " : "";
      toolResults.push(prefix + truncate(resultText.trim(), 400));
      continue;
    }
    if (b.type === "image") {
      imageCount += 1;
      continue;
    }
  }
  if (textParts.length > 0) out.text = textParts.join("\n");
  if (toolCalls.length > 0) out.toolCalls = toolCalls;
  if (toolResults.length > 0) out.toolResults = toolResults;
  if (imageCount > 0) out.imageCount = imageCount;
  return out;
}

/**
 * Render one worker message as plain text the supervisor LLM can
 * read. Squashes the SDK's AgentMessage union into:
 *
 *     [role]
 *     <text>
 *     → tool_use: bash(...)
 *     ← tool_result: <preview>
 *     (+ N image(s))
 *
 * Caller is responsible for capping total transcript size; this
 * function only caps the per-message body so individual messages
 * stay readable when one of them is very long.
 */
function formatMessageForOrchestrator(msg: unknown, index: number, total: number): string {
  const m = msg as { role?: string; type?: string };
  const role = m.role ?? m.type ?? "unknown";
  const blocks = extractFromContent((m as { content?: unknown }).content);
  const lines: string[] = [`[${index + 1}/${total}] ${role}`];
  if (blocks.text !== undefined && blocks.text.trim().length > 0) {
    lines.push(truncate(blocks.text.trim(), PER_MESSAGE_CAP));
  }
  for (const tc of blocks.toolCalls ?? []) lines.push(`→ tool_use: ${tc}`);
  for (const tr of blocks.toolResults ?? []) lines.push(`← tool_result: ${tr}`);
  if ((blocks.imageCount ?? 0) > 0) lines.push(`(+${blocks.imageCount} image(s))`);
  if (lines.length === 1) lines.push("(no readable content)");
  return lines.join("\n");
}

/**
 * Concatenate per-message renders with a total-size budget. If we'd
 * blow past `TOTAL_TRANSCRIPT_CAP`, drop messages from the FRONT
 * (oldest) — the supervisor cares most about what the worker did
 * recently, and the caller can always re-call with a smaller `limit`
 * to see fewer messages in full.
 */
/**
 * Pick the most useful one-line detail from an inbox item's
 * `data` payload, based on its event type. Keeps the inbox summary
 * compact while still surfacing the load-bearing signal — the
 * supervisor LLM shouldn't have to guess what happened from just
 * a type name.
 */
function summarizeInboxData(type: string, data: Record<string, unknown>): string {
  if (type === "worker.ended") {
    const stop = typeof data.stopReason === "string" ? data.stopReason : "unknown";
    const err = typeof data.errorMessage === "string" ? data.errorMessage : "";
    const preview =
      typeof data.assistantTextPreview === "string" ? truncate(data.assistantTextPreview, 200) : "";
    const parts: string[] = [`stop=${stop}`];
    if (err !== "") parts.push(`error="${truncate(err, 120)}"`);
    if (preview !== "") parts.push(`said: ${preview}`);
    return parts.join(" ");
  }
  if (type === "worker.ask_user") {
    const header = typeof data.firstQuestionHeader === "string" ? data.firstQuestionHeader : "";
    const text = typeof data.firstQuestionText === "string" ? data.firstQuestionText : "";
    const count = typeof data.questionCount === "number" ? data.questionCount : 1;
    return `${count} question(s)${header !== "" ? `, first: "${header}"` : ""}${text !== "" ? ` (${truncate(text, 120)})` : ""}`;
  }
  if (type === "worker.execution_stopped_without_agent_end") {
    const reason = typeof data.reason === "string" ? data.reason : "stopped";
    const lastStart = typeof data.lastAgentStartAt === "string" ? data.lastAgentStartAt : "";
    return `${reason} while turn was open${lastStart !== "" ? ` (started ${lastStart})` : ""}`;
  }
  if (type === "worker.auto_retry_failed") {
    const attempt = typeof data.attempt === "number" ? data.attempt : "?";
    const maxA = typeof data.maxAttempts === "number" ? data.maxAttempts : "?";
    const finalErr = typeof data.finalError === "string" ? data.finalError : "";
    return `legacy retry failure attempts=${attempt}/${maxA}${finalErr !== "" ? ` err="${truncate(finalErr, 120)}"` : ""}`;
  }
  if (type === "worker.process_alert") {
    const reason = typeof data.reason === "string" ? data.reason : "unknown";
    const name = typeof data.name === "string" ? data.name : "(unnamed)";
    const exit = typeof data.exitCode === "number" ? data.exitCode : "?";
    return `${reason} process="${name}" exit=${exit}`;
  }
  if (type === "worker.deleted") {
    const wasLive = data.wasLive === true;
    return wasLive ? "was live" : "was cold";
  }
  // Unknown event type — fall back to a compact JSON preview so the
  // supervisor at least sees something actionable.
  try {
    return truncate(JSON.stringify(data), 200);
  } catch {
    return "";
  }
}

function renderTranscript(messages: readonly unknown[], total: number): string {
  const rendered: string[] = [];
  let used = 0;
  // Walk newest-to-oldest, prepend in render order at the end.
  for (let i = messages.length - 1; i >= 0; i--) {
    const block = formatMessageForOrchestrator(messages[i], total - (messages.length - i), total);
    if (used + block.length + 2 > TOTAL_TRANSCRIPT_CAP) break;
    rendered.unshift(block);
    used += block.length + 2;
  }
  if (rendered.length < messages.length) {
    rendered.unshift(
      `[truncated — older ${messages.length - rendered.length} message(s) omitted to keep the transcript under ${TOTAL_TRANSCRIPT_CAP} chars]`,
    );
  }
  return rendered.join("\n\n");
}

// ---- ownership guard ----

async function assertOwns(
  supervisorId: string,
  workerId: string,
): Promise<undefined | AgentToolResult<unknown>> {
  const rec = await getWorkerRecord(workerId);
  if (rec === undefined) {
    return err("worker_not_found", `No worker registered with id ${workerId}.`);
  }
  if (rec.supervisorId !== supervisorId) {
    return err(
      "not_owner",
      `Worker ${workerId} is linked to a different supervisor; refusing to act on it.`,
    );
  }
  return undefined;
}

// ---- spawn_worker ----

const spawnSchema = {
  type: "object",
  required: ["name", "initialPrompt"],
  additionalProperties: false,
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: 200,
      description:
        "Required short, descriptive label shown in the session picker — " +
        "this is how the user (and you, on later turns) will recognise the " +
        "worker among others. Concrete task names work best: " +
        "'Implement /auth route', 'Add tests for orders module', " +
        "'Audit RLS policies'. AVOID generic placeholders ('helper', " +
        "'worker 1', 'task') — those defeat the whole point of having " +
        "named workers.",
    },
    initialPrompt: {
      type: "string",
      minLength: 1,
      description:
        "The TASK assigned to this worker. The worker is a fresh autonomous " +
        "agent — it does not see your transcript or memory. Write a self-" +
        "contained task brief: what to do, where (file paths), constraints, " +
        "and what 'done' looks like. Instruct, don't collaborate.",
    },
    contextSummary: {
      type: "string",
      maxLength: 8_000,
      description:
        "Optional handoff context summary. When present, prepended " +
        "to `initialPrompt` so the worker starts with relevant " +
        "background. Use this for the 'A finishes → B picks up' " +
        "pipeline pattern. Cap is 8k chars to keep the worker's " +
        "first-turn token cost predictable.",
    },
  },
} as const;

function createSpawnWorker(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_spawn_worker",
    label: "Spawn worker session",
    description:
      "Create a new worker session in the same project as the supervisor and " +
      "assign it a task. Workers are autonomous task-running agents — NOT " +
      "conversational helpers. Each spawn delegates a discrete unit of " +
      "work; the worker executes against the task in `initialPrompt`, " +
      "reports completion via its inbox, then waits for the next task " +
      "(or shutdown). ALWAYS pass a descriptive `name` so the user (and " +
      "you, on later turns) can tell workers apart in the picker — " +
      "generic placeholders make the multi-worker case unusable. " +
      "Worker events (turn-end, ask-user-question, etc.) feed back into the " +
      "supervisor's inbox; check with `orchestrate_read_inbox`. " +
      "Same-project only in v1 — cross-project orchestration is intentionally " +
      "disabled. Subject to the per-supervisor fan-out cap (default 8).",
    parameters: Type.Unsafe<Record<string, unknown>>(spawnSchema),
    async execute(_toolCallId, params) {
      const p = params as {
        name: string;
        initialPrompt: string;
        contextSummary?: string;
      };
      const supLive = getSession(supervisorId);
      if (supLive === undefined) {
        return err("supervisor_not_live", "Supervisor session is not currently live.");
      }
      // Enforce fan-out cap on LIVE workers — a worker that was killed
      // earlier (registry-gone) shouldn't count against the cap even
      // though the store may still list it transiently.
      const workerIds = await getWorkerIds(supervisorId);
      const liveWorkers = workerIds.filter((id) => getSession(id) !== undefined);
      const cap = maxWorkersPerSupervisor();
      if (liveWorkers.length >= cap) {
        return err(
          "fanout_limit_exceeded",
          `Supervisor already has ${liveWorkers.length} live workers (cap ${cap}). ` +
            `Kill or detach an existing worker before spawning another.`,
        );
      }
      // Spawn into the supervisor's project — never cross-project.
      let worker: Awaited<ReturnType<typeof createSession>>;
      try {
        worker = await createSession(supLive.projectId, supLive.workspacePath);
      } catch (e) {
        return err(
          "spawn_failed",
          `createSession threw: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      // Register the link AFTER successful session creation so a
      // createSession failure doesn't leave a dangling store entry.
      try {
        await registerWorker({
          supervisorId,
          workerId: worker.sessionId,
          spawnedFrom: {
            sessionId: supervisorId,
            mode: p.contextSummary !== undefined ? "summary" : "fresh",
          },
        });
      } catch (e) {
        // Roll back the session create on registration failure —
        // otherwise we leak a session the user can't see linked
        // anywhere.
        await disposeSession(worker.sessionId).catch(() => undefined);
        await deleteColdSession(worker.sessionId).catch(() => undefined);
        if (e instanceof OrchestrationError) {
          return err(e.code, e.message);
        }
        return err("register_failed", e instanceof Error ? e.message : String(e));
      }
      // Apply the required name. Best-effort — the worker is fully
      // functional even if naming fails, so we don't roll back the
      // spawn on this. The user just sees the SDK default in the
      // picker until they rename it manually.
      try {
        worker.session.setSessionName(p.name);
      } catch (e) {
        process.stderr.write(
          JSON.stringify({
            level: "warn",
            time: new Date().toISOString(),
            msg: "orchestration-worker-rename-failed",
            workerId: worker.sessionId,
            requestedName: p.name,
            err: e instanceof Error ? e.message : String(e),
          }) + "\n",
        );
      }
      // Build the initial prompt: optional context summary + the
      // caller's prompt. The context summary is prepended as its
      // own paragraph so the worker LLM can clearly distinguish
      // background from the task.
      const initialPrompt =
        p.contextSummary !== undefined && p.contextSummary.length > 0
          ? `# Handoff context\n${p.contextSummary}\n\n# Task\n${p.initialPrompt}`
          : p.initialPrompt;
      // Fire the initial prompt. Fire-and-forget — the supervisor
      // will see the turn outcome via its inbox; making the tool
      // wait here would block the supervisor's loop for the entire
      // worker turn.
      worker.session.prompt(initialPrompt).catch((e: unknown) => {
        process.stderr.write(
          JSON.stringify({
            level: "warn",
            time: new Date().toISOString(),
            msg: "orchestration-worker-initial-prompt-failed",
            workerId: worker.sessionId,
            err: e instanceof Error ? e.message : String(e),
          }) + "\n",
        );
      });
      // Push a synthetic `session_list_changed` event to the
      // supervisor's SSE clients so the sidebar picks up the new
      // worker immediately — without this, the sidebar only refreshes
      // when the supervisor's enclosing turn ends (potentially many
      // seconds later, since the supervisor often continues working
      // after the spawn). The client handles this event by calling
      // `loadSessionsForProject(projectId)`.
      const sup = getSession(supervisorId);
      if (sup !== undefined) {
        for (const client of sup.clients) {
          try {
            client.send({
              type: "session_list_changed",
              reason: "spawn_worker",
              projectId: supLive.projectId,
              sessionId: worker.sessionId,
            });
          } catch {
            // SSE client dropped — registry's own client cleanup
            // will remove it on the next event.
          }
        }
      }
      return ok(
        {
          workerId: worker.sessionId,
          name: worker.session.sessionName ?? p.name,
          projectId: worker.projectId,
        },
        `Spawned worker "${p.name}" (${worker.sessionId}). Initial prompt delivered. ` +
          `Monitor via orchestrate_read_inbox or orchestrate_read_worker.`,
      );
    },
  } satisfies ToolDefinition;
}

// ---- list_workers ----

function createListWorkers(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_list_workers",
    label: "List workers",
    description:
      "Survey worker state (live / idle / streaming / cold) + activity. " +
      "DO NOT poll — worker events push into your inbox, you're woken " +
      "automatically. Call once before spawning, or when an inbox event " +
      "needs neighbour-worker context.",
    parameters: Type.Unsafe<Record<string, unknown>>({ type: "object", properties: {} }),
    async execute() {
      interface WorkerRow {
        workerId: string;
        state:
          | "cold"
          | "idle"
          | "streaming"
          | "running"
          | "ended"
          | "errored"
          | "stopped"
          | "deleted"
          | "awaiting_question";
        isLive: boolean;
        isStreaming: boolean;
        messageCount: number | null;
        lastActivityAt: string | null;
        name: string | null;
      }
      const ids = await getWorkerIds(supervisorId);
      const workers: WorkerRow[] = await Promise.all(
        ids.map(async (workerId) => {
          const rec = await getWorkerRecord(workerId);
          const live = getSession(workerId);
          if (live === undefined) {
            return {
              workerId,
              state: rec?.state ?? "cold",
              isLive: false,
              isStreaming: false,
              messageCount: null,
              lastActivityAt: rec?.lastStateAt ?? null,
              name: null,
            };
          }
          return {
            workerId,
            state:
              rec?.state === "running" ||
              rec?.state === "awaiting_question" ||
              rec?.state === "errored" ||
              rec?.state === "stopped" ||
              rec?.state === "deleted"
                ? rec.state
                : live.session.isStreaming
                  ? "streaming"
                  : (rec?.state ?? "idle"),
            isLive: true,
            isStreaming: live.session.isStreaming,
            messageCount: live.session.messages.length,
            lastActivityAt: live.lastActivityAt.toISOString(),
            name: live.session.sessionName ?? null,
          };
        }),
      );
      const summary =
        `${workers.length} worker(s) registered. ` +
        `${workers.filter((w) => w.state === "running" || w.state === "streaming").length} running, ` +
        `${workers.filter((w) => w.state === "idle" || w.state === "ended").length} idle/ended, ` +
        `${workers.filter((w) => w.state === "awaiting_question").length} awaiting question, ` +
        `${workers.filter((w) => w.state === "cold").length} cold.`;
      const rows = workers.map((w) => {
        const label = w.name ?? "(unnamed)";
        const msgs = w.messageCount !== null ? `${w.messageCount} msgs` : "no live state";
        const last = w.lastActivityAt !== null ? `last activity ${w.lastActivityAt}` : "";
        return `- ${w.state.padEnd(9)} "${label}" (${w.workerId}) — ${msgs}${last !== "" ? `, ${last}` : ""}`;
      });
      const body = rows.length === 0 ? "(no workers spawned yet)" : rows.join("\n");
      return ok({ workers }, `${summary}\n${body}`);
    },
  } satisfies ToolDefinition;
}

// ---- read_worker ----

const readWorkerSchema = {
  type: "object",
  required: ["workerId"],
  additionalProperties: false,
  properties: {
    workerId: { type: "string", minLength: 1 },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description:
        "Most-recent messages to return. Default 1 — the single latest " +
        "message is enough for most decisions. Bump only to inspect a " +
        "multi-turn reasoning chain. Bigger `limit` costs more supervisor " +
        "context.",
    },
  },
} as const;

function createReadWorker(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_read_worker",
    label: "Read worker transcript",
    description:
      "Fetch a worker's most recent messages (newest-last). Default `limit` " +
      "is 1. DO NOT poll waiting for the worker to finish — worker events " +
      "push into your inbox, you're woken automatically. Call this in " +
      "REACTION to an inbox event, or when the user asks to inspect a " +
      "worker. Auto-resumes cold workers.",
    parameters: Type.Unsafe<Record<string, unknown>>(readWorkerSchema),
    async execute(_toolCallId, params) {
      const p = params as { workerId: string; limit?: number };
      const guard = await assertOwns(supervisorId, p.workerId);
      if (guard !== undefined) return guard;
      let live = getSession(p.workerId);
      if (live === undefined) {
        try {
          live = await resumeSessionById(p.workerId);
        } catch (e) {
          if (e instanceof SessionNotFoundError) {
            return err("worker_session_missing", `Worker session ${p.workerId} not on disk.`);
          }
          return err("resume_failed", e instanceof Error ? e.message : String(e));
        }
      }
      const limit = Math.min(Math.max(p.limit ?? 1, 1), 100);
      const all = live.session.messages;
      const tail = all.slice(Math.max(0, all.length - limit));
      const name = live.session.sessionName ?? "(unnamed)";
      const header =
        `Worker "${name}" (${p.workerId}) — ` +
        `${live.session.isStreaming ? "streaming" : "idle"}. ` +
        `Showing the last ${tail.length} of ${all.length} message(s).`;
      const transcript =
        tail.length === 0
          ? "(no messages yet — worker hasn't started its first turn)"
          : renderTranscript(tail, all.length);
      return ok(
        {
          workerId: p.workerId,
          totalMessages: all.length,
          returned: tail.length,
          isStreaming: live.session.isStreaming,
          messages: tail,
        },
        `${header}\n\n${transcript}`,
      );
    },
  } satisfies ToolDefinition;
}

// ---- send_to_worker ----

const sendSchema = {
  type: "object",
  required: ["workerId", "message"],
  additionalProperties: false,
  properties: {
    workerId: { type: "string", minLength: 1 },
    message: {
      type: "string",
      minLength: 1,
      description:
        "The next task or directive — concrete instruction, not " +
        "conversational filler (every send spends a worker turn). " +
        "Typical uses: assign follow-up work, course-correct mid-" +
        "execution (with mode='steer'), or answer a pending " +
        "ask_user_question.",
    },
    mode: {
      type: "string",
      enum: ["prompt", "steer", "followUp"],
      description:
        "`prompt` (default): new turn, or queue if busy. " +
        "`steer`: interrupt the current turn — for course-correction. " +
        "`followUp`: wait for idle, then send — for queued next tasks.",
    },
  },
} as const;

function createSendToWorker(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_send_to_worker",
    label: "Send message to worker",
    description:
      "Assign a follow-up task or directive to a running worker. The message " +
      "is tagged as supervisor-sourced in the worker's transcript so the " +
      "worker LLM can distinguish it from a human user message. Frame each " +
      "send as a concrete instruction (next task, course-correction, " +
      "specific answer to a pending question) — NOT chitchat. Every send " +
      "spends a worker turn.",
    parameters: Type.Unsafe<Record<string, unknown>>(sendSchema),
    async execute(_toolCallId, params) {
      const p = params as {
        workerId: string;
        message: string;
        mode?: "prompt" | "steer" | "followUp";
      };
      const guard = await assertOwns(supervisorId, p.workerId);
      if (guard !== undefined) return guard;
      const live = getSession(p.workerId);
      if (live === undefined) {
        return err(
          "worker_not_live",
          `Worker ${p.workerId} is not currently live. Resume it first (open in the UI or call orchestrate_read_worker).`,
        );
      }
      // Tag the message so the client can render it with a
      // supervisor badge. The marker is part of the message text
      // — not a separate metadata channel — because the SDK's
      // prompt/steer/followUp signature only accepts text. Same
      // pattern as the [orchestration] wake-up prefix in inbox.ts.
      const tagged = `[supervisor:${supervisorId}] ${p.message}`;
      const mode = p.mode ?? "prompt";
      try {
        if (mode === "prompt") {
          live.session.prompt(tagged).catch(() => undefined);
        } else if (mode === "steer") {
          live.session.steer(tagged).catch(() => undefined);
        } else {
          live.session.followUp(tagged).catch(() => undefined);
        }
      } catch (e) {
        return err("send_failed", e instanceof Error ? e.message : String(e));
      }
      return ok(
        { workerId: p.workerId, mode, accepted: true },
        `Queued ${mode} message to worker ${p.workerId}.`,
      );
    },
  } satisfies ToolDefinition;
}

// ---- interrupt_worker ----

const interruptSchema = {
  type: "object",
  required: ["workerId"],
  additionalProperties: false,
  properties: { workerId: { type: "string", minLength: 1 } },
} as const;

function createInterruptWorker(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_interrupt_worker",
    label: "Interrupt worker",
    description:
      "Abort the worker's current turn. Idempotent on idle workers. " +
      "The worker session itself stays live; use `orchestrate_kill_worker` " +
      "to fully terminate.",
    parameters: Type.Unsafe<Record<string, unknown>>(interruptSchema),
    async execute(_toolCallId, params) {
      const p = params as { workerId: string };
      const guard = await assertOwns(supervisorId, p.workerId);
      if (guard !== undefined) return guard;
      const live = getSession(p.workerId);
      if (live === undefined) {
        return err("worker_not_live", `Worker ${p.workerId} is not currently live.`);
      }
      try {
        await live.session.abort();
      } catch (e) {
        return err("abort_failed", e instanceof Error ? e.message : String(e));
      }
      return ok(
        { workerId: p.workerId, aborted: true },
        `Aborted worker ${p.workerId}'s current turn.`,
      );
    },
  } satisfies ToolDefinition;
}

// ---- kill_worker ----

const killSchema = {
  type: "object",
  required: ["workerId"],
  additionalProperties: false,
  properties: {
    workerId: { type: "string", minLength: 1 },
    deleteOnDisk: {
      type: "boolean",
      description:
        "Deprecated compatibility flag. Killed workers are always moved out " +
        "of the live session tree and preserved in the 7-day archive so they " +
        "disappear from the sidebar without losing the transcript.",
    },
  },
} as const;

function createKillWorker(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_kill_worker",
    label: "Kill worker",
    description:
      "Dispose the worker session (terminate any in-flight turn, close " +
      "SSE clients), move its transcript into the 7-day archive so it " +
      "disappears from the sidebar, and unregister it from this supervisor.",
    parameters: Type.Unsafe<Record<string, unknown>>(killSchema),
    async execute(_toolCallId, params) {
      const p = params as { workerId: string; deleteOnDisk?: boolean };
      const guard = await assertOwns(supervisorId, p.workerId);
      if (guard !== undefined) return guard;
      const result = await killWorkerAndArchive({ supervisorId, workerId: p.workerId });
      return ok(
        {
          workerId: p.workerId,
          wasLive: result.wasLive,
          archiveStatus: result.archiveStatus,
          // Backward-compatible detail for older consumers that looked for
          // the pre-archive flag name. "Deleted" means gone from live
          // discovery, not purged from the retention archive.
          diskDeleted: result.archiveStatus === "archived",
        },
        `Killed worker ${p.workerId}${
          result.archiveStatus === "archived" ? " (transcript archived)" : ""
        }.`,
      );
    },
  } satisfies ToolDefinition;
}

// ---- detach_worker ----

const detachSchema = {
  type: "object",
  required: ["workerId"],
  additionalProperties: false,
  properties: { workerId: { type: "string", minLength: 1 } },
} as const;

function createDetachWorker(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_detach_worker",
    label: "Detach worker",
    description:
      "Drop the supervisor↔worker link. The worker session stays live " +
      "(transcript untouched) but its events no longer feed this " +
      "supervisor's inbox. Use when the worker is done and should " +
      "continue as a standalone session.",
    parameters: Type.Unsafe<Record<string, unknown>>(detachSchema),
    async execute(_toolCallId, params) {
      const p = params as { workerId: string };
      const guard = await assertOwns(supervisorId, p.workerId);
      if (guard !== undefined) return guard;
      await unregisterWorker(p.workerId);
      return ok(
        { workerId: p.workerId, detached: true },
        `Detached worker ${p.workerId}. It remains live as a standalone session.`,
      );
    },
  } satisfies ToolDefinition;
}

// ---- read_inbox ----

function createReadInbox(supervisorId: string): ToolDefinition {
  return {
    name: "orchestrate_read_inbox",
    label: "Read inbox",
    description:
      "Drain pending worker events (turn-ends, ask-user-question, retry " +
      "failures, process alerts, deletions), oldest-first. The inbox is " +
      "PUSH-DRIVEN — you're woken by an `[orchestration]` system message " +
      "when events arrive, so call this in REACTION to the wake-up, not " +
      "in a polling loop. Items stay in the audit history after draining.",
    parameters: Type.Unsafe<Record<string, unknown>>({ type: "object", properties: {} }),
    async execute() {
      const items = await drainInbox(supervisorId);
      if (items.length === 0) {
        return ok({ items: [] }, "No new inbox items.");
      }
      // Render each item as a readable line. The structured items
      // also go in `details` for the REST layer, but the supervisor
      // LLM reads them from this text — `details` doesn't reach the
      // model's context. Per-item key fields are picked based on
      // the event type so the supervisor sees the load-bearing
      // signal without needing a follow-up read_worker call for
      // every event.
      const lines = items.map((it) => {
        const d = it.data;
        const detail = summarizeInboxData(it.type, d);
        return `- [${it.occurredAt}] ${it.type} worker=${it.workerId}${detail !== "" ? ` — ${detail}` : ""}`;
      });
      return ok(
        {
          items: items.map((it) => ({
            id: it.id,
            type: it.type,
            workerId: it.workerId,
            occurredAt: it.occurredAt,
            data: it.data,
          })),
        },
        `Drained ${items.length} inbox item(s):\n${lines.join("\n")}`,
      );
    },
  } satisfies ToolDefinition;
}

// ---- public factory ----

/**
 * Build the complete orchestration tool set for a supervisor session.
 * Returns 8 tools. Caller (session-registry) is responsible for
 * checking `isOrchestrationEnabled()` and the per-session supervisor
 * flag BEFORE calling — this factory just builds the tools.
 *
 * Workers do NOT call this; their customTools array doesn't include
 * any orchestration tools by design (hub-and-spoke enforcement via
 * tool surface).
 */
export function createOrchestrationTools(supervisorId: string): ToolDefinition[] {
  return [
    createSpawnWorker(supervisorId),
    createListWorkers(supervisorId),
    createReadWorker(supervisorId),
    createSendToWorker(supervisorId),
    createInterruptWorker(supervisorId),
    createKillWorker(supervisorId),
    createDetachWorker(supervisorId),
    createReadInbox(supervisorId),
  ];
}

/** Public for the allowlist machinery in session-registry. */
export const ORCHESTRATION_TOOL_NAMES = [
  "orchestrate_spawn_worker",
  "orchestrate_list_workers",
  "orchestrate_read_worker",
  "orchestrate_send_to_worker",
  "orchestrate_interrupt_worker",
  "orchestrate_kill_worker",
  "orchestrate_detach_worker",
  "orchestrate_read_inbox",
] as const;

/** Helper: best-effort sanity check that `findSessionLocation` can
 *  reach the worker. Used by tests; not used by the tools themselves
 *  because every tool that needs the session already calls
 *  `getSession`/`resumeSessionById` directly. */
export async function workerLocationExists(workerId: string): Promise<boolean> {
  const loc = await findSessionLocation(workerId);
  return loc !== undefined;
}

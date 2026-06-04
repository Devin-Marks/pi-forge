import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { config } from "../config.js";
import { buildListMessage, buildStartMessage, err, ok } from "./envelope.js";
import { processManager } from "./manager.js";
import { PROMPT_GUIDELINES, PROMPT_SNIPPET, TOOL_DESCRIPTION } from "./prompt-strings.js";
import {
  TOOL_LABEL,
  TOOL_NAME,
  type ExecuteResult,
  type LogWatch,
  type ProcessAction,
} from "./types.js";

/**
 * JSON Schema for `process` tool params. Mirrors `@aliou/pi-processes`'s
 * TypeBox schema field-for-field so an agent prompt authored
 * against the plugin sees the same input surface.
 */
const inputSchema = {
  type: "object",
  required: ["action"],
  properties: {
    action: {
      type: "string",
      enum: ["start", "list", "output", "logs", "kill", "clear", "write"],
    },
    command: { type: "string", description: "Command to run (required for start)" },
    name: {
      type: "string",
      description:
        "Friendly name for the process (required for start, e.g. 'backend-dev', 'test-runner')",
    },
    id: {
      type: "string",
      description:
        "Process ID, returned by start and list actions (required for output/kill/logs/write)",
    },
    input: {
      type: "string",
      description: "Data to write to process stdin (required for write action)",
    },
    end: {
      type: "boolean",
      description:
        "Close stdin after writing (optional for write action, use for programs reading until EOF)",
    },
    alertOnSuccess: {
      type: "boolean",
      description:
        "Get a turn to react when process completes successfully (default: false). Use for builds/tests where you need confirmation.",
    },
    alertOnFailure: {
      type: "boolean",
      description:
        "Get a turn to react when process fails/crashes (default: true). Use to be alerted of unexpected failures.",
    },
    alertOnKill: {
      type: "boolean",
      description:
        "Get a turn to react when process is killed by external signal (default: false). Note: killing via tool never triggers a turn.",
    },
    logWatches: {
      type: "array",
      items: {
        type: "object",
        required: ["pattern"],
        additionalProperties: false,
        properties: {
          pattern: {
            type: "string",
            description: "Regular expression pattern to match against process output lines",
          },
          stream: {
            type: "string",
            enum: ["stdout", "stderr", "both"],
            description:
              "Which stream to watch (default: both). Use stdout/stderr to reduce noise.",
          },
          repeat: {
            type: "boolean",
            description: "Trigger every time this pattern matches (default: false, one-time)",
          },
        },
      },
    },
  },
} as const;

interface ToolParams {
  action: ProcessAction | string;
  command?: string;
  name?: string;
  id?: string;
  input?: string;
  end?: boolean;
  alertOnSuccess?: boolean;
  alertOnFailure?: boolean;
  alertOnKill?: boolean;
  logWatches?: LogWatch[];
}

const POLL_SUPPRESSION_MS = 15_000;

interface PollObservation {
  at: number;
  signature: string;
}

const pollObservations = new Map<string, PollObservation>();

function shouldSuppressPoll(key: string, signature: string, now = Date.now()): boolean {
  const prior = pollObservations.get(key);
  pollObservations.set(key, { at: now, signature });
  return (
    prior !== undefined && prior.signature === signature && now - prior.at < POLL_SUPPRESSION_MS
  );
}

function pollingSuppressedMessage(action: "list" | "output"): string {
  return `Polling suppressed: process.${action} was called again while live process state/output had not changed. Do not call process.${action} repeatedly to wait; continue other work or rely on alertOnSuccess / alertOnFailure / logWatches notifications.`;
}

function validateLogWatches(watches: LogWatch[] | undefined): string | null {
  if (watches === undefined) return null;
  if (!Array.isArray(watches)) return "Invalid parameter: logWatches must be an array";
  for (const [i, w] of watches.entries()) {
    if (typeof w.pattern !== "string" || w.pattern.trim().length === 0) {
      return `Invalid logWatches[${i}].pattern: expected non-empty string`;
    }
    try {
      new RegExp(w.pattern);
    } catch (e) {
      return `Invalid logWatches[${i}].pattern: ${e instanceof Error ? e.message : "invalid regex"}`;
    }
    if (w.stream !== undefined && !["stdout", "stderr", "both"].includes(w.stream)) {
      return `Invalid logWatches[${i}].stream: expected stdout, stderr, or both`;
    }
    if (w.repeat !== undefined && typeof w.repeat !== "boolean") {
      return `Invalid logWatches[${i}].repeat: expected boolean`;
    }
  }
  return null;
}

/**
 * Build the `process` tool for one session. Bound to the
 * sessionId + workspace path so `start` knows the right cwd and
 * the manager keys state correctly.
 *
 * Contract-compatible with `@aliou/pi-processes`. Implementation
 * is independent; see `manager.ts` for the spawn/lifecycle code
 * and `docs/processes.md` for the cross-reference.
 */
export function createProcessTool(sessionId: string, workspacePath: string): ToolDefinition {
  return {
    name: TOOL_NAME,
    label: TOOL_LABEL,
    description: TOOL_DESCRIPTION,
    promptSnippet: PROMPT_SNIPPET,
    promptGuidelines: PROMPT_GUIDELINES,
    parameters: Type.Unsafe<Record<string, unknown>>(inputSchema),
    async execute(_toolCallId, params): Promise<ExecuteResult> {
      const p = params as ToolParams;
      switch (p.action) {
        case "start":
          return executeStart(sessionId, workspacePath, p);
        case "list":
          return executeList(sessionId);
        case "output":
          return executeOutput(sessionId, p);
        case "logs":
          return executeLogs(sessionId, p);
        case "kill":
          return executeKill(sessionId, p);
        case "clear":
          return executeClear(sessionId);
        case "write":
          return executeWrite(sessionId, p);
        default:
          return err(p.action as ProcessAction, `Unknown action: ${String(p.action)}`);
      }
    },
  } satisfies ToolDefinition;
}

function executeStart(sessionId: string, workspacePath: string, p: ToolParams): ExecuteResult {
  // Defense in depth — the client also hides the tool under
  // MINIMAL_UI, but a stale tab or scripted caller could still
  // invoke it. Refuse at the tool boundary.
  if (config.minimalUi) {
    return err("start", "process.start is disabled under MINIMAL_UI");
  }
  if (p.name === undefined || p.name.length === 0) {
    return err("start", "Missing required parameter: name");
  }
  if (p.command === undefined || p.command.length === 0) {
    return err("start", "Missing required parameter: command");
  }
  const watchErr = validateLogWatches(p.logWatches);
  if (watchErr !== null) return err("start", watchErr);

  let info;
  try {
    const startOpts: import("./types.js").StartOptions = {};
    if (p.alertOnSuccess !== undefined) startOpts.alertOnSuccess = p.alertOnSuccess;
    if (p.alertOnFailure !== undefined) startOpts.alertOnFailure = p.alertOnFailure;
    if (p.alertOnKill !== undefined) startOpts.alertOnKill = p.alertOnKill;
    if (p.logWatches !== undefined) startOpts.logWatches = p.logWatches;
    info = processManager.start(sessionId, p.name, p.command, workspacePath, startOpts);
  } catch (e) {
    return err("start", `Failed to start: ${e instanceof Error ? e.message : String(e)}`);
  }

  return ok({
    action: "start",
    success: true,
    message: buildStartMessage(info),
    process: info,
  });
}

function executeList(sessionId: string): ExecuteResult {
  const processes = processManager.list(sessionId);
  const liveSignature = processes
    .filter((p) => p.endTime === null)
    .map((p) => `${p.id}:${p.status}`)
    .sort()
    .join("|");
  if (liveSignature.length > 0 && shouldSuppressPoll(`${sessionId}:list`, liveSignature)) {
    return err("list", pollingSuppressedMessage("list"));
  }
  return ok({
    action: "list",
    success: true,
    message: buildListMessage(processes),
    processes,
  });
}

function executeOutput(sessionId: string, p: ToolParams): ExecuteResult {
  if (p.id === undefined || p.id.length === 0) {
    return err("output", "Missing required parameter: id");
  }
  const out = processManager.output(sessionId, p.id);
  if (out === undefined) return err("output", `Process not found: ${p.id}`);
  const stdoutTail = out.stdout.slice(Math.max(0, out.stdout.length - 50)).join("\n");
  const stderrTail = out.stderr.slice(Math.max(0, out.stderr.length - 50)).join("\n");
  if (
    out.status === "running" ||
    out.status === "terminating" ||
    out.status === "terminate_timeout"
  ) {
    const signature = `${out.status}:${out.stdout.length}:${out.stderr.length}:${stdoutTail}:${stderrTail}`;
    if (shouldSuppressPoll(`${sessionId}:output:${p.id}`, signature)) {
      return err("output", pollingSuppressedMessage("output"));
    }
  }
  const parts = [`Status: ${out.status}`];
  if (stdoutTail.length > 0) parts.push("--- stdout ---", stdoutTail);
  if (stderrTail.length > 0) parts.push("--- stderr ---", stderrTail);
  return ok({
    action: "output",
    success: true,
    message: parts.join("\n"),
    output: out,
  });
}

function executeLogs(sessionId: string, p: ToolParams): ExecuteResult {
  if (p.id === undefined || p.id.length === 0) {
    return err("logs", "Missing required parameter: id");
  }
  const files = processManager.logFiles(sessionId, p.id);
  if (files === undefined) return err("logs", `Process not found: ${p.id}`);
  const sandboxNote = config.agentToolSandbox.enabled
    ? "\n\nSandbox note: process log files live under server-private forge data and may not be readable by model file tools. Use process output for recent stdout/stderr from sandboxed sessions."
    : "";
  return ok({
    action: "logs",
    success: true,
    message: `Log files for ${p.id}:\n  stdout: ${files.stdoutFile}\n  stderr: ${files.stderrFile}\n\nUse the read tool to inspect them.${sandboxNote}`,
    logFiles: files,
  });
}

async function executeKill(sessionId: string, p: ToolParams): Promise<ExecuteResult> {
  if (p.id === undefined || p.id.length === 0) {
    return err("kill", "Missing required parameter: id");
  }
  const result = await processManager.kill(sessionId, p.id);
  if (!result.ok) {
    if (result.reason === "not_found") {
      return err("kill", `Process not found: ${p.id}`);
    }
    return err("kill", `Failed to kill ${p.id}: ${result.reason}`);
  }
  return ok({
    action: "kill",
    success: true,
    message: `Killed "${result.info.name}" (${result.info.id})`,
    process: result.info,
  });
}

function executeClear(sessionId: string): ExecuteResult {
  const cleared = processManager.clear(sessionId);
  return ok({
    action: "clear",
    success: true,
    message: `Cleared ${cleared} finished process(es)`,
    cleared,
  });
}

async function executeWrite(sessionId: string, p: ToolParams): Promise<ExecuteResult> {
  if (p.id === undefined || p.id.length === 0) {
    return err("write", "Missing required parameter: id");
  }
  if (p.input === undefined) {
    return err("write", "Missing required parameter: input");
  }
  const result = await processManager.write(sessionId, p.id, p.input, p.end === true);
  if (!result.ok) {
    const reason = result.reason;
    const message =
      reason === "not_found"
        ? `Process not found: ${p.id}`
        : reason === "process_exited"
          ? `Process ${p.id} has already exited`
          : reason === "stdin_closed"
            ? `stdin for ${p.id} is already closed`
            : `Failed to write to ${p.id}`;
    return err("write", message);
  }
  return ok({
    action: "write",
    success: true,
    message: p.end === true ? `Wrote to ${p.id} and closed stdin` : `Wrote to ${p.id}`,
  });
}

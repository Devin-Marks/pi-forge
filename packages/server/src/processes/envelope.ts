import { LIVE_STATUSES, type ExecuteResult, type ProcessesDetails } from "./types.js";

/** Truncate a command for one-line display in `list`. */
function truncateCmd(cmd: string, max = 60): string {
  if (cmd.length <= max) return cmd;
  return `${cmd.slice(0, max - 1)}…`;
}

function formatRuntime(start: number, end: number | null): string {
  const ms = (end ?? Date.now()) - start;
  if (ms < 1_000) return `${ms}ms`;
  const s = ms / 1_000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

function formatStatus(p: {
  status: string;
  exitCode: number | null;
  success: boolean | null;
}): string {
  if (LIVE_STATUSES.has(p.status as "running")) return p.status;
  if (p.success === true) return "exited(0)";
  if (p.exitCode !== null) return `${p.status}(${p.exitCode})`;
  return p.status;
}

/**
 * Build the agent-facing result envelope. Per-action `details`
 * fields piggyback on the same flat `ProcessesDetails` shape the
 * plugin uses; agents that switch between implementations see the
 * same field names.
 */
export function ok(details: ProcessesDetails): ExecuteResult {
  return { content: [{ type: "text", text: details.message }], details };
}

export function err(action: ProcessesDetails["action"], message: string): ExecuteResult {
  return {
    content: [{ type: "text", text: message }],
    details: { action, success: false, message },
  };
}

/** `start` summary the model reads. Mirrors the plugin's text shape. */
export function buildStartMessage(p: {
  name: string;
  id: string;
  pid: number;
  stdoutFile: string;
  stderrFile: string;
}): string {
  return [
    `Started "${p.name}" (${p.id}, PID: ${p.pid})`,
    "Log files:",
    `  stdout: ${p.stdoutFile}`,
    `  stderr: ${p.stderrFile}`,
  ].join("\n");
}

/** `list` summary. One line per process, oldest sort handled by caller. */
export function buildListMessage(
  processes: {
    id: string;
    name: string;
    command: string;
    startTime: number;
    endTime: number | null;
    status: string;
    exitCode: number | null;
    success: boolean | null;
  }[],
): string {
  if (processes.length === 0) return "No background processes running";
  const lines = processes.map(
    (p) =>
      `${p.id} "${p.name}": ${truncateCmd(p.command)} [${formatStatus(p)}] ${formatRuntime(p.startTime, p.endTime)}`,
  );
  return `${processes.length} process(es):\n${lines.join("\n")}`;
}

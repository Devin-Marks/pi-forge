/**
 * Shape definitions for the `process` tool. The wire contract —
 * tool name (`process`), action enum (`start | list | output |
 * logs | kill | clear | write`), per-process `ProcessInfo`
 * fields, status state machine, log-watch shape, and
 * `ProcessesDetails` envelope — is contract-compatible with
 * `@aliou/pi-processes`. An agent prompt authored against the
 * plugin works against this implementation unchanged.
 *
 * Implementation is independent; types and validation rules were
 * derived from the plugin's published schema and tests. See
 * `docs/processes.md` for the cross-reference.
 */

export const TOOL_NAME = "process";
export const TOOL_LABEL = "Process";

export type ProcessAction = "start" | "list" | "output" | "logs" | "kill" | "clear" | "write";

/**
 * Lifecycle states. `terminating` is the window between SIGTERM
 * and the grace deadline; `terminate_timeout` is the moment we
 * escalate to SIGKILL. Both collapse into either `exited` or
 * `killed` once the OS reports the actual exit.
 */
export type ProcessStatus = "running" | "terminating" | "terminate_timeout" | "exited" | "killed";

export const LIVE_STATUSES: ReadonlySet<ProcessStatus> = new Set([
  "running",
  "terminating",
  "terminate_timeout",
]);

export type LogWatchStream = "stdout" | "stderr" | "both";

export interface LogWatch {
  pattern: string;
  stream?: LogWatchStream;
  repeat?: boolean;
}

/**
 * Per-process snapshot returned by the manager and exposed on the
 * wire. Field order pinned by the plugin's tests; adding fields is
 * safe, renaming is not.
 */
export interface ProcessInfo {
  id: string;
  name: string;
  pid: number;
  command: string;
  cwd: string;
  startTime: number;
  endTime: number | null;
  status: ProcessStatus;
  exitCode: number | null;
  /** null while running; true on exit code 0; false otherwise. */
  success: boolean | null;
  stdoutFile: string;
  stderrFile: string;
  alertOnSuccess: boolean;
  alertOnFailure: boolean;
  alertOnKill: boolean;
}

export interface LogWatchMatchEvent {
  processId: string;
  processName: string;
  processCommand: string;
  source: "stdout" | "stderr";
  line: string;
  watch: {
    index: number;
    pattern: string;
    stream: LogWatchStream;
    repeat: boolean;
  };
}

export interface StartOptions {
  alertOnSuccess?: boolean;
  alertOnFailure?: boolean;
  alertOnKill?: boolean;
  logWatches?: LogWatch[];
  toolEnv?: Record<string, string>;
}

/**
 * `details` envelope returned to the agent. Per-action fields are
 * optional; `action` + `success` + `message` are always present.
 */
export interface ProcessesDetails {
  action: ProcessAction;
  success: boolean;
  message: string;
  process?: ProcessInfo;
  processes?: ProcessInfo[];
  output?: { stdout: string[]; stderr: string[]; status: string };
  logFiles?: { stdoutFile: string; stderrFile: string };
  cleared?: number;
}

export interface ExecuteResult {
  content: { type: "text"; text: string }[];
  details: ProcessesDetails;
}

export type KillResult =
  | { ok: true; info: ProcessInfo }
  | { ok: false; info: ProcessInfo; reason: "timeout" | "error" }
  | { ok: false; info: undefined; reason: "not_found" };

export type WriteResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "process_exited" | "stdin_closed" | "write_error";
    };

/**
 * Reason a `process_alert` event was emitted. Mirrors the three
 * `alertOn*` flags on StartOptions:
 *   - `success`: clean exit, exitCode 0, alertOnSuccess set.
 *   - `failure`: non-zero exit (and not killed externally),
 *                alertOnFailure set.
 *   - `killed`:  killed by external signal (NOT by the `process kill`
 *                tool — that's intentional, would be redundant to
 *                notify the agent of its own action), alertOnKill set.
 */
export type ProcessAlertReason = "success" | "failure" | "killed";

/**
 * Public manager events fanned out to listeners (SSE bridge,
 * watches, etc.). All carry the sessionId so the SSE layer can
 * route correctly without needing to know which manager produced
 * the event.
 */
export type ManagerEvent =
  | { type: "process_started"; sessionId: string; info: ProcessInfo }
  | { type: "process_ended"; sessionId: string; info: ProcessInfo }
  | { type: "process_output_changed"; sessionId: string; id: string }
  | { type: "process_watch_matched"; sessionId: string; match: LogWatchMatchEvent }
  | { type: "processes_changed"; sessionId: string }
  | {
      type: "process_alert";
      sessionId: string;
      info: ProcessInfo;
      reason: ProcessAlertReason;
    };

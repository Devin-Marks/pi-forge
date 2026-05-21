import { useState } from "react";
import { Check, Loader2, MessageSquarePlus, Terminal, X } from "lucide-react";
import { useQuickActionRunsStore, type QuickActionRun } from "../store/quick-actions-store";
import { useComposerStore } from "../store/composer-store";

interface Props {
  run: QuickActionRun;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * Inline "I ran a chip" card. Lives in the chat scroll alongside
 * agent messages so the user has a visual trail of what they
 * triggered and what came back — same visual idiom as the existing
 * tool-execution cards (collapsed details + colored left border for
 * success/fail).
 *
 * `running` state: spinner, abort button.
 * `done` state: exit code, duration, expand for stdout / stderr,
 *   "Use as context" button to push the captured output into the
 *   composer for the next prompt.
 */
export function QuickActionRunCard({ run }: Props) {
  const removeRun = useQuickActionRunsStore((s) => s.removeRun);
  const setPendingInsert = useComposerStore((s) => s.setPendingInsert);
  const [expanded, setExpanded] = useState(false);

  const result = run.result;
  const isRunning = run.status === "running";
  const isError = run.error !== undefined;
  const success = result?.success === true && !isError;
  const exitCode = result?.exitCode ?? null;

  // Left border color encodes the headline result: amber while
  // running, green on clean success, red on failure (incl. error,
  // timeout, non-zero exit, abort).
  const borderClass = isRunning
    ? "border-l-amber-500 light:border-l-amber-600"
    : success
      ? "border-l-emerald-500 light:border-l-emerald-600"
      : "border-l-red-500 light:border-l-red-600";

  const statusLabel = isRunning
    ? "running"
    : isError
      ? "error"
      : result?.timedOut === true
        ? "timed out"
        : run.status === "aborted"
          ? "aborted"
          : exitCode === 0
            ? "exit 0"
            : `exit ${exitCode ?? "?"}`;

  // Combined output for the "Use as context" button. Kept simple —
  // fenced with the action name so the agent has framing without us
  // doing heavyweight rendering.
  const buildContextSnippet = (): string => {
    if (result === undefined) return "";
    const out: string[] = [`Ran quick action: ${run.actionName}`, ""];
    if (result.stdout.length > 0) {
      out.push("```", result.stdout.replace(/\s+$/, ""), "```");
    }
    if (result.stderr.length > 0) {
      out.push("", "stderr:", "```", result.stderr.replace(/\s+$/, ""), "```");
    }
    if (result.exitCode !== null && result.exitCode !== 0) {
      out.push("", `exit code: ${result.exitCode}`);
    }
    return out.join("\n");
  };

  return (
    <div
      className={`rounded-lg border border-neutral-800 border-l-4 bg-neutral-900/40 px-3 py-2 text-xs light:border-neutral-300 light:bg-neutral-50 ${borderClass}`}
    >
      <div className="flex items-center gap-2">
        <Terminal size={12} className="text-neutral-500 light:text-neutral-600" />
        <span className="font-mono text-neutral-300 light:text-neutral-800">{run.actionName}</span>
        <span className="text-neutral-500 light:text-neutral-600">·</span>
        {isRunning ? (
          <span className="flex items-center gap-1 text-amber-400 light:text-amber-700">
            <Loader2 size={11} className="animate-spin" />
            {statusLabel}
          </span>
        ) : success ? (
          <span className="flex items-center gap-1 text-emerald-400 light:text-emerald-700">
            <Check size={11} />
            {statusLabel}
          </span>
        ) : (
          <span className="flex items-center gap-1 text-red-400 light:text-red-700">
            <X size={11} />
            {statusLabel}
          </span>
        )}
        {result !== undefined && (
          <span className="text-neutral-500 light:text-neutral-600">
            · {formatDuration(result.durationMs)}
          </span>
        )}
        {result?.truncated === true && (
          <span
            className="rounded bg-amber-700/40 px-1 text-[10px] text-amber-100 light:bg-amber-200 light:text-amber-900"
            title="Output exceeded the per-stream cap and was cut off"
          >
            truncated
          </span>
        )}
        <div className="flex-1" />
        {isRunning ? (
          <button
            type="button"
            onClick={() => {
              run.abort();
              // Note: server doesn't expose a per-run abort endpoint
              // yet — the AbortController only stops us from honouring
              // the result. v2 can wire a real /abort. Mark "aborted"
              // optimistically so the card visibly responds.
              useQuickActionRunsStore.getState().updateRun(run.runId, { status: "aborted" });
            }}
            className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 light:text-neutral-600 light:hover:bg-neutral-200"
            title="Stop waiting on this run (server-side abort coming later)"
          >
            Stop
          </button>
        ) : (
          <>
            {result !== undefined && (result.stdout.length > 0 || result.stderr.length > 0) && (
              <button
                type="button"
                onClick={() => setPendingInsert(run.sessionId, buildContextSnippet())}
                className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-sky-400 hover:bg-neutral-800 hover:text-sky-200 light:text-sky-700 light:hover:bg-neutral-200 light:hover:text-sky-900"
                title="Insert the captured output into the composer for your next prompt"
              >
                <MessageSquarePlus size={11} />
                Use as context
              </button>
            )}
            <button
              type="button"
              onClick={() => removeRun(run.runId)}
              className="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 light:text-neutral-500 light:hover:bg-neutral-200 light:hover:text-neutral-900"
              title="Dismiss"
            >
              Dismiss
            </button>
          </>
        )}
      </div>
      {(result !== undefined &&
        (result.stdout.length > 0 || result.stderr.length > 0 || result.exitCode !== 0)) ||
      isError ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 cursor-pointer text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300 light:text-neutral-600 light:hover:text-neutral-900"
        >
          {expanded ? "Hide output" : "Show output"}
        </button>
      ) : null}
      {expanded && (
        <div className="mt-2 space-y-2">
          {isError && (
            <pre className="overflow-auto whitespace-pre-wrap rounded bg-neutral-950 px-2 py-1 font-mono text-[11px] text-red-300 light:bg-red-50 light:text-red-800">
              {run.error}
            </pre>
          )}
          {result !== undefined && result.stdout.length > 0 && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-neutral-500 light:text-neutral-600">
                stdout
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-200 light:bg-white light:text-neutral-800">
                {result.stdout}
              </pre>
            </div>
          )}
          {result !== undefined && result.stderr.length > 0 && (
            <div>
              <div className="mb-0.5 text-[10px] uppercase tracking-wider text-neutral-500 light:text-neutral-600">
                stderr
              </div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded bg-neutral-950 px-2 py-1 font-mono text-[11px] text-red-300 light:bg-red-50 light:text-red-800">
                {result.stderr}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

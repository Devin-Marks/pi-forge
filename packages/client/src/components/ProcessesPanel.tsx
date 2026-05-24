import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  Loader2,
  RotateCcw,
  Trash2,
  XCircle,
  Zap,
} from "lucide-react";
import { api, ApiError } from "../lib/api-client";
import { getStoredToken } from "../lib/auth-client";
import {
  countRunning,
  LIVE_STATUSES,
  selectProcesses,
  selectWatches,
  useProcessesStore,
  type ProcessInfo,
  type ProcessStatus,
} from "../store/processes-store";

/**
 * Right-pane "Processes" tab. Lists processes for the active
 * session grouped by liveness (running on top, exited below).
 * Per-row: status icon + name + truncated command + duration;
 * click to expand → recent output tail + actions (kill / view
 * full log).
 *
 * Cold load: on mount, kick off `api.listProcesses(sessionId)`
 * once. The SSE snapshot lands immediately after connect and
 * supersedes; we only overwrite when the store is empty so we
 * don't clobber fresher SSE data with a stale GET response.
 */
interface Props {
  sessionId: string;
}

export function ProcessesPanel({ sessionId }: Props) {
  const processes = useProcessesStore((s) => selectProcesses(s, sessionId));
  const watches = useProcessesStore((s) => selectWatches(s, sessionId));
  const setProcesses = useProcessesStore((s) => s.setProcesses);
  const clearWatches = useProcessesStore((s) => s.clearWatches);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busyClear, setBusyClear] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api
      .listProcesses(sessionId)
      .then((res) => {
        if (cancelled) return;
        const cur = useProcessesStore.getState().bySession[sessionId];
        if (cur === undefined || cur.length === 0) {
          setProcesses(sessionId, res.processes);
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.code : (err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, setProcesses]);

  const grouped = useMemo(() => groupByLiveness(processes), [processes]);
  const running = countRunning(processes);
  const finished = processes.length - running;

  const onClearFinished = async (): Promise<void> => {
    setBusyClear(true);
    setError(undefined);
    try {
      await api.clearProcesses(sessionId);
      // SSE process_update fans out the new snapshot; no manual
      // store mutation needed.
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusyClear(false);
    }
  };

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-200 light:bg-white light:text-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-xs light:border-neutral-200">
        <span className="font-semibold uppercase tracking-wider text-neutral-400 light:text-neutral-600">
          Processes
        </span>
        <span className="text-neutral-500 light:text-neutral-600">
          {running} running · {finished} finished
        </span>
        <div className="flex-1" />
        {finished > 0 && (
          <button
            type="button"
            onClick={() => void onClearFinished()}
            disabled={busyClear}
            className="flex items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500 hover:text-neutral-200 disabled:opacity-50 light:border-neutral-400 light:text-neutral-600"
            title="Drop all FINISHED processes from the list (running ones stay)"
          >
            <Trash2 size={10} />
            Clear finished
          </button>
        )}
      </header>
      {error !== undefined && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800">
          {error}
        </div>
      )}
      {watches.length > 0 && (
        <div className="flex items-start gap-2 border-b border-amber-700/40 bg-amber-900/20 px-3 py-1.5 text-[11px] text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
          <Bell size={11} className="mt-0.5 shrink-0" />
          <div className="flex-1 space-y-0.5">
            {watches.slice(-3).map((w, i) => (
              <div key={`${w.processId}-${i}`} className="truncate font-mono">
                <span className="text-neutral-500 light:text-neutral-600">[{w.processName}]</span>{" "}
                {w.line}
              </div>
            ))}
            {watches.length > 3 && (
              <div className="text-neutral-500 light:text-neutral-600">
                +{watches.length - 3} more watch match(es)
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => clearWatches(sessionId)}
            className="rounded p-0.5 text-amber-300 hover:text-amber-100 light:text-amber-700 light:hover:text-amber-900"
            title="Clear watch alerts"
          >
            <RotateCcw size={11} />
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {processes.length === 0 ? (
          <p className="px-1 text-[11px] italic text-neutral-500 light:text-neutral-600">
            No background processes yet. The agent will add them here when it starts dev servers,
            test watchers, builds, etc.
          </p>
        ) : (
          <div className="space-y-2">
            {grouped.live.length > 0 && (
              <ProcessGroup label="Running" items={grouped.live} sessionId={sessionId} />
            )}
            {grouped.finished.length > 0 && (
              <ProcessGroup label="Finished" items={grouped.finished} sessionId={sessionId} />
            )}
          </div>
        )}
      </div>
      <footer className="border-t border-neutral-800 px-3 py-1 text-[10px] italic text-neutral-500 light:border-neutral-200 light:text-neutral-600">
        In-memory only — processes don&apos;t survive a server restart.
      </footer>
    </div>
  );
}

function groupByLiveness(processes: readonly ProcessInfo[]): {
  live: ProcessInfo[];
  finished: ProcessInfo[];
} {
  const live: ProcessInfo[] = [];
  const finished: ProcessInfo[] = [];
  for (const p of processes) {
    if (LIVE_STATUSES.has(p.status)) live.push(p);
    else finished.push(p);
  }
  return { live, finished };
}

function ProcessGroup({
  label,
  items,
  sessionId,
}: {
  label: string;
  items: readonly ProcessInfo[];
  sessionId: string;
}) {
  return (
    <div>
      <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-neutral-500 light:text-neutral-600">
        {label}
      </div>
      <div className="space-y-1">
        {items.map((p) => (
          <ProcessRow key={p.id} process={p} sessionId={sessionId} />
        ))}
      </div>
    </div>
  );
}

function ProcessRow({ process, sessionId }: { process: ProcessInfo; sessionId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [output, setOutput] = useState<
    | {
        stdout: string[];
        stderr: string[];
        status: string;
      }
    | undefined
  >(undefined);
  const [busyKill, setBusyKill] = useState(false);
  const [actionErr, setActionErr] = useState<string | undefined>(undefined);
  const isLive = LIVE_STATUSES.has(process.status);

  // Refetch output when this row is expanded AND its parent's
  // SSE process_update fires (caught by the processes list
  // re-render — `process` ref changes when the manager updates).
  // Throttled by virtue of the re-render cadence (lifecycle
  // events are infrequent compared to raw output).
  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    void api
      .getProcessOutput(sessionId, process.id, 80)
      .then((res) => {
        if (!cancelled) setOutput(res);
      })
      .catch(() => {
        // ignore — the disclosure body just stays empty
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, sessionId, process.id, process.endTime, process.status]);

  const setProcesses = useProcessesStore((s) => s.setProcesses);
  const onKill = async (): Promise<void> => {
    setBusyKill(true);
    setActionErr(undefined);
    try {
      const r = await api.killProcess(sessionId, process.id);
      if (!r.ok) setActionErr(r.reason ?? "kill failed");
      // Defensive refetch — SSE process_update fans out the state
      // change automatically, but if the user's browser dropped a
      // frame (backpressure, paused tab, proxy buffering) the UI
      // would stay stuck on "running" until the next event. Pull
      // the canonical state ~800 ms after kill so the row reflects
      // the new status either way. Cheap: GET /processes is just
      // an in-memory list call.
      setTimeout(() => {
        void api
          .listProcesses(sessionId)
          .then((res) => setProcesses(sessionId, res.processes))
          .catch(() => undefined);
      }, 800);
    } catch (err) {
      setActionErr(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusyKill(false);
    }
  };

  const runtime = formatRuntime(process.startTime, process.endTime);
  return (
    <div
      className={`rounded border px-1.5 py-1 text-xs ${borderForStatus(process.status)} ${
        isLive
          ? "bg-neutral-900/40 light:bg-neutral-50"
          : "bg-neutral-900/20 light:bg-neutral-50/60"
      }`}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-1.5 text-left"
      >
        <ChevronRight
          size={11}
          className={`mt-0.5 shrink-0 text-neutral-500 transition-transform light:text-neutral-600 ${
            expanded ? "rotate-90" : ""
          }`}
        />
        <StatusIcon status={process.status} success={process.success} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate font-medium text-neutral-100 light:text-neutral-900">
              {process.name}
            </span>
            <span className="shrink-0 text-[10px] text-neutral-500 light:text-neutral-600">
              {process.id}
            </span>
          </div>
          <div className="truncate font-mono text-[10px] text-neutral-500 light:text-neutral-600">
            {process.command}
          </div>
        </div>
        <span className="shrink-0 text-[10px] text-neutral-500 light:text-neutral-600">
          {runtime}
        </span>
      </button>
      {expanded && (
        <div className="mt-1 space-y-1 pl-[24px]">
          <div className="flex items-center gap-2 text-[10px] text-neutral-500 light:text-neutral-600">
            <span>PID {process.pid}</span>
            {process.exitCode !== null && <span>exit {process.exitCode}</span>}
            <div className="flex-1" />
            {isLive && (
              <button
                type="button"
                onClick={() => void onKill()}
                disabled={busyKill}
                className="flex items-center gap-1 rounded border border-red-700/40 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/40 disabled:opacity-50 light:border-red-400 light:text-red-700 light:hover:bg-red-100"
              >
                <XCircle size={10} />
                Kill
              </button>
            )}
          </div>
          {actionErr !== undefined && (
            <div className="text-[10px] text-red-300 light:text-red-700">{actionErr}</div>
          )}
          {output !== undefined && output.stdout.length > 0 && (
            <details className="rounded bg-neutral-950 light:bg-white">
              <summary className="cursor-pointer px-1 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300 light:text-neutral-600 light:hover:text-neutral-900">
                stdout (tail)
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-1.5 py-1 font-mono text-[10px] text-neutral-300 light:text-neutral-800">
                {output.stdout.join("\n")}
              </pre>
            </details>
          )}
          {output !== undefined && output.stderr.length > 0 && (
            <details className="rounded bg-neutral-950 light:bg-white">
              <summary className="cursor-pointer px-1 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-300 light:text-neutral-600 light:hover:text-neutral-900">
                stderr (tail)
              </summary>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-1.5 py-1 font-mono text-[10px] text-red-300 light:text-red-700">
                {output.stderr.join("\n")}
              </pre>
            </details>
          )}
          <div className="flex gap-2 text-[10px]">
            <FullLogLink sessionId={sessionId} processId={process.id} stream="stdout" />
            <FullLogLink sessionId={sessionId} processId={process.id} stream="stderr" />
          </div>
        </div>
      )}
    </div>
  );
}

function borderForStatus(status: ProcessStatus): string {
  if (status === "running" || status === "terminating") {
    return "border-neutral-700 light:border-neutral-300";
  }
  if (status === "terminate_timeout") return "border-amber-700/50 light:border-amber-400";
  if (status === "killed") return "border-amber-700/40 light:border-amber-400";
  // exited
  return "border-neutral-800 light:border-neutral-200";
}

function StatusIcon({ status, success }: { status: ProcessStatus; success: boolean | null }) {
  if (status === "running")
    return (
      <Loader2
        size={11}
        className="mt-0.5 shrink-0 animate-spin text-emerald-400 light:text-emerald-700"
        aria-label="running"
      />
    );
  if (status === "terminating" || status === "terminate_timeout")
    return (
      <Zap
        size={11}
        className="mt-0.5 shrink-0 text-amber-400 light:text-amber-700"
        aria-label="terminating"
      />
    );
  if (status === "killed")
    return (
      <AlertTriangle
        size={11}
        className="mt-0.5 shrink-0 text-amber-400 light:text-amber-700"
        aria-label="killed"
      />
    );
  if (success === true)
    return (
      <CheckCircle2
        size={11}
        className="mt-0.5 shrink-0 text-emerald-400 light:text-emerald-700"
        aria-label="exited 0"
      />
    );
  return (
    <XCircle
      size={11}
      className="mt-0.5 shrink-0 text-red-400 light:text-red-700"
      aria-label="exited non-zero"
    />
  );
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

/**
 * "Full log" link that fetches the log file with the user's auth
 * token attached, then opens the response in a new tab as a blob
 * URL. A bare `<a href={apiUrl} target="_blank">` would fail when
 * auth is enabled: top-level navigation can't carry an
 * `Authorization` header, so the server returns 401 missing_token.
 *
 * The blob URL approach keeps the token out of the URL bar (no
 * history leak, no shareable token-bearing URL) at the cost of
 * loading the whole file into memory first. Acceptable for log
 * files capped at 10 MB by the server's rotation policy.
 */
/**
 * Minimal HTML entity escape for embedding raw log text inside a
 * `<pre>` tag in the new-tab document. Handles the four characters
 * that can break out of `<pre>` content (`&` first, then `<`, `>`,
 * and quotes — quotes matter inside the `<title>`). Tab and
 * newline pass through unchanged so the log layout is preserved.
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function FullLogLink({
  sessionId,
  processId,
  stream,
}: {
  sessionId: string;
  processId: string;
  stream: "stdout" | "stderr";
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | undefined>(undefined);
  const onClick = (): void => {
    // Open the new tab SYNCHRONOUSLY in the click handler so the
    // browser counts it as user-initiated and doesn't trigger the
    // popup blocker. We point it at about:blank first, fetch the
    // log in the background, then navigate the already-open tab
    // to the blob URL when the bytes are ready.
    //
    // The earlier implementation called window.open AFTER `await
    // fetch(...)` — by then the user-gesture chain was broken, the
    // popup got blocked, and the fallback (window.location.assign)
    // navigated the CURRENT tab. The user then saw both:
    // (a) the current tab go to the log file, (b) the popup
    // blocker prompt let them open the new tab anyway. Hence
    // "opens in a new tab, but also changes the current tab."
    //
    // `noopener` / `noreferrer` are intentionally omitted: both
    // cause window.open to return null, breaking our ability to
    // navigate the new tab afterward. The opened content is plain
    // text from our own server (the log file blob), with no JS
    // running in it, so `window.opener` accessibility from the
    // new tab is a non-issue here.
    const newTab = window.open("about:blank", "_blank");
    if (newTab === null) {
      // Even the synchronous open got blocked (some strict popup
      // configurations). Surface the failure rather than the
      // earlier behavior of stealing the current tab.
      setErr("popup blocked — allow popups for this site");
      return;
    }
    setBusy(true);
    setErr(undefined);
    void (async () => {
      try {
        const url = api.processLogFileUrl(sessionId, processId, stream);
        const stored = getStoredToken();
        const headers: Record<string, string> = {};
        if (stored !== undefined) headers.Authorization = `Bearer ${stored.token}`;
        const res = await fetch(url, { headers });
        if (!res.ok) {
          newTab.close();
          setErr(`${res.status} ${res.statusText}`);
          return;
        }
        const text = await res.text();
        // Wrap the log in a minimal dark-themed HTML document
        // instead of serving raw text/plain. Two reasons:
        //
        //   1. Plain text/plain rendering varies wildly by browser:
        //      Chrome may apply auto-dark, Safari/Firefox usually
        //      don't. The previous single-step window.open(blobUrl)
        //      happened to land on whatever the browser's default
        //      for the user's color scheme was, which was dark for
        //      most users — but the about:blank-then-navigate
        //      sequence breaks that heuristic and ends up showing
        //      a white page. Wrapping in HTML with explicit CSS
        //      makes the rendering deterministic and matches the
        //      app's dark posture.
        //   2. Bonus: better typography (monospace, soft wrap, line
        //      numbers possible later), and the <title> shows the
        //      stream + process id in the tab strip instead of an
        //      opaque `blob:...` URL.
        const title = `${stream} — ${processId}`;
        const html =
          `<!doctype html><html><head><meta charset="utf-8">` +
          `<title>${escapeHtml(title)}</title>` +
          `<meta name="color-scheme" content="dark light">` +
          `<style>` +
          `html,body{margin:0;padding:0;background:#0a0a0a;color:#e5e5e5;` +
          `font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;` +
          `font-size:13px;line-height:1.5;tab-size:4}` +
          `@media (prefers-color-scheme: light){html,body{background:#fafafa;color:#171717}}` +
          `pre{margin:0;padding:1rem;white-space:pre-wrap;word-break:break-word}` +
          `</style></head><body><pre>${escapeHtml(text)}</pre></body></html>`;
        const blob = new Blob([html], { type: "text/html;charset=utf-8" });
        const blobUrl = URL.createObjectURL(blob);
        // Navigate the already-open tab to the blob. `location =`
        // (rather than `location.replace`) leaves a single
        // about:blank entry in that tab's history, which is the
        // expected back-button behavior.
        newTab.location.href = blobUrl;
        // Revoke after the new tab has had time to load it.
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
      } catch (e) {
        newTab.close();
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="text-sky-400 hover:underline disabled:opacity-50 light:text-sky-700"
      title={err}
    >
      {busy ? "loading…" : err !== undefined ? `${stream}: ${err}` : `full ${stream} log`}
    </button>
  );
}

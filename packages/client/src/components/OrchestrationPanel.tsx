import { useEffect, useState } from "react";
import { Loader2, RefreshCw, Users, X } from "lucide-react";
import {
  api,
  ApiError,
  type InboxItemType,
  type InboxItemWire,
  type SessionLink,
  type WorkerSummary,
} from "../lib/api-client";
import { useUiConfigStore } from "../store/ui-config-store";
import { useSessionStore } from "../store/session-store";

interface Props {
  sessionId: string;
  /** Optional close handler — when set, a close button renders in the
   *  header so the panel can be dismissed from inside (used by the
   *  ChatView dropdown integration). */
  onClose?: () => void;
}

/**
 * Per-session orchestration controls. Renders nothing when
 * orchestration is disabled on this server. Otherwise shows the
 * session's role (supervisor / worker / standalone) with appropriate
 * controls:
 *
 *   - standalone: button to enable supervisor mode
 *   - supervisor: worker list + event history + disable button
 *   - worker:     supervisor back-link
 *
 * Side effects (enable/disable/kill/detach) reload the link state
 * after the mutation so the UI stays in sync with the store.
 *
 * The supervisor's worker list polls every 4s while the panel is
 * mounted. Idle UI overhead is small — one cheap HTTP call.
 */
export function OrchestrationPanel({ sessionId, onClose }: Props) {
  const orchestrationEnabled = useUiConfigStore((s) => s.orchestrationEnabled);
  const [link, setLink] = useState<SessionLink | undefined>(undefined);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [inbox, setInbox] = useState<InboxItemWire[]>([]);
  const [showInbox, setShowInbox] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const reload = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const l = await api.getSessionLink(sessionId);
      setLink(l);
      if (l.role === "supervisor") {
        const w = await api.listSupervisorWorkers(sessionId);
        setWorkers(w.workers);
        const i = await api.listSupervisorInbox(sessionId);
        setInbox(i.items);
      } else {
        setWorkers([]);
        setInbox([]);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!orchestrationEnabled) return;
    void reload();
    // Poll for live worker state. 4s — fast enough to feel live,
    // slow enough not to spam the server. Aligns with the cadence
    // the webhooks deliveries panel uses.
    const t = setInterval(() => {
      void reload();
    }, 4_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orchestrationEnabled, sessionId]);

  if (!orchestrationEnabled) return null;

  const role = link?.role ?? "standalone";

  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 text-sm text-neutral-200">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <Users size={14} />
          <span>Orchestration</span>
          <RoleBadge role={role} />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => {
              void reload();
            }}
            title="Refresh"
            className="p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          </button>
          {onClose !== undefined && (
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100"
            >
              <X size={14} />
            </button>
          )}
        </div>
      </div>

      {error !== undefined && (
        <div className="mt-2 rounded bg-red-900/30 px-2 py-1 text-xs text-red-300 light:bg-red-100 light:text-red-800">
          {error}
        </div>
      )}

      {role === "standalone" && (
        <StandaloneControls
          sessionId={sessionId}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onAfter={reload}
        />
      )}
      {role === "supervisor" && link !== undefined && (
        <SupervisorControls
          link={link}
          workers={workers}
          inbox={inbox}
          showInbox={showInbox}
          setShowInbox={setShowInbox}
          busy={busy}
          setBusy={setBusy}
          setError={setError}
          onAfter={reload}
        />
      )}
      {role === "worker" && link !== undefined && <WorkerControls link={link} />}
    </div>
  );
}

function RoleBadge({ role }: { role: "supervisor" | "worker" | "standalone" }) {
  const styles =
    role === "supervisor"
      ? "bg-violet-900/40 text-violet-200 light:bg-violet-100 light:text-violet-800"
      : role === "worker"
        ? "bg-sky-900/40 text-sky-200 light:bg-sky-100 light:text-sky-800"
        : "bg-neutral-800 text-neutral-300";
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${styles}`}>
      {role === "supervisor" ? "Supervisor" : role === "worker" ? "Worker" : "Standalone"}
    </span>
  );
}

function StandaloneControls({
  sessionId,
  busy,
  setBusy,
  setError,
  onAfter,
}: {
  sessionId: string;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (s: string | undefined) => void;
  onAfter: () => Promise<void>;
}) {
  const onEnable = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      // Server-side: enable rebuilds the live AgentSession in-place
      // so the orchestrate_* tools become available immediately. The
      // SSE connection stays attached — no client-side reconnect
      // needed, no flicker, no risk of losing a pre-prompt session
      // to the cold-resume 404 race.
      await api.enableSupervisor(sessionId);
      await onAfter();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 space-y-2">
      <p className="text-xs text-neutral-400">
        This session is standalone. Enable supervisor mode to give this session the{" "}
        <code className="text-xs">orchestrate_*</code> tools — letting it spawn, observe, and
        coordinate other worker sessions in the same project.
      </p>
      <button
        type="button"
        onClick={() => {
          void onEnable();
        }}
        disabled={busy}
        className="rounded bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-70"
      >
        {busy ? "Enabling…" : "Enable supervisor mode"}
      </button>
      <p className="text-[11px] text-neutral-400">
        The agent's tool list refreshes immediately — no reload needed.
      </p>
    </div>
  );
}

function SupervisorControls({
  link,
  workers,
  inbox,
  showInbox,
  setShowInbox,
  busy,
  setBusy,
  setError,
  onAfter,
}: {
  link: SessionLink;
  workers: WorkerSummary[];
  inbox: InboxItemWire[];
  showInbox: boolean;
  setShowInbox: (b: boolean) => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setError: (s: string | undefined) => void;
  onAfter: () => Promise<void>;
}) {
  const openSession = useSessionStore((s) => s.setActiveSession);

  const onDisable = async (): Promise<void> => {
    if (!confirm("Disable supervisor mode? Linked workers become standalone sessions.")) return;
    setBusy(true);
    setError(undefined);
    try {
      // Server-side: disable rebuilds the live AgentSession in-place
      // so the orchestrate_* tools vanish from its tool surface
      // without an SSE reconnect.
      await api.disableSupervisor(link.sessionId);
      await onAfter();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onDetach = async (workerId: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.detachWorker(link.sessionId, workerId);
      await onAfter();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onKill = async (workerId: string): Promise<void> => {
    if (!confirm(`Kill worker ${workerId.slice(0, 8)}? (Transcript stays on disk.)`)) return;
    setBusy(true);
    setError(undefined);
    try {
      // Human-initiated worker deletion from the Web UI is an external
      // session delete from the supervisor agent's perspective, so use the
      // generic session DELETE route. The orchestration kill endpoint stays
      // reserved for supervisor/tool-initiated self-actions and suppresses
      // redundant notifications back to that same supervisor.
      await api.disposeSession(workerId);
      await onAfter();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onResume = async (workerId: string): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.resumeWorker(link.sessionId, workerId);
      await onAfter();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onClearInbox = async (): Promise<void> => {
    if (!confirm("Clear worker event history?")) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.clearSupervisorInbox(link.sessionId);
      await onAfter();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-xs text-neutral-400">
          {workers.length} worker{workers.length === 1 ? "" : "s"}
        </div>
        <button
          type="button"
          onClick={() => {
            void onDisable();
          }}
          disabled={busy}
          className="rounded px-1.5 py-0.5 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-red-400 disabled:opacity-70 light:hover:text-red-600"
        >
          Disable supervisor mode
        </button>
      </div>
      {workers.length === 0 ? (
        <p className="text-xs italic text-neutral-400">
          No workers yet. The agent can spawn one with{" "}
          <code className="text-xs">orchestrate_spawn_worker</code>.
        </p>
      ) : (
        <ul className="divide-y divide-neutral-800 rounded border border-neutral-800 bg-neutral-950">
          {workers.map((w) => (
            <li key={w.workerId} className="flex items-center gap-2 px-2 py-1.5">
              <StateDot state={w.state ?? (w.isLive ? "idle" : "cold")} />
              <button
                type="button"
                onClick={() => openSession(w.workerId)}
                className="flex-1 text-left truncate text-xs hover:underline"
                title={w.workerId}
              >
                <span className="font-medium">{w.name ?? w.workerId.slice(0, 8)}</span>
                {w.messageCount !== undefined && (
                  <span className="ml-1 text-neutral-400">({w.messageCount} msgs)</span>
                )}
              </button>
              <div className="flex items-center gap-1">
                {!w.isLive && (
                  <button
                    type="button"
                    onClick={() => {
                      void onResume(w.workerId);
                    }}
                    disabled={busy}
                    className="px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-violet-300 disabled:opacity-70 light:hover:text-violet-700"
                  >
                    Resume
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    void onDetach(w.workerId);
                  }}
                  disabled={busy}
                  className="px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-amber-300 disabled:opacity-70 light:hover:text-amber-700"
                  title="Detach (worker continues as standalone)"
                >
                  Detach
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void onKill(w.workerId);
                  }}
                  disabled={busy}
                  className="px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-800 hover:text-red-300 disabled:opacity-70 light:hover:text-red-700"
                  title="Kill (dispose live session; transcript stays on disk)"
                >
                  Kill
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details open={showInbox} onToggle={(e) => setShowInbox(e.currentTarget.open)}>
        <summary className="cursor-pointer select-none text-xs text-neutral-400">
          Worker event history ({inbox.length})
        </summary>
        {inbox.length === 0 ? (
          <p className="mt-1 text-xs italic text-neutral-400">No worker events.</p>
        ) : (
          <div className="mt-1 space-y-1">
            <ul className="max-h-48 divide-y divide-neutral-800 overflow-auto rounded border border-neutral-800 bg-neutral-950">
              {inbox.map((item) => (
                <InboxRow key={item.id} item={item} />
              ))}
            </ul>
            <button
              type="button"
              onClick={() => {
                void onClearInbox();
              }}
              disabled={busy}
              className="text-[11px] text-neutral-400 hover:text-red-400 disabled:opacity-70 light:hover:text-red-600"
            >
              Clear event history
            </button>
          </div>
        )}
      </details>
    </div>
  );
}

function InboxRow({ item }: { item: InboxItemWire }) {
  const label = inboxTypeLabel(item.type);
  return (
    <li className="flex items-baseline gap-2 px-2 py-1 text-xs">
      <span
        className={`rounded px-1 py-0.5 ${
          item.delivered
            ? "bg-neutral-800 text-neutral-400"
            : "bg-amber-700/40 text-amber-200 light:bg-amber-200 light:text-amber-900"
        }`}
      >
        {label}
      </span>
      <span className="font-mono text-neutral-400" title={item.workerId}>
        {item.workerId.slice(0, 8)}
      </span>
      <span className="ml-auto text-neutral-400">
        {new Date(item.occurredAt).toLocaleTimeString()}
      </span>
    </li>
  );
}

function inboxTypeLabel(t: InboxItemType): string {
  switch (t) {
    case "worker.ended":
      return "ended";
    case "worker.ask_user":
      return "asked";
    case "worker.auto_retry_failed":
      return "retry failed";
    case "worker.process_alert":
      return "process";
    case "worker.deleted":
      return "deleted";
  }
}

function WorkerControls({ link }: { link: SessionLink }) {
  const openSession = useSessionStore((s) => s.setActiveSession);
  const supervisorId = link.supervisorId;
  if (supervisorId === undefined) return null;
  return (
    <div className="mt-2 text-xs text-neutral-400">
      Owned by supervisor{" "}
      <button
        type="button"
        onClick={() => openSession(supervisorId)}
        className="font-mono underline hover:text-violet-300 light:hover:text-violet-700"
        title={supervisorId}
      >
        {supervisorId.slice(0, 8)}
      </button>
      {link.spawnedFrom !== undefined && link.spawnedFrom.mode === "summary" && (
        <span className="ml-2 italic">(handoff with context summary)</span>
      )}
    </div>
  );
}

function StateDot({ state }: { state: "streaming" | "idle" | "cold" }) {
  const cls =
    state === "streaming"
      ? "bg-emerald-500 animate-pulse"
      : state === "idle"
        ? "bg-sky-500"
        : "bg-neutral-400";
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${cls}`} title={state} aria-label={state} />
  );
}

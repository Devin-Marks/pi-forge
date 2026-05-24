/**
 * Floating popovers anchored to the chat-input footer badges for
 * processes and todos. **Mobile-only.** On desktop the badges keep
 * their original behavior (route to right-pane Processes tab / open
 * the bottom-strip todo panel); the right pane only auto-expands
 * `!isMobile` (see App.tsx), and there's no useful "open full
 * panel" interaction on mobile — these popovers ARE the panel for
 * the mobile case.
 *
 * Shared mechanics:
 *   - Click-outside / Escape closes.
 *   - Anchored above the trigger button, right-aligned.
 *   - Capped height with overflow scroll for long lists.
 *   - Width clamps to the viewport so the popover doesn't overflow.
 */
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api, ApiError } from "../lib/api-client";
import {
  LIVE_STATUSES,
  selectProcesses,
  useProcessesStore,
  type ProcessInfo,
} from "../store/processes-store";
import { selectTodoState, useTodoStore, type Task } from "../store/todo-store";

/**
 * Common shell: outside-click + Escape close, positioned above the
 * trigger. The trigger's bounding rect is captured by the caller
 * via `anchorRef` (see ChatInput.tsx). We use absolute positioning
 * within a wrapping container (the chat-input footer is positioned
 * relative for this purpose).
 */
function PopoverShell({
  open,
  onClose,
  anchorRef,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  title: string;
  children: React.ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      // Clicks on the trigger button itself are the caller's
      // toggle — don't double-close.
      if (anchorRef.current?.contains(target) === true) return;
      if (popoverRef.current?.contains(target) === true) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={popoverRef}
      role="dialog"
      aria-label={title}
      // `bottom-full` parks the popover ABOVE the button (the chat-
      // input badges live at the bottom of the input footer, so the
      // popover would otherwise need to extend below the input
      // bezel). `right-0` right-aligns to the button — works for
      // both processes and todos since they're both on the right
      // edge of the footer.
      className="absolute bottom-full right-0 z-30 mb-1 w-72 max-w-[calc(100vw-1rem)] overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-xl light:border-neutral-300 light:bg-white"
    >
      <header className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-[11px] uppercase tracking-wider text-neutral-400 light:border-neutral-200 light:text-neutral-500">
        <span>{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 light:hover:bg-neutral-100 light:hover:text-neutral-700"
          aria-label="Close"
        >
          <X size={12} />
        </button>
      </header>
      <div className="max-h-72 overflow-y-auto">{children}</div>
    </div>
  );
}

function formatRuntime(startTime: number, endTime: number | null): string {
  const end = endTime ?? Date.now();
  const secs = Math.max(0, Math.floor((end - startTime) / 1000));
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

function StatusBadge({ status }: { status: ProcessInfo["status"] }) {
  // Colors mirror ProcessesPanel for visual consistency between the
  // popover and the full-panel view.
  const cls =
    status === "running"
      ? "bg-emerald-900/40 text-emerald-200 light:bg-emerald-100 light:text-emerald-800"
      : status === "terminating" || status === "terminate_timeout"
        ? "bg-amber-900/40 text-amber-200 light:bg-amber-100 light:text-amber-800"
        : status === "killed"
          ? "bg-red-900/40 text-red-200 light:bg-red-100 light:text-red-800"
          : "bg-neutral-800 text-neutral-300 light:bg-neutral-200 light:text-neutral-700";
  return (
    <span className={`rounded px-1 py-0.5 text-[9px] uppercase tracking-wider ${cls}`}>
      {status}
    </span>
  );
}

export function ProcessesPopover({
  open,
  onClose,
  anchorRef,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  sessionId: string | undefined;
}) {
  const processes = useProcessesStore((s) => selectProcesses(s, sessionId));
  // Show live processes at top, finished after a divider. Most of
  // the time only running matters; we keep finished accessible so a
  // user who tapped after a process exited can still see "yes, it
  // ended" without leaving the input.
  const live = processes.filter((p) => LIVE_STATUSES.has(p.status));
  const finished = processes.filter((p) => !LIVE_STATUSES.has(p.status));

  // Live runtime updates: re-render once per second while the
  // popover is open and there's at least one live process. Cheap
  // (just bumps a counter) and only runs while visible.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!open || live.length === 0) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [open, live.length]);

  const [killingId, setKillingId] = useState<string | undefined>();
  const onKill = async (id: string): Promise<void> => {
    if (sessionId === undefined) return;
    setKillingId(id);
    try {
      await api.killProcess(sessionId, id);
    } catch {
      // Errors surface in the chat-input error banner via the
      // calling component if needed; for the popover, the SSE
      // update will reflect actual status soon either way. Keep
      // the popover quiet.
    } finally {
      setKillingId(undefined);
    }
  };

  return (
    <PopoverShell
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      title={`Processes (${live.length} running)`}
    >
      {processes.length === 0 ? (
        <p className="px-3 py-3 text-xs italic text-neutral-500">No processes.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 light:divide-neutral-200">
          {live.map((p) => (
            <ProcessRow
              key={p.id}
              process={p}
              busy={killingId === p.id}
              onKill={() => void onKill(p.id)}
            />
          ))}
          {finished.length > 0 && live.length > 0 && (
            <li className="bg-neutral-950 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500 light:bg-neutral-100">
              Finished
            </li>
          )}
          {finished.map((p) => (
            <ProcessRow key={p.id} process={p} busy={false} />
          ))}
        </ul>
      )}
    </PopoverShell>
  );
}

function ProcessRow({
  process,
  busy,
  onKill,
}: {
  process: ProcessInfo;
  busy: boolean;
  onKill?: () => void;
}) {
  const isLive = LIVE_STATUSES.has(process.status);
  return (
    <li className="flex items-start justify-between gap-2 px-3 py-2 text-xs">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-neutral-200 light:text-neutral-800">
            {process.name}
          </span>
          <StatusBadge status={process.status} />
        </div>
        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-neutral-500">
          <span>pid {process.pid}</span>
          <span>·</span>
          <span>{formatRuntime(process.startTime, process.endTime)}</span>
          {process.exitCode !== null && (
            <>
              <span>·</span>
              <span>exit {process.exitCode}</span>
            </>
          )}
        </div>
      </div>
      {isLive && onKill !== undefined && (
        <button
          type="button"
          onClick={onKill}
          disabled={busy}
          className="shrink-0 rounded border border-red-800 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-900/40 disabled:opacity-50 light:border-red-300 light:text-red-700 light:hover:bg-red-50"
          title="Kill this process"
        >
          {busy ? "…" : "Kill"}
        </button>
      )}
    </li>
  );
}

function TaskStatusGlyph({ status }: { status: Task["status"] }) {
  // Plain Unicode glyphs — no icon dependency, render at any DPI,
  // copy/paste meaningful. ProgressIcon-style: ●○◐✓.
  const ch =
    status === "completed"
      ? "✓"
      : status === "in_progress"
        ? "◐"
        : status === "deleted"
          ? "×"
          : "○";
  const cls =
    status === "completed"
      ? "text-emerald-400 light:text-emerald-700"
      : status === "in_progress"
        ? "text-amber-400 light:text-amber-700"
        : status === "deleted"
          ? "text-neutral-600 light:text-neutral-400"
          : "text-neutral-500";
  return <span className={`inline-block w-4 text-center ${cls}`}>{ch}</span>;
}

export function TodosPopover({
  open,
  onClose,
  anchorRef,
  sessionId,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  sessionId: string | undefined;
}) {
  const todoState = useTodoStore((s) => selectTodoState(s, sessionId));
  // Skip soft-deleted tombstones in the popover — they exist in
  // state for branch-replay consistency but aren't useful at-a-
  // glance. The full panel keeps them visible behind a toggle.
  const visible = todoState.tasks.filter((t) => t.status !== "deleted");
  const completed = visible.filter((t) => t.status === "completed").length;
  const inProgress = visible.filter((t) => t.status === "in_progress").length;

  return (
    <PopoverShell
      open={open}
      onClose={onClose}
      anchorRef={anchorRef}
      title={
        visible.length === 0
          ? "Tasks"
          : `Tasks · ${completed}/${visible.length}${inProgress > 0 ? ` · ${inProgress} in progress` : ""}`
      }
    >
      {visible.length === 0 ? (
        <p className="px-3 py-3 text-xs italic text-neutral-500">No tasks.</p>
      ) : (
        <ul className="divide-y divide-neutral-800 light:divide-neutral-200">
          {visible.map((t) => (
            <li key={t.id} className="flex items-start gap-2 px-3 py-2 text-xs">
              <TaskStatusGlyph status={t.status} />
              <span
                className={`min-w-0 flex-1 ${
                  t.status === "completed"
                    ? "text-neutral-500 line-through light:text-neutral-400"
                    : "text-neutral-200 light:text-neutral-800"
                }`}
              >
                {t.subject}
              </span>
            </li>
          ))}
        </ul>
      )}
    </PopoverShell>
  );
}

/**
 * `ApiError` is imported for the same reason as in ProcessesPanel:
 * the kill route can fail with a typed error. We currently swallow
 * silently in the popover for noise reasons, but keep the import
 * so a future "show error inline" change is one line away.
 */
void ApiError;

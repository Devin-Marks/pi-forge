import { useEffect, useMemo, useState } from "react";
import { Check, ChevronRight, Circle, Loader2, X } from "lucide-react";
import { api, ApiError } from "../lib/api-client";
import {
  deriveCounts,
  selectTodoState,
  useTodoStore,
  type Task,
  type TaskStatus,
} from "../store/todo-store";

interface Props {
  sessionId: string;
  onClose: () => void;
}

/**
 * Bottom-strip todo panel — splits the right pane's vertical
 * column. Renders grouped checklist (in-progress, pending,
 * completed) with click-to-expand for description / blockedBy.
 * Updates live from SSE.
 *
 * Cold-load fallback: if the SSE snapshot hasn't landed yet (or
 * we lost it on a re-mount), an effect kicks off
 * `api.listTodos(sessionId)` once on mount. The result populates
 * the store and the SSE handler takes over from there.
 */
export function TodoPanel({ sessionId, onClose }: Props) {
  const state = useTodoStore((s) => selectTodoState(s, sessionId));
  const setState = useTodoStore((s) => s.set);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void api
      .listTodos(sessionId)
      .then((res) => {
        if (cancelled) return;
        // Only overwrite when the store entry is empty. If SSE has
        // already pushed a more-recent state, don't clobber it
        // with the GET response.
        const cur = useTodoStore.getState().byId[sessionId];
        if (cur === undefined || cur.tasks.length === 0) {
          setState(sessionId, { tasks: res.tasks, nextId: res.nextId });
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.code : (err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, setState]);

  const counts = useMemo(() => deriveCounts(state), [state]);
  const groups = useMemo(() => groupByStatus(state.tasks), [state.tasks]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-950 text-neutral-200 light:bg-white light:text-neutral-900">
      <header className="flex items-center gap-2 border-b border-neutral-800 px-3 py-1.5 text-xs light:border-neutral-200">
        <span className="font-semibold uppercase tracking-wider text-neutral-400 light:text-neutral-600">
          Todos
        </span>
        <span className="text-neutral-500 light:text-neutral-600">
          {counts.completed}/{counts.total}
          {counts.inProgress > 0 ? ` · ${counts.inProgress} in progress` : ""}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 light:hover:bg-neutral-200 light:hover:text-neutral-900"
          title="Hide todo panel"
        >
          <X size={12} />
        </button>
      </header>
      {loadError !== undefined && state.tasks.length === 0 && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800">
          Failed to load todos: {loadError}
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {counts.total === 0 ? (
          <p className="px-1 text-[11px] italic text-neutral-500 light:text-neutral-600">
            No todos yet. The agent will add tasks here when it&apos;s planning multi-step work.
          </p>
        ) : (
          <div className="space-y-2">
            {groups.in_progress.length > 0 && (
              <TaskGroup label="In Progress" tasks={groups.in_progress} />
            )}
            {groups.pending.length > 0 && <TaskGroup label="Pending" tasks={groups.pending} />}
            {groups.completed.length > 0 && (
              <TaskGroup label="Completed" tasks={groups.completed} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function groupByStatus(tasks: readonly Task[]): Record<TaskStatus, Task[]> {
  const out: Record<TaskStatus, Task[]> = {
    pending: [],
    in_progress: [],
    completed: [],
    deleted: [],
  };
  for (const t of tasks) out[t.status].push(t);
  return out;
}

function TaskGroup({ label, tasks }: { label: string; tasks: readonly Task[] }) {
  return (
    <div>
      <div className="mb-1 px-1 text-[10px] uppercase tracking-wider text-neutral-500 light:text-neutral-600">
        {label}
      </div>
      <div className="space-y-0.5">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} />
        ))}
      </div>
    </div>
  );
}

function TaskRow({ task }: { task: Task }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails =
    task.description !== undefined ||
    task.activeForm !== undefined ||
    (task.blockedBy !== undefined && task.blockedBy.length > 0) ||
    task.owner !== undefined;
  return (
    <div className="rounded border border-transparent px-1 py-0.5 text-xs hover:border-neutral-800 light:hover:border-neutral-300">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        className={`flex w-full items-start gap-1.5 text-left ${
          hasDetails ? "cursor-pointer" : "cursor-default"
        }`}
      >
        {hasDetails && (
          <ChevronRight
            size={11}
            className={`mt-0.5 shrink-0 text-neutral-500 transition-transform light:text-neutral-600 ${
              expanded ? "rotate-90" : ""
            }`}
          />
        )}
        {!hasDetails && <span className="inline-block w-[11px] shrink-0" />}
        <StatusIcon status={task.status} activeForm={task.activeForm} />
        <span className="min-w-0 flex-1">
          <span
            className={`${
              task.status === "completed"
                ? "text-neutral-500 line-through light:text-neutral-500"
                : task.status === "in_progress"
                  ? "text-neutral-100 light:text-neutral-900"
                  : "text-neutral-300 light:text-neutral-700"
            }`}
          >
            {task.subject}
          </span>
          {task.status === "in_progress" && task.activeForm !== undefined && (
            <span className="ml-1 text-[10px] italic text-amber-400 light:text-amber-700">
              {task.activeForm}
            </span>
          )}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-500 light:text-neutral-600">
          #{task.id}
        </span>
      </button>
      {expanded && hasDetails && (
        <div className="mt-1 space-y-0.5 pl-[34px] text-[11px] text-neutral-400 light:text-neutral-600">
          {task.description !== undefined && <div>{task.description}</div>}
          {task.blockedBy !== undefined && task.blockedBy.length > 0 && (
            <div>
              <span className="text-neutral-500 light:text-neutral-600">blocked by:</span>{" "}
              {task.blockedBy.map((id) => `#${id}`).join(", ")}
            </div>
          )}
          {task.owner !== undefined && (
            <div>
              <span className="text-neutral-500 light:text-neutral-600">owner:</span> {task.owner}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatusIcon({
  status,
  activeForm,
}: {
  status: TaskStatus;
  activeForm: string | undefined;
}) {
  if (status === "in_progress") {
    return (
      <Loader2
        size={11}
        className="mt-0.5 shrink-0 animate-spin text-amber-400 light:text-amber-700"
        aria-label={activeForm ?? "in progress"}
      />
    );
  }
  if (status === "completed") {
    return (
      <Check
        size={11}
        className="mt-0.5 shrink-0 text-emerald-400 light:text-emerald-700"
        aria-label="completed"
      />
    );
  }
  if (status === "deleted") {
    return (
      <X
        size={11}
        className="mt-0.5 shrink-0 text-neutral-500 light:text-neutral-500"
        aria-label="deleted"
      />
    );
  }
  return (
    <Circle
      size={11}
      className="mt-0.5 shrink-0 text-neutral-500 light:text-neutral-500"
      aria-label="pending"
    />
  );
}

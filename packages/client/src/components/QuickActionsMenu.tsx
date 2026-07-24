import { useEffect, useRef, useState } from "react";
import { ChevronDown, Loader2, MessageSquare, Terminal, Zap } from "lucide-react";
import { api, ApiError } from "../lib/api-client";
import type { QuickAction } from "../lib/api-client";
import {
  useQuickActionRunsStore,
  useQuickActionsStore,
  type QuickActionRun,
} from "../store/quick-actions-store";
import { useUiConfigStore } from "../store/ui-config-store";
import { createChatTimelinePosition } from "../lib/chat-timeline";
import { useSessionStore } from "../store/session-store";
import { useComposerStore } from "../store/composer-store";
import { createClientId } from "../lib/client-id";

/**
 * Toolbar chip rendered in `ChatView`'s top bar (left-aligned). Two
 * action kinds are dispatched here:
 *
 *  - command: POST /quick-actions/:id/run with the project id.
 *    A `QuickActionRun` is pushed into the runs store so the inline
 *    card in the chat scroll picks it up immediately in `running`
 *    state, then mutates to `done`/`aborted` when the request
 *    resolves.
 *  - prompt: dispatched entirely client-side — either `sendPrompt`
 *    (mode: "send") or `composerStore.setPendingInsert` (mode:
 *    "insert"). No server round-trip.
 *
 * Command chips are filtered out under MINIMAL_UI. Defense-in-depth
 * matters: the server `/run` route also returns 403 in that mode.
 */
interface Props {
  sessionId: string;
  projectId: string;
}

function isCommandAction(a: QuickAction): boolean {
  return typeof a.command === "string" && a.command.length > 0;
}

function isPromptAction(a: QuickAction): boolean {
  return typeof a.text === "string" && a.text.length > 0;
}

function randomId(): string {
  return createClientId("run");
}

export function QuickActionsMenu({ sessionId, projectId }: Props) {
  const loaded = useQuickActionsStore((s) => s.loaded);
  const actions = useQuickActionsStore((s) => s.actions);
  const minimal = useUiConfigStore((s) => s.minimal);
  const addRun = useQuickActionRunsStore((s) => s.addRun);
  const updateRun = useQuickActionRunsStore((s) => s.updateRun);
  const runs = useQuickActionRunsStore((s) => s.runs);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const setPendingInsert = useComposerStore((s) => s.setPendingInsert);

  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Click-outside close — mirrors the export menu pattern in ChatView.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current === null) return;
      if (!menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // The list the user actually sees: enabled chips, with command-kind
  // filtered out in minimal mode. Settings still shows them; the menu
  // hides them.
  const visible = actions.filter((a) => {
    if (a.enabled === false) return false;
    if (minimal && isCommandAction(a)) return false;
    return true;
  });

  // Per-action in-flight count for the dropdown row spinner. Counts
  // include runs from OTHER sessions too — if the user clicked a
  // chip in session A then switched to B, the row should still hint
  // that the command is running so they're not surprised by a card
  // landing in A on return.
  const inFlightById = new Map<string, number>();
  let totalInFlight = 0;
  for (const r of runs) {
    if (r.status !== "running") continue;
    totalInFlight += 1;
    inFlightById.set(r.actionId, (inFlightById.get(r.actionId) ?? 0) + 1);
  }

  if (!loaded || visible.length === 0) return null;

  const handleCommand = (action: QuickAction): void => {
    const runId = randomId();
    const controller = new AbortController();
    const timelinePosition = createChatTimelinePosition();
    const run: QuickActionRun = {
      runId,
      sessionId,
      actionId: action.id,
      actionName: action.name,
      startedAt: timelinePosition.timestamp,
      timelineOrder: timelinePosition.order,
      status: "running",
      abort: () => {
        try {
          controller.abort();
        } catch {
          // ignore
        }
      },
    };
    addRun(run);
    void api
      .runQuickAction(action.id, projectId)
      .then((result) => {
        updateRun(runId, { status: controller.signal.aborted ? "aborted" : "done", result });
      })
      .catch((err: unknown) => {
        const message =
          err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message;
        updateRun(runId, { status: "done", error: message });
      });
  };

  const handlePrompt = (action: QuickAction): void => {
    const text = action.text ?? "";
    if (text.length === 0) return;
    const mode = action.mode ?? "send";
    if (mode === "insert") {
      setPendingInsert(sessionId, text);
    } else {
      void sendPrompt(sessionId, text);
    }
  };

  const onPick = (action: QuickAction): void => {
    setOpen(false);
    if (isCommandAction(action)) handleCommand(action);
    else if (isPromptAction(action)) handlePrompt(action);
  };

  return (
    <div ref={menuRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 light:text-neutral-600 light:hover:bg-neutral-200 light:hover:text-neutral-900"
        title="Run a saved quick action"
      >
        <Zap size={11} />
        Actions
        {totalInFlight > 0 && (
          <span
            className="ml-0.5 flex items-center gap-0.5 rounded bg-amber-700/40 px-1 text-[9px] normal-case text-amber-100 light:bg-amber-200 light:text-amber-900"
            title={`${totalInFlight} action${totalInFlight === 1 ? "" : "s"} running`}
          >
            <Loader2 size={9} className="animate-spin" />
            {totalInFlight}
          </span>
        )}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute left-0 top-full z-30 mt-1 min-w-[14rem] max-w-[20rem] rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl light:border-neutral-300 light:bg-white"
        >
          {visible.map((action) => {
            const isCmd = isCommandAction(action);
            const Icon = isCmd ? Terminal : MessageSquare;
            const running = inFlightById.get(action.id) ?? 0;
            return (
              <button
                key={action.id}
                role="menuitem"
                onClick={() => onPick(action)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800 light:text-neutral-800 light:hover:bg-neutral-100"
                title={
                  isCmd
                    ? (action.command ?? "")
                    : `${action.mode === "insert" ? "Insert" : "Send"}: ${action.text ?? ""}`
                }
              >
                <Icon
                  size={12}
                  className={
                    isCmd
                      ? "text-amber-400 light:text-amber-700"
                      : "text-sky-400 light:text-sky-700"
                  }
                />
                <span className="flex-1 truncate">{action.name}</span>
                {running > 0 && (
                  <Loader2 size={11} className="animate-spin text-amber-400 light:text-amber-700" />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

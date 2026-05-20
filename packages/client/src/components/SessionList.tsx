import {
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { ChevronDown, ChevronRight, X } from "lucide-react";
import { EMPTY_SESSIONS, useSessionStore } from "../store/session-store";
import { useProjectStore } from "../store/project-store";
import { ConfirmDialog } from "./Modal";
import type { UnifiedSession } from "../lib/api-client";

interface Props {
  projectId: string;
}

/**
 * Per-project session list. Replaces the "No sessions yet" placeholder that
 * lived under the project rows in Phases 3-7. Loads on mount, click selects,
 * double-click renames. The "new session" affordance lives on the parent
 * project row (a `+` button next to the delete `×`), so this component is
 * read-only for the create path.
 */
export function SessionList({ projectId }: Props) {
  // EMPTY_SESSIONS (stable module-level reference) — see session-store.ts
  // for why we don't write `?? []` directly in Zustand selectors.
  const sessions = useSessionStore((s) => s.byProject[projectId] ?? EMPTY_SESSIONS);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const loadSessionsForProject = useSessionStore((s) => s.loadSessionsForProject);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const disposeSession = useSessionStore((s) => s.disposeSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const setActiveProject = useProjectStore((s) => s.setActive);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  /**
   * Selecting a session also pulls the active-project pointer along
   * to that session's project. Without this, clicking a session
   * under project B while project A was active would set the
   * session pointer (so chat would show that session) but leave
   * the rest of the UI — Files / Changes / Git tabs, project
   * dropdown — pinned to A. The two pointers should always agree.
   */
  const selectSession = (sessionId: string): void => {
    if (activeProjectId !== projectId) setActiveProject(projectId);
    setActiveSession(sessionId);
  };

  // Inline rename state — only one row at a time.
  const [renamingId, setRenamingId] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState("");

  /**
   * Bulk-delete dialog state. Used ONLY for the multi-select Delete
   * button — that path benefits from a confirmation modal because
   * deleting N rows at once is destructive and the count is part of
   * the prompt. Single-row delete (the per-row × button) skips the
   * modal and uses a click-to-confirm pattern instead — see
   * `armedDeleteId` below.
   */
  const [deleteDialog, setDeleteDialog] = useState<{ sessionIds: string[] } | undefined>(undefined);

  /**
   * Click-to-confirm state for the per-row delete ×. First click on a
   * row's × "arms" the button — its background flips red and the
   * tooltip changes to "Click again to delete". A second click within
   * the timeout actually deletes; a click anywhere else, an Escape
   * keypress, or the auto-disarm timer all reset state without
   * deleting. Inspired by VS Code's git "discard changes" inline
   * action and similar two-click patterns — fewer modals interrupting
   * the sidebar flow, but the action still requires deliberate intent.
   *
   * The timeout window is short enough (CLICK_TO_CONFIRM_MS) that an
   * armed button is never "stale" by accident: if the user wandered
   * off, hovering or clicking elsewhere disarms; if they came back
   * later, the next × click re-arms rather than firing.
   */
  const [armedDeleteId, setArmedDeleteId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (armedDeleteId === undefined) return;
    const disarm = (): void => setArmedDeleteId(undefined);
    // Auto-disarm after the window. Don't extend on hover or
    // anything else — the goal is to limit how long an "armed"
    // button can sit forgotten.
    const timer = window.setTimeout(disarm, CLICK_TO_CONFIRM_MS);
    // Outside-click: any click that isn't on the armed button
    // itself disarms. The button's own onClick stops propagation
    // so this handler doesn't see clicks on the button.
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      if (target.closest(`[data-armed-delete="${armedDeleteId}"]`) !== null) return;
      disarm();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") disarm();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [armedDeleteId]);

  const onDeleteClick = (sessionId: string): void => {
    if (armedDeleteId === sessionId) {
      // Second click on the armed button — fire and clear. hard:true
      // unconditionally, same matrix as the bulk path: dispose live +
      // remove JSONL atomically.
      setArmedDeleteId(undefined);
      void disposeSession(sessionId, { hard: true });
      return;
    }
    // First click (or click on a different row's ×) — arm this row.
    setArmedDeleteId(sessionId);
  };

  // Selected session ids for the multiselect / bulk-delete affordance.
  // Cmd/Ctrl+click on a session row toggles selection; plain click
  // selects the session as before.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const clearSelection = (): void => setSelectedIds(new Set());
  const toggleSelected = (sessionId: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  };

  /**
   * Per-parent expansion state for the pi-subagents sub-agent dropdown.
   * Tracks user TOGGLES — undefined entries inherit the default
   * (auto-expanded when the parent has children). Storing toggles
   * rather than absolute state means a freshly-discovered parent
   * with children gets expanded by default without the user having
   * to click the chevron, AND user-collapsed state survives across
   * refetches.
   */
  const [expandedParents, setExpandedParents] = useState<Map<string, boolean>>(new Map());
  const toggleExpanded = (parentId: string, currentlyExpanded: boolean): void => {
    setExpandedParents((prev) => {
      const next = new Map(prev);
      next.set(parentId, !currentlyExpanded);
      return next;
    });
  };

  /**
   * Bucket sessions into top-level rows and per-parent child arrays.
   * Children are excluded from the top-level list (rendered nested
   * under their parent's chevron); orphaned children — children
   * whose parent isn't in this project's session list, e.g. because
   * the parent was deleted — fall back to top-level rendering so they
   * don't disappear from the sidebar entirely.
   */
  const { topLevel, childrenByParent } = useMemo(() => {
    const childrenByParent = new Map<string, UnifiedSession[]>();
    const topLevelIds = new Set(
      sessions.filter((s) => s.parentSessionId === undefined).map((s) => s.sessionId),
    );
    for (const s of sessions) {
      if (s.parentSessionId === undefined) continue;
      if (!topLevelIds.has(s.parentSessionId)) continue; // orphan — keep at top level
      const arr = childrenByParent.get(s.parentSessionId);
      if (arr === undefined) childrenByParent.set(s.parentSessionId, [s]);
      else arr.push(s);
    }
    const topLevel = sessions.filter(
      (s) => s.parentSessionId === undefined || !topLevelIds.has(s.parentSessionId),
    );
    // One-shot diagnostic so a still-broken grouping report can be
    // triaged from the browser console: shows what parentSessionIds
    // came in on the wire and which buckets they landed in. Strip
    // when the sub-agent UX stabilises.
    if (sessions.some((s) => s.parentSessionId !== undefined)) {
      console.info("[subagent] SessionList grouping", {
        projectId,
        sessionCount: sessions.length,
        topLevelCount: topLevel.length,
        childCount: Array.from(childrenByParent.values()).reduce((n, a) => n + a.length, 0),
        topLevelIds: Array.from(topLevelIds),
        parentIdsOnChildren: sessions
          .filter((s) => s.parentSessionId !== undefined)
          .map((s) => s.parentSessionId),
        bucketed: Array.from(childrenByParent.keys()),
      });
    }
    return { topLevel, childrenByParent };
  }, [sessions, projectId]);

  const submitDelete = async (): Promise<void> => {
    if (deleteDialog === undefined) return;
    const ids = deleteDialog.sessionIds;
    setDeleteDialog(undefined);
    // hard:true unconditionally — server's DELETE route handles the
    // live + hard case by disposing the in-memory entry AND
    // removing the on-disk JSONL atomically. The route's docs spell
    // out the full matrix; we always pick the "actually delete" leg.
    for (const id of ids) {
      try {
        await disposeSession(id, { hard: true });
      } catch {
        // store.error renders the first failure; keep going so a
        // single missing/blocked session doesn't strand the rest of
        // the bulk action.
      }
    }
    clearSelection();
  };

  useEffect(() => {
    void loadSessionsForProject(projectId);
  }, [projectId, loadSessionsForProject]);

  const startRename = (sessionId: string, current: string): void => {
    setRenamingId(sessionId);
    setRenameDraft(current);
  };

  const cancelRename = (): void => {
    setRenamingId(undefined);
    setRenameDraft("");
  };

  const commitRename = async (sessionId: string): Promise<void> => {
    const next = renameDraft.trim();
    cancelRename();
    try {
      // Server requires a live session for rename. If the user double-clicks
      // an on-disk-only row we'll surface the 404 via store.error and the
      // App-level banner; no local-only fallback because the SDK is the
      // source of truth for session_info entries.
      await renameSession(sessionId, next);
    } catch {
      // store.error surfaces; nothing else to do here
    }
  };

  const onRenameKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>, sessionId: string): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitRename(sessionId);
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelRename();
    }
  };

  return (
    // `mt-1` separates the first session row from the project row
    // above; without it, the active-row highlight backgrounds (both
    // are `bg-neutral-800`) touch and read as one continuous block.
    <div className="ml-6 mt-1 space-y-0.5">
      {/* "New session" lives on the parent project row in
          ProjectSidebar (the + button on hover). Avoids stacking
          a second action button per project. */}
      {sessions.length === 0 && (
        <p className="px-2 py-1 text-xs italic text-neutral-600">No sessions yet.</p>
      )}
      {selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-2 rounded bg-neutral-900/60 px-2 py-1 text-[11px] text-neutral-300">
          <span>{selectedIds.size} selected</span>
          <div className="flex gap-1">
            <button
              onClick={() => setDeleteDialog({ sessionIds: Array.from(selectedIds) })}
              className="rounded border border-red-700/50 px-1.5 py-0.5 text-red-300 hover:bg-red-900/20 light:border-red-400 light:text-red-700 light:hover:bg-red-50"
            >
              Delete
            </button>
            <button
              onClick={clearSelection}
              className="rounded border border-neutral-700 px-1.5 py-0.5 text-neutral-300 hover:border-neutral-500"
            >
              Clear
            </button>
          </div>
        </div>
      )}
      {/*
        Single-pass render: each parent row, immediately followed by
        its children when the parent is expanded. flatMap returns
        an array per parent — React unwraps it inline so the children
        appear directly under their parent in DOM order, not as a
        separate group at the bottom of the list.
      */}
      {topLevel.flatMap((s) => {
        const children = childrenByParent.get(s.sessionId) ?? [];
        // Default-collapsed: most parents have zero children, and a
        // sweeping "show every run's sub-agents" expansion adds noise
        // to the sidebar. User toggle persists.
        const userToggle = expandedParents.get(s.sessionId);
        const isExpanded = userToggle === true;
        const rows: ReactNode[] = [
          <SessionRow
            key={s.sessionId}
            session={s}
            isActive={s.sessionId === activeSessionId}
            isSelected={selectedIds.has(s.sessionId)}
            isRenaming={renamingId === s.sessionId}
            renameDraft={renameDraft}
            childCount={children.length}
            isExpanded={isExpanded}
            isChild={false}
            onSelect={selectSession}
            onToggleSelect={toggleSelected}
            onStartRename={startRename}
            onChangeRename={setRenameDraft}
            onRenameKeyDown={onRenameKeyDown}
            onCommitRename={(id) => void commitRename(id)}
            onToggleExpanded={toggleExpanded}
            isArmedForDelete={armedDeleteId === s.sessionId}
            onDeleteClick={onDeleteClick}
          />,
        ];
        if (isExpanded) {
          for (const c of children) {
            rows.push(
              <SessionRow
                key={c.sessionId}
                session={c}
                isActive={c.sessionId === activeSessionId}
                isSelected={selectedIds.has(c.sessionId)}
                isRenaming={renamingId === c.sessionId}
                renameDraft={renameDraft}
                childCount={0}
                isExpanded={false}
                isChild={true}
                onSelect={selectSession}
                onToggleSelect={toggleSelected}
                onStartRename={startRename}
                onChangeRename={setRenameDraft}
                onRenameKeyDown={onRenameKeyDown}
                onCommitRename={(id) => void commitRename(id)}
                onToggleExpanded={toggleExpanded}
                isArmedForDelete={armedDeleteId === c.sessionId}
                onDeleteClick={onDeleteClick}
              />,
            );
          }
        }
        return rows;
      })}
      <ConfirmDialog
        open={deleteDialog !== undefined}
        onClose={() => setDeleteDialog(undefined)}
        onConfirm={() => void submitDelete()}
        title={`Delete ${deleteDialog?.sessionIds.length ?? 0} session${(deleteDialog?.sessionIds.length ?? 0) === 1 ? "" : "s"}`}
        message={`Delete the ${deleteDialog?.sessionIds.length ?? 0} selected session${(deleteDialog?.sessionIds.length ?? 0) === 1 ? "" : "s"}? Live sessions are killed and on-disk JSONLs are removed. Cannot be undone.`}
        primaryLabel="Delete all"
        tone="danger"
      />
    </div>
  );
}

const CLICK_TO_CONFIRM_MS = 3000;

interface SessionRowProps {
  session: UnifiedSession;
  isActive: boolean;
  isSelected: boolean;
  isRenaming: boolean;
  renameDraft: string;
  /** Number of pi-subagents children for this session — drives chevron visibility. */
  childCount: number;
  isExpanded: boolean;
  /** When true, render with extra left indent + nested-row treatment. */
  isChild: boolean;
  onSelect: (sessionId: string) => void;
  onToggleSelect: (sessionId: string) => void;
  onStartRename: (sessionId: string, current: string) => void;
  onChangeRename: (next: string) => void;
  onRenameKeyDown: (e: ReactKeyboardEvent<HTMLInputElement>, sessionId: string) => void;
  onCommitRename: (sessionId: string) => void;
  onToggleExpanded: (parentId: string, currentlyExpanded: boolean) => void;
  /** True when this row's × is in its "click again to delete" state. */
  isArmedForDelete: boolean;
  onDeleteClick: (sessionId: string) => void;
}

function SessionRow(props: SessionRowProps) {
  const {
    session: s,
    isActive,
    isSelected,
    isRenaming,
    renameDraft,
    childCount,
    isExpanded,
    isChild,
    onSelect,
    onToggleSelect,
    onStartRename,
    onChangeRename,
    onRenameKeyDown,
    onCommitRename,
    onToggleExpanded,
    isArmedForDelete,
    onDeleteClick,
  } = props;
  const label =
    s.name ??
    (s.firstMessage.length > 0
      ? s.firstMessage.slice(0, 40)
      : `session ${s.sessionId.slice(0, 6)}`);
  return (
    <div
      // Multiselect styling matches the file-tree's selection cue:
      // saturated 2-px LEFT BORDER + tinted bg + hover that doesn't
      // erase the selection. Border lives on every row (transparent
      // when unselected) so toggling selection doesn't shift content
      // by 2 px. Blue, not emerald, to disambiguate from any future
      // success / drop affordances on these rows.
      className={`group flex items-center gap-1 rounded border-l-2 ${isChild ? "ml-4" : ""} px-2 py-0.5 text-xs ${
        isSelected
          ? "border-blue-400 bg-blue-500/15 text-neutral-100 hover:bg-blue-500/25"
          : isActive
            ? "border-transparent bg-neutral-800 text-neutral-100"
            : "border-transparent text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
      }`}
    >
      {/* Chevron column. Only parents with children get an interactive
          chevron; everything else gets a fixed-width spacer so labels
          line up across rows. */}
      {childCount > 0 ? (
        <button
          onClick={() => onToggleExpanded(s.sessionId, isExpanded)}
          className="inline-flex h-4 w-4 shrink-0 items-center justify-center text-neutral-500 hover:text-neutral-200"
          title={`${childCount} sub-agent session${childCount === 1 ? "" : "s"}`}
          aria-label={isExpanded ? "Collapse sub-agents" : "Expand sub-agents"}
        >
          {isExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
      ) : (
        <span className="inline-block h-4 w-4 shrink-0" aria-hidden="true" />
      )}
      {isRenaming ? (
        <input
          autoFocus
          value={renameDraft}
          onChange={(e) => onChangeRename(e.target.value)}
          onKeyDown={(e) => onRenameKeyDown(e, s.sessionId)}
          onBlur={() => onCommitRename(s.sessionId)}
          placeholder={label}
          maxLength={200}
          className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-xs text-neutral-100 outline-none focus:border-neutral-500"
        />
      ) : (
        <button
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey) {
              onToggleSelect(s.sessionId);
              return;
            }
            onSelect(s.sessionId);
          }}
          onDoubleClick={() => onStartRename(s.sessionId, s.name ?? "")}
          className="flex-1 truncate text-left"
          title={`${s.sessionId} — double-click to rename, Cmd/Ctrl+click to select for bulk delete`}
        >
          {s.isLive && <span className="mr-1 text-emerald-500 light:text-emerald-700">●</span>}
          {isChild && (
            <span className="mr-1 text-purple-400 light:text-purple-700" title="sub-agent">
              ↳
            </span>
          )}
          {label}
        </button>
      )}
      {!isRenaming && (
        <button
          // data attribute lets the parent's pointerdown handler detect
          // clicks ON the armed button vs OUTSIDE it without needing a
          // ref dance. stopPropagation here is belt-and-suspenders so a
          // sibling row's listener never sees this click either.
          data-armed-delete={isArmedForDelete ? s.sessionId : undefined}
          onClick={(e) => {
            e.stopPropagation();
            onDeleteClick(s.sessionId);
          }}
          className={
            // Explicit `h-6` (24px) on BOTH variants so the row's
            // height is pinned regardless of the inner content (the
            // armed `Confirm` text + border was sub-24px without
            // this, which let the row shrink on toggle). Computing
            // padding to hit 24px exactly was finicky across font /
            // border combos — pinning the height makes the swap
            // visually identical from a layout standpoint.
            isArmedForDelete
              ? "inline-flex h-6 items-center rounded border border-red-500 px-1.5 text-[11px] font-medium uppercase leading-none tracking-wide text-red-300 hover:bg-red-500/10 light:border-red-600 light:text-red-700 light:hover:bg-red-100"
              : "inline-flex h-6 w-6 items-center justify-center rounded text-neutral-500 hover:text-red-400 light:hover:text-red-700"
          }
          title={
            isArmedForDelete
              ? "Click again to delete (Esc to cancel)"
              : s.isLive
                ? "Delete session — also kills the live shell"
                : "Delete session JSONL from disk"
          }
          aria-label={isArmedForDelete ? "Confirm delete" : "Delete session"}
        >
          {isArmedForDelete ? "Confirm" : <X size={16} />}
        </button>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
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
   * Delete-session dialog state. The × button always means "delete
   * forever" — same behavior for live and cold rows. Earlier we did
   * dispose-only on live rows (preserving the JSONL) which forced a
   * second click to actually remove the file: live → dispose →
   * reappears as cold → hard delete → row vanishes. That two-step
   * was confusing ("the row didn't go away") and inconsistent with
   * how the project-delete flow already works. Single click +
   * confirm = gone, end of story.
   */
  const [deleteDialog, setDeleteDialog] = useState<
    | { kind: "single"; sessionId: string; label: string; isLive: boolean }
    | { kind: "many"; sessionIds: string[] }
    | undefined
  >(undefined);

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
    setDeleteDialog(undefined);
    // hard:true unconditionally — server's DELETE route handles the
    // live + hard case by disposing the in-memory entry AND
    // removing the on-disk JSONL atomically. The route's docs spell
    // out the full matrix; we always pick the "actually delete" leg.
    if (deleteDialog.kind === "single") {
      void disposeSession(deleteDialog.sessionId, { hard: true });
      return;
    }
    for (const id of deleteDialog.sessionIds) {
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

  const onRenameKeyDown = (e: KeyboardEvent<HTMLInputElement>, sessionId: string): void => {
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
              onClick={() => setDeleteDialog({ kind: "many", sessionIds: Array.from(selectedIds) })}
              className="rounded border border-red-700/50 px-1.5 py-0.5 text-red-300 hover:bg-red-900/20"
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
            onAskDelete={(payload) => setDeleteDialog(payload)}
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
                onAskDelete={(payload) => setDeleteDialog(payload)}
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
        title={
          deleteDialog?.kind === "many"
            ? `Delete ${deleteDialog.sessionIds.length} session${deleteDialog.sessionIds.length === 1 ? "" : "s"}`
            : `Delete session "${deleteDialog?.label ?? ""}"`
        }
        message={
          deleteDialog?.kind === "many"
            ? `Delete the ${deleteDialog.sessionIds.length} selected session${deleteDialog.sessionIds.length === 1 ? "" : "s"}? Live sessions are killed and on-disk JSONLs are removed. Cannot be undone.`
            : deleteDialog?.kind === "single" && deleteDialog.isLive
              ? `Delete "${deleteDialog.label}"? This kills the live shell AND removes the on-disk JSONL. Cannot be undone.`
              : deleteDialog?.kind === "single"
                ? `Delete the on-disk JSONL for "${deleteDialog.label}"? Cannot be undone — the file is the only copy.`
                : ""
        }
        primaryLabel={deleteDialog?.kind === "many" ? "Delete all" : "Delete"}
        tone="danger"
      />
    </div>
  );
}

interface DeletePayload {
  kind: "single";
  sessionId: string;
  label: string;
  isLive: boolean;
}

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
  onRenameKeyDown: (e: KeyboardEvent<HTMLInputElement>, sessionId: string) => void;
  onCommitRename: (sessionId: string) => void;
  onToggleExpanded: (parentId: string, currentlyExpanded: boolean) => void;
  onAskDelete: (payload: DeletePayload) => void;
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
    onAskDelete,
  } = props;
  const label =
    s.name ??
    (s.firstMessage.length > 0
      ? s.firstMessage.slice(0, 40)
      : `session ${s.sessionId.slice(0, 6)}`);
  return (
    <div
      className={`group flex items-center gap-1 rounded ${isChild ? "ml-4" : ""} px-2 py-0.5 text-xs ${
        isSelected
          ? "bg-emerald-900/20 text-neutral-100"
          : isActive
            ? "bg-neutral-800 text-neutral-100"
            : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
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
          {s.isLive && <span className="mr-1 text-emerald-500">●</span>}
          {isChild && (
            <span className="mr-1 text-purple-400" title="sub-agent">
              ↳
            </span>
          )}
          {label}
        </button>
      )}
      {!isRenaming && (
        <button
          onClick={() =>
            onAskDelete({
              kind: "single",
              sessionId: s.sessionId,
              label,
              isLive: s.isLive,
            })
          }
          className="inline-flex items-center p-1 text-neutral-500 hover:text-red-400"
          title={
            s.isLive
              ? "Delete session — also kills the live shell"
              : "Delete session JSONL from disk"
          }
        >
          <X size={16} />
        </button>
      )}
    </div>
  );
}

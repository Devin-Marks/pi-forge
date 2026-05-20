import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, Loader2, Navigation, RefreshCw, X } from "lucide-react";
import { api, ApiError, type SessionTreeEntry, type SessionTreeResponse } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";
import { Modal } from "./Modal";

/**
 * Phase 15 — Session tree viewer.
 *
 * Loads `/api/v1/sessions/:id/tree` and renders the branching history
 * as an indented list with connecting guides. The active branch path
 * (the entries between the root and the current leaf) is bright; off-
 * path siblings are dimmed but still clickable so the user can
 * navigate to a different branch tip.
 *
 * Two actions per node:
 *   - Click the row → POST /sessions/:id/navigate (in-place leaf
 *     change, no new session file)
 *   - Fork icon on user-message rows → POST /sessions/:id/fork → switch
 *     the active session to the new fork
 *
 * Streaming-aware: navigation while the agent is mid-run prompts for
 * confirmation (the SDK aborts the in-flight turn on navigate).
 */
interface Props {
  sessionId: string;
  projectId: string;
  onClose: () => void;
}

/**
 * Per-navigate dialog state. The dialog covers three concerns the
 * SDK's `navigateTree` accepts in one shot:
 *   - confirming the navigation when streaming (aborts the in-flight turn)
 *   - optional `label` to bookmark the abandoned branch tip
 *   - optional `summarize` + `customInstructions` to ask pi to write
 *     a branch_summary entry capturing what the abandoned branch did
 * We open the dialog from `navigate()` and let it handle the actual
 * api.navigateSession call on confirm — keeps the form state colocated
 * with its trigger.
 */
interface NavConfirmState {
  entryId: string;
  /** True when the abandoned branch has descendants worth summarizing. */
  abandonsBranch: boolean;
  /** True when the session is streaming; navigate will abort. */
  isStreaming: boolean;
}

interface NodeView extends SessionTreeEntry {
  /** Role-based indent step (user=0, assistant=1, tool=2). */
  depth: number;
  /**
   * Branch nesting level — 0 for the original conversation, 1 for
   * its first divergence, 2 for a divergence within that, etc. Adds
   * a small base offset to the visual indent so re-asks at the same
   * role-depth (e.g. two `user` messages from the same parent) sit
   * at visibly different x-positions instead of collapsing into the
   * same column.
   */
  branchLevel: number;
  /** True when this entry sits on the path from root → leaf. */
  onActivePath: boolean;
  /** True when this entry IS the leaf. */
  isLeaf: boolean;
  /** Number of sibling branches at this point (for the divider hint). */
  siblings: number;
  /**
   * True when this row is the FIRST entry of a branch with
   * branchLevel > 0 — used to render a "branch N" badge so the
   * divergence is explicit, not just inferred from the offset.
   */
  isBranchHead: boolean;
}

const MODEL_KEY_PREFIX = "pi-forge/model/";
const VIEW_KEY = "pi-forge/sessionTree.view";

export function SessionTreePanel({ sessionId, projectId, onClose }: Props) {
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const loadSessionsForProject = useSessionStore((s) => s.loadSessionsForProject);
  const reloadMessages = useSessionStore((s) => s.reloadMessages);
  const setPendingDraft = useSessionStore((s) => s.setPendingDraft);
  // Tree4 — auto-refresh once per agent_end. Same trigger pattern
  // file tree / TurnDiffPanel / ContextInspectorPanel use.
  const agentEndCount = useSessionStore((s) => s.agentEndCountBySession[sessionId] ?? 0);

  const [tree, setTree] = useState<SessionTreeResponse | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  // Tree2 + Tree3 + Tree5 — single navigate-confirm dialog handles
  // streaming aborts, optional bookmark label, and optional summarize
  // (all three things `navigateTree` can take). Replaces an earlier
  // window.confirm that was the only `confirm()` call left in the app.
  const [navConfirm, setNavConfirm] = useState<NavConfirmState | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const t = await api.getSessionTree(sessionId);
      setTree(t);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Tree4 — refetch when a new agent_end fires. The first mount
  // already loaded via the effect above; this fires only on
  // subsequent increments. agentEndCount is read reactively, so a
  // closed panel doesn't poll — only an open one repaints.
  useEffect(() => {
    if (agentEndCount === 0) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentEndCount]);

  const nodes = useMemo<NodeView[]>(() => {
    if (tree === undefined) return [];
    return flattenTree(tree);
  }, [tree]);

  // View toggle persists across mounts so users who prefer the
  // other mode don't have to flip it every time they open the
  // panel. Default is the branching graph — it's the more useful
  // view for sessions with multiple branches and reads fine for
  // linear sessions too. Honours an explicitly-stored "list"
  // preference; anything else (including absent / corrupt) falls
  // back to graph.
  const [view, setView] = useState<"list" | "graph">(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "list" ? "list" : "graph";
    } catch {
      // Private-mode storage — fall back to the default graph view.
      return "graph";
    }
  });
  const setViewPersisted = (next: "list" | "graph"): void => {
    setView(next);
    try {
      localStorage.setItem(VIEW_KEY, next);
    } catch {
      // private-mode storage failure — choice still applies for the session
    }
  };

  /**
   * Navigate the active session's leaf. Idempotent on the current
   * leaf (we early-return). When the navigation is non-trivial —
   * either streaming (will abort) or abandoning a branch with
   * descendants (the abandoned tip is worth bookmarking /
   * summarizing) — open the navConfirm dialog instead of firing
   * the call directly. Trivial navigations (no abandons, not
   * streaming) skip the dialog.
   *
   * "Abandoning a branch" = navigating to an entry whose subtree
   * doesn't contain the current leaf. In other words, the current
   * leaf's branch is being left behind for an alternative.
   */
  const navigate = (entryId: string): void => {
    if (busy) return;
    if (tree?.leafId === entryId) return;
    const abandons = currentLeafAbandonedBy(tree, entryId);
    if (isStreaming || abandons) {
      setNavConfirm({ entryId, abandonsBranch: abandons, isStreaming });
      return;
    }
    void executeNavigate(entryId, {});
  };

  /**
   * Fire the navigate API call with optional label/summarize/
   * customInstructions. Called both directly from `navigate()` for
   * the trivial case and from the navConfirm dialog for the
   * complex case.
   */
  const executeNavigate = async (
    entryId: string,
    opts: { summarize?: boolean; customInstructions?: string; label?: string },
  ): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.navigateSession(sessionId, entryId, opts);
      // Two refetches needed:
      //   1. Tree panel — leafId / branchIds change, repaint highlight
      //   2. Chat surface — messagesBySession is keyed by sessionId
      //      and there's no SSE event for navigate, so without this
      //      the chat stays stuck on the pre-navigate message list
      //      and the user thinks the button did nothing.
      await refresh();
      reloadMessages(sessionId);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Fork from the given entry. Two semantics depending on which kind
   * of row it's called from:
   *
   *   - "branch from here" (assistant + non-message rows): server
   *     forks AT entryId; the new session contains everything up to
   *     and including this entry. Useful for "let me try something
   *     different from this point in the assistant's reply."
   *
   *   - "edit & resubmit" (user-message rows, the common case):
   *     server forks at the user message's PARENT, so the user
   *     message is NOT in the new session's history. We then prefill
   *     the chat input with the user message text via
   *     setPendingDraft, so the user lands in an editable textarea
   *     pre-populated with what they originally said. This matches
   *     the ChatGPT-style "edit my message" flow most users expect.
   *
   * Either way we copy the source session's per-session model
   * preference into the new session's localStorage key so the fork
   * inherits the model the user picked on the source.
   */
  const fork = async (
    entryId: string,
    opts: { editDraft?: string; parentId?: string | null } = {},
  ): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      // For the edit-and-resubmit flow, fork from the parent so the
      // user message is excluded. parentId === null means "no parent"
      // (root user message) — fall back to forking AT the message;
      // empty session is the next-best landing.
      const forkAt =
        opts.parentId !== undefined && opts.parentId !== null ? opts.parentId : entryId;
      const forked = await api.forkSession(sessionId, forkAt);
      // Carry the per-session model choice across the fork. ChatInput
      // re-applies whatever's in localStorage on session change, so
      // copying the value before setActiveSession means the new
      // session inherits the model without an extra API call.
      try {
        const sourceModel = localStorage.getItem(MODEL_KEY_PREFIX + sessionId);
        if (sourceModel !== null && sourceModel.length > 0) {
          localStorage.setItem(MODEL_KEY_PREFIX + forked.sessionId, sourceModel);
        }
      } catch {
        // private-mode storage failure — non-fatal, user can pick
        // the model again on the new session.
      }
      if (opts.editDraft !== undefined && opts.editDraft.length > 0) {
        setPendingDraft(forked.sessionId, opts.editDraft);
      }
      // Refresh the sidebar's session list before switching so the
      // new id is known by the time the active-id flip happens —
      // otherwise the sidebar briefly shows "no such session."
      await loadSessionsForProject(projectId);
      setActiveSession(forked.sessionId);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 px-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        // Sized larger than other modals so the graph view can render
        // wide branching trees without immediate horizontal scroll.
        // The viewport caps (vh/vw) keep it sane on small screens; the
        // px caps cap growth on large monitors so the modal doesn't
        // expand to fill 4K. Graph nodes are 220px × 80px with 64px
        // gaps, so ~6 columns fit comfortably at 1400px max-w.
        className="flex h-[min(90vh,900px)] w-[min(95vw,1400px)] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-4 py-2.5">
          <div className="flex items-center gap-2">
            <GitBranch size={14} className="text-neutral-400" />
            <h2 className="text-sm font-semibold text-neutral-100">Session tree</h2>
            {busy && <Loader2 size={11} className="animate-spin text-neutral-500" />}
          </div>
          <div className="flex items-center gap-1">
            {/* View-mode toggle. List = chronological top-to-bottom
                with role indent + branch stripes (good for skimming).
                Graph = turn-grouped DAG (good for branch reasoning). */}
            <div className="mr-1 flex overflow-hidden rounded border border-neutral-700">
              <button
                onClick={() => setViewPersisted("list")}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  view === "list"
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-800"
                }`}
                title="Vertical list view"
              >
                List
              </button>
              <button
                onClick={() => setViewPersisted("graph")}
                className={`px-2 py-0.5 text-[10px] uppercase tracking-wider ${
                  view === "graph"
                    ? "bg-neutral-700 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-800"
                }`}
                title="Branching graph view (turn-grouped)"
              >
                Graph
              </button>
            </div>
            <button
              onClick={() => void refresh()}
              disabled={loading || busy}
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
              title="Refresh tree"
            >
              <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            </button>
            <button
              onClick={onClose}
              className="rounded p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title="Close (Esc)"
            >
              <X size={20} />
            </button>
          </div>
        </header>

        {error !== undefined && (
          <div className="border-b border-red-700/40 bg-red-900/20 px-4 py-1.5 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-700">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading && tree === undefined && (
            <div className="px-4 py-6 text-center text-xs italic text-neutral-500">
              Loading tree…
            </div>
          )}
          {!loading && nodes.length === 0 && (
            <div className="px-4 py-6 text-center text-xs italic text-neutral-500">
              No entries yet.
            </div>
          )}
          {view === "list" ? (
            <ul className="space-y-0.5">
              {nodes.map((n) => (
                <TreeRow
                  key={n.id}
                  node={n}
                  disabled={busy}
                  onNavigate={() => void navigate(n.id)}
                  onFork={() =>
                    void fork(n.id, {
                      // User-message rows: fork BEFORE the message
                      // and prefill the input with its text. Other
                      // rows fork AT the entry — pass nothing.
                      ...(n.type === "message" && n.role === "user"
                        ? { editDraft: n.preview ?? "", parentId: n.parentId }
                        : {}),
                    })
                  }
                />
              ))}
            </ul>
          ) : tree !== undefined ? (
            <SessionTreeGraph
              tree={tree}
              disabled={busy}
              onNavigate={(id) => navigate(id)}
              onForkAfterTurn={(lastEntryId) => void fork(lastEntryId)}
            />
          ) : null}
        </div>

        <footer className="flex items-center justify-between border-t border-neutral-800 bg-neutral-900/40 px-4 py-2 text-[10px] text-neutral-500">
          <span>
            Click a row to navigate · fork icon on user messages to branch from that point
          </span>
          {tree !== undefined && (
            <span>
              {tree.entries.length} {tree.entries.length === 1 ? "entry" : "entries"}
            </span>
          )}
        </footer>
      </div>
      <NavigateConfirmDialog
        state={navConfirm}
        onCancel={() => setNavConfirm(undefined)}
        onConfirm={(opts) => {
          if (navConfirm === undefined) return;
          const { entryId } = navConfirm;
          setNavConfirm(undefined);
          void executeNavigate(entryId, opts);
        }}
      />
    </div>
  );
}

/* ------------------------- navigate-confirm dialog ------------------------- */

/**
 * The single dialog opened when a navigate isn't trivial — handles
 * Tree2 (label), Tree3 (summarize + customInstructions), and Tree5
 * (replace window.confirm). The summarize + label inputs only render
 * when the navigation actually abandons a branch with descendants;
 * a streaming-only confirmation hides them.
 */
function NavigateConfirmDialog({
  state,
  onCancel,
  onConfirm,
}: {
  state: NavConfirmState | undefined;
  onCancel: () => void;
  onConfirm: (opts: { summarize?: boolean; customInstructions?: string; label?: string }) => void;
}) {
  const [label, setLabel] = useState("");
  const [summarize, setSummarize] = useState(false);
  const [customInstructions, setCustomInstructions] = useState("");
  const labelInputRef = useRef<HTMLInputElement>(null);
  // Reset form on open so a stale value from a previous navigate
  // doesn't bleed into the next one.
  useEffect(() => {
    if (state === undefined) return;
    setLabel("");
    setSummarize(false);
    setCustomInstructions("");
  }, [state]);
  const open = state !== undefined;
  const showAbandonOptions = state?.abandonsBranch === true;
  const submit = (): void => {
    const opts: { summarize?: boolean; customInstructions?: string; label?: string } = {};
    const trimmedLabel = label.trim();
    if (trimmedLabel.length > 0) opts.label = trimmedLabel;
    if (summarize) {
      opts.summarize = true;
      const trimmedInstr = customInstructions.trim();
      if (trimmedInstr.length > 0) opts.customInstructions = trimmedInstr;
    }
    onConfirm(opts);
  };
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title="Navigate session leaf"
      width={showAbandonOptions ? "max-w-md" : "max-w-sm"}
      // exactOptionalPropertyTypes — only forward the ref when we
      // have one, don't pass `undefined` explicitly.
      {...(showAbandonOptions ? { initialFocusRef: labelInputRef } : {})}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3 px-4 py-3 text-xs text-neutral-200"
      >
        {state?.isStreaming === true && (
          <p className="rounded border border-amber-700/50 bg-amber-900/20 px-2 py-1.5 text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
            The agent is currently running. Navigating will abort the in-progress turn.
          </p>
        )}
        {showAbandonOptions ? (
          <>
            <p className="text-neutral-400">
              You&rsquo;re leaving the current branch behind. The tip stays on the tree (you can
              navigate back to it any time), but you can also bookmark + summarize it before moving
              on.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-neutral-500">
                Label for the abandoned branch tip{" "}
                <span className="text-neutral-600">(optional)</span>
              </span>
              <input
                ref={labelInputRef}
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. wrong-approach"
                maxLength={200}
                className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-neutral-100 outline-none focus:border-neutral-500"
              />
            </label>
            <label className="flex items-start gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5">
              <input
                type="checkbox"
                checked={summarize}
                onChange={(e) => setSummarize(e.target.checked)}
                className="mt-0.5 h-3 w-3"
              />
              <span className="flex-1 text-neutral-300">
                Have pi write a <code className="font-mono text-[11px]">branch_summary</code> entry
                capturing what this branch did. Costs one extra LLM call.
              </span>
            </label>
            {summarize && (
              <label className="flex flex-col gap-1">
                <span className="text-neutral-500">
                  Custom summarizer instructions{" "}
                  <span className="text-neutral-600">(optional)</span>
                </span>
                <textarea
                  value={customInstructions}
                  onChange={(e) => setCustomInstructions(e.target.value)}
                  rows={3}
                  placeholder="e.g. Focus on what files were changed and why"
                  className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
                />
              </label>
            )}
          </>
        ) : (
          <p className="text-neutral-400">Confirm navigation?</p>
        )}
        <footer className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            type="submit"
            className={`rounded-md px-3 py-1 text-xs font-medium ${
              state?.isStreaming === true
                ? "bg-amber-600 text-amber-50 hover:bg-amber-500 light:bg-amber-500 light:text-white light:hover:bg-amber-600"
                : "bg-neutral-100 text-neutral-900 hover:bg-white"
            }`}
          >
            {state?.isStreaming === true ? "Abort & navigate" : "Navigate"}
          </button>
        </footer>
      </form>
    </Modal>
  );
}

// Role-based indent (depthForEntry): user=0, assistant=1, tool=2.
// 18 px per step is room enough for 3 levels without crowding.
const MAX_INDENT_DEPTH = 4;
const INDENT_PX = 18;
// Per-branch base offset added on top of the role indent so two
// re-asks at the same role level (both depth 0) sit at different
// x-positions when they belong to different branches. 10 px is
// small enough not to consume the modal width even with 6+
// branches, but visible at a glance. Capped to keep the deepest
// branches from running off the right edge.
const BRANCH_OFFSET_PX = 10;
const MAX_BRANCH_LEVEL = 8;

function TreeRow({
  node,
  disabled,
  onNavigate,
  onFork,
}: {
  node: NodeView;
  disabled: boolean;
  onNavigate: () => void;
  onFork: () => void;
}) {
  const indent =
    Math.min(node.depth, MAX_INDENT_DEPTH) * INDENT_PX +
    Math.min(node.branchLevel, MAX_BRANCH_LEVEL) * BRANCH_OFFSET_PX;
  const isUserMessage = node.type === "message" && node.role === "user";
  const dim = !node.onActivePath;
  const labelText = entryTypeLabel(node);
  return (
    // min-w-0 on the wrapper so flex children inside (the row's
    // content column with `truncate`) actually shrink below their
    // content width instead of overflowing the modal.
    <li className="group min-w-0" style={{ paddingLeft: `${indent}px` }}>
      <div
        className={`flex min-w-0 items-start gap-1.5 rounded border px-2 py-1.5 ${
          node.isLeaf
            ? "border-emerald-700/60 bg-emerald-900/10"
            : node.onActivePath
              ? "border-neutral-700 bg-neutral-900/40"
              : "border-neutral-800/50 bg-transparent"
        } ${dim ? "opacity-60" : ""}`}
        // Coloured left-border for non-original branches so the
        // divergence is visible even when scrolled past the branch
        // head. `branchLevel` cycles through a small palette so
        // sibling branches at the same level are distinguishable
        // at a glance.
        style={
          node.branchLevel > 0
            ? { boxShadow: `inset 3px 0 0 ${branchAccent(node.branchLevel)}` }
            : undefined
        }
      >
        {/* Action buttons on the LEFT so they're predictably reachable
            regardless of preview length, and so deeply-nested rows
            don't shove them off the right edge. Always visible —
            previously hidden behind group-hover, which made
            discoverability rough on touch + small screens. */}
        <div className="flex shrink-0 items-center gap-0.5 pt-0.5">
          {!node.isLeaf ? (
            <button
              onClick={onNavigate}
              disabled={disabled}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
              title="Navigate the session leaf to this entry"
            >
              <Navigation size={11} />
            </button>
          ) : (
            // Placeholder keeps row heights consistent when the leaf
            // hides its navigate button.
            <span className="inline-block w-[22px]" aria-hidden="true" />
          )}
          {isUserMessage ? (
            <button
              onClick={onFork}
              disabled={disabled}
              className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300 disabled:opacity-40 light:hover:text-emerald-700"
              title="Fork BEFORE this message — opens a new session with the message text loaded into the input for editing."
            >
              <GitBranch size={11} />
            </button>
          ) : (
            <span className="inline-block w-[22px]" aria-hidden="true" />
          )}
        </div>
        <button
          onClick={onNavigate}
          disabled={disabled || node.isLeaf}
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left disabled:cursor-default"
          title={node.isLeaf ? "Current leaf" : "Navigate the session leaf to this entry"}
        >
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
                node.role === "user"
                  ? "bg-sky-900/40 text-sky-300 light:bg-sky-100 light:text-sky-800"
                  : node.role === "assistant"
                    ? "bg-violet-900/40 text-violet-300 light:bg-violet-100 light:text-violet-800"
                    : node.type === "branch_summary"
                      ? "bg-amber-900/40 text-amber-300 light:bg-amber-100 light:text-amber-800"
                      : node.type === "compaction"
                        ? "bg-fuchsia-900/40 text-fuchsia-300 light:bg-fuchsia-100 light:text-fuchsia-800"
                        : "bg-neutral-800 text-neutral-400"
              }`}
            >
              {labelText}
            </span>
            {node.isBranchHead && (
              <span
                className="rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider"
                style={{
                  background: `${branchAccent(node.branchLevel)}33`,
                  color: branchAccent(node.branchLevel),
                }}
                title="First entry of a divergent branch"
              >
                branch {node.branchLevel}
              </span>
            )}
            {node.label !== undefined && node.label.length > 0 && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] text-neutral-300">
                ★ {node.label}
              </span>
            )}
            {node.isLeaf && (
              <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[9px] text-emerald-300 light:bg-emerald-100 light:text-emerald-800">
                leaf
              </span>
            )}
            {node.siblings > 1 && (
              <span
                className="text-[9px] text-amber-400 light:text-amber-700"
                title={`${node.siblings} branches diverge from this point`}
              >
                ⑂ {node.siblings}
              </span>
            )}
            <span className="text-[9px] text-neutral-600">
              {new Date(node.timestamp).toLocaleString()}
            </span>
          </div>
          {node.preview !== undefined && (
            // w-full + min-w-0 on the parent button is what lets
            // `truncate` actually clip — without min-w-0 the flex
            // child stretches to its content width and pushes the
            // row past the modal edge.
            <p className="w-full truncate text-[11px] text-neutral-300">{node.preview}</p>
          )}
        </button>
      </div>
    </li>
  );
}

/**
 * Flatten the SDK's parentId-linked entry list into a depth-first
 * order suitable for a flat indented list. Tracks which entries are
 * on the active branch path (for highlighting) and how many siblings
 * each branchpoint has (so we can hint at divergences).
 *
 * Indent depth is **role-based, not parent-chain-based**. The
 * conversation flow we want users to see is:
 *
 *   user (0) ────────── flush left
 *     assistant (1) ── one step in
 *       tool (2) ──── two steps in
 *
 * Using the literal parentId chain depth would push every later
 * message progressively further right (depth grows monotonically
 * with conversation length) which is meaningless visually. Branches
 * are still visible via the `⑂ N` siblings badge on the diverging
 * parent — repeated user messages at depth 0 read as "different
 * attempts at the same turn", which is exactly what they are.
 *
 * Non-message entries (compaction, branch_summary, model_change,
 * etc.) are pinned at depth 0 — they're meta events, not part of
 * the user/assistant exchange.
 */
/**
 * True when navigating to `entryId` would abandon the current leaf —
 * i.e. the current leaf is NOT a descendant of `entryId`. Used to
 * decide whether the navigate-confirm dialog should offer
 * "summarize abandoned branch" + "label abandoned branch tip"
 * affordances. Navigating to an ancestor or to the leaf itself
 * doesn't abandon anything.
 */
function currentLeafAbandonedBy(tree: SessionTreeResponse | undefined, targetId: string): boolean {
  if (tree === undefined || tree.leafId === null) return false;
  if (tree.leafId === targetId) return false;
  // Walk from leaf up via parentId until we hit either targetId
  // (target is an ancestor of leaf — no abandon) or null (target
  // isn't on the leaf's chain — abandon).
  const byId = new Map(tree.entries.map((e) => [e.id, e]));
  let cur: string | null = tree.leafId;
  while (cur !== null) {
    if (cur === targetId) return false;
    cur = byId.get(cur)?.parentId ?? null;
  }
  return true;
}

function depthForEntry(entry: SessionTreeEntry): number {
  if (entry.type !== "message") return 0;
  if (entry.role === "user") return 0;
  if (entry.role === "tool") return 2;
  // assistant + system + anything else the SDK might add later
  return 1;
}

function flattenTree(tree: SessionTreeResponse): NodeView[] {
  const childrenByParent = new Map<string | null, SessionTreeEntry[]>();
  for (const e of tree.entries) {
    const list = childrenByParent.get(e.parentId);
    if (list === undefined) childrenByParent.set(e.parentId, [e]);
    else list.push(e);
  }
  // Sort children by timestamp so the original branch is on top and
  // alternative branches sort below — matches how a user mentally
  // reads "the original conversation, plus what I tried instead."
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  const onPath = new Set(tree.branchIds);
  const out: NodeView[] = [];
  // DFS traversal: each subtree carries the branchLevel from its
  // entry point. Within a parent's children, the FIRST child
  // continues the parent's branch (same level); each subsequent
  // child starts a new divergence (level + 1) and propagates that
  // through its descendants.
  const visit = (parentId: string | null, branchLevel: number): void => {
    const list = childrenByParent.get(parentId);
    if (list === undefined) return;
    const siblings = list.length;
    list.forEach((e, idx) => {
      const childLevel = idx === 0 ? branchLevel : branchLevel + 1;
      const isBranchHead = idx > 0 && childLevel > 0;
      out.push({
        ...e,
        depth: depthForEntry(e),
        branchLevel: childLevel,
        onActivePath: onPath.has(e.id),
        isLeaf: tree.leafId === e.id,
        siblings,
        isBranchHead,
      });
      visit(e.id, childLevel);
    });
  };
  visit(null, 0);
  return out;
}

/**
 * Stable per-branch accent color. Used for the left-border stripe
 * and the "branch N" badge so sibling branches are colour-coded.
 * Cycles through a small palette so the same level always renders
 * the same color across re-fetches; reads on dark backgrounds.
 * `branchLevel === 0` (the original conversation) doesn't get an
 * accent — the row's normal border serves as its baseline.
 */
const BRANCH_PALETTE = [
  "#f59e0b", // amber-500
  "#0ea5e9", // sky-500
  "#ec4899", // pink-500
  "#10b981", // emerald-500
  "#8b5cf6", // violet-500
  "#f97316", // orange-500
];
function branchAccent(level: number): string {
  if (level <= 0) return "transparent";
  return BRANCH_PALETTE[(level - 1) % BRANCH_PALETTE.length]!;
}

function entryTypeLabel(node: SessionTreeEntry): string {
  if (node.type === "message") return node.role ?? "message";
  if (node.type === "thinking_level_change") return "thinking";
  if (node.type === "model_change") return "model";
  if (node.type === "compaction") return "compact";
  if (node.type === "branch_summary") return "branch";
  if (node.type === "label") return "label";
  if (node.type === "session_info") return "info";
  if (node.type === "custom") return "custom";
  if (node.type === "custom_message") return "extension";
  return node.type;
}

/* ============================== graph view ============================== */

/**
 * Turn-level node for the graph view. A "turn" anchors on a user
 * message and includes everything from that user message up to (but
 * not including) the next user message in the chain. Non-message
 * entries (compaction, branch_summary, model_change, etc.) get their
 * own degenerate "turn" so they're visible too — they tend to be
 * meta events that belong to no specific turn.
 */
interface TurnNode {
  /** Anchor entry id (the user message, or the first entry of a meta turn). */
  id: string;
  /** Parent turn's anchor id (null for roots). */
  parentId: string | null;
  /** Branch column index (0 = original conversation, +1 per divergence). */
  col: number;
  /** Row index — chain-depth from root in the turn graph. Sibling
   *  branches at the same depth share a row, which lets the layout
   *  read as "depth = down, branch = right" instead of jittering on
   *  global chronological sort. */
  row: number;
  isOnActivePath: boolean;
  isLeafTurn: boolean;
  /** True when this turn IS the divergence point (>1 child turn). */
  hasMultipleChildren: boolean;
  /** Number of branch divergences originating from this turn. */
  childCount: number;
  /** Anchor entry's role/type for the badge. */
  roleLabel: string;
  /** Truncated user prompt or label of the anchor. */
  preview: string;
  /** Non-anchor entries inside this turn — counts per category. */
  insideCounts: { assistant: number; tool: number; thinking: number; meta: number };
  /** True when the anchor is a user message (eligible for fork). */
  isUserAnchor: boolean;
  /** Anchor's parentId. */
  anchorParentId: string | null;
  /**
   * Last entry id within this turn (chronologically). The graph view's
   * fork branches AT this id so the new session INCLUDES the turn's
   * full output (user msg + assistant + tool results) — distinct
   * semantic from the list view's edit-and-resubmit which forks at
   * the user message's parent.
   */
  lastEntryId: string;
  /** ISO timestamp of the anchor. */
  timestamp: string;
}

/** Width / height for graph layout. Kept as constants so SVG math is one place. */
const NODE_WIDTH = 220;
const NODE_HEIGHT = 78;
const COL_GAP = 64;
const ROW_GAP = 28;
const PAD = 24;

/**
 * Group entries into turn-level nodes for the graph view.
 *
 * Walk the entries DFS. When we encounter a user message, start a
 * new TurnNode at that message's id. Subsequent non-user entries
 * (assistant text, assistant tool-use, tool result, etc.) accumulate
 * into the current turn's `insideCounts`. The turn's parent =
 * whichever turn contained the user message's chain-parent (if any).
 *
 * A turn that has multiple direct child user messages is a
 * branchpoint; each child user message starts a new turn with the
 * branchpoint as its parent — and gets its own column.
 *
 * Non-message entries that aren't part of any user-anchored turn
 * (e.g., a compaction at the very root) become their own degenerate
 * turn nodes.
 */
function buildTurns(tree: SessionTreeResponse): TurnNode[] {
  const byId = new Map(tree.entries.map((e) => [e.id, e]));
  const childrenByParent = new Map<string | null, SessionTreeEntry[]>();
  for (const e of tree.entries) {
    const list = childrenByParent.get(e.parentId);
    if (list === undefined) childrenByParent.set(e.parentId, [e]);
    else list.push(e);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  // First pass: classify each entry's "owning turn id". An entry's
  // owning turn = the most recent user-message ancestor on the chain
  // (or the entry itself if it's a user message or has no user
  // ancestor).
  const owningTurn = new Map<string, string>();
  const computeOwner = (entry: SessionTreeEntry): string => {
    const cached = owningTurn.get(entry.id);
    if (cached !== undefined) return cached;
    if (entry.type === "message" && entry.role === "user") {
      owningTurn.set(entry.id, entry.id);
      return entry.id;
    }
    if (entry.parentId === null) {
      owningTurn.set(entry.id, entry.id);
      return entry.id;
    }
    const parent = byId.get(entry.parentId);
    if (parent === undefined) {
      owningTurn.set(entry.id, entry.id);
      return entry.id;
    }
    const owner = computeOwner(parent);
    owningTurn.set(entry.id, owner);
    return owner;
  };
  for (const e of tree.entries) computeOwner(e);

  // Second pass: build TurnNode skeletons keyed by anchor id.
  const turnsByAnchor = new Map<string, TurnNode>();
  for (const e of tree.entries) {
    if (owningTurn.get(e.id) !== e.id) continue;
    // This entry is the anchor of its turn.
    const isUser = e.type === "message" && e.role === "user";
    turnsByAnchor.set(e.id, {
      id: e.id,
      parentId: null, // filled in below
      col: 0,
      row: 0,
      isOnActivePath: false,
      isLeafTurn: false,
      hasMultipleChildren: false,
      childCount: 0,
      roleLabel: isUser ? "user" : entryTypeLabel(e),
      preview: e.preview ?? "",
      insideCounts: { assistant: 0, tool: 0, thinking: 0, meta: 0 },
      isUserAnchor: isUser,
      anchorParentId: e.parentId,
      lastEntryId: e.id, // updated below as we tally non-anchor entries
      timestamp: e.timestamp,
    });
  }

  // Third pass: tally non-anchor entries into their turn's insideCounts.
  // Also track the latest (max-timestamp) entry id per turn so the
  // graph fork can branch AT it (= include the turn's full output).
  for (const e of tree.entries) {
    const owner = owningTurn.get(e.id)!;
    const turn = turnsByAnchor.get(owner);
    if (turn === undefined) continue;
    // Update lastEntryId across all entries (including the anchor),
    // by timestamp comparison.
    const currentLast = byId.get(turn.lastEntryId);
    if (currentLast === undefined || e.timestamp.localeCompare(currentLast.timestamp) > 0) {
      turn.lastEntryId = e.id;
    }
    if (owner === e.id) continue; // anchor itself — no inside-count tally
    if (e.type === "message" && e.role === "assistant") {
      turn.insideCounts.assistant += 1;
    } else if (e.type === "message" && (e.role === "tool" || e.role === "toolResult")) {
      turn.insideCounts.tool += 1;
    } else if (e.type === "message" && e.role === "compactionSummary") {
      turn.insideCounts.meta += 1;
    } else {
      turn.insideCounts.meta += 1;
    }
  }

  // Fourth pass: parent-link turns. A turn's parent is the turn
  // containing its anchor's chain-parent.
  for (const turn of turnsByAnchor.values()) {
    if (turn.anchorParentId === null) continue;
    const parentOwner = owningTurn.get(turn.anchorParentId);
    if (parentOwner === undefined) continue;
    if (parentOwner === turn.id) continue; // self-parent shouldn't happen, defensive
    turn.parentId = parentOwner;
  }

  // Fifth pass: column + row layout. Walk turns DFS, sibling turns
  // get incremented columns relative to their first sibling.
  const childrenByTurnParent = new Map<string | null, TurnNode[]>();
  for (const t of turnsByAnchor.values()) {
    const list = childrenByTurnParent.get(t.parentId);
    if (list === undefined) childrenByTurnParent.set(t.parentId, [t]);
    else list.push(t);
  }
  for (const list of childrenByTurnParent.values()) {
    list.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }
  // Mark branch points + child counts for the badge.
  for (const t of turnsByAnchor.values()) {
    const kids = childrenByTurnParent.get(t.id) ?? [];
    t.childCount = kids.length;
    t.hasMultipleChildren = kids.length > 1;
  }

  // Active-path + leaf flags.
  const onPath = new Set(tree.branchIds);
  // A turn is on the active path if its anchor entry id is on the
  // active branch path. A turn is the leaf turn if it owns the leaf
  // entry.
  const leafOwner = tree.leafId !== null ? owningTurn.get(tree.leafId) : undefined;
  for (const t of turnsByAnchor.values()) {
    t.isOnActivePath = onPath.has(t.id);
    t.isLeafTurn = leafOwner === t.id;
  }

  // Layout: assign columns DFS — first child stays in the same
  // column as the parent; each subsequent sibling claims a new
  // column to the right of the parent's subtree.
  let nextFreeCol = 0;
  const claimedCol = new Map<string, number>();
  const visit = (parentId: string | null, parentCol: number): void => {
    const kids = childrenByTurnParent.get(parentId) ?? [];
    kids.forEach((kid, idx) => {
      let col: number;
      if (idx === 0) {
        col = parentCol;
      } else {
        col = nextFreeCol;
        nextFreeCol += 1;
      }
      kid.col = col;
      claimedCol.set(kid.id, col);
      visit(kid.id, col);
    });
  };
  // Roots: each gets its own column starting at 0.
  const roots = childrenByTurnParent.get(null) ?? [];
  roots.forEach((root, idx) => {
    if (idx === 0) {
      root.col = 0;
      nextFreeCol = Math.max(nextFreeCol, 1);
    } else {
      root.col = nextFreeCol;
      nextFreeCol += 1;
    }
    claimedCol.set(root.id, root.col);
    visit(root.id, root.col);
  });

  // Row assignment: chain-depth from root in the turn graph.
  // Sibling branches at the same depth share a row, which gives the
  // graph a structured "depth = down, branch = right" reading
  // instead of jittering on global chronological sort. Multiple
  // turns CAN share a row (different columns), and that's fine —
  // it's how git log graphs convey "these happened at the same
  // structural depth on different branches."
  const computeDepth = (turn: TurnNode, memo: Map<string, number>): number => {
    const cached = memo.get(turn.id);
    if (cached !== undefined) return cached;
    if (turn.parentId === null) {
      memo.set(turn.id, 0);
      return 0;
    }
    const parent = turnsByAnchor.get(turn.parentId);
    if (parent === undefined) {
      memo.set(turn.id, 0);
      return 0;
    }
    const d = computeDepth(parent, memo) + 1;
    memo.set(turn.id, d);
    return d;
  };
  const depthMemo = new Map<string, number>();
  for (const t of turnsByAnchor.values()) {
    t.row = computeDepth(t, depthMemo);
  }

  // Sort the returned array by (row, col) so the renderer paints
  // top-to-bottom, left-to-right. Stable for a deterministic DOM
  // order regardless of insertion order.
  return [...turnsByAnchor.values()].sort((a, b) =>
    a.row !== b.row ? a.row - b.row : a.col - b.col,
  );
}

function SessionTreeGraph({
  tree,
  disabled,
  onNavigate,
  onForkAfterTurn,
}: {
  tree: SessionTreeResponse;
  disabled: boolean;
  onNavigate: (entryId: string) => void;
  /**
   * Graph-view fork. Branches AT the turn's last entry id so the
   * new session INCLUDES the full turn (user message + assistant
   * output + tool results). Distinct from the list view's fork
   * which branches at the user message's parent for an
   * edit-and-resubmit flow.
   */
  onForkAfterTurn: (lastEntryId: string) => void;
}) {
  const turns = useMemo(() => buildTurns(tree), [tree]);
  const layout = useMemo(() => {
    if (turns.length === 0) return { width: 0, height: 0 };
    const maxCol = turns.reduce((m, t) => Math.max(m, t.col), 0);
    const maxRow = turns.reduce((m, t) => Math.max(m, t.row), 0);
    return {
      width: PAD * 2 + (maxCol + 1) * NODE_WIDTH + maxCol * COL_GAP,
      height: PAD * 2 + (maxRow + 1) * NODE_HEIGHT + maxRow * ROW_GAP,
    };
  }, [turns]);
  if (turns.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs italic text-neutral-500">
        No turns to render.
      </div>
    );
  }
  const xOf = (col: number): number => PAD + col * (NODE_WIDTH + COL_GAP);
  const yOf = (row: number): number => PAD + row * (NODE_HEIGHT + ROW_GAP);
  const turnsById = new Map(turns.map((t) => [t.id, t]));
  return (
    <div className="relative" style={{ width: `${layout.width}px`, height: `${layout.height}px` }}>
      {/* Edges: orthogonal routing with rounded corners. Same-column
          edges are a straight vertical line; cross-column edges
          drop from the parent's column to a midpoint, jog
          horizontally to the child's column, then drop to the
          child's top. Reads like a git log graph. Active-path
          edges are bright neutral-400; off-path edges dim. */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-0"
        width={layout.width}
        height={layout.height}
      >
        {turns.map((t) => {
          if (t.parentId === null) return null;
          const parent = turnsById.get(t.parentId);
          if (parent === undefined) return null;
          const px = xOf(parent.col) + NODE_WIDTH / 2;
          const py = yOf(parent.row) + NODE_HEIGHT;
          const cx = xOf(t.col) + NODE_WIDTH / 2;
          const cy = yOf(t.row);
          const onActive = t.isOnActivePath && parent.isOnActivePath;
          // Same column → straight vertical. Cross column →
          // L-shape with rounded corner at the bend, drawn via
          // a quadratic curve segment. Bend happens halfway down
          // the gap between the two rows so multiple branches
          // diverging from the same parent don't overlap their
          // horizontal segments.
          const d =
            px === cx
              ? `M ${px} ${py} L ${cx} ${cy}`
              : (() => {
                  const bendY = py + (cy - py) / 2;
                  const r = 8; // corner radius
                  const goingRight = cx > px;
                  const cornerInX = goingRight ? px + r : px - r;
                  const cornerOutX = goingRight ? cx - r : cx + r;
                  return [
                    `M ${px} ${py}`,
                    // Down to just before the bend
                    `L ${px} ${bendY - r}`,
                    // Round corner from vertical to horizontal
                    `Q ${px} ${bendY} ${cornerInX} ${bendY}`,
                    // Horizontal across to just before the second corner
                    `L ${cornerOutX} ${bendY}`,
                    // Round corner from horizontal back to vertical
                    `Q ${cx} ${bendY} ${cx} ${bendY + r}`,
                    // Down to the child's top
                    `L ${cx} ${cy}`,
                  ].join(" ");
                })();
          return (
            <path
              key={t.id}
              d={d}
              fill="none"
              stroke={onActive ? "#a3a3a3" : "#404040"}
              strokeWidth={onActive ? 1.5 : 1}
              strokeOpacity={onActive ? 0.85 : 0.5}
            />
          );
        })}
      </svg>
      {/* Nodes */}
      {turns.map((t) => (
        <GraphNode
          key={t.id}
          turn={t}
          x={xOf(t.col)}
          y={yOf(t.row)}
          disabled={disabled}
          // Navigate AND fork both target the turn's last entry, not
          // its anchor. Navigating to the anchor (the user message
          // for user turns) sets the leaf there, which makes the
          // assistant's reply an off-path child — chat view then
          // shows everything UP TO the user message, reading as
          // "the previous turn's content + this prompt waiting for
          // a reply." Targeting lastEntryId puts the leaf at the
          // END of the turn, so the full turn is on the active
          // branch (= visible in the chat) when the user lands.
          onNavigate={() => onNavigate(t.lastEntryId)}
          onForkAfterTurn={() => onForkAfterTurn(t.lastEntryId)}
        />
      ))}
    </div>
  );
}

function GraphNode({
  turn,
  x,
  y,
  disabled,
  onNavigate,
  onForkAfterTurn,
}: {
  turn: TurnNode;
  x: number;
  y: number;
  disabled: boolean;
  onNavigate: () => void;
  onForkAfterTurn: () => void;
}) {
  const dim = !turn.isOnActivePath;
  const borderClass = turn.isLeafTurn
    ? "border-emerald-700/70 bg-emerald-900/15"
    : turn.isOnActivePath
      ? "border-neutral-600 bg-neutral-900"
      : "border-neutral-800 bg-neutral-950";
  return (
    <div
      className={`absolute overflow-hidden rounded-lg border ${borderClass} ${
        dim ? "opacity-60" : ""
      }`}
      style={{
        left: `${x}px`,
        top: `${y}px`,
        width: `${NODE_WIDTH}px`,
        height: `${NODE_HEIGHT}px`,
      }}
    >
      <button
        onClick={onNavigate}
        disabled={disabled || turn.isLeafTurn}
        className="flex h-full w-full flex-col items-stretch gap-1 px-2 py-1.5 text-left disabled:cursor-default"
        title={turn.isLeafTurn ? "Current leaf turn" : "Navigate to this turn"}
      >
        <div className="flex items-center gap-1.5">
          <span
            className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${
              turn.roleLabel === "user"
                ? "bg-sky-900/40 text-sky-300 light:bg-sky-100 light:text-sky-800"
                : turn.roleLabel === "compact"
                  ? "bg-fuchsia-900/40 text-fuchsia-300 light:bg-fuchsia-100 light:text-fuchsia-800"
                  : turn.roleLabel === "branch"
                    ? "bg-amber-900/40 text-amber-300 light:bg-amber-100 light:text-amber-800"
                    : "bg-neutral-800 text-neutral-400"
            }`}
          >
            {turn.roleLabel}
          </span>
          {turn.isLeafTurn && (
            <span className="rounded bg-emerald-900/40 px-1.5 py-0.5 text-[9px] text-emerald-300 light:bg-emerald-100 light:text-emerald-800">
              leaf
            </span>
          )}
          {turn.hasMultipleChildren && (
            <span
              className="text-[9px] text-amber-400 light:text-amber-700"
              title={`${turn.childCount} branches diverge from here`}
            >
              ⑂ {turn.childCount}
            </span>
          )}
          {/* Graph-view fork: branches AT the turn's last entry so
              the new session INCLUDES the full turn (user message +
              assistant output + tool results). The user lands on
              that branch with the next turn ready to type, NOT in
              the middle of an unsent draft like the list view's
              fork. Available on every turn, not just user-anchored
              ones, since "branch from after this point" is the
              graph's mental model. */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              onForkAfterTurn();
            }}
            disabled={disabled}
            className="ml-auto rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-emerald-300 disabled:opacity-40 light:hover:text-emerald-700"
            title="Fork AFTER this turn — opens a new session that includes this turn's full output, ready for the next prompt."
          >
            <GitBranch size={11} />
          </button>
        </div>
        <p className="line-clamp-2 flex-1 text-[11px] text-neutral-200">
          {turn.preview.length > 0 ? turn.preview : <em className="text-neutral-500">(no text)</em>}
        </p>
        <div className="flex items-center gap-2 text-[9px] text-neutral-500">
          {turn.insideCounts.assistant > 0 && (
            <span title="Assistant messages within this turn">{turn.insideCounts.assistant}a</span>
          )}
          {turn.insideCounts.tool > 0 && (
            <span title="Tool results within this turn">{turn.insideCounts.tool}t</span>
          )}
          {turn.insideCounts.thinking > 0 && (
            <span title="Thinking blocks">{turn.insideCounts.thinking}th</span>
          )}
          {turn.insideCounts.meta > 0 && (
            <span title="Meta entries (model_change, branch_summary, etc.)">
              {turn.insideCounts.meta}m
            </span>
          )}
          <span className="ml-auto">{new Date(turn.timestamp).toLocaleTimeString()}</span>
        </div>
      </button>
    </div>
  );
}

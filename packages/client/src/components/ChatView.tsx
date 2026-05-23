import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  Download,
  ExternalLink,
  FileCode,
  GitBranch,
  Rows2,
  Users,
} from "lucide-react";
import {
  EMPTY_COMPACTIONS,
  EMPTY_MESSAGES,
  EMPTY_STRING,
  useSessionStore,
  type ActiveTool,
  type AgentMessageLike,
  type CompactionEvent,
} from "../store/session-store";
import { useActiveProject, useProjectStore } from "../store/project-store";
import { api, ApiError } from "../lib/api-client";
import { useIsMobile } from "../lib/use-is-mobile";
import { ChatMarkdown } from "./ChatMarkdown";
import { CompactionCard } from "./CompactionCard";
import { DiffBlock } from "./DiffBlock";
import { SessionTreePanel } from "./SessionTreePanel";
import { QuickActionsMenu } from "./QuickActionsMenu";
import { QuickActionRunCard } from "./QuickActionRunCard";
import { useQuickActionRunsStore } from "../store/quick-actions-store";
import { parseSubagentDetails, type SubagentResult } from "../lib/subagent-parser";

/**
 * Per-ChatView diff view-type preference. Each diff-rendering surface
 * has its own setting (TurnDiffPanel uses `pi.turnDiff.viewType`,
 * GitPanel uses `pi.gitPanel.viewType`); chat inline edit-tool diffs
 * use `pi.chat.viewType`. Toggling one panel doesn't affect the
 * others — different mental contexts often want different layouts.
 *
 * The hover-revealed toggle on each `<details>` summary updates the
 * chat-wide pref via Context, so one click flips every other chat
 * diff currently rendered without remounting.
 */
type ChatViewType = "unified" | "split";
const ChatDiffViewContext = createContext<{
  viewType: ChatViewType;
  setViewType: (next: ChatViewType) => void;
}>({
  viewType: "unified",
  setViewType: () => undefined,
});

const CHAT_VIEW_TYPE_KEY = "forge.chat.viewType";
function readChatViewType(): ChatViewType {
  try {
    return localStorage.getItem(CHAT_VIEW_TYPE_KEY) === "split" ? "split" : "unified";
  } catch {
    // Private-mode storage — pick the default view type.
    return "unified";
  }
}

interface Props {
  sessionId: string;
}

/**
 * Phase 8 chat surface. Renders the SDK's AgentMessage union heuristically —
 * matches on `role` and `type` to pick a renderer per message kind. The shape
 * detection lives at the renderer boundary rather than in the store so we
 * don't couple the bundle to SDK type internals.
 *
 * Markdown rendering for user text, assistant text blocks, and the
 * streaming preview goes through `ChatMarkdown` — `react-markdown` +
 * `remark-gfm` with prism-highlighted fenced code blocks. Tool calls,
 * file-reference badges, bash exec messages, and image attachments
 * still render as their dedicated components (markdown is for prose
 * only).
 */
export function ChatView({ sessionId }: Props) {
  // EMPTY_* fallbacks are stable module-level constants — using `?? []` here
  // would return a new ref each render and trip React 18's
  // useSyncExternalStore infinite-loop guard. See session-store.ts.
  const messages = useSessionStore((s) => s.messagesBySession[sessionId] ?? EMPTY_MESSAGES);
  const compactions = useSessionStore(
    (s) => s.compactionsBySession[sessionId] ?? EMPTY_COMPACTIONS,
  );
  const streamingText = useSessionStore((s) => s.streamingTextBySession[sessionId] ?? EMPTY_STRING);
  const isStreaming = useSessionStore((s) => s.streamingBySession[sessionId] ?? false);
  const activeTool = useSessionStore((s) => s.activeToolBySession[sessionId]);
  const banner = useSessionStore((s) => s.bannerBySession[sessionId]);
  const queued = useSessionStore((s) => s.queuedBySession[sessionId]);
  const openStream = useSessionStore((s) => s.openStream);
  const closeStream = useSessionStore((s) => s.closeStream);
  // Pending scroll target set by the global search bar when the user
  // clicks a result. Read as a primitive so the effect below only
  // re-fires when the target index actually changes (selecting the
  // map and reading by key would re-run on every map mutation).
  const pendingScrollTarget = useSessionStore((s) => s.pendingScrollByMessageIndex[sessionId]);
  const consumePendingScroll = useSessionStore((s) => s.consumePendingScroll);
  // Quick-action run cards for THIS session — empty array when none.
  // The store mutation triggers a re-render which the sticky-bottom
  // effect picks up automatically, so a new run appearing at the
  // bottom scrolls into view the same way a new message would.
  const allRuns = useQuickActionRunsStore((s) => s.runs);
  const sessionRuns = useMemo(
    () => allRuns.filter((r) => r.sessionId === sessionId),
    [allRuns, sessionId],
  );

  const [chatViewType, setChatViewType] = useState<ChatViewType>(readChatViewType);
  const setAndPersistChatViewType = (next: ChatViewType): void => {
    setChatViewType(next);
    try {
      localStorage.setItem(CHAT_VIEW_TYPE_KEY, next);
    } catch {
      // ignore — choice still applies for this session
    }
  };

  // Phase 15 — session tree overlay. The button lives in a tiny
  // toolbar above the scroll container so it's always visible
  // regardless of how far the user has scrolled.
  const project = useActiveProject();
  const [treeOpen, setTreeOpen] = useState(false);

  // Conversation export menu (Markdown / Raw JSONL). Hidden on mobile —
  // the file-download flow is desktop-shaped (browser save dialog,
  // open-in-editor follow-ups) and a phone user typically doesn't
  // want a .md / .jsonl landing in their Downloads folder anyway.
  const isMobile = useIsMobile();
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportError, setExportError] = useState<string | undefined>(undefined);
  const exportMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!exportMenuOpen) return;
    const onDoc = (e: MouseEvent): void => {
      if (exportMenuRef.current === null) return;
      if (!exportMenuRef.current.contains(e.target as Node)) setExportMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [exportMenuOpen]);
  const doExport = async (format: "markdown" | "jsonl"): Promise<void> => {
    setExportMenuOpen(false);
    setExportError(undefined);
    try {
      const { blob, filename } = await api.exportSession(sessionId, format);
      // Same trigger pattern FileBrowserPanel / SettingsPanel use:
      // synthesize an `<a download>`, click, then revoke the blob URL
      // on the next tick so Safari has time to grab it.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.code} (${err.status})`
          : err instanceof Error
            ? err.message
            : "export_failed";
      setExportError(message);
      // Auto-clear after a few seconds so a transient error doesn't
      // sit forever.
      window.setTimeout(() => setExportError(undefined), 4_000);
    }
  };

  // Open SSE on mount, close on unmount/session change. The store ensures
  // openStream is idempotent for the same id.
  useEffect(() => {
    openStream(sessionId);
    return () => {
      closeStream(sessionId);
    };
  }, [sessionId, openStream, closeStream]);

  const scrollRef = useRef<HTMLDivElement>(null);
  // "Sticky bottom" scroll: track the user's INTENT in a ref via the
  // onScroll handler, then auto-scroll only when intent says "follow."
  //
  // Why a ref and not a re-measure inside the effect: by the time the
  // effect fires, the new streaming text has already inflated scrollHeight,
  // so `scrollHeight - scrollTop - clientHeight` is artificially large —
  // the check would always say "user scrolled away" during streaming and
  // auto-scroll would never fire. Reading the ref reflects the user's
  // last actual scroll position before the content grew.
  const NEAR_BOTTOM_PX = 96;
  const isFollowingBottomRef = useRef(true);

  const onScroll = (): void => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    isFollowingBottomRef.current = distance <= NEAR_BOTTOM_PX;
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el === null) return;
    if (isFollowingBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages, streamingText, isStreaming]);

  // Force scroll-to-bottom + re-engage follow mode whenever a NEW
  // user message lands at the tail. Catches both the "user typed in
  // the input box" path AND the "user message arrived via cross-tab
  // sync" path. Without this, a user who scrolled up to read history
  // and then submits a prompt stays parked in history while the
  // agent's response streams off-screen.
  const lastUserMessageCountRef = useRef(0);
  useEffect(() => {
    const userCount = messages.reduce((n, m) => (m.role === "user" ? n + 1 : n), 0);
    if (userCount > lastUserMessageCountRef.current) {
      const el = scrollRef.current;
      if (el !== null) el.scrollTop = el.scrollHeight;
      isFollowingBottomRef.current = true;
    }
    lastUserMessageCountRef.current = userCount;
  }, [messages]);

  // Global-search scroll-to-message: when the search bar dispatches a
  // pending target for this session, locate the matching wrapper by
  // its `data-message-index` attribute and bring it into view. Wait
  // for the snapshot to land (messages.length > target) so the target
  // node actually exists in the DOM. Once consumed, drop the pending
  // value so a re-mount of ChatView (e.g. user toggling the chat
  // pane) doesn't re-scroll. Disable sticky-bottom follow so the
  // subsequent agent stream doesn't yank focus away.
  useEffect(() => {
    if (pendingScrollTarget === undefined) return;
    if (messages.length <= pendingScrollTarget) return;
    const root = scrollRef.current;
    if (root === null) return;
    const node = root.querySelector(`[data-message-index="${pendingScrollTarget}"]`);
    if (node === null) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    isFollowingBottomRef.current = false;
    consumePendingScroll(sessionId);
  }, [pendingScrollTarget, messages.length, sessionId, consumePendingScroll]);

  return (
    <ChatDiffViewContext.Provider
      value={{ viewType: chatViewType, setViewType: setAndPersistChatViewType }}
    >
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Chat-level toolbar. Per-session controls (export, session
            tree, etc.) — pinned above the scroll container so the
            affordances stay reachable from any scroll position. */}
        <div className="flex items-center justify-between gap-1 border-b border-neutral-800 bg-neutral-900/30 px-3 py-1">
          {/* Left cluster — quick-action chips. Empty when no actions
              are defined, in minimal mode with only command chips,
              or while the store is still loading. The container is
              always rendered so the right cluster stays anchored
              right via flex justify-between. */}
          <div className="flex items-center gap-1">
            {project !== undefined && (
              <QuickActionsMenu sessionId={sessionId} projectId={project.id} />
            )}
          </div>
          <div className="flex items-center gap-1">
            {!isMobile && (
              <div ref={exportMenuRef} className="relative">
                <button
                  onClick={() => setExportMenuOpen((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={exportMenuOpen}
                  className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
                  title="Export this conversation"
                >
                  <Download size={11} />
                  Export
                </button>
                {exportMenuOpen && (
                  <div
                    role="menu"
                    className="absolute right-0 top-full z-30 mt-1 min-w-[12rem] rounded-md border border-neutral-700 bg-neutral-900 py-1 shadow-xl"
                  >
                    <button
                      role="menuitem"
                      onClick={() => void doExport("markdown")}
                      className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800"
                    >
                      Markdown <span className="text-neutral-500">(.md)</span>
                    </button>
                    <button
                      role="menuitem"
                      onClick={() => void doExport("jsonl")}
                      className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 hover:bg-neutral-800"
                    >
                      Raw JSONL <span className="text-neutral-500">(.jsonl)</span>
                    </button>
                  </div>
                )}
              </div>
            )}
            {exportError !== undefined && (
              <span className="text-[10px] text-amber-400 light:text-amber-700" role="status">
                Export failed: {exportError}
              </span>
            )}
            <button
              onClick={() => setTreeOpen(true)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
              title="Open session tree (navigate / fork from any prior point)"
            >
              <GitBranch size={11} />
              Tree
            </button>
          </div>
        </div>
        {/* Banner sits ABOVE the scroll container so it stays pinned to the top
            of the chat view regardless of how far the user has scrolled into a
            long session. Earlier we rendered it inside the scroll container,
            which meant a long-running streaming session pushed the
            "Reconnecting…" / compaction banners off-screen. */}
        {banner !== undefined && (
          <div className="border-b border-amber-700/40 bg-amber-900/20 px-6 py-2 text-xs text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
            {banner}
          </div>
        )}
        <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 && streamingText.length === 0 && !isStreaming && (
            <p className="mt-12 text-center text-sm text-neutral-500">
              No messages yet. Send a prompt to get started.
            </p>
          )}
          <div className="chat-message-list mx-auto max-w-3xl space-y-4">
            {(() => {
              // Pair toolCall blocks (in assistant messages) with their
              // matching toolResult messages (by toolCallId) so each
              // tool invocation renders as one collapsed entry instead
              // of two separate boxes. Loose toolResults — orphans
              // from older sessions, or results whose call we never
              // saw — still render via the standalone path.
              const toolResultsById = new Map<string, AgentMessageLike>();
              const pairedIds = new Set<string>();
              for (const m of messages) {
                if (m.role === "toolResult" && typeof m.toolCallId === "string") {
                  toolResultsById.set(m.toolCallId, m);
                }
              }
              for (const m of messages) {
                if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
                for (const block of m.content as Record<string, unknown>[]) {
                  if (block.type === "toolCall" && typeof block.id === "string") {
                    pairedIds.add(block.id);
                  }
                }
              }
              // Group compactions by `insertBeforeIndex` so each
              // render-loop tick can ask "any cards land here?" in O(1).
              // Multiple compactions can share insertBeforeIndex=0 —
              // those are the older events whose kept window has
              // itself been re-archived; render them stacked at the
              // top in chronological order.
              const compactionsAt = new Map<number, CompactionEvent[]>();
              for (const ev of compactions) {
                const list = compactionsAt.get(ev.insertBeforeIndex) ?? [];
                list.push(ev);
                compactionsAt.set(ev.insertBeforeIndex, list);
              }
              const renderArchived = (ev: CompactionEvent): React.ReactNode =>
                ev.archivedMessages.map((am, i) => (
                  <Message key={i} message={am} toolResultsById={toolResultsById} />
                ));
              const out: React.ReactNode[] = [];
              const renderCardsAt = (idx: number): void => {
                const events = compactionsAt.get(idx);
                if (events === undefined) return;
                for (const ev of events) {
                  out.push(
                    <CompactionCard
                      key={`compaction-${ev.id}`}
                      event={ev}
                      renderArchived={() => renderArchived(ev)}
                    />,
                  );
                }
              };
              messages.forEach((m, i) => {
                renderCardsAt(i);
                if (
                  m.role === "toolResult" &&
                  typeof m.toolCallId === "string" &&
                  pairedIds.has(m.toolCallId)
                ) {
                  return; // rendered inline next to its toolCall
                }
                // Hide the SDK-synthesized compaction summary message
                // (role: "compactionSummary"). The same summary text
                // already renders inside our CompactionCard's
                // disclosure body, so showing it as a top-of-chat
                // bubble would just duplicate the content under an
                // "unknown message" fallback.
                if (m.role === "compactionSummary") return;
                out.push(
                  <div key={i} data-message-index={i}>
                    <Message message={m} toolResultsById={toolResultsById} />
                  </div>,
                );
              });
              // Trailing cards (insertBeforeIndex === messages.length)
              // — the entire current context was archived but no
              // messages have been pushed since. Rare; render at the
              // bottom for completeness.
              renderCardsAt(messages.length);
              return out;
            })()}
            {streamingText.length > 0 && (
              <div className="message-bubble rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                  assistant (streaming)
                </div>
                <div className="text-neutral-100">
                  <ChatMarkdown text={streamingText} />
                  <span className="ml-1 inline-block h-3 w-1.5 animate-pulse bg-neutral-300 align-text-bottom" />
                </div>
              </div>
            )}
            {isStreaming && streamingText.length === 0 && (
              <ActiveToolPlaceholder tool={activeTool} />
            )}
            {queued !== undefined && <QueuedMessages queued={queued} />}
            {sessionRuns.map((run) => (
              <QuickActionRunCard key={run.runId} run={run} />
            ))}
          </div>
        </div>
      </div>
      {treeOpen && project !== undefined && (
        <SessionTreePanel
          sessionId={sessionId}
          projectId={project.id}
          onClose={() => setTreeOpen(false)}
        />
      )}
    </ChatDiffViewContext.Provider>
  );
}

/**
 * Inline badge listing messages the user has queued during the
 * current run. Pi delivers `steering` at the next agent decision
 * point (mid-tool boundary) and `followUp` once the agent goes idle.
 * The SDK clears these on delivery, which fires another queue_update
 * with the new (smaller) arrays — no need to pop locally.
 */
function QueuedMessages({ queued }: { queued: { steering: string[]; followUp: string[] } }) {
  const all: { kind: "steer" | "followUp"; text: string }[] = [];
  for (const text of queued.steering) all.push({ kind: "steer", text });
  for (const text of queued.followUp) all.push({ kind: "followUp", text });
  if (all.length === 0) return null;
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-900/40 px-3 py-2">
      <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
        queued ({all.length})
      </div>
      <ul className="space-y-1">
        {all.map((q) => (
          // Key on (kind, text). Pi clears delivered queue items by
          // emitting a smaller queue_update; index would shift and
          // index-based keys would remount items into different DOM
          // slots. Even with text duplicates the visual is identical
          // — a re-mount is harmless.
          <li
            key={`${q.kind}:${q.text}`}
            className="flex items-baseline gap-2 text-xs text-neutral-300"
          >
            <span
              className={
                q.kind === "steer"
                  ? "shrink-0 rounded bg-amber-900/30 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-300 light:bg-amber-100 light:text-amber-800"
                  : "shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400"
              }
              title={
                q.kind === "steer"
                  ? "Delivered at the agent's next decision point (often mid-tool)"
                  : "Delivered after the agent goes fully idle"
              }
            >
              {q.kind === "steer" ? "steer" : "follow-up"}
            </span>
            <span className="truncate">{q.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Pre-text placeholder while the agent is busy. If a tool is currently
 * executing we render its name + a one-line summary ("running `bash`:
 * `ls`") so the user sees what the agent is doing instead of an opaque
 * spinner. Outside tool execution we fall back to "Thinking…".
 */
function ActiveToolPlaceholder({ tool }: { tool: ActiveTool | undefined }) {
  if (tool === undefined) {
    return (
      <div
        className="flex items-center gap-2 text-xs italic text-neutral-500"
        aria-live="polite"
        aria-label="Agent is thinking"
      >
        <span>Thinking</span>
        <span className="pi-thinking-dots" aria-hidden="true">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-neutral-400">
      <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-neutral-400" />
      <span className="text-neutral-500">running</span>
      <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-[11px] text-neutral-200">
        {tool.name}
      </code>
      {tool.summary !== undefined && (
        <code
          className="truncate rounded bg-neutral-900 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300"
          title={tool.summary}
        >
          {tool.summary}
        </code>
      )}
    </div>
  );
}

/**
 * Wrapper for the inline edit-tool diff in chat. Reads the chat-wide
 * view-type pref via Context and renders a hover-revealed toggle on
 * the right side of the `<details>` summary so the user can flip
 * unified ↔ split without leaving the chat surface. Toggle is the
 * same Columns2/Rows2 icon pair the panels use, so muscle memory
 * carries.
 */
function ChatEditDiff({
  diff,
  filename,
  adds,
  dels,
}: {
  diff: string;
  filename: string | undefined;
  adds: number;
  dels: number;
}) {
  const { viewType, setViewType } = useContext(ChatDiffViewContext);
  return (
    <details className="group rounded border border-neutral-800 bg-neutral-950 text-xs">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-neutral-300">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-neutral-500">edit{filename !== undefined ? " " : ""}</span>
          {filename !== undefined && <span className="truncate font-mono">{filename}</span>}
          <span className="ml-2 text-emerald-400 light:text-emerald-700">+{adds}</span>
          <span className="ml-1 text-red-400 light:text-red-700">−{dels}</span>
        </span>
        <button
          onClick={(e) => {
            // The summary's default click toggles the <details>; stop
            // propagation so flipping the view doesn't also collapse
            // the diff the user just opened.
            e.preventDefault();
            e.stopPropagation();
            setViewType(viewType === "split" ? "unified" : "split");
          }}
          className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title={
            viewType === "split"
              ? "Switch chat diffs to unified view"
              : "Switch chat diffs to side-by-side view"
          }
        >
          {viewType === "split" ? <Rows2 size={11} /> : <Columns2 size={11} />}
        </button>
      </summary>
      <DiffBlock diff={diff} viewType={viewType} />
    </details>
  );
}

/**
 * Extract every file reference embedded in a stored user-message text
 * and strip the underlying tokens from the visible text.
 *
 * Two forms come through, both rendered as badges in the bubble:
 *   - "inlined": fenced ``` `<lang> file: <path>` ```-style blocks
 *     that the server's expandFileReferences (or multipart text-file
 *     composer) emitted. Content is included; the badge expands to
 *     show it.
 *   - "deferred": bare `@<path>` (or `@"path with spaces"`) markers
 *     that the server left for the model to load on demand. No
 *     content; the badge just shows the path with a tooltip.
 *
 * Backreference (`\1`) on the fenced regex matches the closing fence
 * length to the opening, mirroring the longest-run-plus-one logic on
 * the server.
 */
type FileRef =
  | { kind: "inline"; path: string; lang: string; content: string }
  | { kind: "defer"; path: string };

function extractFileRefs(text: string): { stripped: string; refs: FileRef[] } {
  const refs: FileRef[] = [];
  // Step 1: pull out fenced "<lang> file: <path>" blocks. The server
  // (after the file-references fix) emits the literal `@<path>` marker
  // immediately before each fenced block, so dropping just the block
  // here leaves the marker in place inline with the user's prose.
  //
  // Eat the `\n` immediately before AND after the fence too so the
  // marker flows inline with surrounding prose — without this, the
  // server's mandatory `marker\nfence\ntail` framing leaves an
  // orphan blank line between the marker and the rest of the
  // sentence after the fence is stripped. The leading `\n?` is
  // optional because the marker may be at start-of-string.
  const fenceRe = /\n?(`{3,})(\w*)\s+file:\s+([^\n]+)\n([\s\S]*?)\n\1\n?/g;
  let stripped = text.replace(
    fenceRe,
    (_match, _fence: string, lang: string, path: string, content: string) => {
      refs.push({ kind: "inline", path: path.trim(), lang, content });
      return "";
    },
  );
  // Step 2: collect bare `@<path>` (or `@"path"`) deferred refs WITHOUT
  // stripping them — the marker stays visible in the bubble so the
  // user's sentence still reads as typed ("look at @src/foo.ts and
  // explain"). The badge rendered below is the expandable affordance
  // for inline content; deferred refs no longer get a separate badge
  // since the inline marker already carries the information.
  // Lazy bare alternation + lookahead so trailing sentence punctuation
  // (`?`, `,`, `;`, `:`, `!`, `)`, `]`) doesn't end up in the path —
  // kept in sync with file-references.ts#REF_RE.
  const deferRe = /(^|\s)@(?:"([^"\n]+)"|([^\s]+?))(?=[?,;:!)\]]?(?:\s|$))/g;
  let m: RegExpExecArray | null;
  while ((m = deferRe.exec(stripped)) !== null) {
    const path = (m[2] ?? m[3] ?? "").trim();
    if (path.length === 0) continue;
    // Avoid duplicating the inline ref we already collected above —
    // when the server inlines a file, the marker AND the fenced block
    // both appear, and we want a single badge for that pair.
    if (refs.some((r) => r.kind === "inline" && r.path === path)) continue;
    refs.push({ kind: "defer", path });
  }
  // Collapse runs of blank lines created by the fence removal.
  stripped = stripped.replace(/\n{3,}/g, "\n\n").trim();
  return { stripped, refs };
}

function FileRefBadge({ ref: r }: { ref: FileRef }) {
  const [expanded, setExpanded] = useState(false);
  const isInline = r.kind === "inline";
  return (
    <div
      className={`overflow-hidden rounded border bg-neutral-900 ${
        isInline ? "border-neutral-700" : "border-emerald-700/60 bg-emerald-900/15"
      }`}
    >
      <button
        type="button"
        onClick={() => isInline && setExpanded((v) => !v)}
        disabled={!isInline}
        className={`flex min-h-11 w-full items-center gap-1.5 px-2 py-1 text-left text-[11px] md:min-h-0 ${
          isInline
            ? "text-neutral-200 hover:bg-neutral-800"
            : "cursor-default text-emerald-200 light:text-emerald-800"
        }`}
        title={
          isInline
            ? `${r.path} — click to ${expanded ? "collapse" : "expand"}`
            : `${r.path} — model will load this on demand using its read tool (file is larger than the inline threshold)`
        }
      >
        {isInline ? (
          expanded ? (
            <ChevronDown size={12} />
          ) : (
            <ChevronRight size={12} />
          )
        ) : (
          <AtSign size={12} className="text-emerald-300/80 light:text-emerald-700" />
        )}
        <FileCode size={12} className={isInline ? "text-neutral-400" : "text-emerald-300/80"} />
        <span className="font-mono">{r.path}</span>
        {isInline && (
          <span className="text-[10px] text-neutral-500">
            {r.content.length < 1024
              ? `${r.content.length} B`
              : `${(r.content.length / 1024).toFixed(1)} KB`}
          </span>
        )}
        {!isInline && (
          <span className="text-[10px] text-emerald-300/70 light:text-emerald-700/80">
            on demand
          </span>
        )}
      </button>
      {isInline && expanded && (
        <pre className="max-h-72 overflow-auto border-t border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-[11px] leading-relaxed text-neutral-300">
          {r.content}
        </pre>
      )}
    </div>
  );
}

function Message({
  message,
  toolResultsById,
}: {
  message: AgentMessageLike;
  toolResultsById?: Map<string, AgentMessageLike>;
}) {
  // Per-message toggle: rendered markdown (default) ↔ raw plaintext.
  // Useful when the user wants to copy a literal `**bold**` or see
  // exactly what whitespace the assistant emitted. State lives at
  // the message level so all text blocks within an assistant message
  // flip together (one click, not one per block).
  const [showRaw, setShowRaw] = useState(false);

  // User text messages — may include image + file attachments per
  // Phase 14. Optimistic shape uses a blob URL on the image block;
  // canonical refetched shape uses raw base64 with a mimeType, which
  // we render via a data URL.
  if (message.role === "user") {
    const rawText = extractText(message);
    const { stripped: text, refs: fileRefs } = extractFileRefs(rawText);
    const blocks = Array.isArray(message.content) ? message.content : [];
    const images: { src: string; key: string }[] = [];
    const files: { name: string; size?: number; key: string }[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i] as Record<string, unknown>;
      if (b.type === "image") {
        const data = typeof b.data === "string" ? b.data : "";
        const mime = typeof b.mimeType === "string" ? b.mimeType : "image/png";
        // Optimistic blocks set `__blobUrl`; treat `data` as a
        // direct blob URL. Canonical blocks store raw base64; build
        // a data URL on the fly.
        const isBlob = b.__blobUrl === true;
        const src = isBlob ? data : `data:${mime};base64,${data}`;
        if (data.length > 0) images.push({ src, key: `img-${i}` });
      } else if (b.type === "file") {
        const name = typeof b.filename === "string" ? b.filename : "attachment";
        const file: { name: string; size?: number; key: string } = { name, key: `file-${i}` };
        if (typeof b.size === "number") file.size = b.size;
        files.push(file);
      }
    }
    return (
      <div
        className="message-bubble group rounded-lg bg-neutral-800 px-4 py-3"
        data-message-role="user"
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-neutral-400">you</span>
            <MessageTimestamp ts={(message as { timestamp?: unknown }).timestamp} />
          </div>
          {text.length > 0 && (
            <div className="flex items-center gap-1">
              <CopyButton getText={() => text} title="Copy message text" />
              <RawToggle showRaw={showRaw} onToggle={setShowRaw} />
            </div>
          )}
        </div>
        {text.length > 0 && (
          <div className="text-neutral-100">
            {showRaw ? (
              <RawText text={text} />
            ) : (
              // Chat-style hard breaks for user input only — see
              // ChatMarkdown's `chatStyleBreaks` prop docstring for
              // the trade-off (tables in user input need a leading
              // blank line; this matches what most users type).
              <ChatMarkdown text={text} chatStyleBreaks />
            )}
          </div>
        )}
        {fileRefs.length > 0 && (
          <div className="mt-2 flex flex-col gap-1">
            {fileRefs.map((r, i) => (
              <FileRefBadge key={`fileref-${i}-${r.path}`} ref={r} />
            ))}
          </div>
        )}
        {images.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {images.map((img) => (
              <img
                key={img.key}
                src={img.src}
                alt=""
                className="max-h-48 max-w-full rounded border border-neutral-700"
              />
            ))}
          </div>
        )}
        {files.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-2">
            {files.map((f) => (
              <span
                key={f.key}
                className="inline-flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-300"
                title={f.name}
              >
                <span className="font-mono">{f.name}</span>
                {f.size !== undefined && (
                  <span className="text-[10px] text-neutral-500">
                    {f.size < 1024
                      ? `${f.size} B`
                      : f.size < 1024 * 1024
                        ? `${(f.size / 1024).toFixed(1)} KB`
                        : `${(f.size / (1024 * 1024)).toFixed(1)} MB`}
                  </span>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Assistant messages — content is an array of TextContent / ThinkingContent / ToolCall.
  if (message.role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    // Show the raw toggle only when the message has at least one
    // text block — toolCall and thinking blocks aren't markdown and
    // the toggle would do nothing useful for them.
    const hasTextBlock = content.some((b) => (b as Record<string, unknown>).type === "text");
    return (
      <div
        className="message-bubble group rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
        data-message-role="assistant"
      >
        <div className="mb-1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-wider text-neutral-500">assistant</span>
            <MessageTimestamp ts={(message as { timestamp?: unknown }).timestamp} />
          </div>
          {hasTextBlock && (
            <div className="flex items-center gap-1">
              <CopyButton
                getText={() => assistantTextContent(content as Record<string, unknown>[])}
                title="Copy all text from this assistant message"
              />
              <RawToggle showRaw={showRaw} onToggle={setShowRaw} />
            </div>
          )}
        </div>
        <div className="space-y-2 text-sm text-neutral-100">
          {renderAssistantBlocks(content as Record<string, unknown>[], toolResultsById, showRaw)}
        </div>
      </div>
    );
  }

  // Tool result messages — render based on toolName.
  if (message.role === "toolResult") {
    return <ToolResult message={message} />;
  }

  // Bash execution messages — surface via either the SDK's native
  // `role: "bashExecution"` BashExecutionMessage (the `!` chat input
  // path appends these via session.sessionManager.appendMessage) or
  // the custom-message-entry shape some flows produce.
  if (
    message.role === "bashExecution" ||
    message.type === "bashExecution" ||
    message.customType === "bashExecution"
  ) {
    return <BashExecution message={message} />;
  }

  // Fallback: stringify so we can see what we missed.
  return (
    <details className="rounded-lg border border-neutral-800 bg-neutral-900/40 px-3 py-2 text-xs text-neutral-400">
      <summary className="cursor-pointer">
        unknown message ({String(message.role ?? message.type ?? "?")})
      </summary>
      <pre className="mt-2 overflow-auto whitespace-pre-wrap text-[10px] text-neutral-500">
        {JSON.stringify(message, null, 2)}
      </pre>
    </details>
  );
}

/**
 * Render an assistant message's content array, collapsing runs of
 * consecutive `todo` toolCall blocks into a single batched card.
 *
 * Motivation: a single planning turn often fires 5+ `todo create`
 * calls back-to-back, and each one would otherwise render as its
 * own bordered card — eating vertical space with redundant info
 * (every todo result carries the full state, so only the last one
 * is informative; the rest are intermediate steps).
 *
 * Non-todo blocks render unchanged via the normal AssistantBlock
 * path. Mixed runs (text + todo + bash) stay in original order
 * because grouping only happens for adjacent todo blocks.
 */
function renderAssistantBlocks(
  content: Record<string, unknown>[],
  toolResultsById: Map<string, AgentMessageLike> | undefined,
  showRaw: boolean,
): React.ReactNode {
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < content.length) {
    const block = content[i]!;
    if (block.type === "toolCall" && block.name === "todo") {
      // Greedy: pull every adjacent todo toolCall into the same batch.
      const start = i;
      const batch: { block: Record<string, unknown>; result: AgentMessageLike | undefined }[] = [];
      while (i < content.length) {
        const b = content[i];
        if (b?.type !== "toolCall" || b.name !== "todo") break;
        const id = typeof b.id === "string" ? b.id : undefined;
        const r = id !== undefined ? toolResultsById?.get(id) : undefined;
        batch.push({ block: b, result: r });
        i += 1;
      }
      if (batch.length === 1) {
        // Single call — render via the standard ToolCallEntry path.
        const only = batch[0]!;
        out.push(<ToolCallEntry key={start} block={only.block} result={only.result} />);
      } else {
        out.push(<TodoBatchCard key={`todo-batch-${start}`} entries={batch} />);
      }
      continue;
    }
    const blockProps: {
      block: Record<string, unknown>;
      toolResultsById?: Map<string, AgentMessageLike>;
      showRaw?: boolean;
    } = { block, showRaw };
    if (toolResultsById !== undefined) blockProps.toolResultsById = toolResultsById;
    out.push(<AssistantBlock key={i} {...blockProps} />);
    i += 1;
  }
  return out;
}

/**
 * Compact single-card rendering for a run of N consecutive `todo`
 * tool calls in one assistant message. Each call's one-line result
 * text becomes a row; the latest result's task count is the
 * headline. Expanded view shows the full output of each call.
 */
function TodoBatchCard({
  entries,
}: {
  entries: { block: Record<string, unknown>; result: AgentMessageLike | undefined }[];
}) {
  const lastWithResult = [...entries].reverse().find((e) => e.result !== undefined);
  const lastDetails =
    (lastWithResult?.result?.details as { tasks?: unknown; nextId?: unknown } | undefined) ??
    undefined;
  const taskCount = Array.isArray(lastDetails?.tasks) ? lastDetails.tasks.length : 0;
  const inFlight = entries.filter((e) => e.result === undefined).length;
  const errored = entries.some((e) => e.result?.isError === true);
  const lines = entries.map((e) => {
    const content = Array.isArray(e.result?.content) ? e.result.content : [];
    const first = content.find((c): c is { type: "text"; text: string } => {
      const o = c as { type?: unknown; text?: unknown };
      return o.type === "text" && typeof o.text === "string";
    });
    return first?.text ?? "(no output)";
  });
  return (
    <details className="group rounded border border-neutral-800 bg-neutral-950 text-xs">
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-neutral-300">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-neutral-500">→</span>
          <span className="font-mono">todo</span>
          <span className="text-neutral-500">
            ×{entries.length} {entries.length === 1 ? "call" : "calls"}
          </span>
          <span className="ml-2 truncate text-neutral-400">
            {taskCount === 0
              ? "no tasks"
              : `${taskCount} ${taskCount === 1 ? "task" : "tasks"} after batch`}
          </span>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          {inFlight > 0 && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
              {inFlight} running…
            </span>
          )}
          {errored && (
            <span className="rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-red-300 light:bg-red-100 light:text-red-800">
              error
            </span>
          )}
        </div>
      </summary>
      <div className="space-y-1 border-t border-neutral-800/60 px-3 py-2 font-mono text-[11px] text-neutral-400">
        {lines.map((line, j) => (
          <div key={j} className="flex items-baseline gap-2">
            <span className="shrink-0 text-neutral-600">#{j + 1}</span>
            <span className="whitespace-pre-wrap break-words text-neutral-300">{line}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function AssistantBlock({
  block,
  toolResultsById,
  showRaw = false,
}: {
  block: Record<string, unknown>;
  toolResultsById?: Map<string, AgentMessageLike>;
  /** When true, render text blocks as plain `<pre>` instead of markdown. */
  showRaw?: boolean;
}) {
  const type = block.type;

  if (type === "text" && typeof block.text === "string") {
    return showRaw ? <RawText text={block.text} /> : <ChatMarkdown text={block.text} />;
  }

  if (type === "thinking" && typeof block.thinking === "string") {
    return (
      <details className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400">
        <summary className="cursor-pointer">Thinking…</summary>
        <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-[12px]">
          {block.thinking}
        </pre>
      </details>
    );
  }

  if (type === "toolCall") {
    const id = typeof block.id === "string" ? block.id : undefined;
    const result = id !== undefined ? toolResultsById?.get(id) : undefined;
    return <ToolCallEntry block={block} result={result} />;
  }

  return (
    <details className="text-xs text-neutral-500">
      <summary className="cursor-pointer">block ({String(type ?? "?")})</summary>
      <pre className="mt-1 overflow-auto whitespace-pre-wrap text-[10px]">
        {JSON.stringify(block, null, 2)}
      </pre>
    </details>
  );
}

/**
 * One tool invocation rendered as a single entry: header (always
 * visible) + collapsible Input row + collapsible Output row.
 *
 * Replaces the prior layout where the assistant-side toolCall block
 * and its matching toolResult message rendered as two separate boxes.
 * Pairing happens in the parent render loop via toolCallId; if no
 * result has arrived yet (mid-streaming) the Output row shows
 * "running…" and is not collapsible.
 *
 * `edit` keeps its specialized diff renderer inside the Output row —
 * the diff is the most informative content for that tool, and
 * showing it inside the same collapsed entry keeps the visual
 * grouping while preserving the per-file +/- gutter the user is
 * used to.
 */
function ToolCallEntry({
  block,
  result,
}: {
  block: Record<string, unknown>;
  result: AgentMessageLike | undefined;
}) {
  const name = String(block.name ?? "tool");
  const args = block.input ?? block.arguments ?? {};
  const argsText = typeof args === "string" ? args : JSON.stringify(args, null, 2);

  const isError = result?.isError === true;
  const resultContent = Array.isArray(result?.content) ? result?.content : [];

  // One-line header preview so the entry is scannable without
  // expanding it. Pulled from the tool's args by name:
  //   bash         → command (most informative single line)
  //   read/write   → file path / filename
  //   edit         → file path (the +/- counts live on the Output row)
  //   anything else → no preview (the Input row carries it)
  // Long values are truncated visually via CSS; the full text lives
  // in the Input row anyway.
  const argsObj = isObjectShape(args) ? args : undefined;
  const preview =
    name === "bash" && typeof argsObj?.command === "string"
      ? argsObj.command
      : (name === "read" || name === "write" || name === "edit") &&
          typeof argsObj?.path === "string"
        ? argsObj.path
        : undefined;
  const outputText = resultContent
    .filter((c): c is { type: "text"; text: string } => {
      const o = c as { type?: unknown; text?: unknown };
      return o.type === "text" && typeof o.text === "string";
    })
    .map((c) => c.text)
    .join("\n");

  // For `edit`, prefer the unified diff string the SDK puts on
  // result.details over the joined text body — same logic the prior
  // standalone ToolResult used; keeping it here means edit results
  // still render as a real diff once expanded.
  const editDiff =
    name === "edit" && result !== undefined
      ? (() => {
          const d = (result.details as { diff?: unknown } | undefined)?.diff;
          return typeof d === "string" ? d : outputText;
        })()
      : undefined;
  const editFn = name === "edit" && result !== undefined ? extractFilename(result) : undefined;
  const editStats = editDiff !== undefined ? countDiffLines(editDiff) : undefined;

  // pi-subagents tool gets a dedicated rich card instead of the
  // generic toolCall+result rendering. Short-circuit BEFORE the
  // generic render path: the user's eye should land on the violet
  // sub-agent card with its prominent Open button, not on a row of
  // small "subagent" badges nested under "Input/Output" details.
  // Pre-result (running) state still fires through here — the card
  // surfaces the input args (which agent + task) so the user sees
  // what's running.
  if (name === "subagent") {
    return (
      <SubagentInflightOrResult
        argsText={argsText}
        input={argsObj}
        result={result}
        isError={isError}
        outputText={outputText}
      />
    );
  }

  // Border tint reflects success/error/pending so the user can scan
  // a long thread without expanding every entry.
  const borderClass =
    result === undefined
      ? "border-neutral-700"
      : isError
        ? "border-red-700/50"
        : "border-neutral-800";

  return (
    <div className={`rounded border ${borderClass} bg-neutral-950 text-xs`}>
      <div className="flex items-center justify-between px-3 py-2 text-neutral-300">
        <div className="min-w-0 flex-1 truncate">
          <span className="text-neutral-500">→ </span>
          <span className="font-mono">{name}</span>
          {preview !== undefined && (
            <span className="ml-2 truncate font-mono text-neutral-400" title={preview}>
              {preview}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {result === undefined && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400">
              running…
            </span>
          )}
          {isError && (
            <span className="rounded bg-red-900/30 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-red-300 light:bg-red-100 light:text-red-800">
              error
            </span>
          )}
        </div>
      </div>

      {argsText.length > 0 && (
        <details className="border-t border-neutral-800/60">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-neutral-500 hover:text-neutral-300">
            Input
          </summary>
          <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-400">
            {argsText}
          </pre>
        </details>
      )}

      {result !== undefined && (
        <details className="border-t border-neutral-800/60">
          <summary className="cursor-pointer px-3 py-1.5 text-[11px] text-neutral-500 hover:text-neutral-300">
            Output
            {editStats !== undefined && (
              <span className="ml-2 font-mono text-[10px]">
                <span className="text-emerald-400 light:text-emerald-700">+{editStats.adds}</span>{" "}
                <span className="text-red-400 light:text-red-700">-{editStats.dels}</span>
              </span>
            )}
            {editFn !== undefined && (
              <span className="ml-2 font-mono text-[10px] text-neutral-500">{editFn}</span>
            )}
          </summary>
          {editDiff !== undefined && editStats !== undefined ? (
            <div className="px-3 pb-2">
              <ChatEditDiff
                diff={editDiff}
                filename={editFn}
                adds={editStats.adds}
                dels={editStats.dels}
              />
            </div>
          ) : (
            <pre className="max-h-96 overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-300">
              {outputText.length > 0 ? outputText : "(empty)"}
            </pre>
          )}
        </details>
      )}
    </div>
  );
}

function ToolResult({ message }: { message: AgentMessageLike }) {
  const toolName = String(message.toolName ?? "tool");
  const isError = message.isError === true;
  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .filter((c): c is { type: "text"; text: string } => {
      const o = c as { type?: unknown; text?: unknown };
      return o.type === "text" && typeof o.text === "string";
    })
    .map((c) => c.text)
    .join("\n");

  // Special-case the few known tools the dev plan calls out.
  if (toolName === "edit") {
    const details = message.details as { diff?: string } | undefined;
    const diff = typeof details?.diff === "string" ? details.diff : text;
    const fn = extractFilename(message);
    const { adds, dels } = countDiffLines(diff);
    return <ChatEditDiff diff={diff} filename={fn} adds={adds} dels={dels} />;
  }

  if (toolName === "read") {
    const fn = extractFilename(message);
    return (
      <details className="rounded border border-neutral-800 bg-neutral-950 text-xs">
        <summary className="cursor-pointer px-3 py-2 text-neutral-300">
          <span className="text-neutral-500">read{fn !== undefined ? " " : ""}</span>
          {fn !== undefined && <span className="font-mono">{fn}</span>}
        </summary>
        <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-400">{text}</pre>
      </details>
    );
  }

  if (toolName === "bash") {
    const cmd = extractCommand(message);
    return (
      <div
        className={`rounded border ${isError ? "border-red-700/40" : "border-neutral-800"} bg-neutral-950 text-xs`}
      >
        <div className="px-3 py-2 text-neutral-400">
          <span className="text-neutral-500">bash{cmd !== undefined ? " → " : " output"}</span>
          {cmd !== undefined && <span className="font-mono">{cmd}</span>}
        </div>
        <pre className="max-h-64 overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-300">
          {text}
        </pre>
      </div>
    );
  }

  if (toolName === "write") {
    const fn = extractFilename(message);
    return (
      <details className="rounded border border-neutral-800 bg-neutral-950 text-xs">
        <summary className="cursor-pointer px-3 py-2 text-neutral-300">
          <span className="text-neutral-500">write{fn !== undefined ? " " : ""}</span>
          {fn !== undefined && <span className="font-mono">{fn}</span>}
          <span className="ml-2 text-neutral-500">({text.split("\n").length} lines)</span>
        </summary>
        <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-400">{text}</pre>
      </details>
    );
  }

  // pi-subagents: replace the generic tool card with a richer surface
  // listing each spawned sub-agent + a "open session" affordance.
  // Standalone (orphan) toolResult — no paired toolCall, so we have no
  // input args to show. argsText="" and the Input section won't render.
  if (toolName === "subagent") {
    return <SubagentResultCard message={message} argsText="" outputText={text} isError={isError} />;
  }

  // Generic tool result fallback.
  return (
    <details
      className={`rounded border ${isError ? "border-red-700/40 light:border-red-300" : "border-neutral-800"} bg-neutral-950 text-xs`}
    >
      <summary className="cursor-pointer px-3 py-2 text-neutral-300">
        <span className="text-neutral-500">{toolName}</span>
        {isError && <span className="ml-2 text-red-400 light:text-red-700">error</span>}
      </summary>
      <pre className="overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-400">{text}</pre>
    </details>
  );
}

/**
 * Render a `subagent` tool result with one row per spawned sub-agent.
 * Each row's "open session" button switches the active session to the
 * child via `setActiveSession(childSessionId)` — the sidebar's chevron
 * grouping then reveals the child under its parent. Management-mode
 * calls (`mode: "management"`) and details we couldn't parse fall
 * back to a plain text block so we never lose information silently.
 */
/**
 * Wrapper that picks the right sub-agent card variant based on whether
 * the tool has finished. In-flight (no result yet) renders a compact
 * "Sub-agent running…" card; completed renders SubagentResultCard,
 * which always carries Input + Output collapsibles so the user can
 * inspect what was sent and what came back — same affordance the
 * generic ToolCallEntry has.
 */
function SubagentInflightOrResult({
  argsText,
  input,
  result,
  isError,
  outputText,
}: {
  argsText: string;
  input: Record<string, unknown> | undefined;
  result: AgentMessageLike | undefined;
  isError: boolean;
  outputText: string;
}) {
  if (result !== undefined) {
    return (
      <SubagentResultCard
        message={result}
        argsText={argsText}
        outputText={outputText}
        isError={isError}
      />
    );
  }
  // In-flight: pull a friendly preview out of the SubagentParams shape
  // (single mode → input.agent / input.task; parallel/chain mode →
  // count of tasks; management mode → input.action). Best-effort —
  // schema-bumps on the plugin side just degrade to "running" with
  // no detail, never crash.
  let summary: string | undefined;
  if (input !== undefined) {
    const agent = typeof input.agent === "string" ? input.agent : undefined;
    const task = typeof input.task === "string" ? input.task : undefined;
    const action = typeof input.action === "string" ? input.action : undefined;
    const tasks = Array.isArray(input.tasks) ? input.tasks.length : undefined;
    const chain = Array.isArray(input.chain) ? input.chain.length : undefined;
    if (action !== undefined) summary = `action: ${action}`;
    else if (tasks !== undefined) summary = `${tasks} parallel task${tasks === 1 ? "" : "s"}`;
    else if (chain !== undefined) summary = `${chain}-step chain`;
    else if (agent !== undefined && task !== undefined) summary = `${agent} — ${task}`;
    else if (agent !== undefined) summary = agent;
  }
  return (
    <div className="overflow-hidden rounded border border-l-2 border-sky-700/50 border-l-sky-400 bg-sky-950/15 text-xs light:border-sky-300 light:border-l-sky-600 light:bg-sky-50">
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Users size={11} className="shrink-0 text-sky-300 light:text-sky-700" />
          <span className="truncate font-medium text-sky-100 light:text-sky-900">
            Sub-agent running…
          </span>
          {summary !== undefined && (
            <span
              className="ml-1 truncate font-mono text-[11px] text-sky-200/70 light:text-sky-800/80"
              title={summary}
            >
              {summary}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function SubagentResultCard({
  message,
  argsText,
  outputText,
  isError,
}: {
  message: AgentMessageLike;
  argsText: string;
  outputText: string;
  isError: boolean;
}) {
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const setActiveProject = useProjectStore((s) => s.setActive);
  const byProject = useSessionStore((s) => s.byProject);
  // Resolve a tool-result `sessionFile` (absolute path) back to its
  // canonical sessionId by scanning the loaded session list. pi-subagents
  // writes children as a literal `session.jsonl`, so the filename's
  // stem is the string "session" — useless for navigation. Server-side
  // discovery reads the JSONL header for the real id and surfaces both
  // path AND sessionId on UnifiedSession; we look up by path here.
  const sessionByPath = useMemo(() => {
    const map = new Map<string, { sessionId: string; projectId: string }>();
    for (const list of Object.values(byProject)) {
      for (const s of list) {
        if (typeof s.path === "string" && s.path.length > 0) {
          map.set(s.path, { sessionId: s.sessionId, projectId: s.projectId });
        }
      }
    }
    return map;
  }, [byProject]);
  const openByFile = (sessionFile: string | undefined): void => {
    if (sessionFile === undefined) {
      console.warn("[subagent] Open clicked but result has no sessionFile");
      return;
    }
    const match = sessionByPath.get(sessionFile);
    console.info("[subagent] Open clicked", { sessionFile, match });
    if (match === undefined) {
      // The child wasn't in any project's session list — most likely
      // because the project sidebar hasn't been refreshed since the
      // sub-agent ran. Reload the active project's list and retry.
      // For now: surface a console warning rather than silently doing
      // nothing. (A future revision could trigger a refetch + retry.)
      console.warn(
        "[subagent] Open: sessionFile not found in any project's session list",
        sessionFile,
      );
      return;
    }
    setActiveProject(match.projectId);
    setActiveSession(match.sessionId);
  };
  const parsed = parseSubagentDetails(message.details);
  const isManagement = parsed.mode === "management";
  const count = parsed.results.length;
  const headline =
    count === 1
      ? `Sub-agent: ${parsed.results[0]!.agent}`
      : count > 1
        ? `${count} sub-agents (${parsed.mode})`
        : isManagement
          ? "Sub-agent management"
          : "Sub-agent";

  // Light-blue (sky) color treatment per request — distinctive but
  // soft. Failures get a red border but keep the rest of the card
  // intact (so the input + output sections are still inspectable
  // when the call errored).
  const borderColors = isError
    ? "border-red-700/50 border-l-red-400 bg-red-950/15 light:border-red-300 light:border-l-red-600 light:bg-red-50"
    : "border-sky-700/50 border-l-sky-400 bg-sky-950/15 light:border-sky-300 light:border-l-sky-600 light:bg-sky-50";

  return (
    <div className={`overflow-hidden rounded border border-l-2 ${borderColors} text-xs`}>
      <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <Users size={11} className="shrink-0 text-sky-300 light:text-sky-700" />
          <span className="truncate font-medium text-sky-100 light:text-sky-900">{headline}</span>
          {parsed.context !== undefined && (
            <span
              className="shrink-0 rounded bg-sky-900/40 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-sky-200 light:bg-sky-100 light:text-sky-800"
              title={parsed.context === "fork" ? "Forked from parent context" : "Fresh context"}
            >
              {parsed.context}
            </span>
          )}
          {isError && (
            <span className="shrink-0 rounded bg-red-900/40 px-1 py-0.5 text-[9px] font-medium uppercase tracking-wider text-red-200 light:bg-red-100 light:text-red-800">
              error
            </span>
          )}
        </div>
        {parsed.results.length === 1 && parsed.results[0]!.sessionFile !== undefined && (
          <button
            onClick={() => openByFile(parsed.results[0]!.sessionFile)}
            className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded border border-sky-700/60 px-2 py-1 text-[12px] font-medium text-sky-200 hover:border-sky-500 hover:bg-sky-900/30 hover:text-sky-100 light:border-sky-400 light:text-sky-800 light:hover:border-sky-600 light:hover:bg-sky-100 light:hover:text-sky-900 md:min-h-0 md:px-1.5 md:py-0.5 md:text-[10px]"
            title={`Open sub-agent session — ${parsed.results[0]!.sessionFile}`}
          >
            <ExternalLink size={12} />
            Open
          </button>
        )}
      </div>
      {/* Multi-result body — one row per child with its own Open button. */}
      {count > 1 && (
        <div className="space-y-1.5 border-t border-sky-900/30 px-2.5 py-2">
          {parsed.results.map((r, i) => (
            <SubagentResultRow
              key={r.sessionFile ?? `${i}-${r.agent}`}
              result={r}
              onOpenFile={openByFile}
            />
          ))}
        </div>
      )}
      {/* Input + Output collapsibles — same affordance the generic
          ToolCallEntry has. Always present (when there's content),
          collapsed by default, so the card stays compact but the user
          can still see what was sent and what came back. Failures
          surface here as Output content rather than disappearing. */}
      {argsText.length > 0 && (
        <details className="border-t border-sky-900/30">
          <summary className="cursor-pointer px-2.5 py-1 text-[11px] text-neutral-500 hover:text-neutral-300">
            Input
          </summary>
          <pre className="overflow-auto px-2.5 pb-2 font-mono text-[11px] text-neutral-400">
            {argsText}
          </pre>
        </details>
      )}
      {outputText.length > 0 && (
        <details
          // Errors open by default so failures aren't blank cards.
          // Management calls and successful runs stay collapsed so the
          // chat is scannable — the user can click to inspect.
          open={isError}
          className="border-t border-sky-900/30"
        >
          <summary className="cursor-pointer px-2.5 py-1 text-[11px] text-neutral-500 hover:text-neutral-300">
            Output
          </summary>
          <pre className="overflow-auto px-2.5 pb-2 font-mono text-[11px] text-neutral-300 whitespace-pre-wrap">
            {outputText}
          </pre>
        </details>
      )}
    </div>
  );
}

function SubagentResultRow({
  result,
  onOpenFile,
}: {
  result: SubagentResult;
  onOpenFile: (sessionFile: string | undefined) => void;
}) {
  const failed = result.exitCode !== 0;
  return (
    <div
      className={`flex items-center justify-between gap-2 rounded border ${failed ? "border-red-700/40 light:border-red-300" : "border-sky-900/40 light:border-sky-300"} bg-neutral-950/60 px-2 py-1.5`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[11px] font-medium text-sky-200 light:text-sky-800">
            {result.agent}
          </span>
          {failed && (
            <span className="text-[10px] font-medium text-red-400 light:text-red-700">
              exit {result.exitCode}
            </span>
          )}
        </div>
        {result.task.length > 0 && (
          <div className="mt-0.5 truncate text-[11px] text-neutral-400" title={result.task}>
            {result.task}
          </div>
        )}
      </div>
      {result.sessionFile !== undefined && (
        <button
          onClick={() => onOpenFile(result.sessionFile)}
          className="inline-flex shrink-0 items-center gap-1 rounded border border-sky-700/60 px-1.5 py-0.5 text-[10px] font-medium text-sky-200 hover:border-sky-500 hover:bg-sky-900/30 hover:text-sky-100 light:border-sky-400 light:text-sky-800 light:hover:border-sky-600 light:hover:bg-sky-100 light:hover:text-sky-900"
          title={result.sessionFile}
        >
          <ExternalLink size={10} />
          Open
        </button>
      )}
    </div>
  );
}

function BashExecution({ message }: { message: AgentMessageLike }) {
  const command = String(message.command ?? "");
  const output = String(message.output ?? "");
  const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
  const truncated = message.truncated === true;
  const cancelled = message.cancelled === true;
  const excluded = message.excludeFromContext === true;
  return (
    <div className="rounded border border-neutral-800 bg-neutral-950 text-xs">
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-neutral-400">
        <div className="min-w-0 flex-1 truncate">
          <span className="text-neutral-500">$ </span>
          <span className="font-mono text-neutral-200">{command}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {excluded && (
            <span
              className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-400"
              title="!! prefix — kept out of LLM context on the next turn"
            >
              local-only
            </span>
          )}
          {cancelled && (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300 light:bg-amber-100 light:text-amber-800">
              timed out
            </span>
          )}
          {truncated && !cancelled && (
            <span className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-amber-300 light:bg-amber-100 light:text-amber-800">
              truncated
            </span>
          )}
          {exitCode !== undefined && (
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                exitCode === 0
                  ? "bg-emerald-900/30 text-emerald-300 light:bg-emerald-100 light:text-emerald-800"
                  : "bg-red-900/30 text-red-300 light:bg-red-100 light:text-red-800"
              }`}
              title={exitCode === 0 ? "exit 0" : `exit ${String(exitCode)}`}
            >
              exit {exitCode}
            </span>
          )}
        </div>
      </div>
      {output.length > 0 && (
        <pre className="max-h-64 overflow-auto px-3 pb-2 font-mono text-[11px] text-neutral-300">
          {output}
        </pre>
      )}
    </div>
  );
}

/**
 * Tiny header-corner button to flip a message between rendered
 * markdown and raw plaintext. Owned by the parent `Message`
 * component (state lives there so all text blocks within one
 * assistant message flip together).
 *
 * Sits in the same row as the role label (`you` / `assistant`).
 * Defaults to "rendered" — click flips to raw, click again flips
 * back. Per-session, per-message; not persisted.
 */
/**
 * Copy-to-clipboard button rendered next to the raw/rendered toggle on
 * each message bubble (and inside fenced code blocks via ChatMarkdown).
 * `getText` is invoked on click so callers don't have to keep a copy
 * of the (potentially large) message text in a closure when the
 * button isn't used. Shows a brief check-mark confirmation; falls
 * back to a synthetic textarea when the async clipboard API isn't
 * available (older Safari, insecure HTTP origins).
 */
function CopyButton({ getText, title }: { getText: () => string; title: string }) {
  const [copied, setCopied] = useState(false);
  const onClick = (): void => {
    const text = getText();
    if (text.length === 0) return;
    const writeAsync = navigator.clipboard?.writeText?.bind(navigator.clipboard);
    if (writeAsync !== undefined) {
      void writeAsync(text)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1200);
        })
        .catch(() => fallback(text));
    } else {
      fallback(text);
    }
  };
  const fallback = (text: string): void => {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard unavailable; do nothing — user can still select + Cmd+C.
    }
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-700/40 hover:text-neutral-300 md:min-h-0 md:min-w-0"
      title={title}
      aria-label={title}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

/**
 * Concatenate every text-typed block in an assistant message's content
 * array into one newline-separated string for the message-level Copy
 * button. Tool calls and thinking blocks are skipped — they have their
 * own copy affordances inside their respective renderers.
 */
function assistantTextContent(content: Record<string, unknown>[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function RawToggle({ showRaw, onToggle }: { showRaw: boolean; onToggle: (next: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!showRaw)}
      className="inline-flex min-h-11 min-w-11 items-center justify-center rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:bg-neutral-700/40 hover:text-neutral-300 md:min-h-0 md:min-w-0"
      title={showRaw ? "Show rendered markdown" : "Show raw text"}
    >
      {showRaw ? "rendered" : "raw"}
    </button>
  );
}

/**
 * Plain-text counterpart to ChatMarkdown — used when the user has
 * flipped a message to raw view. Preserves whitespace verbatim
 * (including the literal `**` and backticks the user typed) and
 * keeps long-token wrapping consistent with the rendered view.
 */
function RawText({ text }: { text: string }) {
  return (
    <pre className="whitespace-pre-wrap break-words font-sans text-sm text-neutral-100 [overflow-wrap:anywhere]">
      {text}
    </pre>
  );
}

function isObjectShape(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Render a message's wall-clock timestamp as a hover-revealed badge.
 * SDK messages carry `timestamp` as a Unix ms number (see pi-ai's
 * UserMessage / AssistantMessage / ToolResultMessage). The badge stays
 * invisible until the user hovers the bubble (the bubble itself owns
 * the `group` class) so the chrome doesn't compete with the message
 * content. Native `title` carries the absolute date+time for a
 * second-level disclosure on top of the visible short time.
 */
function MessageTimestamp({ ts }: { ts: unknown }) {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;
  const d = new Date(ts);
  const display = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const full = d.toLocaleString([], { dateStyle: "medium", timeStyle: "medium" });
  return (
    <span
      className="text-[10px] tabular-nums text-neutral-500 opacity-0 transition-opacity duration-150 group-hover:opacity-100"
      title={full}
    >
      {display}
    </span>
  );
}

function extractText(message: AgentMessageLike): string {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((c): c is { type: "text"; text: string } => {
        const o = c as { type?: unknown; text?: unknown };
        return o.type === "text" && typeof o.text === "string";
      })
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

function extractFilename(message: AgentMessageLike): string | undefined {
  // The shape of `details` varies per tool and per SDK version. Try the
  // common paths; return undefined (and let the caller drop the label)
  // rather than show "(unknown file)" — the toolCall block on the
  // preceding assistant message already names the target.
  const details = message.details as
    | { path?: unknown; filename?: unknown; file?: unknown; file_path?: unknown }
    | undefined;
  const input = message.input as
    | { path?: unknown; filename?: unknown; file?: unknown; file_path?: unknown }
    | undefined;
  for (const src of [details, input]) {
    if (src === undefined) continue;
    if (typeof src.path === "string") return src.path;
    if (typeof src.filename === "string") return src.filename;
    if (typeof src.file === "string") return src.file;
    if (typeof src.file_path === "string") return src.file_path;
  }
  return undefined;
}

/**
 * Cheap +/- counter for the chat tool-result summary. The full diff
 * renderer (`DiffBlock` → `react-diff-view`) parses the same text
 * structurally; we only need scalar counts for the collapsed summary.
 */
function countDiffLines(diff: string): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) adds += 1;
    else if (line.startsWith("-")) dels += 1;
  }
  return { adds, dels };
}

function extractCommand(message: AgentMessageLike): string | undefined {
  // Same story as extractFilename — bash details may carry the command in
  // a few places depending on SDK version. Drop the label if absent.
  const details = message.details as { command?: unknown } | undefined;
  const input = message.input as { command?: unknown } | undefined;
  if (typeof details?.command === "string") return details.command;
  if (typeof input?.command === "string") return input.command;
  return undefined;
}

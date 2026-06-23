import { useEffect, useRef, useState } from "react";
import { FileCode, FolderTree, Menu, MessageSquare, Terminal as TerminalIcon } from "lucide-react";
import { useIsMobile } from "./lib/use-is-mobile";
import { useAuthStore } from "./store/auth-store";
import { useActiveProject, useProjectStore } from "./store/project-store";
import { useSessionStore } from "./store/session-store";
import { useFileStore } from "./store/file-store";
import { useUiConfigStore } from "./store/ui-config-store";
import { useQuickActionsStore } from "./store/quick-actions-store";
import { LoginScreen } from "./components/LoginScreen";
import { ChangePasswordScreen } from "./components/ChangePasswordScreen";
import { InstallPrompt } from "./components/InstallPrompt";
import { ProjectSidebar } from "./components/ProjectSidebar";
import { ProjectPicker } from "./components/ProjectPicker";
import { ChatView } from "./components/ChatView";
import { ChatInput } from "./components/ChatInput";
import { ChangedFilesBadge } from "./components/ChangedFilesBadge";
import { SettingsPanel } from "./components/SettingsPanel";
import { AskUserQuestionPanel } from "./components/AskUserQuestionPanel";
import { TodoPanel } from "./components/TodoPanel";
import { ProcessesPanel } from "./components/ProcessesPanel";
import { countRunning, selectProcesses, useProcessesStore } from "./store/processes-store";
import { FileBrowserPanel } from "./components/FileBrowserPanel";
import { EditorPanel } from "./components/EditorPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { GlobalSearchBar } from "./components/GlobalSearchBar";
import { McpStatusBadge } from "./components/McpStatusBadge";
import { useMcpStore } from "./store/mcp-store";
import { useUiStore, type SettingsTab } from "./store/ui-store";
import { TurnDiffPanel } from "./components/TurnDiffPanel";
import { GitPanel } from "./components/GitPanel";
import { SearchPanel } from "./components/SearchPanel";
import { ContextInspectorPanel } from "./components/ContextInspectorPanel";
import { ResizableDivider } from "./components/ResizableDivider";
import { useGitStatus } from "./hooks/useGitStatus";

type RightPaneTab = "files" | "search" | "changes" | "git" | "context" | "processes";

/* Persisted pane widths. Stored in localStorage so the user-tuned
   layout survives reloads. Defaults err on the side of "the chat is the
   primary surface" — files is narrow, editor is medium. */
const FILES_WIDTH_KEY = "pi-forge/files-width";
const EDITOR_WIDTH_KEY = "pi-forge/editor-width";
const TERMINAL_HEIGHT_KEY = "pi-forge/terminal-height";
const TODO_PANEL_HEIGHT_KEY = "pi-forge/todo-panel-height";
const DEFAULT_FILES_WIDTH = 280;
const DEFAULT_EDITOR_WIDTH = 480;
const DEFAULT_TERMINAL_HEIGHT = 280;
const DEFAULT_TODO_PANEL_HEIGHT = 200;
const MIN_FILES_WIDTH = 200;
const MIN_EDITOR_WIDTH = 320;
const MIN_CHAT_WIDTH = 320;
const MIN_TERMINAL_HEIGHT = 140;
const MIN_TODO_PANEL_HEIGHT = 100;

function readPersistedWidth(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function App() {
  const ready = useAuthStore((s) => s.ready);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const mustChangePassword = useAuthStore((s) => s.mustChangePassword);
  const bootstrap = useAuthStore((s) => s.bootstrap);
  const logout = useAuthStore((s) => s.logout);

  const projects = useProjectStore((s) => s.projects);
  const projectsLoaded = useProjectStore((s) => !s.loading);
  const loadProjects = useProjectStore((s) => s.load);
  const active = useActiveProject();
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);

  /* Mobile drawer state. The sidebar slides off-screen at < 768 px and
     reappears via the hamburger button OR a left-edge swipe gesture.
     `useIsMobile` reacts to viewport changes so resize / orientation
     flip / "Request Desktop Site" all transition cleanly. */
  const isMobile = useIsMobile();
  const [drawerOpen, setDrawerOpen] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Files pane visibility persists across reloads — opening it once is
  // a strong signal the user wants it. localStorage > a session-scoped
  // boolean so a refresh doesn't snap back to "hidden".
  const [filesOpen, setFilesOpen] = useState<boolean>(
    () => localStorage.getItem("pi-forge/files-open") === "true",
  );
  const setFilesOpenPersisted = (v: boolean): void => {
    setFilesOpen(v);
    localStorage.setItem("pi-forge/files-open", v ? "true" : "false");
  };

  const [rightTab, setRightTab] = useState<RightPaneTab>(() => {
    const raw = localStorage.getItem("pi-forge/right-tab");
    return raw === "files" ||
      raw === "search" ||
      raw === "changes" ||
      raw === "git" ||
      raw === "context" ||
      raw === "processes"
      ? raw
      : "files";
  });
  const setRightTabPersisted = (next: RightPaneTab): void => {
    setRightTab(next);
    localStorage.setItem("pi-forge/right-tab", next);
  };

  const [terminalOpen, setTerminalOpen] = useState<boolean>(
    () => localStorage.getItem("pi-forge/terminal-open") === "true",
  );
  const setTerminalOpenPersisted = (v: boolean): void => {
    setTerminalOpen(v);
    localStorage.setItem("pi-forge/terminal-open", v ? "true" : "false");
  };

  // Chat pane visibility — defaults to OPEN (the chat is the pi-forge's
  // primary surface), and the persistence key is absence-means-open so a
  // user who has never touched the toggle gets the chat. Hide is for the
  // "I just want to use the file editor + terminal" focus mode.
  const [chatOpen, setChatOpen] = useState<boolean>(
    () => localStorage.getItem("pi-forge/chat-open") !== "false",
  );
  const setChatOpenPersisted = (v: boolean): void => {
    setChatOpen(v);
    localStorage.setItem("pi-forge/chat-open", v ? "true" : "false");
  };

  // Editor pane visibility — independent of `filesOpen` (the file
  // browser tree). Defaults to OPEN so a user with persisted tabs from
  // the previous session sees them on reload. Tabs themselves persist
  // in sessionStorage via file-store; this toggle just controls
  // visibility of the rendered pane.
  const [editorOpen, setEditorOpen] = useState<boolean>(
    () => localStorage.getItem("pi-forge/editor-open") !== "false",
  );
  const setEditorOpenPersisted = (v: boolean): void => {
    setEditorOpen(v);
    localStorage.setItem("pi-forge/editor-open", v ? "true" : "false");
  };

  // First-run picker dismissal. When no projects exist we render the
  // ProjectPicker by default, but the user can dismiss it to take a
  // look around the empty pi-forge. Re-opens via the sidebar's
  // "+ New project" button. Reset whenever a project is created so
  // the picker doesn't reappear if the user later deletes all
  // projects in the same browser tab.
  const [setupPickerDismissed, setSetupPickerDismissed] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState<number>(() =>
    readPersistedWidth(TERMINAL_HEIGHT_KEY, DEFAULT_TERMINAL_HEIGHT),
  );
  const terminalHeightRef = useRef(terminalHeight);
  useEffect(() => {
    terminalHeightRef.current = terminalHeight;
    localStorage.setItem(TERMINAL_HEIGHT_KEY, String(terminalHeight));
  }, [terminalHeight]);

  // Todo-panel height (bottom strip of the right pane). Persisted
  // independently of the other panes' sizes — same pattern as
  // terminalHeight.
  const [todoPanelHeight, setTodoPanelHeight] = useState<number>(() =>
    readPersistedWidth(TODO_PANEL_HEIGHT_KEY, DEFAULT_TODO_PANEL_HEIGHT),
  );
  const todoPanelHeightRef = useRef(todoPanelHeight);
  useEffect(() => {
    todoPanelHeightRef.current = todoPanelHeight;
    localStorage.setItem(TODO_PANEL_HEIGHT_KEY, String(todoPanelHeight));
  }, [todoPanelHeight]);

  // Auto-open the right pane when the user toggles the todo panel
  // on from a chat-only view. Without this, clicking the todo
  // icon would set `todoPanelOpen=true` but nothing visible would
  // change — the panel lives inside the right pane.
  const todoPanelOpen = useUiStore((s) => s.todoPanelOpen);
  useEffect(() => {
    if (todoPanelOpen && !filesOpen && !isMobile) {
      setFilesOpenPersisted(true);
    }
    // setFilesOpenPersisted is stable enough — we only react to the
    // toggle flipping, not to filesOpen changes (a user closing the
    // pane shouldn't immediately re-open it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todoPanelOpen]);

  // Same auto-open behavior for the processes badge in the chat
  // input: bumping `openProcessesTabSeq` means "show me processes
  // now" — open the right pane if collapsed, switch to the tab.
  const openProcessesTabSeq = useUiStore((s) => s.openProcessesTabSeq);
  useEffect(() => {
    if (openProcessesTabSeq === 0) return; // initial value, no request
    if (!filesOpen && !isMobile) setFilesOpenPersisted(true);
    setRightTabPersisted("processes");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openProcessesTabSeq]);

  // Opening a file from the file viewer/search should make the editor
  // visible even if the user previously toggled the editor pane off.
  const openEditorPaneSeq = useUiStore((s) => s.openEditorPaneSeq);
  useEffect(() => {
    if (openEditorPaneSeq === 0) return;
    setEditorOpenPersisted(true);
  }, [openEditorPaneSeq]);

  // Pane widths (px). Persisted on every drag-end via the ref; we keep
  // the live value in state so drags re-render the layout, and mirror
  // it through the ref so the divider can read the start width without
  // a stale-closure bug across drags.
  const [filesWidth, setFilesWidth] = useState<number>(() =>
    readPersistedWidth(FILES_WIDTH_KEY, DEFAULT_FILES_WIDTH),
  );
  const [editorWidth, setEditorWidth] = useState<number>(() =>
    readPersistedWidth(EDITOR_WIDTH_KEY, DEFAULT_EDITOR_WIDTH),
  );
  const filesWidthRef = useRef(filesWidth);
  const editorWidthRef = useRef(editorWidth);
  useEffect(() => {
    filesWidthRef.current = filesWidth;
    localStorage.setItem(FILES_WIDTH_KEY, String(filesWidth));
  }, [filesWidth]);
  useEffect(() => {
    editorWidthRef.current = editorWidth;
    localStorage.setItem(EDITOR_WIDTH_KEY, String(editorWidth));
  }, [editorWidth]);

  const openFilesCount = useFileStore((s) => s.openFiles.length);
  const editorVisible = editorOpen && openFilesCount > 0;

  // Drives the modified-file count badge on the Git tab. Polls via
  // the hook regardless of which tab is currently visible — we want
  // the badge to update even when the user is on Files. Gate the
  // project id on auth so a stale active project from the previous
  // session does not keep polling protected git routes on the login
  // or change-password screens.
  const canPollGit = ready && isAuthenticated && !mustChangePassword;
  const gitStatus = useGitStatus(canPollGit ? active?.id : undefined);
  const gitChangedCount = gitStatus.status?.files.length ?? 0;
  // Running-process count drives the Processes tab badge and the
  // chat-input top-right Activity icon. Reads the SSE-hydrated
  // processes-store; empty for sessions with no managed processes.
  const sessionProcesses = useProcessesStore((s) => selectProcesses(s, activeSessionId));
  const runningProcessCount = countRunning(sessionProcesses);

  // Refresh the file tree/editor tabs when the session store observes
  // workspace mutations. `write` tool completions bump this immediately
  // mid-turn; `agent_end` bumps it only for turns with no write calls so
  // bash/MCP-side mutations still reconcile without double-loading after
  // normal write-tool turns.
  const fileRefreshCount = useSessionStore((s) =>
    activeSessionId !== undefined ? (s.fileRefreshCountBySession[activeSessionId] ?? 0) : 0,
  );
  const loadFileTree = useFileStore((s) => s.loadTree);
  const restoreTabs = useFileStore((s) => s.restoreTabs);
  const refreshOpenFiles = useFileStore((s) => s.refreshOpenFiles);
  useEffect(() => {
    if (active === undefined || fileRefreshCount === 0) return;
    void loadFileTree(active.id);
    void refreshOpenFiles(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, fileRefreshCount]);

  // Re-open the editor tabs persisted for this project. No-op if any
  // tabs are already open, so a project hot-switch doesn't fight a
  // user who's mid-edit. Runs only on project change (not on every
  // agent_end / streaming flip the tree refresh keys off of).
  useEffect(() => {
    if (active === undefined) return;
    void restoreTabs(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setSettingsOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settingsOpen]);

  /* Mobile drawer: close when the user picks something. Watching the
     two active-id values catches every selection path (project click,
     session click, new-session creation that auto-selects). A first-
     mount ref guard skips the initial restoration so the drawer
     doesn't auto-open-then-close on page load. */
  const drawerFirstMount = useRef(true);
  useEffect(() => {
    if (drawerFirstMount.current) {
      drawerFirstMount.current = false;
      return;
    }
    if (drawerOpen) setDrawerOpen(false);
    // Intentional: respond to selection changes only, not to drawerOpen
    // toggling (would create a self-closing loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeSessionId]);

  /* Esc key closes the drawer. Body scroll lock prevents the page
     scrolling behind the open drawer on iOS Safari (where the address
     bar's scroll-to-top can otherwise pull the chat out from under
     the user's finger). */
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [drawerOpen]);

  /* Auto-close when leaving mobile (resize, rotate, "Request Desktop
     Site"). Without this, a drawer left open while flipping to desktop
     keeps the open-state in memory; harmless visually because the CSS
     forces it visible at md+, but it'd resurrect as "open" if the
     viewport re-narrowed. */
  useEffect(() => {
    if (!isMobile && drawerOpen) setDrawerOpen(false);
  }, [isMobile, drawerOpen]);

  // ui-store: ChatInput's `/settings`, `/skills`, `/mcp`, `/providers`
  // slash commands set `settingsRequest` here. We open the panel and
  // (if a tab was specified) hand the requested tab to SettingsPanel
  // via `initialTab`. Cleared after handling so a second request to
  // the same tab still fires (the seq counter on the store guarantees
  // re-render even when tab is identical).
  const settingsRequest = useUiStore((s) => s.settingsRequest);
  const clearSettingsRequest = useUiStore((s) => s.clearSettingsRequest);
  const [pendingSettingsTab, setPendingSettingsTab] = useState<SettingsTab | undefined>(undefined);
  useEffect(() => {
    if (settingsRequest === undefined) return;
    setSettingsOpen(true);
    if (settingsRequest.tab !== undefined) setPendingSettingsTab(settingsRequest.tab);
    clearSettingsRequest();
  }, [settingsRequest, clearSettingsRequest]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // ui-config has no auth requirement and gates which surfaces
  // we render — load it in parallel with auth bootstrap so the
  // first render after login already knows whether we're in
  // minimal mode (avoids a flash of full-UI elements that then
  // disappear).
  const loadUiConfig = useUiConfigStore((s) => s.load);
  const minimal = useUiConfigStore((s) => s.minimal);
  useEffect(() => {
    void loadUiConfig();
  }, [loadUiConfig]);

  useEffect(() => {
    // Don't fetch projects with a `must_change_password` token — that
    // call would 403 and (currently) does nothing useful for the user.
    // The change-password screen reloads projects on its own success
    // path by transitioning isAuthenticated→true with mustChange→false.
    if (isAuthenticated && !mustChangePassword) void loadProjects();
  }, [isAuthenticated, mustChangePassword, loadProjects]);

  // Quick-action chips load once after auth — same trigger as projects.
  // Failure is non-fatal (the store keeps `loaded: false` and the
  // chip simply never appears in the toolbar).
  const loadQuickActions = useQuickActionsStore((s) => s.load);
  useEffect(() => {
    if (isAuthenticated && !mustChangePassword) void loadQuickActions();
  }, [isAuthenticated, mustChangePassword, loadQuickActions]);

  // MCP status polling — single 30s ticker shared by the header badge
  // and the Settings MCP tab. Starts after auth (the route is
  // protected); stops on logout. Idempotent — safe to call repeatedly.
  const startMcpPolling = useMcpStore((s) => s.startPolling);
  const stopMcpPolling = useMcpStore((s) => s.stopPolling);
  useEffect(() => {
    if (isAuthenticated && !mustChangePassword) {
      startMcpPolling();
    } else {
      stopMcpPolling();
    }
  }, [isAuthenticated, mustChangePassword, startMcpPolling, stopMcpPolling]);

  if (!ready) {
    return (
      <main className="flex min-h-screen items-center justify-center text-sm text-neutral-400">
        Loading…
      </main>
    );
  }

  if (!isAuthenticated) return <LoginScreen />;
  if (mustChangePassword) return <ChangePasswordScreen />;

  return (
    <div className="flex h-screen flex-col bg-neutral-950 text-neutral-100">
      {/* Top-of-viewport chrome respects iOS Dynamic Island / notch
          and Android cutouts via safe-area-inset-top. The viewport
          meta in index.html already opts in with `viewport-fit=cover`
          (PR 3); this is what actually consumes the inset so the
          hamburger + brand don't sit under the status bar. Combined
          with `py-2` so we have at least the original 8 px even on
          devices with no inset. */}
      <header
        className="flex items-center justify-between border-b border-neutral-800 px-4 py-2"
        style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="flex items-center gap-3">
          {/* Hamburger — only at < md. Tapping toggles the drawer
              that wraps ProjectSidebar; the icon serves as the
              visible affordance complementing the left-edge swipe
              gesture. min-w-11 keeps the touch target ≥ 44px even
              on small phones. */}
          <button
            type="button"
            onClick={() => setDrawerOpen((v) => !v)}
            aria-label={drawerOpen ? "Close project sidebar" : "Open project sidebar"}
            aria-expanded={drawerOpen}
            className="-ml-1 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-neutral-300 hover:bg-neutral-800 md:hidden"
          >
            <Menu size={20} />
          </button>
          {/* Header brand: same SVG as the favicon / PWA icon, served
              from /icons/icon.svg via the public dir. The inner gap-1.5
              keeps the logo + wordmark visually paired (tighter than
              the parent gap-3 used between brand and project picker). */}
          <div className="flex items-center gap-1.5">
            <img src="/icons/icon.svg" alt="" className="h-8 w-8" aria-hidden="true" />
            <span className="text-sm font-semibold tracking-tight">pi-forge</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {/* Pane-toggle buttons (Chat / Editor / Files / Terminal) hide
              at < md. The corresponding panes are also unmounted by the
              isMobile gates below, so the toggles would have nothing to
              act on anyway. `hidden md:contents` keeps the wrapper out
              of the flex layout at md+ so spacing stays identical to
              pre-mobile-PR behavior. */}
          <div className="hidden md:contents">
            <button
              onClick={() => setChatOpenPersisted(!chatOpen)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                chatOpen
                  ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
              title="Toggle the chat pane"
            >
              <MessageSquare size={13} />
              Chat
            </button>
            <button
              onClick={() => setEditorOpenPersisted(!editorOpen)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                editorOpen
                  ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
              title="Toggle the editor pane (open tabs persist across reloads)"
            >
              <FileCode size={13} />
              Editor
            </button>
            <button
              onClick={() => setFilesOpenPersisted(!filesOpen)}
              className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                filesOpen
                  ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                  : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
              }`}
              title="Toggle the file browser tree"
            >
              <FolderTree size={13} />
              Files
            </button>
            {!minimal && (
              <button
                onClick={() => setTerminalOpenPersisted(!terminalOpen)}
                className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs ${
                  terminalOpen
                    ? "border-neutral-500 bg-neutral-800 text-neutral-100"
                    : "border-neutral-700 text-neutral-300 hover:border-neutral-500"
                }`}
                title="Toggle the integrated terminal"
              >
                <TerminalIcon size={13} />
                Terminal
              </button>
            )}
          </div>
          {/* Global cross-session search. Hidden at < md to keep the
              mobile header compact — phone users can search via the
              session list. Sits to the LEFT of the status badges /
              Settings so it's the visual anchor when the user is
              looking for "where did I see that?" content. */}
          <div className="hidden md:block">
            <GlobalSearchBar />
          </div>
          {/* MCP status badge stays visible in minimal — operators
              still want to see whether MCP servers are connected,
              they just can't reconfigure them from a locked-down
              deploy (the Settings → MCP tab is hidden separately). */}
          <McpStatusBadge />
          <button
            onClick={() => setSettingsOpen(true)}
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
            title="Settings (providers, agent defaults, MCP, skills)"
          >
            Settings
          </button>
          <button
            onClick={logout}
            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:border-neutral-500"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* PWA install prompt — mobile-only, dismissable, hidden when
          already running standalone or after the user has dismissed
          once. Self-gated to render nothing on desktop. */}
      <InstallPrompt />

      {settingsOpen && (
        <SettingsPanel
          onClose={() => {
            setSettingsOpen(false);
            setPendingSettingsTab(undefined);
          }}
          {...(pendingSettingsTab !== undefined ? { initialTab: pendingSettingsTab } : {})}
        />
      )}

      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex flex-1 overflow-hidden">
          {/* Mobile drawer chrome (only renders at < md):
              - backdrop dims main content + closes on tap
              - left-edge swipe-target opens the drawer when closed
              Hidden on desktop via md:hidden so the layout stays
              identical at md+ — sidebar is in normal flow there. */}
          {drawerOpen && (
            <div
              className="fixed inset-0 z-30 bg-black/50 md:hidden"
              onClick={() => setDrawerOpen(false)}
              aria-hidden
            />
          )}
          {isMobile && !drawerOpen && (
            <div
              className="fixed inset-y-0 left-0 z-20 w-5 md:hidden"
              aria-hidden
              onPointerDown={(e) => {
                /* Threshold-based open: ≥ 50px rightward drag from
                   the left edge opens the drawer. Listeners attach
                   to the window so the gesture isn't lost when the
                   pointer leaves this thin strip. */
                const startX = e.clientX;
                let opened = false;
                const onMove = (ev: PointerEvent): void => {
                  if (opened) return;
                  if (ev.clientX - startX > 50) {
                    setDrawerOpen(true);
                    opened = true;
                    cleanup();
                  }
                };
                const cleanup = (): void => {
                  window.removeEventListener("pointermove", onMove);
                  window.removeEventListener("pointerup", cleanup);
                  window.removeEventListener("pointercancel", cleanup);
                };
                window.addEventListener("pointermove", onMove);
                window.addEventListener("pointerup", cleanup);
                window.addEventListener("pointercancel", cleanup);
              }}
            />
          )}
          <ProjectSidebar
            className={
              // The drawer-slide translate is scoped with `max-md:` so
              // it ONLY applies on mobile. Earlier this was an
              // unscoped `translate-x-0` / `-translate-x-full` plus
              // `md:transform-none` on top, but `transform-none` does
              // not beat translate utilities in Tailwind's CSS source
              // order: the translate's emitted `transform: translateX(
              // ...)` won at md+, which (a) created a CSS containing
              // block on the sidebar — squishing every `fixed inset-0`
              // modal rendered inside it (ProjectPicker, project-delete,
              // session bulk-delete) into the sidebar's bounding box —
              // and (b) when we tried clearing it via removing the
              // `md:translate-x-0` counter, the closed-drawer base
              // `-translate-x-full` shoved the desktop sidebar off-
              // screen. `max-md:` on both conditional translates
              // emits no transform at md+ at all, so neither pathology
              // triggers and the sidebar lays out in its natural flow.
              "fixed inset-y-0 left-0 z-40 shadow-2xl transition-transform duration-200 ease-out " +
              "md:static md:inset-auto md:z-auto md:shadow-none md:transition-none " +
              (drawerOpen ? "max-md:translate-x-0" : "max-md:-translate-x-full")
            }
          />
          <main className="flex flex-1 overflow-hidden">
            {/* Layout when files pane is open:
                  chat (flex) | divider | editor (when ≥1 tab) | divider | files
              The file browser is pinned to the far right; the editor
              materialises between chat and files only when at least
              one file is open. Both right-side panes are user-resizable
              via their dividers; widths persist in localStorage. */}
            {/* Chat column is suppressed when chatOpen=false — fully.
                Includes the empty-state branches (project picker,
                "no session" prompt). When chat is closed AND there's
                no project, the main area is empty and the user can
                re-open chat from the header to reach the picker, or
                use the sidebar's "+ New project" button. */}
            {chatOpen && (
              <div className="flex flex-1 flex-col overflow-hidden">
                {projectsLoaded && projects.length === 0 ? (
                  setupPickerDismissed ? (
                    // Picker dismissed — show a friendly empty state
                    // pointing back at the sidebar's + button. The
                    // header buttons (settings, theme, etc.) stay
                    // reachable from this state too.
                    <div className="flex flex-1 items-center justify-center px-6 text-center">
                      <div className="space-y-3 text-sm text-neutral-400">
                        <p>No projects yet.</p>
                        <button
                          onClick={() => setSetupPickerDismissed(false)}
                          className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
                        >
                          + New project
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex flex-1 items-center justify-center">
                      <ProjectPicker onClose={() => setSetupPickerDismissed(true)} />
                    </div>
                  )
                ) : activeSessionId !== undefined ? (
                  <>
                    <ChatView sessionId={activeSessionId} />
                    {!minimal && (
                      <ChangedFilesBadge
                        sessionId={activeSessionId}
                        alreadyOnChangesTab={filesOpen && rightTab === "changes"}
                        onOpen={() => {
                          if (!filesOpen) setFilesOpenPersisted(true);
                          setRightTabPersisted("changes");
                        }}
                      />
                    )}
                    {/* Inline panel for `ask_user_question` tool
                        calls. Renders directly above the composer
                        when the agent has asked something; null
                        otherwise. Lives in the chat-pane flex
                        column so the chat scroll stays usable
                        while answering. */}
                    <AskUserQuestionPanel sessionId={activeSessionId} />
                    <ChatInput sessionId={activeSessionId} />
                  </>
                ) : active ? (
                  <div className="flex flex-1 items-center justify-center px-6 text-center">
                    <div className="space-y-3 text-sm text-neutral-400">
                      <h2 className="text-xl font-semibold text-neutral-100">{active.name}</h2>
                      <p className="font-mono text-xs">{active.path}</p>
                      <p>Pick a session from the sidebar — or start a new one here.</p>
                      <button
                        onClick={() => {
                          // Fire-and-forget; createSession sets the
                          // active session id on success which routes
                          // this branch into the ChatView render
                          // above. Failures surface via the session
                          // store's `error` field.
                          void useSessionStore.getState().createSession(active.id);
                        }}
                        className="rounded-md bg-neutral-100 px-3 py-1.5 text-sm font-medium text-neutral-900 hover:bg-white"
                      >
                        + New session
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-1 items-center justify-center">
                    <p className="text-sm text-neutral-400">Select a project from the sidebar.</p>
                  </div>
                )}
              </div>
            )}

            {/* Layout rule when chat is hidden: whichever pane is
                LEFTMOST in the render order (editor, then files) takes
                flex-1 + drops its leading divider so the visible panes
                fill the entire main area with at most one slider
                between them. With chat visible, the chat column is
                always the flex-1 leftmost and editor + files keep
                their persisted widths + dividers as before.

                `chatColumnVisible` mirrors the rendering condition for
                the chat column above — strictly chatOpen now. */}
            {!isMobile &&
              editorVisible &&
              (() => {
                const chatColumnVisible = chatOpen;
                const editorIsLeftmost = !chatColumnVisible;
                if (editorIsLeftmost) {
                  return (
                    <div className="flex flex-1 flex-col overflow-hidden">
                      <EditorPanel />
                    </div>
                  );
                }
                return (
                  <>
                    <ResizableDivider
                      getStartSize={() => editorWidthRef.current}
                      onResize={(next) => setEditorWidth(next)}
                      /* Pane is to the RIGHT of the divider, so drag-right
                       shrinks the editor. direction: -1 → grow as user drags left. */
                      direction={-1}
                      minSize={MIN_EDITOR_WIDTH}
                      maxSize={Math.max(
                        MIN_EDITOR_WIDTH,
                        window.innerWidth - (filesOpen ? filesWidth : 0) - MIN_CHAT_WIDTH - 240, // 240 ≈ ProjectSidebar
                      )}
                    />
                    <div
                      className="flex shrink-0 flex-col border-l border-neutral-800"
                      style={{ width: `${editorWidth}px` }}
                    >
                      <EditorPanel />
                    </div>
                  </>
                );
              })()}

            {!isMobile &&
              filesOpen &&
              (() => {
                const chatColumnVisible = chatOpen;
                const filesIsLeftmost = !chatColumnVisible && !editorVisible;
                // Inner content (tabs + selected panel) — identical in
                // both layout branches. Extracted so we can wrap it in
                // either a flex-1 container (leftmost) or a shrink-0
                // fixed-width container (with a divider in front).
                const filesContent = (
                  <>
                    {/* Right-pane tabs: file browser vs the turn-diff
                        "Changes" view. Both share width + position so
                        they don't compete for screen real estate. */}
                    <div className="flex border-b border-neutral-800 bg-neutral-900/40">
                      {(minimal
                        ? // Minimal mode keeps Files + Search + Context.
                          // Context (token usage / message inspector) is
                          // useful even in locked-down deploys — it's
                          // read-only and helps users debug their own
                          // sessions without needing the full diff/git
                          // toolchain. Processes is also surfaced — listing /
                          // killing existing processes is operator-useful even
                          // when MINIMAL_UI blocks starting new ones at the
                          // tool boundary.
                          (["files", "search", "processes", "context"] as const)
                        : (["files", "search", "changes", "git", "processes", "context"] as const)
                      ).map((t) => (
                        <button
                          key={t}
                          onClick={() => setRightTabPersisted(t)}
                          className={`flex items-center gap-1 px-3 py-1.5 text-[11px] uppercase tracking-wider ${
                            rightTab === t
                              ? "border-b border-neutral-100 text-neutral-100"
                              : "text-neutral-500 hover:text-neutral-300"
                          }`}
                        >
                          {/* Internal key stays "changes" for backwards-compat with
                              persisted localStorage; user-visible label is "Last turn"
                              so it's distinct from the Git tab's working-tree changes. */}
                          {t === "files"
                            ? "Files"
                            : t === "search"
                              ? "Search"
                              : t === "changes"
                                ? "Last turn"
                                : t === "git"
                                  ? "Git"
                                  : t === "processes"
                                    ? "Processes"
                                    : "Context"}
                          {t === "git" && gitChangedCount > 0 && (
                            <span className="rounded bg-amber-900/40 px-1 py-0.5 text-[9px] text-amber-300 light:bg-amber-100 light:text-amber-800">
                              {gitChangedCount}
                            </span>
                          )}
                          {t === "processes" && runningProcessCount > 0 && (
                            <span className="rounded bg-emerald-900/40 px-1 py-0.5 text-[9px] text-emerald-300 light:bg-emerald-100 light:text-emerald-800">
                              {runningProcessCount}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-1 flex-col overflow-hidden">
                      <div className="flex-1 overflow-hidden">
                        {rightTab === "files" ? (
                          <FileBrowserPanel />
                        ) : rightTab === "search" ? (
                          <SearchPanel />
                        ) : !minimal && rightTab === "changes" ? (
                          <TurnDiffPanel />
                        ) : !minimal && rightTab === "git" ? (
                          <GitPanel />
                        ) : rightTab === "context" ? (
                          <ContextInspectorPanel />
                        ) : rightTab === "processes" && activeSessionId !== undefined ? (
                          <ProcessesPanel sessionId={activeSessionId} />
                        ) : (
                          // minimal mode: stale persisted "changes"/"git"/"context"
                          // falls back to the file browser rather than rendering
                          // a tab the user can't even see.
                          <FileBrowserPanel />
                        )}
                      </div>
                      {/* Bottom-strip todo panel — splits the
                          right pane's vertical column when the
                          toggle in ChatInput is on AND a session is
                          active. Width is whatever the right pane
                          already has; height is independently
                          resizable. */}
                      {todoPanelOpen && activeSessionId !== undefined && (
                        <>
                          <ResizableDivider
                            orientation="horizontal"
                            getStartSize={() => todoPanelHeightRef.current}
                            onResize={(next) => setTodoPanelHeight(next)}
                            // Direction -1: the todo strip is BELOW the
                            // divider — dragging DOWN (higher clientY)
                            // shrinks the strip; UP grows it.
                            direction={-1}
                            minSize={MIN_TODO_PANEL_HEIGHT}
                            maxSize={Math.max(MIN_TODO_PANEL_HEIGHT, window.innerHeight * 0.7)}
                          />
                          <div
                            className="shrink-0 overflow-hidden border-t border-neutral-800 light:border-neutral-200"
                            style={{ height: `${todoPanelHeight}px` }}
                          >
                            <TodoPanel
                              sessionId={activeSessionId}
                              onClose={() => useUiStore.getState().setTodoPanelOpen(false)}
                            />
                          </div>
                        </>
                      )}
                    </div>
                  </>
                );
                if (filesIsLeftmost) {
                  return <div className="flex flex-1 flex-col overflow-hidden">{filesContent}</div>;
                }
                return (
                  <>
                    <ResizableDivider
                      getStartSize={() => filesWidthRef.current}
                      onResize={(next) => setFilesWidth(next)}
                      direction={-1}
                      minSize={MIN_FILES_WIDTH}
                      maxSize={Math.max(
                        MIN_FILES_WIDTH,
                        window.innerWidth -
                          MIN_CHAT_WIDTH -
                          240 -
                          (editorVisible ? MIN_EDITOR_WIDTH : 0),
                      )}
                    />
                    <div
                      className="flex shrink-0 flex-col border-l border-neutral-800"
                      style={{ width: `${filesWidth}px` }}
                    >
                      {filesContent}
                    </div>
                  </>
                );
              })()}
          </main>
        </div>

        {!isMobile && !minimal && terminalOpen && (
          <>
            <ResizableDivider
              orientation="horizontal"
              getStartSize={() => terminalHeightRef.current}
              onResize={(next) => setTerminalHeight(next)}
              direction={-1}
              minSize={MIN_TERMINAL_HEIGHT}
              maxSize={Math.max(MIN_TERMINAL_HEIGHT, Math.floor(window.innerHeight * 0.7))}
            />
            <div
              className="shrink-0 border-t border-neutral-800"
              style={{ height: `${terminalHeight}px` }}
            >
              <TerminalPanel />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useRef } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useTerminalStore, type TerminalTab } from "../store/terminal-store";
import { useActiveProject, useProjectStore } from "../store/project-store";
import { getStoredToken } from "../lib/auth-client";
import { readCssVar, useThemeStore } from "../lib/theme";

/**
 * Per-tab DOM/WebSocket/xterm bag. Lives OUTSIDE React state because
 * the WebSocket + xterm.Terminal are imperative resources whose
 * lifetimes we want decoupled from React renders. The Map is keyed
 * by tab id; entries are created when a tab first attaches its
 * `<div>` host and torn down when the tab closes.
 */
interface Live {
  term: Terminal;
  fit: FitAddon;
  ws: WebSocket;
  /** ResizeObserver watching the host div; fires `fit.fit()` and a server resize. */
  observer: ResizeObserver;
  /** Latest cols/rows we sent to the server, used to elide redundant resize messages. */
  lastSize: { cols: number; rows: number };
  /** Number of consecutive reconnect attempts; reset to 0 on a successful open. */
  reconnectAttempt: number;
  /** Pending reconnect timeout, cleared on success or teardown. */
  reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set when the tab is being torn down — prevents the close handler from scheduling a reconnect. */
  disposed: boolean;
}

const live = new Map<string, Live>();

/**
 * xterm.js captures keyboard input through an off-screen textarea.
 * Mobile browsers can still apply autocomplete/autocorrect to that
 * textarea unless we explicitly opt out, which corrupts terminal
 * input (for example, command names rewritten or capitalized).
 */
function disableBrowserTextAssist(host: HTMLElement): void {
  const input = host.querySelector("textarea");
  if (input === null) return;
  input.setAttribute("autocomplete", "off");
  input.setAttribute("autocorrect", "off");
  input.setAttribute("autocapitalize", "none");
  input.setAttribute("spellcheck", "false");
}

/**
 * Push xterm's current grid size to the backing PTY whenever fit() changes it.
 * Shell line editors use the PTY's kernel window size to decide where pasted
 * input wraps; if xterm and the PTY drift apart, long paste echo wraps back over
 * the same visual line. Keep the websocket resize in one helper so every fit()
 * path (mount, remount, tab visibility, container resize) stays in sync.
 */
function syncPtySize(entry: Live, force = false): void {
  const cols = entry.term.cols;
  const rows = entry.term.rows;
  if (!force && cols === entry.lastSize.cols && rows === entry.lastSize.rows) return;
  entry.lastSize = { cols, rows };
  if (entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.send(JSON.stringify({ type: "resize", cols, rows }));
  }
}

function fitAndSyncPty(entry: Live, force = false): void {
  entry.fit.fit();
  syncPtySize(entry, force);
}

/**
 * Mirrors the SSE backoff in `streamSSE`: 1→2→4→8→16→30s then steady
 * at 30. The cap matches the SSE client so behavior is consistent
 * across the two transport channels.
 */
function reconnectDelayMs(attempt: number): number {
  const seconds = [1, 2, 4, 8, 16, 30];
  return (seconds[Math.min(attempt, seconds.length - 1)] ?? 30) * 1000;
}

/**
 * Close codes the server emits for terminal failures we do NOT want
 * to retry on:
 *   - 4401: auth (token expired/invalid). Reconnect would just fail
 *     the same way; the user needs to log in again.
 *   - 4404: project not found. The project was deleted while the WS
 *     was live; reconnect can't recover it.
 *   - 1000 ("normal closure") issued by us in `teardown()`.
 * Anything else (1006 abnormal close from a network blip, 1011
 * server error, etc.) gets the backoff treatment.
 */
function isTerminalCloseCode(code: number): boolean {
  return code === 1000 || code === 4401 || code === 4404;
}

/**
 * Bottom-anchored terminal panel. Toggle from the header; tabs persist
 * across toggles (the WebSocket + PTY keep running on the server). On
 * project switch, every tab tied to the previous project is closed
 * (so we don't leak shells in directories the user can no longer reach
 * via the picker).
 */
export function TerminalPanel() {
  const project = useActiveProject();
  const tabs = useTerminalStore((s) => s.tabs);
  const activeTabId = useTerminalStore((s) => s.activeTabId);
  const openTab = useTerminalStore((s) => s.openTab);
  const closeTab = useTerminalStore((s) => s.closeTab);
  const setActiveTab = useTerminalStore((s) => s.setActiveTab);
  const projects = useProjectStore((s) => s.projects);
  const projectTabs = tabs.filter((t) => t.projectId === project?.id);
  const activeTab = projectTabs.find((t) => t.id === activeTabId) ?? projectTabs[0];

  // Project-path lookup for cross-project tabs. We keep TerminalHost
  // components mounted for tabs in ALL projects (see render block
  // below), so we need to know each tab's project path for the
  // host's tooltip — `useActiveProject()` only gives us the
  // currently-selected one.
  const projectPathById = new Map(projects.map((p) => [p.id, p.path]));

  // Tabs from OTHER projects stay in the store and on the server —
  // they're filtered out of the visible tab list via `projectTabs`
  // above, so switching projects just hides them. The PTYs keep
  // running; the user can switch back and pick up where they left
  // off. (Earlier versions tore them down here; the rationale was
  // tied to a topbar project picker that no longer exists.)

  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center text-xs italic text-neutral-500">
        Select a project to open a terminal.
      </div>
    );
  }

  const onNewTab = (): void => {
    openTab(project.id);
  };

  const onCloseTab = (id: string): void => {
    teardown(id);
    closeTab(id);
  };

  return (
    <div className="flex h-full flex-col bg-black">
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/40 px-2 py-1">
        <div className="flex items-center gap-1 overflow-x-auto">
          {projectTabs.length === 0 && (
            <span className="px-2 text-[11px] italic text-neutral-500">No terminals open.</span>
          )}
          {projectTabs.map((t) => {
            const isActive = t.id === activeTab?.id;
            return (
              <div
                key={t.id}
                className={`group flex items-center gap-1 rounded px-2 py-0.5 text-xs ${
                  isActive
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
                }`}
              >
                <button onClick={() => setActiveTab(t.id)} className="flex items-center gap-1">
                  <TerminalIcon size={11} />
                  {t.label}
                </button>
                <button
                  onClick={() => onCloseTab(t.id)}
                  className="rounded p-1 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
                  title="Close terminal (kills the PTY)"
                >
                  <X size={16} />
                </button>
              </div>
            );
          })}
          <button
            onClick={onNewTab}
            className="ml-1 flex items-center gap-1 rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 light:text-neutral-200 light:hover:bg-neutral-800 light:hover:text-neutral-50"
            title="New terminal"
          >
            <Plus size={14} />
            New
          </button>
        </div>
      </div>

      {/* xterm hosts. We render every tab across EVERY project here
          (not just the active project's) so each host div stays
          attached to the DOM for the lifetime of the tab. Switching
          projects merely toggles visibility — xterm never has to
          re-bind to a fresh parent, which it doesn't always do
          cleanly (the symptom was a blank pane after project
          switch + back). Visibility = same project AND active tab. */}
      <div className="relative flex-1 overflow-hidden">
        {projectTabs.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs italic text-neutral-500">
            Click "New" to open a terminal in {project.path}.
          </div>
        )}
        {tabs.map((t) => (
          <TerminalHost
            key={t.id}
            tab={t}
            projectPath={projectPathById.get(t.projectId) ?? ""}
            visible={t.projectId === project.id && t.id === activeTab?.id}
          />
        ))}
      </div>
    </div>
  );
}

function TerminalHost({
  tab,
  projectPath,
  visible,
}: {
  tab: TerminalTab;
  projectPath: string;
  visible: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hostRef.current === null) return undefined;
    const host = hostRef.current;

    // Re-mount path: the panel was toggled off and back on (or any
    // ancestor unmounted us), but the imperative resources in `live`
    // are still alive. Re-attach the existing xterm to the FRESH
    // host div, rebind a new ResizeObserver (the old host's
    // observer was disconnected on unmount below), and re-fit.
    // Without this branch the new host stays an empty div and the
    // user just sees blank space.
    const existing = live.get(tab.id);
    if (existing !== undefined) {
      try {
        // xterm 5's `term.open(newParent)` doesn't reliably move its
        // root DOM element to the new parent on a second call — it
        // short-circuits because the terminal is already "opened",
        // leaving the root attached to the prior (now-detached) host.
        // Explicitly relocate the root ourselves so the terminal
        // contents become visible after a panel-toggle re-mount.
        const root = existing.term.element;
        if (root !== undefined && root.parentNode !== host) {
          host.appendChild(root);
        } else {
          existing.term.open(host);
        }
        disableBrowserTextAssist(host);
        // visibility:hidden (not display:none) is used for tab
        // switching, so `host` has real layout dimensions on every
        // mount — fit always returns correct cols/rows. Force a resize
        // frame because the socket may have reconnected while unmounted.
        fitAndSyncPty(existing, true);
      } catch {
        // open() / appendChild can throw transiently if the host
        // hasn't been laid out yet; the visibility-change effect
        // below also calls fit() so this isn't load-bearing on
        // success.
      }
      const observer = new ResizeObserver(() => {
        try {
          fitAndSyncPty(existing);
        } catch {
          // host detached momentarily during tab/panel toggles
        }
      });
      observer.observe(host);
      // Disconnect the previous observer (which was watching a now-
      // detached host div) and replace it with the new one.
      try {
        existing.observer.disconnect();
      } catch {
        // ignore
      }
      existing.observer = observer;
      requestAnimationFrame(() => {
        try {
          fitAndSyncPty(existing);
          existing.term.focus();
        } catch {
          // ignore
        }
      });
      return () => {
        // On unmount (panel closed or component otherwise removed)
        // tear down only the observer — the term + ws survive so
        // the next mount can re-attach. Full cleanup happens in
        // teardown() when the tab is closed.
        try {
          observer.disconnect();
        } catch {
          // ignore
        }
      };
    }

    const term = new Terminal({
      // Theme reads `--pi-terminal-bg` / `--pi-terminal-fg` from
      // the active app theme so the terminal blends with the rest
      // of the chrome on every theme. ANSI palette is left to
      // xterm's defaults — themable per-color is a v2 polish.
      theme: {
        background: readCssVar("--pi-terminal-bg", "#0a0a0a"),
        foreground: readCssVar("--pi-terminal-fg", "#e5e5e5"),
        cursor: readCssVar("--pi-terminal-fg", "#e5e5e5"),
        black: readCssVar("--color-neutral-800", "#262626"),
        brightBlack: readCssVar("--color-neutral-600", "#525252"),
      },
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      // SCROLLBACK: 5000 lines is enough for `npm install` output;
      // memory cost ~few MB.
      scrollback: 5000,
      // Wrap long lines visually (default true).
      convertEol: false,
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon();
    term.loadAddon(fit);
    term.loadAddon(links);
    term.open(host);
    disableBrowserTextAssist(host);
    // Hosts use `visibility: hidden` (not `display: none`) for tab
    // switching — see render block — so every host has real layout
    // dimensions even when not the active tab. fit() therefore
    // returns the correct cols/rows on first mount regardless of
    // which tab is active, and the initial resize message we send
    // matches the server PTY's actual rendering size from the start.
    fit.fit();

    const initialSize = { cols: term.cols, rows: term.rows };
    const ws = attachWebSocket(tab.id, tab.projectId, term, initialSize, /* isReconnect */ false);

    // Keystrokes → server. xterm.onData fires for every key including
    // Ctrl+C, paste, etc. with the correctly-encoded byte sequence.
    // Reads `live.get(tab.id)?.ws` each call so the listener picks up
    // the LATEST socket after a reconnect — without this, keystrokes
    // would silently dead-letter into the original (closed) WS object.
    const dataDisposable = term.onData((data) => {
      const sock = live.get(tab.id)?.ws;
      if (sock?.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: "input", data }));
      }
    });

    // Container resize → fit + send resize message. ResizeObserver
    // is throttled by the browser so we don't need to debounce
    // ourselves. Reads the current WS each call (post-reconnect-safe).
    const observer = new ResizeObserver(() => {
      try {
        const entry = live.get(tab.id);
        if (entry === undefined) return;
        fitAndSyncPty(entry);
      } catch {
        // fit can throw if the host is detached momentarily during
        // tab toggles; harmless.
      }
    });
    observer.observe(hostRef.current);

    live.set(tab.id, {
      term,
      fit,
      ws,
      observer,
      lastSize: initialSize,
      reconnectAttempt: 0,
      reconnectTimer: undefined,
      disposed: false,
    });

    // Reference the data listener so its handle survives remounts.
    // The re-mount branch above re-uses the same `term`, so we MUST
    // NOT dispose `dataDisposable` on unmount — the keystroke
    // listener has to keep working when the panel re-opens.
    // Cleanup is the responsibility of `teardown()`, which calls
    // `term.dispose()` to remove every listener at once.
    void dataDisposable;
    return () => {
      // Panel toggled off / parent unmounted: disconnect just the
      // observer. The next mount creates a fresh observer bound to
      // the new host. Term + WS + listeners are intentionally kept
      // alive so the PTY stays connected and scrollback survives.
      try {
        observer.disconnect();
      } catch {
        // ignore
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  // When the tab becomes visible, force a fit() — the xterm
  // dimensions are stale because the host was display:none.
  useEffect(() => {
    if (!visible) return;
    const entry = live.get(tab.id);
    if (entry === undefined) return;
    requestAnimationFrame(() => {
      try {
        fitAndSyncPty(entry);
        entry.term.focus();
      } catch {
        // see ResizeObserver comment
      }
    });
  }, [visible, tab.id]);

  // Live theme update for an existing xterm. xterm 5+ accepts a
  // re-assignment to `options.theme` and re-renders. We read the
  // CSS vars *after* the theme store has applied the new
  // data-theme to the document, so the values reflect the just-
  // selected palette.
  const activeTheme = useThemeStore((s) => s.theme);
  useEffect(() => {
    const entry = live.get(tab.id);
    if (entry === undefined) return;
    entry.term.options.theme = {
      background: readCssVar("--pi-terminal-bg", "#0a0a0a"),
      foreground: readCssVar("--pi-terminal-fg", "#e5e5e5"),
      cursor: readCssVar("--pi-terminal-fg", "#e5e5e5"),
      black: readCssVar("--color-neutral-800", "#262626"),
      brightBlack: readCssVar("--color-neutral-600", "#525252"),
    };
  }, [activeTheme, tab.id]);

  // Click-to-focus safety net. xterm normally handles its own focus
  // on click via its internal textarea, but the click can land on
  // empty space below the cursor (especially in a freshly-opened
  // shell with little output). Forwarding clicks to `term.focus()`
  // guarantees keystrokes go to the right place.
  const onHostClick = (): void => {
    live.get(tab.id)?.term.focus();
  };

  return (
    <div
      ref={hostRef}
      onClick={onHostClick}
      // Left offset so text doesn't sit flush against the pane edge.
      // Using `left-2` instead of `pl-2` because the host is the
      // xterm parent — fit-addon reads its padding-box width to
      // compute cols, so padding would cause horizontal overflow.
      // An absolute offset shrinks the box xterm sees, which is what
      // we want.
      className="absolute inset-y-0 left-2 right-0"
      // `visibility: hidden` instead of `display: none` so every host
      // keeps real layout dimensions whether or not it's the active
      // tab. That way fit() always reads the correct cols/rows on
      // first mount AND every host's ResizeObserver tracks the panel
      // size for the lifetime of the tab — no stale PTY size, no
      // catch-up resize on tab switch (which previously triggered
      // zsh's PROMPT_EOL_MARK and dropped a `%` into the scrollback
      // of every inactive tab on page refresh).
      // pointerEvents:none so clicks pass through to the visible tab.
      // zIndex layered so the visible tab's xterm receives focus.
      style={{
        visibility: visible ? "visible" : "hidden",
        pointerEvents: visible ? "auto" : "none",
        zIndex: visible ? 1 : 0,
      }}
      title={projectPath}
    />
  );
}

/**
 * Open a WebSocket to the terminal route and wire up the message /
 * close handlers. Called both at first attach AND on every reconnect
 * — the second case bumps `reconnectAttempt` and replays the cached
 * cols/rows so the new shell formats correctly out of the gate.
 *
 * The new PTY spawned by the server on reconnect is a FRESH shell —
 * env vars, foreground processes, and any in-progress command from
 * the old shell are gone. xterm's client-side scrollback survives,
 * so the user still sees prior output, but they're effectively at a
 * brand-new prompt.
 */
function attachWebSocket(
  tabId: string,
  projectId: string,
  term: Terminal,
  size: { cols: number; rows: number },
  isReconnect: boolean,
): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const stored = getStoredToken();
  const tokenQs = stored !== undefined ? `&token=${encodeURIComponent(stored.token)}` : "";
  // Pass the stable client tabId so the server can reattach to the
  // existing PTY (with its rolling output buffer replayed) on
  // reconnect / page reload, instead of spawning a fresh shell.
  const url = `${proto}://${window.location.host}/api/v1/terminal?projectId=${encodeURIComponent(
    projectId,
  )}&tabId=${encodeURIComponent(tabId)}${tokenQs}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    // Send the cached size so the shell formats correctly out of the
    // gate — both for first connect and reconnect. On reattach the
    // server resizes the existing PTY rather than spawning a new one.
    // visibility:hidden tab-switching means every host has real
    // dimensions at mount, so this size is always honest.
    const entry = live.get(tabId);
    const currentSize =
      entry !== undefined ? { cols: entry.term.cols, rows: entry.term.rows } : size;
    ws.send(JSON.stringify({ type: "resize", cols: currentSize.cols, rows: currentSize.rows }));
    // Note: no "reconnected" banner here. The server's buffer
    // replay (sent on attach) shows recent output, and the same PTY
    // is still alive — the user is back in the SAME shell, not a
    // fresh one. A banner would just be a lie if the reattach
    // succeeded; a fresh PTY only happens if the idle reaper killed
    // it (10 min) and that case looks indistinguishable from "new
    // tab" on the wire.
    if (entry !== undefined) {
      entry.lastSize = currentSize;
      entry.reconnectAttempt = 0;
    }
    // Suppress the unused-arg lint without changing the function
    // signature (kept stable for future use, e.g. a server-side
    // "fresh_pty" hint frame).
    void isReconnect;
  };

  ws.onmessage = (e) => {
    if (typeof e.data === "string") term.write(e.data);
    else if (e.data instanceof ArrayBuffer) term.write(new Uint8Array(e.data));
  };

  ws.onclose = (e) => {
    const entry = live.get(tabId);
    if (entry === undefined || entry.disposed) return;
    if (isTerminalCloseCode(e.code)) {
      // Custom messages for the specific terminal codes — without
      // these the user sees a bare numeric code with no clear path.
      let msg = `[connection closed: ${String(e.code)}]`;
      if (e.code === 4401) {
        msg =
          "[connection closed (4401): your session expired — refresh the page after logging back in]";
      } else if (e.code === 4404) {
        msg = "[connection closed (4404): project no longer exists]";
      }
      term.write(`\r\n${msg}\r\n`);
      return;
    }
    // Schedule a reconnect with exponential backoff. The keystroke +
    // resize listeners read live.get(tabId).ws each fire, so they'll
    // pick up the new socket transparently.
    const attempt = entry.reconnectAttempt + 1;
    entry.reconnectAttempt = attempt;
    const delay = reconnectDelayMs(attempt);
    term.write(
      `\r\n[connection lost (${String(e.code)}) — reconnecting in ${String(delay / 1000)}s, attempt ${String(attempt)}]\r\n`,
    );
    entry.reconnectTimer = setTimeout(() => {
      const cur = live.get(tabId);
      if (cur === undefined || cur.disposed) return;
      cur.reconnectTimer = undefined;
      cur.ws = attachWebSocket(tabId, projectId, term, cur.lastSize, /* isReconnect */ true);
    }, delay);
  };

  return ws;
}

/**
 * Tear down a tab's WebSocket + xterm + observer. Called on tab
 * close and on project switch (to release shells from the previous
 * project's cwd). Server kills the PTY when the WS closes.
 *
 * Marks the entry `disposed` BEFORE closing the WS so the close
 * handler short-circuits its reconnect schedule.
 */
function teardown(id: string): void {
  const entry = live.get(id);
  if (entry === undefined) return;
  entry.disposed = true;
  if (entry.reconnectTimer !== undefined) clearTimeout(entry.reconnectTimer);
  live.delete(id);
  try {
    entry.observer.disconnect();
  } catch {
    // ignore
  }
  try {
    if (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING) {
      entry.ws.close(1000, "tab_closed");
    }
  } catch {
    // ignore
  }
  try {
    entry.term.dispose();
  } catch {
    // ignore
  }
}

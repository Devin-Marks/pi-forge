import { create } from "zustand";
import { api, ApiError, type FileTreeNode } from "../lib/api-client";

/**
 * Per-tab editor state. Tracks an in-memory `draft` separately from
 * `saved` so the dirty indicator and autosave logic don't fight: the
 * draft is what's in the textarea, `saved` is the last value we
 * successfully PUT to the server. `dirty = draft !== saved`.
 *
 * `loadingError` lets the editor render an error banner instead of an
 * empty textarea when a read fails (binary files surface here too —
 * the editor renders "Binary file" rather than letting the user paste
 * over zero bytes).
 */
export interface OpenFile {
  /**
   * Stable per-tab identity. Assigned at open time and NEVER changes —
   * survives renames and moves so the CodeMirror instance keyed on it
   * keeps cursor / scroll / undo / selection across path changes.
   */
  tabId: string;
  /** Absolute path on the server's filesystem. Mutates on rename / move. */
  path: string;
  saved: string;
  draft: string;
  dirty: boolean;
  language: string;
  binary: boolean;
  saving: boolean;
  /** Last successful save timestamp (ms). Drives the "Saved at hh:mm:ss" hint. */
  savedAt: number | undefined;
  /**
   * Per-tab save error. When set, the editor StatusBar shows a "Save
   * failed" state with retry guidance — without this, autosave failures
   * silently flipped `saving` back off and the user kept editing
   * thinking the next debounce would save, then closed the tab and
   * lost work. Cleared on the next successful save (manual Cmd+S or
   * autosave debounce that succeeds).
   */
  saveError: string | undefined;
  loadingError: string | undefined;
  /**
   * One-shot navigation request — when set, the CodeMirror host
   * scrolls + sets selection to this position on its next render and
   * clears the field so subsequent draft updates don't re-scroll.
   * Set by `openFile` callers that want to land on a specific line
   * (e.g. clicking a search result).
   */
  pendingNav?: { line: number; column?: number };
}

/**
 * sessionStorage key for the per-project editor tab list. Same
 * persistence posture as the terminal store: per-browser-tab so
 * sibling tabs don't fight over the same UI state. Survives
 * in-tab reload, doesn't bleed across browser tabs.
 *
 * Stored shape: `{ paths: string[]; activePath: string | null }`.
 * Per-project key so switching projects doesn't pull the previous
 * project's files into view.
 */
const TABS_KEY_PREFIX = "forge.editor.tabs.v1:";

interface PersistedTabs {
  paths: string[];
  activePath: string | null;
}

function readPersistedTabs(projectId: string): PersistedTabs {
  try {
    const raw = sessionStorage.getItem(TABS_KEY_PREFIX + projectId);
    if (raw === null) return { paths: [], activePath: null };
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return { paths: [], activePath: null };
    const obj = parsed as { paths?: unknown; activePath?: unknown };
    const paths = Array.isArray(obj.paths)
      ? obj.paths.filter((p): p is string => typeof p === "string")
      : [];
    const activePath = typeof obj.activePath === "string" ? obj.activePath : null;
    return {
      paths,
      activePath: paths.includes(activePath ?? "") ? activePath : (paths[0] ?? null),
    };
  } catch {
    return { paths: [], activePath: null };
  }
}

function writePersistedTabs(projectId: string, paths: string[], activePath: string | undefined) {
  try {
    sessionStorage.setItem(
      TABS_KEY_PREFIX + projectId,
      JSON.stringify({ paths, activePath: activePath ?? null }),
    );
  } catch {
    // ignore — choice still applies for this tab session
  }
}

interface FileState {
  /** Most-recently-fetched tree, keyed by projectId. */
  treeByProject: Record<string, FileTreeNode | undefined>;
  /** Loading flag per project so the panel can spinner during refreshes. */
  treeLoading: Record<string, boolean>;
  /** Open editor tabs, in user-visible order. */
  openFiles: OpenFile[];
  /** Path of the currently-active tab. */
  activePath: string | undefined;
  /** Last error code surfaced by an API call (sticky until next op). */
  error: string | undefined;

  loadTree: (projectId: string) => Promise<void>;
  /**
   * Re-open every tab persisted for `projectId` in sessionStorage and
   * restore the active path. No-op if tabs are already open (avoids
   * double-restore when called twice for the same project). Failures
   * to read individual files are silently dropped — a file that's
   * been deleted since persist time just doesn't reappear.
   */
  restoreTabs: (projectId: string) => Promise<void>;
  openFile: (
    projectId: string,
    absPath: string,
    nav?: { line: number; column?: number },
  ) => Promise<void>;
  /** Clear `pendingNav` on a tab after the editor has consumed it. */
  consumePendingNav: (path: string) => void;
  closeFile: (path: string) => void;
  /** Close every open editor tab. Persisted state for the active
   *  project is also cleared so a reload doesn't reopen them. */
  closeAllFiles: () => void;
  setActiveFile: (path: string | undefined) => void;
  updateDraft: (path: string, draft: string) => void;
  saveFile: (projectId: string, path: string) => Promise<void>;
  /**
   * Reload an open file from disk, discarding the in-memory draft. Used
   * after the agent edits a file the user has open. The route handler
   * should only call this when the tab is NOT dirty (i.e. agent edits
   * win silently). For dirty tabs, surface a banner via the
   * `externallyChanged` flag instead — see {@link markExternallyChanged}.
   */
  reloadFile: (projectId: string, path: string) => Promise<void>;
  /**
   * Re-read every open editor tab from disk and reconcile with the
   * in-memory state. Per-file decision:
   *   - on-disk content matches the current `saved` field → no-op
   *   - on-disk content differs AND tab is clean → reload (replace
   *     `saved` + `draft`); CodeMirror's draft-watching effect
   *     replays the new doc into the editor
   *   - on-disk content differs AND tab is dirty → markExternallyChanged
   *     so the user sees the banner instead of losing their work
   * Used by App.tsx on every `agent_end` (and any other point we know
   * the workspace may have shifted underneath us). Intentionally
   * decoupled from tool-result detection — this works for ANY change
   * the agent's run produced (tool calls, terminal commands the
   * agent shelled out to, git operations, etc.).
   */
  refreshOpenFiles: (projectId: string) => Promise<void>;
  /**
   * Mark a tab as having received an external change while dirty. The
   * editor renders a banner offering to discard or reload. Cleared by
   * the next successful saveFile or reloadFile, OR by an explicit
   * `dismissExternallyChanged` (the "Keep mine" affordance).
   */
  markExternallyChanged: (path: string) => void;
  /**
   * Dismiss the "external change" banner without reloading. The user's
   * draft stays in place and the next save will overwrite the
   * external change. Without this, the banner had no path back to
   * "the user knows and accepts" — clicking "Keep mine" was a no-op.
   */
  dismissExternallyChanged: (path: string) => void;
  externallyChanged: Record<string, boolean>;

  // Tree mutations — fire the route, then refresh the tree on success.
  createFile: (projectId: string, parentAbsPath: string, name: string) => Promise<string>;
  createFolder: (projectId: string, parentAbsPath: string, name: string) => Promise<void>;
  /**
   * Multipart upload of one or more files into `parentAbsPath`. The
   * client SHA-256s each file via WebCrypto and the server verifies
   * before swap-in. Returns the per-file results so callers can
   * surface "uploaded N files" feedback or open the result. Refreshes
   * the tree on success.
   */
  uploadFiles: (
    projectId: string,
    parentAbsPath: string,
    files: File[],
    opts?: {
      overwrite?: boolean;
      onHashProgress?: (hashed: number, total: number) => void;
    },
  ) => Promise<{ path: string; size: number; sha256: string }[]>;
  renameEntry: (projectId: string, absPath: string, newName: string) => Promise<string>;
  /**
   * Move `srcAbsPath` to `destAbsPath`. Caller is responsible for
   * computing the dest path (typically `<targetDir>/<basename(src)>`);
   * the server validates and rejects moves into the same dir, into a
   * descendant, or onto an existing target. Open tabs whose path
   * matches `srcAbsPath` get patched in place to the new path so the
   * editor stays open without a flash.
   */
  moveEntry: (projectId: string, srcAbsPath: string, destAbsPath: string) => Promise<string>;
  deleteEntry: (
    projectId: string,
    absPath: string,
    opts?: { recursive?: boolean },
  ) => Promise<void>;
}

export const EMPTY_OPEN_FILES: OpenFile[] = [];

// Module-level pointer to the project the open tabs belong to.
// Updated whenever openFile is called; consumed by closeFile /
// setActiveFile so they know which sessionStorage key to write to
// without dragging projectId through every callsite.
let currentProjectId: string | undefined;

function persist(
  projectId: string | undefined,
  state: { openFiles: OpenFile[]; activePath: string | undefined },
) {
  if (projectId === undefined) return;
  writePersistedTabs(
    projectId,
    state.openFiles.map((f) => f.path),
    state.activePath,
  );
}

export const useFileStore = create<FileState>((set, get) => ({
  treeByProject: {},
  treeLoading: {},
  openFiles: [],
  activePath: undefined,
  error: undefined,
  externallyChanged: {},

  loadTree: async (projectId) => {
    set((s) => ({ treeLoading: { ...s.treeLoading, [projectId]: true }, error: undefined }));
    try {
      const tree = await api.filesTree(projectId);
      set((s) => ({
        treeByProject: { ...s.treeByProject, [projectId]: tree },
        treeLoading: { ...s.treeLoading, [projectId]: false },
      }));
    } catch (err) {
      set((s) => ({
        treeLoading: { ...s.treeLoading, [projectId]: false },
        error: err instanceof ApiError ? err.code : (err as Error).message,
      }));
    }
  },

  restoreTabs: async (projectId) => {
    // Two cases:
    // 1. Same project as the current in-memory state — preserve
    //    whatever the user has open (cold-boot already ran, or this
    //    is a redundant call). Early-return.
    // 2. Different project (project switch) — clear in-memory state
    //    in place so the editor pane stops showing the OLD project's
    //    tabs while we load the new project's persisted list.
    //    Crucially, we DON'T persist the empty state to the old
    //    project's storage key; the old tabs were already persisted
    //    by every prior edit, so the data is intact for when the
    //    user switches back. We just clear what's in the store.
    if (currentProjectId === projectId && get().openFiles.length > 0) return;
    if (currentProjectId !== projectId) {
      set({ openFiles: [], activePath: undefined, externallyChanged: {} });
    }
    currentProjectId = projectId;
    const persisted = readPersistedTabs(projectId);
    if (persisted.paths.length === 0) return;
    // Open files in order so the tab strip matches the persisted
    // layout. Each openFile awaits the server fetch; if a file
    // 404s (deleted since persist time), we drop it and continue.
    for (const path of persisted.paths) {
      try {
        await get().openFile(projectId, path);
      } catch {
        // Silently skip — the server-side miss is the expected
        // outcome for files that no longer exist; we don't want a
        // stale tab list to block the rest of the restore.
      }
    }
    if (persisted.activePath !== null) {
      get().setActiveFile(persisted.activePath);
    }
  },

  openFile: async (projectId, absPath, nav) => {
    currentProjectId = projectId;
    // If already open, just activate. When `nav` is supplied, also
    // patch the existing tab so the editor scrolls to the requested
    // line on its next render.
    const existing = get().openFiles.find((f) => f.path === absPath);
    if (existing !== undefined) {
      if (nav !== undefined) {
        set((s) => {
          const next = {
            openFiles: s.openFiles.map((f) => (f.path === absPath ? { ...f, pendingNav: nav } : f)),
            activePath: absPath,
          };
          persist(currentProjectId, next);
          return next;
        });
      } else {
        set((s) => {
          persist(currentProjectId, { openFiles: s.openFiles, activePath: absPath });
          return { activePath: absPath };
        });
      }
      return;
    }
    set({ error: undefined });
    try {
      const r = await api.filesRead(projectId, absPath);
      const tab: OpenFile = {
        tabId: newTabId(),
        path: absPath,
        saved: r.content,
        draft: r.content,
        dirty: false,
        language: r.language,
        binary: r.binary,
        saving: false,
        savedAt: undefined,
        saveError: undefined,
        loadingError: r.binary ? "Binary file — open externally to edit." : undefined,
      };
      if (nav !== undefined) tab.pendingNav = nav;
      set((s) => {
        const next = {
          openFiles: [...s.openFiles, tab],
          activePath: absPath,
        };
        persist(currentProjectId, next);
        return next;
      });
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
    }
  },

  closeFile: (path) => {
    set((s) => {
      const idx = s.openFiles.findIndex((f) => f.path === path);
      if (idx === -1) return {};
      const next = s.openFiles.slice(0, idx).concat(s.openFiles.slice(idx + 1));
      const activePath =
        s.activePath === path ? (next[idx] ?? next[idx - 1] ?? next[0])?.path : s.activePath;
      const ext = { ...s.externallyChanged };
      delete ext[path];
      const result = { openFiles: next, activePath, externallyChanged: ext };
      persist(currentProjectId, result);
      return result;
    });
  },

  closeAllFiles: () => {
    set(() => {
      const result = { openFiles: [], activePath: undefined, externallyChanged: {} };
      persist(currentProjectId, result);
      return result;
    });
  },

  setActiveFile: (path) =>
    set((s) => {
      persist(currentProjectId, { openFiles: s.openFiles, activePath: path });
      return { activePath: path };
    }),

  consumePendingNav: (path) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) => {
        if (f.path !== path || f.pendingNav === undefined) return f;
        const next: OpenFile = { ...f };
        delete next.pendingNav;
        return next;
      }),
    }));
  },

  updateDraft: (path, draft) => {
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, draft, dirty: draft !== f.saved } : f,
      ),
    }));
  },

  saveFile: async (projectId, path) => {
    const file = get().openFiles.find((f) => f.path === path);
    if (file === undefined || file.binary) return;
    set((s) => ({
      openFiles: s.openFiles.map((f) =>
        f.path === path ? { ...f, saving: true, saveError: undefined } : f,
      ),
      error: undefined,
    }));
    try {
      await api.filesWrite(projectId, path, file.draft);
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
            ? {
                ...f,
                saving: false,
                saved: f.draft,
                dirty: false,
                savedAt: Date.now(),
                saveError: undefined,
              }
            : f,
        ),
        externallyChanged: omitKey(s.externallyChanged, path),
      }));
    } catch (err) {
      const code = err instanceof ApiError ? err.code : (err as Error).message;
      // Set both the per-tab saveError (drives the StatusBar's "Save
      // failed — Cmd+S to retry" state) AND the global error (kept for
      // backwards compat with any panel that subscribes to it).
      // Without per-tab state, the user's view of "saving in progress"
      // silently flips back to "unsaved changes" and they keep editing
      // thinking the next debounce will save.
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path ? { ...f, saving: false, saveError: code } : f,
        ),
        error: code,
      }));
      throw err;
    }
  },

  reloadFile: async (projectId, path) => {
    set({ error: undefined });
    try {
      const r = await api.filesRead(projectId, path);
      set((s) => ({
        openFiles: s.openFiles.map((f) =>
          f.path === path
            ? {
                ...f,
                saved: r.content,
                draft: r.content,
                dirty: false,
                language: r.language,
                binary: r.binary,
                loadingError: r.binary ? "Binary file — open externally to edit." : undefined,
              }
            : f,
        ),
        externallyChanged: omitKey(s.externallyChanged, path),
      }));
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
    }
  },

  refreshOpenFiles: async (projectId) => {
    // Snapshot the open paths so concurrent close/open doesn't reshape
    // the array while we iterate. Reads are issued in parallel — each
    // one is independent and the worst case is O(open_tabs) requests
    // (typically 0–3).
    const snapshot = get().openFiles.map((f) => ({
      path: f.path,
      saved: f.saved,
      dirty: f.dirty,
    }));
    if (snapshot.length === 0) return;
    const results = await Promise.allSettled(snapshot.map((s) => api.filesRead(projectId, s.path)));
    set((state) => {
      let openFilesNext = state.openFiles;
      let externallyChanged = state.externallyChanged;
      for (let i = 0; i < snapshot.length; i++) {
        const res = results[i];
        const snap = snapshot[i];
        if (res === undefined || snap === undefined) continue;
        // Ignore failures here — a 404 on a deleted file should
        // surface via the user's next interaction, not as a noisy
        // banner during a refresh sweep.
        if (res.status !== "fulfilled") continue;
        const r = res.value;
        // No-op when content matches — avoids spurious CodeMirror
        // doc replays + flickers.
        if (r.content === snap.saved && !snap.dirty) continue;
        if (r.content === snap.saved) continue;
        if (snap.dirty) {
          externallyChanged = { ...externallyChanged, [snap.path]: true };
        } else {
          openFilesNext = openFilesNext.map((f) =>
            f.path === snap.path
              ? {
                  ...f,
                  saved: r.content,
                  draft: r.content,
                  dirty: false,
                  language: r.language,
                  binary: r.binary,
                  loadingError: r.binary ? "Binary file — open externally to edit." : undefined,
                }
              : f,
          );
          externallyChanged = omitKey(externallyChanged, snap.path);
        }
      }
      return { openFiles: openFilesNext, externallyChanged };
    });
  },

  markExternallyChanged: (path) => {
    set((s) => ({ externallyChanged: { ...s.externallyChanged, [path]: true } }));
  },

  dismissExternallyChanged: (path) => {
    set((s) => ({ externallyChanged: omitKey(s.externallyChanged, path) }));
  },

  createFile: async (projectId, parentAbsPath, name) => {
    set({ error: undefined });
    try {
      const dest = `${parentAbsPath}/${name}`;
      await api.filesWrite(projectId, dest, "");
      await get().loadTree(projectId);
      return dest;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  createFolder: async (projectId, parentAbsPath, name) => {
    set({ error: undefined });
    try {
      await api.filesMkdir(projectId, parentAbsPath, name);
      await get().loadTree(projectId);
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  renameEntry: async (projectId, absPath, newName) => {
    set({ error: undefined });
    try {
      const { path } = await api.filesRename(projectId, absPath, newName);
      // Update any open tab whose path matches: server returns the new
      // canonical path; we patch the in-memory tab in place.
      set((s) => ({
        openFiles: s.openFiles.map((f) => (f.path === absPath ? { ...f, path } : f)),
        activePath: s.activePath === absPath ? path : s.activePath,
      }));
      await get().loadTree(projectId);
      return path;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  moveEntry: async (projectId, srcAbsPath, destAbsPath) => {
    set({ error: undefined });
    try {
      const { path } = await api.filesMove(projectId, srcAbsPath, destAbsPath);
      // Patch any open tab whose path matches the source — also patch
      // tabs whose path was UNDER the moved directory (e.g. moving
      // `src/` to `lib/src/` should retarget every open `src/foo.ts`
      // tab to `lib/src/foo.ts`).
      set((s) => ({
        openFiles: s.openFiles.map((f) => {
          if (f.path === srcAbsPath) return { ...f, path };
          const prefix = `${srcAbsPath}/`;
          if (f.path.startsWith(prefix)) {
            return { ...f, path: `${path}/${f.path.slice(prefix.length)}` };
          }
          return f;
        }),
        activePath:
          s.activePath === srcAbsPath
            ? path
            : s.activePath !== undefined && s.activePath.startsWith(`${srcAbsPath}/`)
              ? `${path}/${s.activePath.slice(srcAbsPath.length + 1)}`
              : s.activePath,
      }));
      await get().loadTree(projectId);
      return path;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  deleteEntry: async (projectId, absPath, opts) => {
    set({ error: undefined });
    try {
      await api.filesDelete(
        projectId,
        absPath,
        opts?.recursive === true ? { recursive: true } : undefined,
      );
      // Close any tab the user had open on this path. For recursive
      // dir delete we'd ideally also close any child-of-absPath tabs;
      // those will surface "file_not_found" on the next save / reload
      // and the user can close them — keeping the tab close logic
      // simple here.
      const open = get().openFiles.find((f) => f.path === absPath);
      if (open !== undefined) get().closeFile(absPath);
      await get().loadTree(projectId);
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },

  uploadFiles: async (projectId, parentAbsPath, files, opts) => {
    set({ error: undefined });
    try {
      const res = await api.uploadFiles(projectId, parentAbsPath, files, {
        ...(opts?.overwrite !== undefined ? { overwrite: opts.overwrite } : {}),
        ...(opts?.onHashProgress !== undefined ? { onHashProgress: opts.onHashProgress } : {}),
      });
      await get().loadTree(projectId);
      return res.files;
    } catch (err) {
      set({ error: err instanceof ApiError ? err.code : (err as Error).message });
      throw err;
    }
  },
}));

function newTabId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function omitKey<V>(record: Record<string, V>, key: string): Record<string, V> {
  if (record[key] === undefined) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

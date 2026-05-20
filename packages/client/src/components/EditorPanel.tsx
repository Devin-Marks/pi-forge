import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { useFileStore, type OpenFile } from "../store/file-store";
import { useActiveProject } from "../store/project-store";
import { AlertTriangle, Save, WrapText, X, XSquare } from "lucide-react";
import type { DiffLine } from "../lib/diff-parser";

const WRAP_KEY_PREFIX = "forge.editor.wrap.";

// Stable empty-array reference for the diff prop. Re-creating `[]`
// inline on every render would trigger CodeMirrorEditor's
// `useEffect([diffChanges])` to re-dispatch unnecessarily.
const EMPTY_DIFF: DiffLine[] = [];

/**
 * Per-file-extension line-wrap preference, persisted across sessions.
 * Long log files want horizontal scroll; markdown / prose wants wrap.
 * The bucket is keyed by lower-cased extension (or "" for no
 * extension); the default for unset extensions is `true` (wrap on),
 * matching the behaviour the editor shipped with.
 */
function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = slash === -1 ? path : path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function readWrapPref(ext: string): boolean {
  try {
    const v = localStorage.getItem(WRAP_KEY_PREFIX + ext);
    if (v === "0") return false;
    if (v === "1") return true;
  } catch {
    // private-mode storage failure → fall through to default
  }
  return true;
}

function writeWrapPref(ext: string, wrap: boolean): void {
  try {
    localStorage.setItem(WRAP_KEY_PREFIX + ext, wrap ? "1" : "0");
  } catch {
    // ignore — choice still applies for this session
  }
}

/**
 * Lazy-loaded CodeMirror host. The CM bundle (basicSetup + 9 language
 * packs + theme) is ~700 KB minified and irrelevant on the initial
 * render — the user might open the chat, run a command, never look at
 * a file. Splitting it keeps the entry chunk closer to 600 KB and
 * makes the Vite "chunk size" warning go quiet.
 *
 * The lazy boundary lives at the React render layer, NOT inside the
 * panel component, so React identifies it once at module evaluation
 * (not every render).
 */
const CodeMirrorEditor = lazy(() =>
  import("./CodeMirrorEditor").then((m) => ({ default: m.CodeMirrorEditor })),
);

/**
 * Phase 10 editor: tabs across the top, single CodeMirror instance under
 * them. Switching tabs replaces the editor's `EditorState` rather than
 * teardown-and-rebuild — keeps focus + DOM stable while we hot-swap the
 * document and language extension.
 *
 * Autosave debounces a `PUT /files/write` 1s after the last keystroke;
 * Cmd/Ctrl+S forces an immediate save. Dirty state lives in the store
 * (so the tab labels and "Saved" indicator can render without dragging
 * a ref through every consumer), but the CodeMirror state is the
 * source of truth for the textarea contents until we persist it via
 * `updateDraft`.
 */
export function EditorPanel() {
  const project = useActiveProject();
  const openFiles = useFileStore((s) => s.openFiles);
  const activePath = useFileStore((s) => s.activePath);
  const setActiveFile = useFileStore((s) => s.setActiveFile);
  const closeFile = useFileStore((s) => s.closeFile);
  const closeAllFiles = useFileStore((s) => s.closeAllFiles);
  const updateDraft = useFileStore((s) => s.updateDraft);
  const saveFile = useFileStore((s) => s.saveFile);
  const reloadFile = useFileStore((s) => s.reloadFile);
  const externallyChanged = useFileStore((s) => s.externallyChanged);
  const gitDiffByPath = useFileStore((s) => s.gitDiffByPath);

  const active = openFiles.find((f) => f.path === activePath);
  const activeExt = active !== undefined ? extensionOf(active.path) : "";
  const [wrap, setWrap] = useState<boolean>(() => readWrapPref(activeExt));

  // Re-read the persisted preference when switching tabs / extensions.
  useEffect(() => {
    setWrap(readWrapPref(activeExt));
  }, [activeExt]);

  const toggleWrap = useCallback((): void => {
    setWrap((prev) => {
      const next = !prev;
      writeWrapPref(activeExt, next);
      return next;
    });
  }, [activeExt]);

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-sm text-neutral-200">
      <Tabs
        files={openFiles}
        activePath={activePath}
        externallyChanged={externallyChanged}
        onActivate={setActiveFile}
        onClose={closeFile}
        onCloseAll={closeAllFiles}
      />
      {active === undefined ? (
        <div className="flex flex-1 items-center justify-center text-xs italic text-neutral-500">
          No file open. Click a file in the tree to start editing.
        </div>
      ) : (
        <>
          {externallyChanged[active.path] === true && (
            <ExternalChangeBanner
              path={active.path}
              onReload={() => {
                if (project !== undefined) void reloadFile(project.id, active.path);
              }}
              onDiscard={() => useFileStore.getState().dismissExternallyChanged(active.path)}
            />
          )}
          {active.binary ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-sm text-neutral-500">
              {active.loadingError ?? "Binary file."}
            </div>
          ) : (
            <Suspense fallback={<EditorLoading />}>
              <CodeMirrorEditor
                key={active.tabId}
                file={active}
                wrap={wrap}
                // Always pass an array (default to empty) so the prop
                // type stays `DiffLine[]`, not `DiffLine[] | undefined`
                // — the latter trips exactOptionalPropertyTypes.
                diffChanges={gitDiffByPath[active.path] ?? EMPTY_DIFF}
                onChange={(v) => updateDraft(active.path, v)}
                onSaveShortcut={() => {
                  if (project !== undefined) void saveFile(project.id, active.path);
                }}
                onConsumePendingNav={(path) => useFileStore.getState().consumePendingNav(path)}
              />
            </Suspense>
          )}
          <StatusBar
            file={active}
            wrap={wrap}
            onToggleWrap={toggleWrap}
            onSave={() => {
              if (project !== undefined) void saveFile(project.id, active.path);
            }}
          />
        </>
      )}
    </div>
  );
}

function EditorLoading() {
  return (
    <div className="flex flex-1 items-center justify-center text-xs italic text-neutral-500">
      Loading editor…
    </div>
  );
}

function Tabs({
  files,
  activePath,
  externallyChanged,
  onActivate,
  onClose,
  onCloseAll,
}: {
  files: OpenFile[];
  activePath: string | undefined;
  externallyChanged: Record<string, boolean>;
  onActivate: (path: string | undefined) => void;
  onClose: (path: string) => void;
  onCloseAll: () => void;
}) {
  if (files.length === 0) return null;
  const dirtyCount = files.filter((f) => f.dirty).length;
  const handleCloseAll = (): void => {
    if (
      dirtyCount > 0 &&
      !window.confirm(
        `Close ${files.length} tab${files.length === 1 ? "" : "s"}? ${dirtyCount} ha${
          dirtyCount === 1 ? "s" : "ve"
        } unsaved changes that will be lost.`,
      )
    ) {
      return;
    }
    onCloseAll();
  };
  return (
    <div className="flex border-b border-neutral-800 bg-neutral-900/40">
      {/* Close-all sits before the tab strip so its position is
          stable regardless of how many tabs are open. Confirmation
          prompt only when there are unsaved changes. */}
      <button
        onClick={handleCloseAll}
        className="flex shrink-0 items-center justify-center border-r border-neutral-800 px-2 py-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
        title={`Close all ${files.length} tab${files.length === 1 ? "" : "s"}`}
      >
        <XSquare size={14} />
      </button>
      <div className="flex flex-1 overflow-x-auto">
        {files.map((f) => {
          const name = f.path.split("/").pop() ?? f.path;
          const active = f.path === activePath;
          // Externally-changed only fires when the tab is dirty (the
          // refresh helper silently reloads clean tabs). Surface it
          // via an amber tint + warning icon so the user notices on
          // inactive tabs — without this signal, the only place the
          // collision shows up is the banner inside the active tab.
          const extChanged = externallyChanged[f.path] === true;
          const baseClass = active
            ? "bg-neutral-950 text-neutral-100"
            : "text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200";
          const conflictClass = extChanged
            ? "bg-amber-900/30 text-amber-200 light:bg-amber-100 light:text-amber-800"
            : "";
          return (
            <div
              key={f.tabId}
              className={`group flex items-center gap-1 border-r border-neutral-800 px-3 py-1.5 text-xs ${baseClass} ${conflictClass}`}
              title={
                extChanged
                  ? `${f.path}\n\nExternal change while you have unsaved edits — open the tab to review.`
                  : f.path
              }
            >
              <button onClick={() => onActivate(f.path)} className="truncate">
                {extChanged ? (
                  <AlertTriangle
                    size={11}
                    className="mr-1 inline text-amber-400 light:text-amber-700"
                  />
                ) : f.dirty ? (
                  // Filled 10-px circle (was a 12-px bullet character that
                  // mostly disappeared into the surrounding text). aria-
                  // label so screen readers announce the unsaved state.
                  <span
                    className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-amber-400 align-middle"
                    aria-label="Unsaved changes"
                    title="Unsaved changes"
                  />
                ) : null}
                {name}
              </button>
              <button
                onClick={() => onClose(f.path)}
                className="rounded p-1 text-neutral-600 hover:bg-neutral-800 hover:text-neutral-200"
                title="Close (any unsaved changes are lost)"
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ExternalChangeBanner({
  path,
  onReload,
  onDiscard,
}: {
  path: string;
  onReload: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-amber-700/40 bg-amber-900/20 px-4 py-1.5 text-xs text-amber-200 light:border-amber-300 light:bg-amber-50 light:text-amber-800">
      <span>
        File changed externally — local edits in this tab are stale. Reload from disk?
        <span className="ml-2 font-mono text-[10px] text-amber-400/70 light:text-amber-700/80">
          {path}
        </span>
      </span>
      <div className="flex gap-1">
        <button
          onClick={onReload}
          className="rounded border border-amber-700/50 px-2 py-0.5 hover:bg-amber-900/30 light:border-amber-400 light:hover:bg-amber-100"
        >
          Reload
        </button>
        <button
          onClick={onDiscard}
          className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
        >
          Keep mine
        </button>
      </div>
    </div>
  );
}

function StatusBar({
  file,
  wrap,
  onToggleWrap,
  onSave,
}: {
  file: OpenFile;
  wrap: boolean;
  onToggleWrap: () => void;
  onSave: () => void;
}) {
  const dirty = file.dirty;
  const saving = file.saving;
  const savedAt = file.savedAt;
  const saveError = file.saveError;
  let label: string;
  let className = "text-neutral-500";
  // Order matters: a save-error state takes precedence over dirty/saving
  // because the user needs to see the failure before deciding to keep
  // editing or retry. Cleared on the next successful save.
  if (saveError !== undefined) {
    label = `Save failed (${saveError}) — Cmd/Ctrl+S or Save to retry`;
    className = "text-rose-400 light:text-rose-700";
  } else if (saving) {
    label = "Saving…";
  } else if (dirty) {
    label = "Unsaved changes";
    className = "text-amber-400 light:text-amber-700";
  } else if (savedAt !== undefined) {
    const t = new Date(savedAt);
    label = `Saved ${t.toLocaleTimeString()}`;
    className = "text-emerald-500 light:text-emerald-700";
  } else {
    label = "Up to date";
  }
  // Save button is only meaningful when there's something to save
  // (dirty buffer) or something to retry (last save errored). Stays
  // disabled while a save is in flight to avoid double-fire.
  const canSave = (dirty || saveError !== undefined) && !saving && !file.binary;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-neutral-800 bg-neutral-900/40 px-3 py-1 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="font-mono text-neutral-500">{file.language}</span>
        <button
          onClick={onToggleWrap}
          className={`flex items-center gap-1 rounded px-1 py-0.5 text-[10px] hover:bg-neutral-800 ${
            wrap ? "text-neutral-300" : "text-neutral-500"
          }`}
          title={
            wrap
              ? "Wrap on (click to switch to horizontal scroll, persisted per file extension)"
              : "Wrap off (click to enable wrap, persisted per file extension)"
          }
        >
          <WrapText size={11} />
          {wrap ? "wrap" : "no wrap"}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <span className={className}>{label}</span>
        <button
          onClick={onSave}
          disabled={!canSave}
          className="flex items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-200 hover:border-neutral-500 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:text-neutral-600"
          title="Save (Cmd/Ctrl+S)"
        >
          <Save size={11} />
          Save
        </button>
      </div>
    </div>
  );
}

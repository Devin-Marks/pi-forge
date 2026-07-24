import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react";
import {
  AtSign,
  ChevronDown,
  ChevronRight,
  Download,
  Eye,
  FilePlus2,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { useFileStore } from "../store/file-store";
import { useActiveProject } from "../store/project-store";
import { useUiStore } from "../store/ui-store";
import { api, ApiError, type FileTreeNode } from "../lib/api-client";
import { ConfirmDialog, PromptDialog } from "./Modal";

/**
 * Discriminated union of the active dialog. `undefined` means no
 * dialog is open. The state lives on the panel rather than as
 * imperative `await dialog.prompt()` calls so we don't need a global
 * provider — keeps the dialog primitives purely declarative.
 */
type DialogState =
  | { kind: "create"; entryKind: "file" | "folder"; parentAbsPath: string }
  | { kind: "delete"; absPath: string; name: string; isDir: boolean; recursive: boolean }
  | { kind: "deleteMany"; paths: string[] }
  | undefined;

/**
 * Phase 10 file browser. A recursive tree of the active project's source
 * tree (with `node_modules` / `.git` / `dist` etc filtered server-side).
 *
 * Click a file → opens in EditorPanel. Click a folder → expands.
 * Toolbar at the top: refresh, new file, new folder. Hover a row for
 * rename / delete buttons. Right-click a file → context menu (today
 * just "Add as @ context", which appends `@<path>` to the chat input;
 * extensible to more actions as we add them).
 */
export function FileBrowserPanel() {
  const project = useActiveProject();
  const tree = useFileStore((s) =>
    project !== undefined ? s.treeByProject[project.id] : undefined,
  );
  const loading = useFileStore((s) =>
    project !== undefined ? (s.treeLoading[project.id] ?? false) : false,
  );
  const error = useFileStore((s) => s.error);
  const loadTree = useFileStore((s) => s.loadTree);
  const showExcludedTreeEntries = useFileStore((s) => s.showExcludedTreeEntries);
  const setShowExcludedTreeEntries = useFileStore((s) => s.setShowExcludedTreeEntries);
  const openFile = useFileStore((s) => s.openFile);
  const createFile = useFileStore((s) => s.createFile);
  const createFolder = useFileStore((s) => s.createFolder);
  const renameEntry = useFileStore((s) => s.renameEntry);
  const moveEntry = useFileStore((s) => s.moveEntry);
  const deleteEntry = useFileStore((s) => s.deleteEntry);

  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "": true });
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [renameDraft, setRenameDraft] = useState("");
  // Path of the directory currently being hovered as a drop target,
  // used to highlight the row. Cleared on dragleave/drop.
  const [dropTarget, setDropTarget] = useState<string | undefined>(undefined);
  const [dialog, setDialog] = useState<DialogState>(undefined);
  // Upload state: progress message during in-flight uploads, target dir
  // chosen by the toolbar button (so the same hidden <input> can be
  // re-used for both root-level and per-folder uploads).
  const [uploadStatus, setUploadStatus] = useState<string | undefined>(undefined);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<string | undefined>(undefined);
  const uploadFiles = useFileStore((s) => s.uploadFiles);
  // Right-click context menu — hoisted above the early-return below so
  // hook ordering stays stable across renders. `kind` discriminates the
  // three entry points: a file row, a folder row, or empty area in the
  // tree's scroll container (which targets the project root).
  const [contextMenu, setContextMenu] = useState<
    | {
        x: number;
        y: number;
        kind: "file" | "folder" | "empty";
        absPath: string;
        /** basename of the row, used by rename / delete copy. Empty for kind=empty. */
        name: string;
        /** Tree-relative path (`node.path`) used by create-in-folder to
         *  auto-expand the parent. Empty string = project root. */
        relPath: string;
      }
    | undefined
  >(undefined);
  const requestChatInsert = useUiStore((s) => s.requestChatInsert);
  const openEditorPane = useUiStore((s) => s.openEditorPane);
  // Selected paths for the multiselect / bulk-delete affordance.
  // Cmd/Ctrl+click on a row toggles selection; plain click clears and
  // opens/expands as before. Hoisted above the early-return below so
  // hook ordering stays stable across renders (rules-of-hooks).
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (project !== undefined) void loadTree(project.id);
  }, [project?.id, showExcludedTreeEntries, loadTree]);

  if (project === undefined) {
    return (
      <div className="p-4 text-xs italic text-neutral-500">
        Select a project to browse its files.
      </div>
    );
  }

  const submitCreate = async (
    entryKind: "file" | "folder",
    parentAbsPath: string,
    name: string,
  ): Promise<void> => {
    setDialog(undefined);
    try {
      if (entryKind === "file") {
        const path = await createFile(project.id, parentAbsPath, name);
        // Open the new file immediately so the user can start editing.
        await openFile(project.id, path);
        openEditorPane();
      } else {
        await createFolder(project.id, parentAbsPath, name);
      }
    } catch {
      // Error already in store; banner renders below.
    }
  };

  // Open the create dialog scoped to a specific folder. Used by the
  // per-row + buttons so the new file/folder lands inside the hovered
  // directory rather than at the project root. Auto-expands the parent
  // so the new entry becomes visible after loadTree refreshes the tree.
  const requestCreateInFolder = (
    parentAbsPath: string,
    parentRelPath: string,
    entryKind: "file" | "folder",
  ): void => {
    setExpanded((e) => ({ ...e, [parentRelPath]: true }));
    setDialog({ kind: "create", entryKind, parentAbsPath });
  };

  const startRename = (absPath: string, currentName: string): void => {
    setRenaming(absPath);
    setRenameDraft(currentName);
  };
  const commitRename = async (absPath: string): Promise<void> => {
    const name = renameDraft.trim();
    setRenaming(undefined);
    setRenameDraft("");
    if (name.length === 0) return;
    try {
      await renameEntry(project.id, absPath, name);
    } catch {
      // store.error renders
    }
  };

  const clearSelection = (): void => setSelectedPaths(new Set());
  const toggleSelected = (absPath: string): void => {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(absPath)) next.delete(absPath);
      else next.add(absPath);
      return next;
    });
  };

  const requestDelete = (absPath: string, name: string, isDir: boolean): void => {
    setDialog({ kind: "delete", absPath, name, isDir, recursive: false });
  };

  const submitDelete = async (): Promise<void> => {
    if (dialog?.kind !== "delete") return;
    const { absPath, name, isDir, recursive } = dialog;
    setDialog(undefined);
    try {
      await deleteEntry(project.id, absPath, recursive ? { recursive: true } : undefined);
    } catch (err) {
      // If the folder turned out to be non-empty, re-open the dialog
      // in "recursive" mode with a stronger message instead of just
      // surfacing the error code. The user already wanted to delete
      // it; we just need a second confirmation that they accept the
      // contents going too.
      if (err instanceof ApiError && err.code === "directory_not_empty") {
        setDialog({ kind: "delete", absPath, name, isDir, recursive: true });
        return;
      }
      // store.error renders
    }
  };

  const submitDeleteMany = async (): Promise<void> => {
    if (dialog?.kind !== "deleteMany") return;
    const { paths } = dialog;
    setDialog(undefined);
    // Bulk delete is always recursive — the user explicitly opted into
    // a multi-item action, so re-prompting per non-empty directory
    // would be obnoxious.
    for (const p of paths) {
      try {
        await deleteEntry(project.id, p, { recursive: true });
      } catch {
        // store.error renders the first failure; keep going so a single
        // missing path doesn't strand the rest of the selection.
      }
    }
    clearSelection();
  };

  const onClickEntry = async (node: FileTreeNode): Promise<void> => {
    if (node.type === "directory") {
      setExpanded((e) => ({ ...e, [node.path]: !e[node.path] }));
      return;
    }
    await openFile(project.id, joinPath(project.path, node.path));
    openEditorPane();
  };

  // Right-click context menu for file rows. State (`contextMenu`) is
  // hoisted above the early-return up top; the handlers below own the
  // open/close + per-item dispatch. `stopPropagation` prevents the
  // empty-area handler on the scroll container from firing too — only
  // ONE menu opens per right-click, with the most specific target winning.
  const openContextMenu = (
    e: React.MouseEvent,
    info: { absPath: string; isDir: boolean; name: string; relPath: string },
  ): void => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      kind: info.isDir ? "folder" : "file",
      absPath: info.absPath,
      name: info.name,
      relPath: info.relPath,
    });
  };

  // Right-click in the tree's empty area (below the last row) opens
  // a slim menu rooted at the project. Useful when a project has no
  // top-level folders to right-click ON yet.
  const openEmptyContextMenu = (e: React.MouseEvent): void => {
    e.preventDefault();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      kind: "empty",
      absPath: project.path,
      name: "",
      relPath: "",
    });
  };

  const addAsChatContext = (absPath: string): void => {
    // Compute the path relative to the project root — `@<rel>` is what
    // expandFileReferences resolves on the server (rooted at workspace
    // path). file-references.ts joins workspacePath + the captured
    // path, so we want a project-relative form here.
    let rel = absPath;
    if (absPath.startsWith(`${project.path}/`)) {
      rel = absPath.slice(project.path.length + 1);
    }
    // Quote the path if it contains whitespace so the server's regex
    // captures the full token (matches the same convention the
    // ChatInput autocomplete uses).
    const ref = /\s/.test(rel) ? `@"${rel}"` : `@${rel}`;
    requestChatInsert(ref);
    setContextMenu(undefined);
  };

  /**
   * Drop handler — `targetDirAbsPath` is the directory the user dropped
   * onto (or the project root when the drop hit the empty area). Two
   * sources: an in-app drag (a tree row) carries `application/x-pi-path`
   * and triggers a move; an OS drag carries `dataTransfer.files` and
   * triggers an upload. Same-dir moves are no-ops; descendant moves
   * surface the server's 400 via the store's `error` slot.
   */
  const handleDrop = async (e: DragEvent<HTMLElement>, targetDirAbsPath: string): Promise<void> => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(undefined);
    const src = e.dataTransfer.getData("application/x-pi-path");
    // In-app drags also pass through the browser's drag/drop plumbing;
    // prefer the explicit pi path when present so a row drag never gets
    // misclassified as an OS file upload.
    if (src.length === 0 && hasTransferType(e.dataTransfer, "Files")) {
      const files = await collectDroppedUploadFiles(e.dataTransfer);
      await runUpload(targetDirAbsPath, files);
      return;
    }

    if (src.length === 0) return;
    // basename of src
    const name = src.split("/").pop() ?? "";
    if (name.length === 0) return;
    const dest = `${targetDirAbsPath}/${name}`;
    if (dest === src) return;
    // Refuse moving a directory into itself or a descendant — server
    // catches this too, but the client check skips a round trip.
    if (targetDirAbsPath === src || targetDirAbsPath.startsWith(`${src}/`)) return;
    try {
      await moveEntry(project.id, src, dest);
    } catch {
      // store.error renders banner
    }
  };

  const runUpload = async (targetDirAbsPath: string, files: File[]): Promise<void> => {
    if (files.length === 0) return;
    const totalBytes = files.reduce((acc, f) => acc + f.size, 0);
    setUploadStatus(
      `Hashing ${files.length} file${files.length === 1 ? "" : "s"} (${formatBytes(totalBytes)})…`,
    );
    try {
      const written = await uploadFiles(project.id, targetDirAbsPath, files, {
        onHashProgress: (hashed, total) => {
          // Once hashing is done the network upload kicks off; we
          // can't cheaply track POST progress without an XHR upload
          // hook, so the label flips to "Uploading…" via the
          // post-progress branch below.
          if (hashed < total) {
            setUploadStatus(
              `Hashing ${formatBytes(hashed)} / ${formatBytes(total)} (${Math.floor((hashed / total) * 100)}%)…`,
            );
          } else {
            setUploadStatus(
              `Uploading ${files.length} file${files.length === 1 ? "" : "s"} (${formatBytes(total)})…`,
            );
          }
        },
      });
      setUploadStatus(`Uploaded ${written.length} file${written.length === 1 ? "" : "s"}.`);
      window.setTimeout(() => setUploadStatus(undefined), 2500);
    } catch {
      setUploadStatus(undefined);
      // store.error renders the failure banner
    }
  };

  const onPickUpload = (targetDirAbsPath: string): void => {
    uploadTargetRef.current = targetDirAbsPath;
    uploadInputRef.current?.click();
  };

  /**
   * Trigger an authed download of a file or directory. Folders +
   * the project root come back as `.tar.gz`. We blob-buffer the
   * response then click a hidden anchor — `<a href download>` alone
   * can't carry the Authorization header.
   */
  const downloadEntry = async (absPath: string | undefined): Promise<void> => {
    setUploadStatus("Preparing download…");
    try {
      const { blob, filename } = await api.filesDownload(project.id, absPath);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Defer revoke a tick so Safari's download handler has a chance
      // to grab the blob — revoking inside the same task can race.
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setUploadStatus(undefined);
    } catch (err) {
      setUploadStatus(undefined);
      // Surface via the store error slot for consistency with the
      // rest of the panel — wrap unknown errors in a code-ish string.
      useFileStore.setState({
        error: err instanceof Error ? err.message : "download_failed",
      });
    }
  };

  const onUploadInputChange = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    // Snapshot the FileList into a real array BEFORE we reset
    // input.value — the reset empties the FileList in-place, so any
    // later read would see zero files. Same trick as the chat input's
    // attachment handler.
    const list = e.target.files;
    const files = list !== null ? Array.from(list) : [];
    const target = uploadTargetRef.current ?? project.path;
    e.target.value = "";
    uploadTargetRef.current = undefined;
    if (files.length === 0) return;
    await runUpload(target, files);
  };

  return (
    <div className="forge-file-browser flex h-full flex-col bg-neutral-950 text-xs text-neutral-300">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="truncate font-medium text-neutral-200" title={project.path}>
          {project.name}
        </span>
        <div className="flex gap-1">
          <button
            onClick={() =>
              setDialog({ kind: "create", entryKind: "file", parentAbsPath: project.path })
            }
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="New file"
          >
            <FilePlus2 size={14} />
          </button>
          <button
            onClick={() =>
              setDialog({ kind: "create", entryKind: "folder", parentAbsPath: project.path })
            }
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="New folder"
          >
            <FolderPlus size={14} />
          </button>
          <button
            onClick={() => onPickUpload(project.path)}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Upload files into project root (drag-and-drop also works on any folder)"
          >
            <Upload size={14} />
          </button>
          <button
            onClick={() => void downloadEntry(undefined)}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Download project as .tar.gz (skips node_modules, .git, dist, etc.)"
          >
            <Download size={14} />
          </button>
          <button
            onClick={() => setShowExcludedTreeEntries(!showExcludedTreeEntries)}
            className={`rounded p-1 hover:bg-neutral-800 hover:text-neutral-200 ${
              showExcludedTreeEntries ? "bg-neutral-800 text-sky-300" : "text-neutral-400"
            }`}
            title={
              showExcludedTreeEntries
                ? "Hide normally excluded files and folders"
                : "Show all files and folders"
            }
            aria-label={
              showExcludedTreeEntries
                ? "Hide normally excluded files and folders"
                : "Show all files and folders"
            }
            aria-pressed={showExcludedTreeEntries}
          >
            <Eye size={14} />
          </button>
          <button
            onClick={() => void loadTree(project.id)}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Refresh"
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => void onUploadInputChange(e)}
      />
      {uploadStatus !== undefined && (
        <div className="flex items-center gap-1.5 border-b border-emerald-700/40 bg-emerald-900/20 px-3 py-1.5 text-[11px] text-emerald-200 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800">
          {!uploadStatus.startsWith("Uploaded") && <Loader2 size={11} className="animate-spin" />}
          <span>{uploadStatus}</span>
        </div>
      )}
      {error !== undefined && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300 light:border-red-300 light:bg-red-50 light:text-red-700">
          {error}
        </div>
      )}
      {selectedPaths.size > 0 && (
        <div className="flex items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-900/60 px-3 py-1.5 text-[11px] text-neutral-300">
          <span>
            {selectedPaths.size} selected
            <span className="ml-2 text-neutral-500">(Cmd/Ctrl+click rows to add or remove)</span>
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setDialog({ kind: "deleteMany", paths: Array.from(selectedPaths) })}
              className="rounded border border-red-700/50 px-2 py-0.5 text-red-300 hover:bg-red-900/20 light:border-red-400 light:text-red-700 light:hover:bg-red-50"
            >
              Delete selected
            </button>
            <button
              onClick={clearSelection}
              className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:border-neutral-500"
            >
              Clear
            </button>
          </div>
        </div>
      )}
      <div
        className="flex-1 overflow-y-auto py-1"
        // Empty-area context menu — only fires when the right-click
        // didn't land on a tree row (rows stopPropagation in their own
        // openContextMenu). Useful for empty projects or below-last-row
        // gaps where there's no row to right-click on.
        onContextMenu={openEmptyContextMenu}
        // Empty-area drop = move/upload to the project root. dragover
        // MUST preventDefault to enable the drop. We accept either an
        // in-app drag (custom mime) or a native OS file drag (`Files`).
        onDragOver={(e) => {
          const isPiPath = hasTransferType(e.dataTransfer, "application/x-pi-path");
          const isFiles = hasTransferType(e.dataTransfer, "Files");
          if (isPiPath || isFiles) {
            e.preventDefault();
            e.dataTransfer.dropEffect = isFiles ? "copy" : "move";
          }
        }}
        onDrop={(e) => void handleDrop(e, project.path)}
      >
        {tree === undefined && !loading && (
          <p className="px-3 py-2 italic text-neutral-500">Tree not loaded.</p>
        )}
        {tree !== undefined && (
          <Tree
            node={tree}
            depth={0}
            projectPath={project.path}
            expanded={expanded}
            onToggle={(path) => setExpanded((e) => ({ ...e, [path]: !e[path] }))}
            onOpen={(node) => void onClickEntry(node)}
            renaming={renaming}
            renameDraft={renameDraft}
            onRenameDraftChange={setRenameDraft}
            onRenameCommit={(absPath) => void commitRename(absPath)}
            onRenameStart={startRename}
            onDelete={(absPath, name, isDir) => requestDelete(absPath, name, isDir)}
            onCreate={(parentAbsPath, parentRelPath, entryKind) =>
              requestCreateInFolder(parentAbsPath, parentRelPath, entryKind)
            }
            onUpload={(absPath) => onPickUpload(absPath)}
            onDownload={(absPath) => void downloadEntry(absPath)}
            dropTarget={dropTarget}
            onDropTargetChange={setDropTarget}
            onDrop={(e, dir) => void handleDrop(e, dir)}
            onContextMenu={openContextMenu}
            selectedPaths={selectedPaths}
            onToggleSelect={toggleSelected}
          />
        )}
      </div>
      <PromptDialog
        open={dialog?.kind === "create"}
        onClose={() => setDialog(undefined)}
        onSubmit={(name) => {
          if (dialog?.kind !== "create") return;
          void submitCreate(dialog.entryKind, dialog.parentAbsPath, name);
        }}
        title={createDialogTitle(dialog, project.path)}
        label={createDialogLabel(dialog, project.path)}
        placeholder={createDialogPlaceholder(dialog)}
        primaryLabel="Create"
      />
      <ConfirmDialog
        open={dialog?.kind === "delete"}
        onClose={() => setDialog(undefined)}
        onConfirm={() => void submitDelete()}
        title={
          dialog?.kind === "delete"
            ? dialog.recursive
              ? `"${dialog.name}" is not empty`
              : dialog.isDir
                ? "Delete directory"
                : "Delete file"
            : ""
        }
        message={
          dialog?.kind === "delete"
            ? dialog.recursive
              ? `"${dialog.name}" contains files. Delete the directory and ALL its contents? This cannot be undone.`
              : `Delete ${dialog.isDir ? "directory" : "file"} "${dialog.name}"? This cannot be undone.`
            : ""
        }
        primaryLabel={dialog?.kind === "delete" && dialog.recursive ? "Delete contents" : "Delete"}
        tone="danger"
      />
      <ConfirmDialog
        open={dialog?.kind === "deleteMany"}
        onClose={() => setDialog(undefined)}
        onConfirm={() => void submitDeleteMany()}
        title={
          dialog?.kind === "deleteMany"
            ? `Delete ${dialog.paths.length} item${dialog.paths.length === 1 ? "" : "s"}`
            : ""
        }
        message={
          dialog?.kind === "deleteMany"
            ? `Delete the ${dialog.paths.length} selected file${dialog.paths.length === 1 ? "" : "s"} / folder${dialog.paths.length === 1 ? "" : "s"}? Folders are deleted recursively. This cannot be undone.`
            : ""
        }
        primaryLabel="Delete all"
        tone="danger"
      />
      {contextMenu !== undefined && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          kind={contextMenu.kind}
          onClose={() => setContextMenu(undefined)}
          onAddAsContext={() => addAsChatContext(contextMenu.absPath)}
          {...(contextMenu.kind !== "empty" && {
            onRename: () => startRename(contextMenu.absPath, contextMenu.name),
            onDelete: () =>
              requestDelete(contextMenu.absPath, contextMenu.name, contextMenu.kind === "folder"),
            onDownload: () => void downloadEntry(contextMenu.absPath),
          })}
          {...(contextMenu.kind !== "file" && {
            onAddFile: () =>
              requestCreateInFolder(contextMenu.absPath, contextMenu.relPath, "file"),
            onAddFolder: () =>
              requestCreateInFolder(contextMenu.absPath, contextMenu.relPath, "folder"),
          })}
        />
      )}
    </div>
  );
}

/**
 * Floating context menu rendered at viewport coordinates. Closes on
 * any outside click, on Esc, or when a menu item runs. Three target
 * kinds drive different action sets:
 *
 *  - `file`   — Add as @ context, Rename, Delete, Download
 *  - `folder` — Rename, Delete, Download, Add file, Add folder
 *  - `empty`  — Add file, Add folder (rooted at the project)
 *
 * Items that don't apply to the current kind have their handler set
 * to `undefined` by the parent — this component just doesn't render
 * those rows. (Older revision rendered them disabled; that produced a
 * cluttered menu where most items were greyed out, especially for the
 * empty-area target. Hiding inapplicable rows reads better.)
 */
function FileContextMenu(props: {
  x: number;
  y: number;
  kind: "file" | "folder" | "empty";
  onClose: () => void;
  onAddAsContext: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onDownload?: () => void;
  onAddFile?: () => void;
  onAddFolder?: () => void;
}) {
  // Memo-stable close ref so the effect's dep array doesn't churn on
  // every parent render — earlier `[props]` dep meant the outside-click
  // listener tore down + re-attached on every render of the parent
  // (which happened on file-tree refreshes, store updates, etc.). The
  // teardown window made outside-click closing flaky.
  const closeRef = useRef(props.onClose);
  closeRef.current = props.onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") closeRef.current();
    };
    const onMouseDown = (): void => closeRef.current();
    window.addEventListener("keydown", onKey);
    // mousedown fires before the click handler on the menu items, so
    // capture-phase + same-tick close would race. Listen on the next
    // tick so the menu's own click resolves first.
    const t = setTimeout(() => window.addEventListener("mousedown", onMouseDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onMouseDown);
      clearTimeout(t);
    };
  }, []);

  // Run the action then close. Wrapping every callback this way keeps
  // the per-item JSX terse and makes the close-on-action contract
  // local to the menu rather than expecting every parent handler to
  // call onClose itself.
  const run = (fn: (() => void) | undefined): (() => void) | undefined => {
    if (fn === undefined) return undefined;
    return () => {
      fn();
      props.onClose();
    };
  };
  // Both files and folders can be `@` references — files inline their
  // content, folders defer to the model (which lists / greps via tools).
  // Empty area has no path to attach.
  const addAsContext = props.kind !== "empty" ? run(props.onAddAsContext) : undefined;
  const rename = run(props.onRename);
  const del = run(props.onDelete);
  const download = run(props.onDownload);
  const addFile = run(props.onAddFile);
  const addFolder = run(props.onAddFolder);

  return (
    <div
      className="forge-file-context-menu fixed z-50 min-w-[200px] overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-lg"
      style={{ left: props.x, top: props.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {addAsContext !== undefined && (
        <ContextMenuItem
          onClick={addAsContext}
          icon={<AtSign size={12} />}
          label="Add as @ context"
          title={
            props.kind === "folder"
              ? "Append @<path>/ to the chat input so the model can ls / grep this folder"
              : "Append @<path> to the chat input so the file's content is sent with the next prompt"
          }
        />
      )}
      {addFile !== undefined && (
        <ContextMenuItem
          onClick={addFile}
          icon={<FilePlus2 size={12} />}
          label="Add file"
          title={
            props.kind === "folder"
              ? "Create a new file inside this folder"
              : "Create a new file at the project root"
          }
        />
      )}
      {addFolder !== undefined && (
        <ContextMenuItem
          onClick={addFolder}
          icon={<FolderPlus size={12} />}
          label="Add folder"
          title={
            props.kind === "folder"
              ? "Create a new subfolder inside this folder"
              : "Create a new folder at the project root"
          }
        />
      )}
      {rename !== undefined && (
        <ContextMenuItem
          onClick={rename}
          icon={<Pencil size={12} />}
          label="Rename"
          title="Rename this file or folder"
        />
      )}
      {download !== undefined && (
        <ContextMenuItem
          onClick={download}
          icon={<Download size={12} />}
          label="Download"
          title={props.kind === "folder" ? "Download folder as .tar.gz" : "Download this file"}
        />
      )}
      {del !== undefined && (
        <ContextMenuItem
          onClick={del}
          icon={<Trash2 size={12} />}
          label="Delete"
          title="Delete this file or folder"
          tone="danger"
        />
      )}
    </div>
  );
}

function ContextMenuItem(props: {
  onClick: () => void;
  icon: ReactNode;
  label: string;
  title: string;
  tone?: "danger";
}) {
  const danger = props.tone === "danger";
  return (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title}
      className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs ${
        danger
          ? "text-red-300 hover:bg-red-900/30 hover:text-red-100 light:text-red-700 light:hover:bg-red-100 light:hover:text-red-900"
          : "text-neutral-200 hover:bg-neutral-800"
      }`}
    >
      {props.icon}
      {props.label}
    </button>
  );
}

interface TreeProps {
  node: FileTreeNode;
  depth: number;
  projectPath: string;
  expanded: Record<string, boolean>;
  onToggle: (path: string) => void;
  onOpen: (node: FileTreeNode) => void;
  renaming: string | undefined;
  renameDraft: string;
  onRenameDraftChange: (v: string) => void;
  onRenameCommit: (absPath: string) => void;
  onRenameStart: (absPath: string, name: string) => void;
  onDelete: (absPath: string, name: string, isDir: boolean) => void;
  /**
   * Open the create-entry dialog scoped to this directory. parentRelPath
   * is the tree-relative key (used to auto-expand the folder so the new
   * entry materializes in view); parentAbsPath is what the file store
   * needs to resolve the destination on the server.
   */
  onCreate: (parentAbsPath: string, parentRelPath: string, entryKind: "file" | "folder") => void;
  /** Click-to-upload into this directory; click-fired from a hover icon. */
  onUpload: (absPath: string) => void;
  /** Click-to-download (file: verbatim; directory: tar.gz). */
  onDownload: (absPath: string) => void;
  /** Path of the directory currently being hovered as a drop target. */
  dropTarget: string | undefined;
  onDropTargetChange: (path: string | undefined) => void;
  onDrop: (e: DragEvent<HTMLElement>, targetDirAbsPath: string) => void;
  /** Right-click handler — opens the per-row context menu. */
  onContextMenu: (
    e: React.MouseEvent,
    info: { absPath: string; isDir: boolean; name: string; relPath: string },
  ) => void;
  /** Set of absolute paths currently selected (for bulk actions). */
  selectedPaths: Set<string>;
  /** Toggle one path in the selection set. */
  onToggleSelect: (absPath: string) => void;
}

function Tree(props: TreeProps) {
  const { node, depth, projectPath } = props;
  // Root: render only its children, no row for the root itself (the
  // panel header already shows the project name).
  if (depth === 0 && node.type === "directory") {
    return (
      <ul>
        {node.children?.map((child) => (
          <Tree key={child.path} {...props} node={child} depth={1} />
        ))}
      </ul>
    );
  }
  const absPath = joinPath(projectPath, node.path);
  const isDir = node.type === "directory";
  const open = isDir && (props.expanded[node.path] ?? false);
  const isRenaming = props.renaming === absPath;
  const isDropTarget = isDir && props.dropTarget === absPath;
  const isSelected = props.selectedPaths.has(absPath);
  return (
    <li>
      <div
        // Selection styling: a saturated 2-px LEFT BORDER + tinted bg
        // gives an unambiguous "this row is selected" cue that stays
        // legible against the dark theme and survives hover. Earlier
        // version was `bg-emerald-900/20` only (close to neutral-900
        // at low alpha) plus a `hover:bg-neutral-900` that completely
        // hid the selection on cursor-over. Border lives on every row
        // (transparent when unselected) so toggling selection doesn't
        // shift content by 2 px.
        //
        // Blue, not emerald, to disambiguate from the drop-target
        // styling below — drop-target keeps its emerald ring so
        // dragging onto a selected row is still obvious.
        className={`group flex items-center gap-1 border-l-2 py-0.5 pr-2 ${
          isSelected
            ? "border-blue-400 bg-blue-500/15 hover:bg-blue-500/25"
            : "border-transparent hover:bg-neutral-900"
        } ${isDropTarget ? "bg-emerald-900/30 ring-1 ring-emerald-700/50" : ""}`}
        style={{ paddingLeft: `${depth * 12 + 6}px` }}
        // Right-click → context menu. Skip while renaming so the input
        // keeps its native context menu (paste, etc.).
        onContextMenu={
          isRenaming
            ? undefined
            : (e) =>
                props.onContextMenu(e, {
                  absPath,
                  isDir,
                  name: node.name,
                  relPath: node.path,
                })
        }
        // Drag source: every row is draggable except while inline
        // renaming (the input owns pointer events then).
        draggable={!isRenaming}
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-pi-path", absPath);
          e.dataTransfer.effectAllowed = "move";
        }}
        // Drop target: only directories accept drops. dragover MUST
        // preventDefault to enable the drop; we also stopPropagation
        // so the project-root drop area doesn't fire when dropping on
        // a nested folder. Accepts either in-app moves (custom mime)
        // or native OS file uploads (`Files`).
        onDragOver={
          isDir
            ? (e) => {
                const isFile = hasTransferType(e.dataTransfer, "Files");
                const isPiPath = hasTransferType(e.dataTransfer, "application/x-pi-path");
                if (!isFile && !isPiPath) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = isFile ? "copy" : "move";
                if (props.dropTarget !== absPath) props.onDropTargetChange(absPath);
              }
            : undefined
        }
        onDragLeave={
          isDir
            ? () => {
                if (props.dropTarget === absPath) props.onDropTargetChange(undefined);
              }
            : undefined
        }
        onDrop={
          isDir
            ? (e) => {
                e.stopPropagation();
                props.onDrop(e, absPath);
              }
            : undefined
        }
      >
        <button
          onClick={(e) => {
            // Cmd (mac) / Ctrl (win/linux) toggles selection without
            // opening or expanding the row, so users can build up a
            // multi-row selection for the bulk-delete action without
            // navigating away. Plain click keeps the open / expand
            // behavior; meta-click never touches the editor / tree
            // expansion state.
            if (e.metaKey || e.ctrlKey) {
              props.onToggleSelect(absPath);
              return;
            }
            props.onOpen(node);
          }}
          className="flex flex-1 items-center gap-1 truncate text-left"
          title={absPath}
        >
          {isDir ? (
            open ? (
              <ChevronDown size={12} className="text-neutral-500" />
            ) : (
              <ChevronRight size={12} className="text-neutral-500" />
            )
          ) : (
            <span className="inline-block w-3" />
          )}
          {isRenaming ? (
            <input
              autoFocus
              value={props.renameDraft}
              onChange={(e) => props.onRenameDraftChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  props.onRenameCommit(absPath);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  props.onRenameCommit(absPath); // commit-or-empty cancels via empty draft
                }
              }}
              onBlur={() => props.onRenameCommit(absPath)}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
            />
          ) : (
            <span className={`truncate ${isDir ? "text-neutral-200" : "text-neutral-300"}`}>
              {node.name}
            </span>
          )}
          {node.truncated === true && <span className="ml-1 text-[10px] text-neutral-600">…</span>}
        </button>
        {!isRenaming && (
          <div className="hidden items-center gap-0.5 group-hover:flex">
            {isDir && (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onCreate(absPath, node.path, "file");
                  }}
                  className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title="New file in this folder"
                >
                  <FilePlus2 size={11} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onCreate(absPath, node.path, "folder");
                  }}
                  className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title="New subfolder in this folder"
                >
                  <FolderPlus size={11} />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onUpload(absPath);
                  }}
                  className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
                  title="Upload into this folder"
                >
                  <Upload size={11} />
                </button>
              </>
            )}
            <button
              onClick={(e) => {
                e.stopPropagation();
                props.onDownload(absPath);
              }}
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title={isDir ? "Download folder as .tar.gz" : "Download file"}
            >
              <Download size={11} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                props.onRenameStart(absPath, node.name);
              }}
              className="rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
              title="Rename"
            >
              <Pencil size={11} />
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                props.onDelete(absPath, node.name, isDir);
              }}
              className="rounded p-0.5 text-neutral-500 hover:bg-red-900/30 hover:text-red-300 light:hover:bg-red-100 light:hover:text-red-700"
              title="Delete"
            >
              <Trash2 size={11} />
            </button>
          </div>
        )}
      </div>
      {isDir && open && node.children !== undefined && (
        <ul>
          {node.children.map((child) => (
            <Tree key={child.path} {...props} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Build an absolute path from the project root + a relative tree path.
 * The server uses the local OS separator on disk; the tree returns
 * paths in that same separator. We deliberately don't normalise — the
 * server treats the path as opaque + validates it's inside the project
 * root, so consistency with what the server returned is what matters.
 */
function joinPath(root: string, rel: string): string {
  if (rel === "") return root;
  return `${root}/${rel.replaceAll("\\", "/")}`;
}

/**
 * Derive the parent's display path for the create-dialog title/label.
 * Toolbar-triggered creates have parentAbsPath === project root and
 * read as "(relative to project root)"; per-folder + buttons get the
 * project-relative form so users see exactly where the new entry will
 * land.
 */
function parentDisplay(parentAbsPath: string, projectPath: string): string | undefined {
  if (parentAbsPath === projectPath) return undefined;
  if (parentAbsPath.startsWith(`${projectPath}/`)) {
    return parentAbsPath.slice(projectPath.length + 1);
  }
  return parentAbsPath;
}

function createDialogTitle(dialog: DialogState, projectPath: string): string {
  if (dialog?.kind !== "create") return "";
  const rel = parentDisplay(dialog.parentAbsPath, projectPath);
  const noun = dialog.entryKind === "folder" ? "folder" : "file";
  return rel === undefined ? `New ${noun}` : `New ${noun} in ${rel}/`;
}

function createDialogLabel(dialog: DialogState, projectPath: string): string {
  if (dialog?.kind !== "create") return "";
  const rel = parentDisplay(dialog.parentAbsPath, projectPath);
  const noun = dialog.entryKind === "folder" ? "Folder name" : "File name";
  return rel === undefined ? `${noun} (relative to project root)` : `${noun} (in ${rel}/)`;
}

function createDialogPlaceholder(dialog: DialogState): string {
  if (dialog?.kind !== "create") return "";
  return dialog.entryKind === "folder" ? "utils" : "index.ts";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

type UploadFile = File & { uploadRelativePath?: string; webkitRelativePath?: string };

function hasTransferType(dataTransfer: DataTransfer, type: string): boolean {
  return Array.from(dataTransfer.types).some((candidate) => candidate === type);
}

interface FileSystemEntryLike {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

interface FileSystemFileEntryLike extends FileSystemEntryLike {
  isFile: true;
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
}

interface FileSystemDirectoryEntryLike extends FileSystemEntryLike {
  isDirectory: true;
  createReader: () => FileSystemDirectoryReaderLike;
}

interface FileSystemDirectoryReaderLike {
  readEntries: (
    success: (entries: FileSystemEntryLike[]) => void,
    failure?: (error: DOMException) => void,
  ) => void;
}

function getDataTransferEntry(item: DataTransferItem): FileSystemEntryLike | null {
  const withEntry = item as unknown as { webkitGetAsEntry?: () => FileSystemEntryLike | null };
  return withEntry.webkitGetAsEntry?.() ?? null;
}

async function collectDroppedUploadFiles(dataTransfer: DataTransfer): Promise<File[]> {
  const entries = Array.from(dataTransfer.items)
    .map((item) => getDataTransferEntry(item))
    .filter((entry): entry is FileSystemEntryLike => entry !== null);
  if (entries.length === 0) {
    return Array.from(dataTransfer.files).map((file) => withUploadRelativePath(file, file.name));
  }
  const files: File[] = [];
  for (const entry of entries) {
    await collectEntryFiles(entry, entry.name, files);
  }
  return files;
}

async function collectEntryFiles(
  entry: FileSystemEntryLike,
  relativePath: string,
  out: File[],
): Promise<void> {
  if (entry.isFile) {
    const file = await readFileEntry(entry as FileSystemFileEntryLike);
    out.push(withUploadRelativePath(file, relativePath));
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readDirectoryEntries(entry as FileSystemDirectoryEntryLike);
  await Promise.all(
    children.map((child) => collectEntryFiles(child, `${relativePath}/${child.name}`, out)),
  );
}

function readFileEntry(entry: FileSystemFileEntryLike): Promise<File> {
  return new Promise((resolveFile, reject) => entry.file(resolveFile, reject));
}

async function readDirectoryEntries(
  entry: FileSystemDirectoryEntryLike,
): Promise<FileSystemEntryLike[]> {
  const reader = entry.createReader();
  const all: FileSystemEntryLike[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolveEntries, reject) =>
      reader.readEntries(resolveEntries, reject),
    );
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function withUploadRelativePath(file: File, relativePath: string): File {
  const uploadFile = file as UploadFile;
  uploadFile.uploadRelativePath = relativePath;
  return uploadFile;
}

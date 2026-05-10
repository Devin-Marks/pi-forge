import { useState } from "react";
import { Plus, X, ChevronDown, ChevronRight } from "lucide-react";
import { useProjectStore } from "../store/project-store";
import { useSessionStore } from "../store/session-store";
import { ProjectPicker } from "./ProjectPicker";
import { SessionList } from "./SessionList";
import { Modal } from "./Modal";

export interface ProjectSidebarProps {
  /** Extra classes on the outer aside. Used by the App-level mobile
   *  drawer wrapper to layer in fixed-position transform classes
   *  without ProjectSidebar needing to know it's in a drawer. */
  className?: string;
}

export function ProjectSidebar({ className = "" }: ProjectSidebarProps = {}) {
  const projects = useProjectStore((s) => s.projects);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const collapsed = useProjectStore((s) => s.collapsed);
  const setActive = useProjectStore((s) => s.setActive);
  const toggleCollapsed = useProjectStore((s) => s.toggleCollapsed);
  const remove = useProjectStore((s) => s.remove);
  const rename = useProjectStore((s) => s.rename);
  const sessionsByProject = useSessionStore((s) => s.byProject);
  const createSession = useSessionStore((s) => s.createSession);

  /**
   * Create a new session under `projectId`. Mirrors the project-
   * switch-then-create dance that lived in SessionList: switching
   * the active project FIRST so the right pane (Files / Changes /
   * Git) lines up by the time the session is selected.
   */
  const handleNewSession = async (projectId: string): Promise<void> => {
    if (activeProjectId !== projectId) setActive(projectId);
    try {
      await createSession(projectId);
    } catch {
      // store.error surfaces — no UI noise here
    }
  };
  const [showPicker, setShowPicker] = useState(false);
  const [renamingId, setRenamingId] = useState<string | undefined>();
  const [renameValue, setRenameValue] = useState("");

  /**
   * Delete-project modal state. We track on-disk session count to
   * surface the cascade option only when there's something to clean
   * up — otherwise the checkbox would just be confusing.
   */
  const [deleteDialog, setDeleteDialog] = useState<
    { id: string; name: string; onDiskCount: number; cascade: boolean } | undefined
  >(undefined);

  /**
   * Two-stage delete confirm: if the project has live sessions, demand the
   * user dispose them first. Otherwise show the delete modal which offers
   * to cascade-delete the on-disk session JSONLs (default: NO, the safer
   * option — matches v1's "workspace dir is user-managed" framing).
   */
  const handleDelete = (id: string, name: string): void => {
    const list = sessionsByProject[id] ?? [];
    const liveCount = list.filter((s) => s.isLive).length;
    if (liveCount > 0) {
      alert(
        `Cannot delete "${name}" — it has ${liveCount} live session${liveCount === 1 ? "" : "s"}. ` +
          `Dispose ${liveCount === 1 ? "it" : "them"} first (× next to each session in the sidebar), then try again.`,
      );
      return;
    }
    // Count cold (on-disk-only) sessions: anything in the unified
    // list that isn't currently live. Live count is already 0 here.
    const onDiskCount = list.filter((s) => !s.isLive).length;
    setDeleteDialog({ id, name, onDiskCount, cascade: false });
  };

  const submitDelete = async (): Promise<void> => {
    if (deleteDialog === undefined) return;
    const { id, cascade } = deleteDialog;
    setDeleteDialog(undefined);
    void remove(id, { cascade });
  };

  const submitRename = async (id: string): Promise<void> => {
    const v = renameValue.trim();
    if (v.length === 0) {
      setRenamingId(undefined);
      return;
    }
    try {
      await rename(id, v);
    } finally {
      setRenamingId(undefined);
      setRenameValue("");
    }
  };

  return (
    <aside
      className={`flex h-full w-64 flex-col border-r border-neutral-800 bg-neutral-950 ${className}`}
      // Safe-area-aware top + bottom padding so the drawer chrome
      // (header, sessions list) doesn't slide under iPhone notches /
      // Android cutouts when the drawer is fullscreen-tall on
      // mobile. env() returns 0 on devices without insets, so this
      // is a no-op on desktop and on non-notched phones.
      style={{
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Projects
        </span>
        <button
          onClick={() => setShowPicker(true)}
          className="rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-800"
        >
          + New
        </button>
      </header>

      <div className="flex-1 overflow-y-auto py-1">
        {projects.length === 0 && (
          <p className="px-3 py-4 text-sm text-neutral-500">No projects yet.</p>
        )}
        {projects.map((p) => {
          const isActive = p.id === activeProjectId;
          const isCollapsed = collapsed[p.id] ?? false;
          return (
            <div key={p.id} className="mt-1 px-1">
              <div
                className={`group flex items-center gap-1 rounded-md px-2 py-1 text-sm ${
                  isActive
                    ? "bg-neutral-800 text-neutral-100"
                    : "text-neutral-300 hover:bg-neutral-900"
                }`}
              >
                <button
                  onClick={() => toggleCollapsed(p.id)}
                  className="flex items-center text-neutral-500 hover:text-neutral-300"
                  title={isCollapsed ? "Expand" : "Collapse"}
                >
                  {isCollapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                </button>
                {renamingId === p.id ? (
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onBlur={() => void submitRename(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitRename(p.id);
                      if (e.key === "Escape") setRenamingId(undefined);
                    }}
                    autoFocus
                    className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-sm"
                  />
                ) : (
                  <button
                    onClick={() => setActive(p.id)}
                    onDoubleClick={() => {
                      setRenamingId(p.id);
                      setRenameValue(p.name);
                    }}
                    className="flex min-w-0 flex-1 flex-col items-start text-left leading-tight"
                    title={p.path}
                  >
                    <span className="w-full truncate">{p.name}</span>
                    {/* Folder basename below the display name. Distinct
                        font (mono) and tone (neutral-500) so it reads as
                        metadata, not part of the name. Useful when the
                        display name doesn't match the on-disk folder
                        (e.g. user renamed the project to something
                        memorable but is debugging which checkout it
                        points at). Hover the row to see the full path
                        — that's still in the title attribute above. */}
                    <span className="w-full truncate font-mono text-[10px] text-neutral-500">
                      {folderName(p.path)}
                    </span>
                  </button>
                )}
                <button
                  onClick={() => void handleNewSession(p.id)}
                  className="inline-flex p-1 text-neutral-500 hover:text-neutral-200"
                  title="New session in this project"
                >
                  <Plus size={16} />
                </button>
                <button
                  onClick={() => handleDelete(p.id, p.name)}
                  className="inline-flex items-center p-1 text-neutral-500 hover:text-red-400"
                  title="Delete project (blocked while live sessions exist)"
                >
                  <X size={16} />
                </button>
              </div>
              {!isCollapsed && <SessionList projectId={p.id} />}
            </div>
          );
        })}
      </div>

      {showPicker && <ProjectPicker onClose={() => setShowPicker(false)} />}
      <Modal
        open={deleteDialog !== undefined}
        onClose={() => setDeleteDialog(undefined)}
        title={
          deleteDialog !== undefined ? `Delete project "${deleteDialog.name}"` : "Delete project"
        }
      >
        {deleteDialog !== undefined && (
          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="text-xs text-neutral-300">
              Remove "{deleteDialog.name}" from the pi-forge. The project folder on disk is{" "}
              <strong>not</strong> deleted; only the pi-forge's record of it goes away.
            </p>
            {deleteDialog.onDiskCount > 0 && (
              <label className="flex items-start gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1.5 text-xs text-neutral-300">
                <input
                  type="checkbox"
                  checked={deleteDialog.cascade}
                  onChange={(e) =>
                    setDeleteDialog((d) =>
                      d === undefined ? d : { ...d, cascade: e.target.checked },
                    )
                  }
                  className="mt-0.5 h-3 w-3"
                />
                <span>
                  Also delete {deleteDialog.onDiskCount} on-disk session file
                  {deleteDialog.onDiskCount === 1 ? "" : "s"} (under{" "}
                  <code className="font-mono text-[10px] text-neutral-400">
                    .pi/sessions/{deleteDialog.id}/
                  </code>
                  ). Without this, the JSONLs stay on disk and become orphaned — recoverable but not
                  reachable through the pi-forge.
                </span>
              </label>
            )}
            {deleteDialog.onDiskCount === 0 && (
              <p className="text-[11px] italic text-neutral-500">
                No on-disk sessions for this project; nothing to clean up beyond the project record.
              </p>
            )}
            <footer className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setDeleteDialog(undefined)}
                className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void submitDelete()}
                className="rounded-md bg-red-700 px-3 py-1 text-xs font-medium text-red-50 hover:bg-red-600"
              >
                Delete
              </button>
            </footer>
          </div>
        )}
      </Modal>
    </aside>
  );
}

/**
 * Strip everything but the last path segment so the project row can
 * show "the folder name" as a sub-label under the display name. Both
 * `/` and `\` are accepted so Windows-form paths (which the project
 * store could in principle produce) don't fall through to showing the
 * whole absolute path. Trailing-separator and empty-string defenses
 * are belt-and-suspenders — `project-manager` realpaths every project
 * path before storage, so the result should always have at least one
 * segment.
 */
function folderName(absPath: string): string {
  const parts = absPath.split(/[/\\]/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? absPath;
}

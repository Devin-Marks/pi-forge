import { useEffect, useState } from "react";
import { api, ApiError, type BrowseEntry } from "../lib/api-client";
import { useProjectStore } from "../store/project-store";
import { useUiConfigStore } from "../store/ui-config-store";

interface Props {
  onClose: () => void;
  /** When true, the picker cannot be dismissed without creating a project. */
  required?: boolean;
}

type Step = "name" | "browse";

export function ProjectPicker({ onClose, required = false }: Props) {
  const create = useProjectStore((s) => s.create);
  const minimal = useUiConfigStore((s) => s.minimal);
  const workspaceRoot = useUiConfigStore((s) => s.workspaceRoot);
  const [step, setStep] = useState<Step>("name");
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const [path, setPath] = useState<string | undefined>();
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [loadingBrowse, setLoadingBrowse] = useState(false);
  const [newFolderInput, setNewFolderInput] = useState("");
  const [showNewFolder, setShowNewFolder] = useState(false);

  useEffect(() => {
    if (step !== "browse") return;
    let cancelled = false;
    setLoadingBrowse(true);
    setError(undefined);
    api
      .browse(path)
      .then((res) => {
        if (cancelled) return;
        setPath(res.path);
        setParentPath(res.parentPath);
        setEntries(res.entries);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.code : (err as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoadingBrowse(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, path]);

  /**
   * Default flow: take the typed name, advance to the folder
   * browser, let the user pick or create a destination dir.
   * Minimal flow (`MINIMAL_UI=1`): skip browsing entirely — mkdir
   * `<workspaceRoot>/<name>` and use it as the project path. The
   * server's mkdir route already 409s on conflict, which we surface
   * as a normal error code on the form.
   */
  const onSubmitName = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    if (!minimal) {
      setStep("browse");
      return;
    }
    if (workspaceRoot.length === 0) {
      // ui-config hasn't loaded yet (rare — load fires in App).
      // Surface the error rather than silently doing nothing.
      setError("workspace_not_loaded");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      const { path: created } = await api.mkdir(workspaceRoot, trimmed);
      await create(trimmed, created);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
      setSubmitting(false);
    }
  };

  const select = async (selected: string): Promise<void> => {
    if (submitting) return;
    // Refuse the workspace root itself as a project folder. pi-forge
    // expects each project to be a sub-tree of WORKSPACE_PATH; the
    // root is the boundary, not a project. Picking it would let the
    // agent see every other project's files in one session.
    if (workspaceRoot.length > 0 && selected === workspaceRoot) {
      setError("workspace_root_not_allowed");
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await create(name.trim(), selected);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
      setSubmitting(false);
    }
  };

  const goUp = (): void => {
    if (parentPath !== null) setPath(parentPath);
  };

  const createFolder = async (): Promise<void> => {
    if (!path || newFolderInput.trim().length === 0) return;
    setError(undefined);
    try {
      const { path: created } = await api.mkdir(path, newFolderInput.trim());
      setNewFolderInput("");
      setShowNewFolder(false);
      await select(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-lg rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-xl">
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">
            {step === "name" ? "New project" : `Pick a folder for "${name.trim()}"`}
          </h2>
          {!required && (
            <button
              onClick={onClose}
              className="rounded-md px-2 py-1 text-sm text-neutral-400 hover:bg-neutral-800"
            >
              Cancel
            </button>
          )}
        </header>

        {step === "name" && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void onSubmitName();
            }}
            className="space-y-4"
          >
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-neutral-300">Project name</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
              />
              {minimal && workspaceRoot.length > 0 && (
                <span className="block font-mono text-[11px] text-neutral-500">
                  Will create {workspaceRoot}/{name.trim().length > 0 ? name.trim() : "<name>"}
                </span>
              )}
            </label>
            {error !== undefined && (
              <p className="text-xs text-red-400 light:text-red-700">Error: {error}</p>
            )}
            <button
              type="submit"
              disabled={name.trim().length === 0 || submitting}
              className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
            >
              {minimal ? (submitting ? "Creating…" : "Create project") : "Next: pick folder"}
            </button>
          </form>
        )}

        {step === "browse" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-xs text-neutral-400">
              <button
                onClick={goUp}
                disabled={parentPath === null}
                className="rounded-md border border-neutral-700 px-2 py-1 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
                title={parentPath === null ? "At workspace root" : "Up one folder"}
              >
                ↑ up
              </button>
              <code className="truncate font-mono text-neutral-300">{path ?? "(loading)"}</code>
            </div>
            <div className="max-h-64 overflow-y-auto rounded-md border border-neutral-800 bg-neutral-950">
              {loadingBrowse && <div className="px-3 py-2 text-sm text-neutral-400">Loading…</div>}
              {!loadingBrowse && entries.length === 0 && (
                <div className="px-3 py-2 text-sm text-neutral-400">(empty)</div>
              )}
              {!loadingBrowse &&
                entries.map((e) => (
                  <div
                    key={e.path}
                    className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2 text-sm last:border-b-0"
                  >
                    <button
                      onClick={() => setPath(e.path)}
                      className="flex flex-1 items-center gap-2 text-left text-neutral-200 hover:text-white"
                    >
                      <span>📁</span>
                      <span className="truncate">{e.name}</span>
                      {e.isGitRepo && (
                        <span className="rounded-sm bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-neutral-300">
                          git
                        </span>
                      )}
                    </button>
                    <button
                      onClick={() => void select(e.path)}
                      disabled={submitting}
                      className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800 disabled:opacity-50"
                    >
                      Select
                    </button>
                  </div>
                ))}
            </div>

            {showNewFolder ? (
              <div className="flex gap-2">
                <input
                  value={newFolderInput}
                  onChange={(e) => setNewFolderInput(e.target.value)}
                  placeholder="folder name"
                  className="flex-1 rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm"
                  autoFocus
                />
                <button
                  onClick={() => void createFolder()}
                  className="rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900"
                >
                  Create + select
                </button>
                <button
                  onClick={() => {
                    setShowNewFolder(false);
                    setNewFolderInput("");
                  }}
                  className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex justify-between gap-2">
                <button
                  onClick={() => setStep("name")}
                  className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300"
                >
                  ← Back
                </button>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowNewFolder(true)}
                    className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300"
                  >
                    + New folder
                  </button>
                  <button
                    onClick={() => path && void select(path)}
                    disabled={
                      !path || submitting || (workspaceRoot.length > 0 && path === workspaceRoot)
                    }
                    className="rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
                    title={
                      workspaceRoot.length > 0 && path === workspaceRoot
                        ? "Pick a sub-folder — the workspace root itself can't be a project."
                        : "Use this folder as the project root"
                    }
                  >
                    Select this folder
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {error !== undefined && (
          <p className="mt-3 text-sm text-red-400 light:text-red-700">
            {error === "path_not_allowed"
              ? "That folder is outside the workspace root."
              : error === "workspace_root_not_allowed"
                ? "Pick a sub-folder — the workspace root itself can't be a project."
                : error === "not_a_directory"
                  ? "That path is not a directory."
                  : error === "already_exists"
                    ? "A folder with that name already exists."
                    : error === "duplicate_path"
                      ? "Another project already points at that folder."
                      : error === "network_error"
                        ? "Couldn't reach the server."
                        : `Error: ${error}`}
          </p>
        )}
      </div>
    </div>
  );
}

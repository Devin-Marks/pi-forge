import { useEffect, useRef, useState } from "react";
import {
  Check,
  Columns2,
  GitBranch,
  GitCommit,
  Minus,
  Plus,
  RefreshCw,
  Rows2,
  Trash2,
  Undo2,
  Upload,
} from "lucide-react";
import {
  api,
  ApiError,
  type GitFileStatus,
  type GitLogEntry,
  type GitBranch as GitBranchEntry,
  type GitRemote,
  type GitWorktree,
} from "../lib/api-client";
import { useActiveProject } from "../store/project-store";
import { useGitStatus } from "../hooks/useGitStatus";
import { DiffBlock } from "./DiffBlock";
import { ConfirmDialog, Modal, PromptDialog } from "./Modal";
import { laneColor, layoutCommits, type CommitLayout } from "../lib/git-graph";

/**
 * Right-pane Git tab. Sections, top-to-bottom:
 *
 *   - Header: current branch, refresh button.
 *   - Status: files grouped Staged / Unstaged / Untracked, checkbox
 *     to flip stage state, click row to expand inline diff.
 *   - Commit: message textarea + Commit button. Disabled when nothing
 *     is staged.
 *   - Push: Push button. Surfaces git's stderr verbatim on failure
 *     (no upstream, auth refused, non-fast-forward, etc.).
 *   - Log: collapsible list of recent commits (lazy-loaded on first
 *     expand to keep the initial render cheap).
 *   - Branches: collapsible list (lazy-loaded the same way).
 *
 * Polls `GET /git/status` every 15s via `useGitStatus` (pauses while
 * the active session is streaming).
 */
export function GitPanel() {
  const project = useActiveProject();
  const projectId = project?.id;
  const [worktrees, setWorktrees] = useState<GitWorktree[] | undefined>(undefined);
  const [selectedWorktreePath, setSelectedWorktreePath] = useState<string | undefined>(undefined);
  const { status, error: statusError, refresh } = useGitStatus(projectId, selectedWorktreePath);

  const [commitMessage, setCommitMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [opError, setOpError] = useState<string | undefined>(undefined);
  const [opResult, setOpResult] = useState<string | undefined>(undefined);

  // Lazily-loaded log + branches.
  const [log, setLog] = useState<GitLogEntry[] | undefined>(undefined);
  const [branches, setBranches] = useState<GitBranchEntry[] | undefined>(undefined);
  const [remotes, setRemotes] = useState<GitRemote[] | undefined>(undefined);
  const [showLog, setShowLog] = useState(false);
  const [showBranches, setShowBranches] = useState(false);
  const [showRemotes, setShowRemotes] = useState(false);
  // Pending-branch-op state. `branchBusy` blocks duplicate clicks on
  // the per-row buttons; `branchDialog` drives the create / delete
  // confirmation modals.
  const [branchBusy, setBranchBusy] = useState<string | undefined>(undefined);
  const [branchDialog, setBranchDialog] = useState<
    { kind: "create" } | { kind: "delete"; name: string } | undefined
  >(undefined);

  // Remote-add modal state. PromptDialog only takes one input, so a
  // "name + url" form lives in its own modal below. Per-row delete
  // uses ConfirmDialog (danger tone) — different state field so the
  // two modals don't share a discriminator.
  const [remoteBusy, setRemoteBusy] = useState<string | undefined>(undefined);
  const [showAddRemote, setShowAddRemote] = useState(false);
  const [newRemoteName, setNewRemoteName] = useState("");
  const [newRemoteUrl, setNewRemoteUrl] = useState("");
  const [newRemoteInsecureTls, setNewRemoteInsecureTls] = useState(false);
  const [removeRemoteName, setRemoveRemoteName] = useState<string | undefined>(undefined);

  const reloadRemotes = async (): Promise<void> => {
    if (project === undefined) return;
    try {
      const r = await api.gitRemotes(project.id, selectedWorktreePath);
      setRemotes(r.remotes);
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  const handleAddRemote = async (): Promise<void> => {
    if (project === undefined) return;
    const name = newRemoteName.trim();
    const url = newRemoteUrl.trim();
    if (name.length === 0 || url.length === 0) return;
    setRemoteBusy(name);
    setOpError(undefined);
    try {
      const opts: { insecureTls: boolean; worktreePath?: string } = {
        insecureTls: newRemoteInsecureTls,
      };
      if (selectedWorktreePath !== undefined) opts.worktreePath = selectedWorktreePath;
      await api.gitRemoteAdd(project.id, name, url, opts);
      setShowAddRemote(false);
      setNewRemoteName("");
      setNewRemoteUrl("");
      setNewRemoteInsecureTls(false);
      await reloadRemotes();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message || err.code : (err as Error).message);
    } finally {
      setRemoteBusy(undefined);
    }
  };

  const handleToggleRemoteTls = async (name: string, insecureTls: boolean): Promise<void> => {
    if (project === undefined) return;
    setRemoteBusy(name);
    setOpError(undefined);
    try {
      await api.gitRemoteSetInsecureTls(project.id, name, insecureTls, selectedWorktreePath);
      await reloadRemotes();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message || err.code : (err as Error).message);
    } finally {
      setRemoteBusy(undefined);
    }
  };

  const handleRemoveRemote = async (): Promise<void> => {
    if (project === undefined || removeRemoteName === undefined) return;
    const name = removeRemoteName;
    setRemoveRemoteName(undefined);
    setRemoteBusy(name);
    setOpError(undefined);
    try {
      await api.gitRemoteRemove(project.id, name, selectedWorktreePath);
      await reloadRemotes();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message || err.code : (err as Error).message);
    } finally {
      setRemoteBusy(undefined);
    }
  };

  const reloadBranches = async (): Promise<void> => {
    if (project === undefined) return;
    try {
      const r = await api.gitBranches(project.id, selectedWorktreePath);
      setBranches(r.branches);
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  const handleCheckout = async (branch: string): Promise<void> => {
    if (project === undefined) return;
    setBranchBusy(branch);
    setOpError(undefined);
    try {
      await api.gitCheckout(project.id, branch, selectedWorktreePath);
      await reloadBranches();
      void refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBranchBusy(undefined);
    }
  };

  const handleCreateBranch = async (name: string): Promise<void> => {
    if (project === undefined) return;
    setBranchDialog(undefined);
    setBranchBusy(name);
    setOpError(undefined);
    try {
      // Create + checkout in one step — matches what most UIs do
      // when the user clicks "New branch" while looking at the
      // branches panel.
      const opts: { checkout: true; worktreePath?: string } = { checkout: true };
      if (selectedWorktreePath !== undefined) opts.worktreePath = selectedWorktreePath;
      await api.gitBranchCreate(project.id, name, opts);
      await reloadBranches();
      void refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBranchBusy(undefined);
    }
  };

  const handleDeleteBranch = async (force: boolean): Promise<void> => {
    if (project === undefined || branchDialog?.kind !== "delete") return;
    const { name } = branchDialog;
    setBranchDialog(undefined);
    setBranchBusy(name);
    setOpError(undefined);
    try {
      await api.gitBranchDelete(project.id, name, force, selectedWorktreePath);
      await reloadBranches();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.code : (err as Error).message);
    } finally {
      setBranchBusy(undefined);
    }
  };

  // Per-file diff cache. Keyed by `<path>|<staged>` so toggling
  // staged status swaps the rendered diff cleanly.
  const [openDiffs, setOpenDiffs] = useState<Record<string, string | "loading" | "error">>({});
  // Path of the file whose hunk-level apply is in flight. Hoisted
  // above any early return for the rules-of-hooks check (matches the
  // pattern used by the push-form state below).
  const [pendingHunkPath, setPendingHunkPath] = useState<string | undefined>(undefined);

  // Push form state — has to live above the early returns to keep
  // hook order stable. `pushRemote === undefined` means "use the
  // configured upstream"; explicit "origin"/etc. switches to a
  // positional `git push <remote>`. `pushBranchOverride` likewise
  // defaults to the current branch. Both are advanced affordances —
  // most users hit Push and never expand the form.
  const [pushRemote, setPushRemote] = useState<string | undefined>(undefined);
  const [pushBranchOverride, setPushBranchOverride] = useState("");
  const [pushSetUpstream, setPushSetUpstream] = useState(false);
  const [showPushOptions, setShowPushOptions] = useState(false);

  // Per-panel diff view-type preference. Each diff-rendering panel
  // owns its own setting — the TurnDiffPanel and GitPanel choices
  // are independent (a user might want side-by-side for git diffs
  // they're committing but unified for the per-turn agent activity).
  const [diffViewType, setDiffViewType] = useState<"unified" | "split">(() => {
    try {
      return localStorage.getItem("forge.gitPanel.viewType") === "split" ? "split" : "unified";
    } catch {
      // Private-mode storage — fall back to the default unified view.
      return "unified";
    }
  });
  const setAndPersistDiffView = (next: "unified" | "split"): void => {
    setDiffViewType(next);
    try {
      localStorage.setItem("forge.gitPanel.viewType", next);
    } catch {
      // ignore — choice still applies for this session
    }
  };

  useEffect(() => {
    setWorktrees(undefined);
    setSelectedWorktreePath(undefined);
    setLog(undefined);
    setBranches(undefined);
    setRemotes(undefined);
    setOpenDiffs({});
    if (projectId === undefined) return;
    void api
      .gitWorktrees(projectId)
      .then((r) => {
        setWorktrees(r.worktrees);
        const current = r.worktrees.find((w) => w.current) ?? r.worktrees[0];
        setSelectedWorktreePath(current?.path);
      })
      .catch((err: unknown) =>
        setOpError(err instanceof ApiError ? err.code : (err as Error).message),
      );
  }, [projectId]);

  useEffect(() => {
    setLog(undefined);
    setBranches(undefined);
    setRemotes(undefined);
    setOpenDiffs({});
    setOpResult(undefined);
    setOpError(undefined);
  }, [selectedWorktreePath]);

  // Prune diff cache entries whose file is no longer in the latest
  // status (e.g. user ran `git checkout -- file` from the integrated
  // terminal). Without this, the diff card stayed open with stale
  // content. We compare path-only because either staged side counts
  // as "still around".
  useEffect(() => {
    if (status === undefined) return;
    const livePaths = new Set(status.files.map((f) => f.path));
    setOpenDiffs((prev) => {
      let changed = false;
      const next: typeof prev = {};
      for (const [key, value] of Object.entries(prev)) {
        const path = key.split("|")[0] ?? "";
        if (livePaths.has(path)) {
          next[key] = value;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [status]);

  // Load lazily on first expand. Refresh on subsequent project
  // switches if the user happens to leave the section open.
  useEffect(() => {
    if (showLog && project !== undefined) {
      void api
        .gitLog(project.id, 30)
        .then((r) => setLog(r.commits))
        .catch((err: unknown) =>
          setOpError(err instanceof ApiError ? err.code : (err as Error).message),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLog, project?.id]);

  useEffect(() => {
    if (showBranches && project !== undefined) {
      void api
        .gitBranches(project.id)
        .then((r) => setBranches(r.branches))
        .catch((err: unknown) =>
          setOpError(err instanceof ApiError ? err.code : (err as Error).message),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBranches, project?.id]);

  useEffect(() => {
    if (showRemotes && project !== undefined) {
      void api
        .gitRemotes(project.id)
        .then((r) => setRemotes(r.remotes))
        .catch((err: unknown) =>
          setOpError(err instanceof ApiError ? err.code : (err as Error).message),
        );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showRemotes, project?.id]);

  if (project === undefined) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-xs italic text-neutral-500">
        Pick a project to see its git status.
      </div>
    );
  }

  if (status?.isGitRepo === false) {
    const handleInit = async (): Promise<void> => {
      setBusy(true);
      setOpError(undefined);
      try {
        await api.gitInit(project.id);
        // Re-poll status so the panel flips out of the empty-state
        // branch into the normal Staged / Unstaged layout. Branch
        // will read "main" — that's git init -b main behaviour.
        await refresh();
      } catch (err) {
        setOpError(err instanceof ApiError ? err.code : (err as Error).message);
      } finally {
        setBusy(false);
      }
    };
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center text-xs text-neutral-500">
        <p className="italic">{project.name} isn't a git repository.</p>
        <button
          onClick={() => void handleInit()}
          disabled={busy}
          className="rounded-md bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"
          title="Run `git init -b main` in the project root"
        >
          {busy ? "Initializing…" : "Initialize git repo"}
        </button>
        <p className="text-[10px] text-neutral-600">
          Default branch will be <code className="font-mono text-neutral-400">main</code>.
        </p>
        {opError !== undefined && (
          <p className="text-[10px] text-red-400 light:text-red-700">git init failed: {opError}</p>
        )}
      </div>
    );
  }

  const stagedFiles = status?.files.filter((f) => f.staged) ?? [];
  // A partially-staged file (porcelain `MM` — some hunks staged, some
  // not) MUST appear in BOTH Staged and Unstaged groups so the user
  // can keep adding hunks. Earlier this filter had `&& !f.staged`,
  // which hid the file from Unstaged the moment its first hunk was
  // staged — blocking access to remaining hunks. Untracked files have
  // both flags false, so they're naturally excluded here and only
  // appear in the dedicated Untracked group below.
  const unstagedFiles = status?.files.filter((f) => f.unstaged) ?? [];
  const untrackedFiles = status?.files.filter((f) => f.kind === "untracked") ?? [];

  const toggleDiff = async (file: GitFileStatus, staged: boolean): Promise<void> => {
    const key = `${file.path}|${staged ? "staged" : "unstaged"}`;
    if (openDiffs[key] !== undefined) {
      setOpenDiffs((s) => {
        const next = { ...s };
        delete next[key];
        return next;
      });
      return;
    }
    setOpenDiffs((s) => ({ ...s, [key]: "loading" }));
    try {
      const r = await api.gitDiffFile(project.id, file.path, staged, selectedWorktreePath);
      setOpenDiffs((s) => ({ ...s, [key]: r.diff }));
    } catch {
      // Diff fetch failed (file vanished, git error). State machine
      // shows a "(failed to load)" placeholder; user can re-open the
      // file to retry.
      setOpenDiffs((s) => ({ ...s, [key]: "error" }));
    }
  };

  const stage = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    try {
      await api.gitStage(project.id, paths, selectedWorktreePath);
      await refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Revert (discard local changes). Wired through to
  // `git restore --staged --worktree --source=HEAD` server-side.
  // Untracked files are filtered out client-side because git
  // refuses them; the panel doesn't render the button for them
  // (see FileGroup below).
  const revert = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      await api.gitRevert(project.id, paths, selectedWorktreePath);
      setOpResult(paths.length === 1 ? `Reverted ${paths[0]}` : `Reverted ${paths.length} files`);
      await refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const unstage = async (paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    try {
      await api.gitUnstage(project.id, paths, selectedWorktreePath);
      await refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Per-hunk stage / unstage. The button in DiffBlock fires this with
  // the file + the hunk's 0-based index within the file's CURRENT diff
  // (server-side fetch). After the apply we refetch the diff so the
  // panel reflects the new state — and refresh status so the file's
  // staged/unstaged grouping updates if the apply consumed the last
  // hunk on a side. (`pendingHunkPath` state is hoisted above early
  // returns at the top of the component for rules-of-hooks.)
  const applyHunk = async (
    file: GitFileStatus,
    hunkIndex: number,
    mode: "stage" | "unstage",
  ): Promise<void> => {
    setPendingHunkPath(file.path);
    setOpError(undefined);
    try {
      const r = await api.gitApplyHunks(
        project.id,
        file.path,
        mode,
        [hunkIndex],
        selectedWorktreePath,
      );
      if (r.ok !== true) {
        // Surface the server's error code as the op-error banner so
        // the user sees "binary_or_no_hunks" / "git_apply_failed" /
        // etc. The panel's existing banner is the right surface for
        // these — they're file-level diagnostics, not toasts.
        setOpError(`Hunk apply failed: ${r.error ?? "unknown_error"}`);
        return;
      }
      // Refetch BOTH sides of the diff for this file so the inline
      // expanded sections update if the user has them open. Then
      // refresh status so the file moves between groups when its
      // last hunk on one side gets applied.
      await Promise.all([refetchOpenDiff(file, true), refetchOpenDiff(file, false), refresh()]);
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setPendingHunkPath(undefined);
    }
  };
  const refetchOpenDiff = async (file: GitFileStatus, staged: boolean): Promise<void> => {
    const key = `${file.path}|${staged ? "staged" : "unstaged"}`;
    if (openDiffs[key] === undefined) return; // not currently shown — skip
    setOpenDiffs((s) => ({ ...s, [key]: "loading" }));
    try {
      const r = await api.gitDiffFile(project.id, file.path, staged, selectedWorktreePath);
      setOpenDiffs((s) => {
        // Empty diff after an apply means "no more changes on this side";
        // drop the key so the inline section collapses naturally.
        if (r.diff.length === 0) {
          const next = { ...s };
          delete next[key];
          return next;
        }
        return { ...s, [key]: r.diff };
      });
    } catch {
      setOpenDiffs((s) => ({ ...s, [key]: "error" }));
    }
  };

  const commit = async (): Promise<void> => {
    const msg = commitMessage.trim();
    if (msg.length === 0) return;
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      const { hash } = await api.gitCommit(project.id, msg, selectedWorktreePath);
      setCommitMessage("");
      setOpResult(`Committed ${hash.slice(0, 7)}`);
      await refresh();
      // Refresh log if the section is open so the new commit shows up.
      if (showLog) {
        const r = await api.gitLog(project.id, 30, selectedWorktreePath);
        setLog(r.commits);
      }
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Distinct remote names for the Push/Fetch/Pull dropdown. Prefer
  // the explicit Remotes-section data when loaded; fall back to
  // parsing the branches list for `<remote>/<branch>` prefixes when
  // remotes haven't been fetched yet (branches typically load first
  // when the user expands a different section).
  const knownRemotes = (() => {
    if (remotes !== undefined) {
      return remotes.map((r) => r.name).sort();
    }
    if (branches === undefined) return [] as string[];
    const set = new Set<string>();
    for (const b of branches) {
      if (!b.remote) continue;
      const slash = b.name.indexOf("/");
      if (slash > 0) set.add(b.name.slice(0, slash));
    }
    return Array.from(set).sort();
  })();

  // Local branch names for the Branch override dropdown.
  const knownLocalBranches = (() => {
    if (branches === undefined) return [] as string[];
    return branches
      .filter((b) => !b.remote)
      .map((b) => b.name)
      .sort();
  })();

  const handleFetch = async (): Promise<void> => {
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      const opts: { remote?: string; worktreePath?: string } = {};
      if (pushRemote !== undefined) opts.remote = pushRemote;
      if (selectedWorktreePath !== undefined) opts.worktreePath = selectedWorktreePath;
      const { output } = await api.gitFetch(project.id, opts);
      setOpResult(
        output.trim().length > 0 ? (output.trim().split("\n").pop() ?? "Fetched") : "Fetched",
      );
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handlePull = async (): Promise<void> => {
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      const opts: { remote?: string; branch?: string; worktreePath?: string } = {};
      if (pushRemote !== undefined) opts.remote = pushRemote;
      const overrideName = pushBranchOverride.trim();
      if (overrideName.length > 0) opts.branch = overrideName;
      if (selectedWorktreePath !== undefined) opts.worktreePath = selectedWorktreePath;
      const { output } = await api.gitPull(project.id, opts);
      setOpResult(
        output.trim().length > 0 ? (output.trim().split("\n").pop() ?? "Pulled") : "Pulled",
      );
      // Pull can change the working tree; refresh status so the panel
      // reflects the new state without waiting for the 5s poll.
      void refresh();
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const handlePush = async (): Promise<void> => {
    setBusy(true);
    setOpError(undefined);
    setOpResult(undefined);
    try {
      const opts: {
        remote?: string;
        branch?: string;
        setUpstream?: boolean;
        worktreePath?: string;
      } = {};
      if (pushRemote !== undefined) opts.remote = pushRemote;
      const overrideName = pushBranchOverride.trim();
      if (overrideName.length > 0) opts.branch = overrideName;
      if (pushSetUpstream) opts.setUpstream = true;
      if (selectedWorktreePath !== undefined) opts.worktreePath = selectedWorktreePath;
      const { output } = await api.gitPush(project.id, opts);
      setOpResult(
        output.trim().length > 0 ? (output.trim().split("\n").pop() ?? "Pushed") : "Pushed",
      );
      // Set-upstream is a one-shot: the remote ref is now tracked,
      // so future pushes don't need the flag. Auto-clear so the
      // user doesn't keep re-sending --set-upstream by accident.
      if (pushSetUpstream) setPushSetUpstream(false);
    } catch (err) {
      setOpError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const worktreeLabel = (w: GitWorktree): string => {
    const dirname = w.path.split(/[\\/]/).filter(Boolean).pop() ?? w.path;
    if (w.branch !== undefined) return `${w.branch} — ${dirname}`;
    if (w.detached && w.head !== undefined) return `${w.head.slice(0, 7)} — ${dirname}`;
    return dirname;
  };

  return (
    <div className="flex h-full flex-col text-xs text-neutral-300">
      <div className="flex items-center justify-between gap-2 border-b border-neutral-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 font-medium text-neutral-200">
            <GitBranch size={13} className="shrink-0" />
            <span className="truncate">{status?.branch ?? "—"}</span>
            {status !== undefined && status.files.length > 0 && (
              <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-400">
                {status.files.length}
              </span>
            )}
          </div>
          <label className="mt-1 flex items-center gap-1.5 text-[10px] text-neutral-500">
            <span className="shrink-0 uppercase tracking-wider">Worktree</span>
            <select
              value={selectedWorktreePath ?? ""}
              onChange={(e) => setSelectedWorktreePath(e.target.value || undefined)}
              disabled={worktrees === undefined || worktrees.length <= 1}
              className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-1.5 py-0.5 text-[10px] text-neutral-200 outline-none hover:border-neutral-600 focus:border-neutral-500 disabled:cursor-not-allowed disabled:border-neutral-800 disabled:text-neutral-500"
              title={
                selectedWorktreePath !== undefined
                  ? `Viewing git info for ${selectedWorktreePath}`
                  : "Loading git worktrees"
              }
            >
              {worktrees === undefined ? (
                <option value="">Loading…</option>
              ) : worktrees.length === 0 ? (
                <option value="">No worktrees</option>
              ) : (
                worktrees.map((w) => (
                  <option key={w.path} value={w.path}>
                    {worktreeLabel(w)}
                  </option>
                ))
              )}
            </select>
          </label>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            onClick={() => setAndPersistDiffView(diffViewType === "split" ? "unified" : "split")}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title={
              diffViewType === "split"
                ? "Switch git diffs to unified view"
                : "Switch git diffs to side-by-side view"
            }
          >
            {diffViewType === "split" ? <Rows2 size={13} /> : <Columns2 size={13} />}
          </button>
          <button
            onClick={() => void refresh()}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Refresh"
          >
            <RefreshCw size={13} className={busy ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {(statusError !== undefined || opError !== undefined) && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300 light:border-red-300 light:bg-red-50 light:text-red-700">
          {opError ?? statusError}
        </div>
      )}
      {opResult !== undefined && (
        <div className="border-b border-emerald-700/40 bg-emerald-900/20 px-3 py-1.5 text-[11px] text-emerald-300 light:border-emerald-300 light:bg-emerald-50 light:text-emerald-800">
          {opResult}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {status === undefined && <p className="px-3 py-3 italic text-neutral-500">Loading…</p>}

        {status?.files.length === 0 && (
          <p className="px-3 py-3 italic text-neutral-500">Working tree clean.</p>
        )}

        {stagedFiles.length > 0 && (
          <FileGroup
            label="Staged"
            files={stagedFiles}
            actionLabel="Unstage all"
            onGroupAction={() => void unstage(stagedFiles.map((f) => f.path))}
            onFileAction={(f) => void unstage([f.path])}
            fileActionLabel="Unstage"
            onRevert={(f) => void revert([f.path])}
            onClickFile={(f) => void toggleDiff(f, true)}
            openDiffs={openDiffs}
            staged
            diffViewType={diffViewType}
            onHunkAction={(f, idx) => void applyHunk(f, idx, "unstage")}
            pendingHunkPath={pendingHunkPath}
          />
        )}
        {unstagedFiles.length > 0 && (
          <FileGroup
            label="Unstaged"
            files={unstagedFiles}
            actionLabel="Stage all"
            onGroupAction={() => void stage(unstagedFiles.map((f) => f.path))}
            onFileAction={(f) => void stage([f.path])}
            fileActionLabel="Stage"
            onRevert={(f) => void revert([f.path])}
            onClickFile={(f) => void toggleDiff(f, false)}
            openDiffs={openDiffs}
            staged={false}
            diffViewType={diffViewType}
            onHunkAction={(f, idx) => void applyHunk(f, idx, "stage")}
            pendingHunkPath={pendingHunkPath}
          />
        )}
        {untrackedFiles.length > 0 && (
          <FileGroup
            label="Untracked"
            files={untrackedFiles}
            actionLabel="Stage all"
            onGroupAction={() => void stage(untrackedFiles.map((f) => f.path))}
            onFileAction={(f) => void stage([f.path])}
            fileActionLabel="Stage"
            // Untracked files can't be reverted (git refuses; they
            // weren't in HEAD). Pass undefined so the row hides
            // the revert button — user should delete via the file
            // browser instead.
            onRevert={undefined}
            onClickFile={(f) => void toggleDiff(f, false)}
            openDiffs={openDiffs}
            staged={false}
            diffViewType={diffViewType}
            // No per-hunk action for untracked files: `git apply
            // --cached` against an unknown path errors. File-level
            // Stage already covers the use case (untracked = single
            // "all-add" hunk anyway).
          />
        )}

        {/* Commit section — disabled while nothing's staged. */}
        <div className="border-t border-neutral-800/60 px-3 py-3">
          <div className="mb-1 flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-500">
            <GitCommit size={10} /> Commit
          </div>
          <textarea
            value={commitMessage}
            onChange={(e) => setCommitMessage(e.target.value)}
            placeholder="Commit message…"
            rows={3}
            className="w-full resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 outline-none focus:border-neutral-500"
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span className="text-[10px] text-neutral-500">{stagedFiles.length} staged</span>
            <button
              onClick={() => void commit()}
              disabled={busy || stagedFiles.length === 0 || commitMessage.trim().length === 0}
              className="rounded bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Commit
            </button>
          </div>
        </div>

        {/* Push section. */}
        <div className="border-t border-neutral-800/60 px-3 py-3">
          <div className="mb-1 flex items-center justify-between gap-1 text-[10px] uppercase tracking-wider text-neutral-500">
            <span className="flex items-center gap-1">
              <Upload size={10} /> Push
            </span>
            <button
              onClick={() => {
                setShowPushOptions((v) => !v);
                // Lazy-load branches + remotes the first time the
                // user opens push options. Both feed the dropdowns
                // below; without these the dropdowns fall back to
                // free-text inputs (which is what the user reported
                // as "it's not a dropdown, it's a text field").
                if (!showPushOptions && branches === undefined) {
                  void api
                    .gitBranches(project.id)
                    .then((r) => setBranches(r.branches))
                    .catch(() => undefined);
                }
                if (!showPushOptions && remotes === undefined) {
                  void api
                    .gitRemotes(project.id)
                    .then((r) => setRemotes(r.remotes))
                    .catch(() => undefined);
                }
              }}
              className="rounded px-1 py-0.5 text-[10px] normal-case text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
            >
              {showPushOptions ? "Hide options" : "Options"}
            </button>
          </div>
          {showPushOptions && (
            <div className="mb-2 space-y-1.5 rounded border border-neutral-800 bg-neutral-900/40 p-2">
              <label className="flex items-center gap-2 text-[11px]">
                <span className="w-16 shrink-0 text-neutral-400">Remote</span>
                {knownRemotes.length > 0 ? (
                  <select
                    value={pushRemote ?? ""}
                    onChange={(e) =>
                      setPushRemote(e.target.value === "" ? undefined : e.target.value)
                    }
                    className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
                  >
                    <option value="">configured upstream</option>
                    {knownRemotes.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={pushRemote ?? ""}
                    onChange={(e) =>
                      setPushRemote(e.target.value.length === 0 ? undefined : e.target.value)
                    }
                    placeholder="origin"
                    className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
                  />
                )}
              </label>
              <label className="flex items-center gap-2 text-[11px]">
                <span className="w-16 shrink-0 text-neutral-400">Branch</span>
                {knownLocalBranches.length > 0 ? (
                  <select
                    value={pushBranchOverride}
                    onChange={(e) => setPushBranchOverride(e.target.value)}
                    className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
                  >
                    <option value="">{status?.branch ?? "current branch"}</option>
                    {knownLocalBranches.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={pushBranchOverride}
                    onChange={(e) => setPushBranchOverride(e.target.value)}
                    placeholder={status?.branch ?? "current"}
                    className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-1 py-0.5 text-[11px] text-neutral-100 outline-none focus:border-neutral-500"
                  />
                )}
              </label>
              <label className="flex items-center gap-2 text-[11px] text-neutral-300">
                <input
                  type="checkbox"
                  checked={pushSetUpstream}
                  onChange={(e) => setPushSetUpstream(e.target.checked)}
                  className="h-3 w-3"
                />
                <span>Set upstream (first push of a new branch)</span>
              </label>
            </div>
          )}
          <div className="flex gap-1">
            <button
              onClick={() => void handleFetch()}
              disabled={busy}
              className="flex-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
              title={
                pushRemote !== undefined
                  ? `git fetch ${pushRemote}`
                  : "git fetch (configured upstream)"
              }
            >
              Fetch
            </button>
            <button
              onClick={() => void handlePull()}
              disabled={busy}
              className="flex-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
              title="git pull — conflicts surface in the error banner; resolve via the integrated terminal"
            >
              Pull
            </button>
            <button
              onClick={() => void handlePush()}
              disabled={busy}
              className="flex-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:border-neutral-500 disabled:opacity-50"
              title={
                pushRemote === undefined && pushBranchOverride.trim().length === 0
                  ? "git push (configured upstream)"
                  : `git push ${pushRemote ?? "(upstream)"}${
                      pushBranchOverride.trim().length > 0 ? ` ${pushBranchOverride.trim()}` : ""
                    }`
              }
            >
              Push
            </button>
          </div>
        </div>

        {/* Log section. */}
        <div className="border-t border-neutral-800/60">
          <button
            onClick={() => setShowLog((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-900"
          >
            <span>Log</span>
            <span>{showLog ? "−" : "+"}</span>
          </button>
          {showLog && (
            <div className="px-3 pb-3 text-[11px]">
              {log === undefined ? (
                <p className="italic text-neutral-500">Loading…</p>
              ) : log.length === 0 ? (
                <p className="italic text-neutral-500">No commits yet.</p>
              ) : (
                <LogGraph commits={log} />
              )}
            </div>
          )}
        </div>

        {/* Branches section. */}
        <div className="border-t border-neutral-800/60">
          <button
            onClick={() => setShowBranches((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-900"
          >
            <span>Branches</span>
            <span>{showBranches ? "−" : "+"}</span>
          </button>
          {showBranches && (
            <div className="px-3 pb-3 text-[11px]">
              {branches === undefined ? (
                <p className="italic text-neutral-500">Loading…</p>
              ) : (
                <>
                  <ul className="space-y-0.5">
                    {branches.map((b) => {
                      const busy = branchBusy === b.name;
                      return (
                        <li
                          key={b.name}
                          className={`group flex items-center gap-1 rounded px-1 py-0.5 font-mono hover:bg-neutral-900 ${
                            b.current
                              ? "text-emerald-400 light:text-emerald-700"
                              : "text-neutral-300"
                          }`}
                        >
                          <span className="w-3 shrink-0">
                            {b.current ? <Check size={10} /> : null}
                          </span>
                          <span className="flex-1 truncate" title={b.name}>
                            {b.name}
                          </span>
                          {b.remote && (
                            <span className="ml-1 text-[10px] text-neutral-600">remote</span>
                          )}
                          {/* Per-row actions only show on hover. Current
                              local branch shows neither — checkout-self
                              is a no-op and -d on current is rejected. */}
                          {!b.current && (
                            <div className="hidden gap-0.5 group-hover:flex">
                              <button
                                onClick={() => void handleCheckout(b.name)}
                                disabled={busy}
                                className="rounded px-1 py-0.5 text-[10px] text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-40"
                                title={
                                  b.remote
                                    ? `Checkout (creates a tracking branch from ${b.name})`
                                    : `Checkout ${b.name}`
                                }
                              >
                                checkout
                              </button>
                              {!b.remote && (
                                <button
                                  onClick={() => setBranchDialog({ kind: "delete", name: b.name })}
                                  disabled={busy}
                                  className="rounded p-0.5 text-neutral-500 hover:bg-red-900/30 hover:text-red-300 disabled:opacity-40 light:hover:bg-red-100 light:hover:text-red-700"
                                  title="Delete branch"
                                >
                                  <Trash2 size={10} />
                                </button>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    onClick={() => setBranchDialog({ kind: "create" })}
                    className="mt-2 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                  >
                    <Plus size={10} /> New branch
                  </button>
                </>
              )}
            </div>
          )}
        </div>

        {/* Remotes section — same lazy-load pattern as Log + Branches.
            Supports add/remove plus the per-remote local TLS opt-in used by
            internal Git hosts with private/self-signed certificates. */}
        <div className="border-t border-neutral-800/60">
          <button
            onClick={() => setShowRemotes((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-[10px] uppercase tracking-wider text-neutral-400 hover:bg-neutral-900"
          >
            <span>Remotes</span>
            <span>{showRemotes ? "−" : "+"}</span>
          </button>
          {showRemotes && (
            <div className="px-3 pb-3 text-[11px]">
              {remotes === undefined ? (
                <p className="italic text-neutral-500">Loading…</p>
              ) : (
                <>
                  {remotes.length === 0 ? (
                    <p className="italic text-neutral-500">No remotes configured.</p>
                  ) : (
                    <ul className="space-y-1">
                      {remotes.map((r) => {
                        const diverged = r.fetchUrl !== r.pushUrl;
                        const busy = remoteBusy === r.name;
                        return (
                          <li key={r.name} className="group flex flex-col gap-0.5">
                            <div className="flex items-baseline gap-2">
                              {/* Neutral, not emerald — emerald in the
                                  branches list means "currently checked
                                  out". Remotes don't have a singular
                                  active state at this list level; the
                                  active selection lives on the Push
                                  Options dropdown above. */}
                              <span className="font-mono text-neutral-200">{r.name}</span>
                              {diverged && (
                                <span className="rounded bg-amber-900/30 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-300 light:bg-amber-100 light:text-amber-800">
                                  fetch ≠ push
                                </span>
                              )}
                              {r.insecureTls && (
                                <span
                                  className="rounded bg-amber-900/40 px-1 py-0.5 text-[9px] uppercase tracking-wider text-amber-300 light:bg-amber-100 light:text-amber-800"
                                  title="TLS certificate verification disabled for this remote URL in local git config"
                                >
                                  ignore tls
                                </span>
                              )}
                              <button
                                onClick={() => setRemoveRemoteName(r.name)}
                                disabled={busy}
                                className="ml-auto hidden rounded p-0.5 text-neutral-500 hover:bg-red-900/30 hover:text-red-300 disabled:opacity-40 group-hover:inline-flex light:hover:bg-red-100 light:hover:text-red-700"
                                title={`Remove remote "${r.name}"`}
                              >
                                <Trash2 size={10} />
                              </button>
                            </div>
                            <span
                              className="break-all font-mono text-[10px] text-neutral-500"
                              title={r.fetchUrl}
                            >
                              {r.fetchUrl}
                            </span>
                            {diverged && (
                              <span
                                className="break-all font-mono text-[10px] text-neutral-500"
                                title={`push → ${r.pushUrl}`}
                              >
                                push → {r.pushUrl}
                              </span>
                            )}
                            <label className="mt-0.5 flex items-start gap-1.5 text-[10px] text-neutral-500">
                              <input
                                type="checkbox"
                                checked={r.insecureTls}
                                onChange={(e) =>
                                  void handleToggleRemoteTls(r.name, e.target.checked)
                                }
                                disabled={busy}
                                className="mt-0.5 h-3 w-3"
                              />
                              <span>
                                Ignore SSL/TLS verification for this remote (local repo config only)
                              </span>
                            </label>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  <button
                    onClick={() => {
                      setNewRemoteName("");
                      setNewRemoteUrl("");
                      setNewRemoteInsecureTls(false);
                      setShowAddRemote(true);
                    }}
                    className="mt-2 flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                  >
                    <Plus size={10} /> Add remote
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      <PromptDialog
        open={branchDialog?.kind === "create"}
        onClose={() => setBranchDialog(undefined)}
        onSubmit={(name) => void handleCreateBranch(name)}
        title="New branch"
        label="Branch name"
        placeholder="feature/my-change"
        primaryLabel="Create + checkout"
      />
      <ConfirmDialog
        open={branchDialog?.kind === "delete"}
        onClose={() => setBranchDialog(undefined)}
        onConfirm={() => void handleDeleteBranch(false)}
        title="Delete branch"
        message={
          branchDialog?.kind === "delete"
            ? `Delete branch "${branchDialog.name}"? Refused if not merged into HEAD; force-delete from the terminal if you really mean it.`
            : ""
        }
        primaryLabel="Delete"
        tone="danger"
      />
      <Modal open={showAddRemote} onClose={() => setShowAddRemote(false)} title="Add remote">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void handleAddRemote();
          }}
          className="flex flex-col gap-3 px-4 py-3"
        >
          <label className="block space-y-1.5">
            <span className="text-xs text-neutral-300">Name</span>
            <input
              type="text"
              value={newRemoteName}
              onChange={(e) => setNewRemoteName(e.target.value)}
              placeholder="origin"
              autoFocus
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm text-neutral-100 outline-none focus:border-neutral-500"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs text-neutral-300">URL</span>
            <input
              type="text"
              value={newRemoteUrl}
              onChange={(e) => setNewRemoteUrl(e.target.value)}
              placeholder="git@github.com:user/repo.git"
              className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-1.5 font-mono text-sm text-neutral-100 outline-none focus:border-neutral-500"
            />
          </label>
          <label className="flex items-start gap-2 rounded border border-amber-900/40 bg-amber-950/30 px-2 py-1.5 text-xs light:border-amber-300 light:bg-amber-50">
            <input
              type="checkbox"
              checked={newRemoteInsecureTls}
              onChange={(e) => setNewRemoteInsecureTls(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              <span className="text-amber-200 light:text-amber-800">
                Ignore SSL/TLS verification for this remote
              </span>
              <br />
              <span className="text-[11px] text-amber-300/70 light:text-amber-700/80">
                Persists only in this repository as URL-scoped git config. Use only for internal Git
                hosts with a known self-signed/private-CA certificate.
              </span>
            </span>
          </label>
          <footer className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setShowAddRemote(false)}
              className="rounded-md border border-neutral-700 px-3 py-1 text-xs text-neutral-200 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={newRemoteName.trim().length === 0 || newRemoteUrl.trim().length === 0}
              className="rounded-md bg-neutral-100 px-3 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              Add
            </button>
          </footer>
        </form>
      </Modal>
      <ConfirmDialog
        open={removeRemoteName !== undefined}
        onClose={() => setRemoveRemoteName(undefined)}
        onConfirm={() => void handleRemoveRemote()}
        title="Remove remote"
        message={
          removeRemoteName !== undefined
            ? `Remove remote "${removeRemoteName}"? The local repo loses its reference to this URL; existing commits aren't affected.`
            : ""
        }
        primaryLabel="Remove"
        tone="danger"
      />
    </div>
  );
}

interface FileGroupProps {
  label: string;
  files: GitFileStatus[];
  actionLabel: string;
  onGroupAction: () => void;
  onFileAction: (f: GitFileStatus) => void;
  fileActionLabel: string;
  /** Called when the user double-clicks (confirms) Revert. Pass
   *  `undefined` to hide the revert button entirely (e.g. for
   *  untracked files where git can't restore from HEAD). */
  onRevert: ((f: GitFileStatus) => void) | undefined;
  onClickFile: (f: GitFileStatus) => void;
  openDiffs: Record<string, string | "loading" | "error">;
  staged: boolean;
  diffViewType: "unified" | "split";
  /**
   * Per-hunk action for the inline diff. Called with the file + the
   * hunk's 0-based index within the file's diff. Pass `undefined` to
   * disable hunk-level actions for this group (e.g. untracked files
   * — they're a single "added" hunk so file-level Stage suffices and
   * `git apply --cached` against an untracked file would error).
   */
  onHunkAction?: ((file: GitFileStatus, hunkIndex: number) => void) | undefined;
  /** Path currently being mutated — disables its diff buttons during the request. */
  pendingHunkPath?: string | undefined;
}

const REVERT_CONFIRM_TIMEOUT_MS = 3000;

function FileGroup(props: FileGroupProps) {
  // Click-twice-to-confirm state for the destructive Revert action.
  // First click on a file's revert button puts THAT file's path
  // into `pending`, swaps the icon for "Confirm?" copy, and sets
  // a 3s timeout to auto-clear. Second click within the window
  // executes the revert. Clicking a different file's revert
  // moves the pending state to that file (so two-step destructive
  // actions can't accidentally hit the wrong row). The ref tracks
  // the timeout so we can clear it on unmount or state transition.
  const [pendingRevert, setPendingRevert] = useState<string | undefined>(undefined);
  const revertTimerRef = useRef<number | undefined>(undefined);

  const clearPending = (): void => {
    if (revertTimerRef.current !== undefined) {
      window.clearTimeout(revertTimerRef.current);
      revertTimerRef.current = undefined;
    }
    setPendingRevert(undefined);
  };

  useEffect(() => {
    return () => {
      if (revertTimerRef.current !== undefined) {
        window.clearTimeout(revertTimerRef.current);
      }
    };
  }, []);

  const handleRevertClick = (f: GitFileStatus): void => {
    if (props.onRevert === undefined) return;
    if (pendingRevert === f.path) {
      // Second click within the window — commit.
      clearPending();
      props.onRevert(f);
      return;
    }
    // First click (or click on a different file).
    if (revertTimerRef.current !== undefined) {
      window.clearTimeout(revertTimerRef.current);
    }
    setPendingRevert(f.path);
    revertTimerRef.current = window.setTimeout(() => {
      setPendingRevert(undefined);
      revertTimerRef.current = undefined;
    }, REVERT_CONFIRM_TIMEOUT_MS);
  };

  return (
    <div className="border-t border-neutral-800/60">
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-neutral-500">
          {props.label} ({props.files.length})
        </span>
        <button
          onClick={props.onGroupAction}
          className="text-[10px] text-neutral-400 hover:text-neutral-200"
        >
          {props.actionLabel}
        </button>
      </div>
      <ul>
        {props.files.map((f) => {
          const key = `${f.path}|${props.staged ? "staged" : "unstaged"}`;
          const diffState = props.openDiffs[key];
          const revertPending = pendingRevert === f.path;
          return (
            <li key={f.path} className="border-t border-neutral-900">
              <div className="group flex items-center gap-2 px-3 py-1 hover:bg-neutral-900">
                <span
                  className="inline-block w-5 shrink-0 text-center font-mono text-[10px] text-neutral-500"
                  title={`porcelain code: ${f.code}`}
                >
                  {kindBadge(f.kind)}
                </span>
                <button
                  onClick={() => props.onClickFile(f)}
                  className="flex-1 truncate text-left font-mono"
                  title={f.path}
                >
                  {f.path}
                </button>
                {props.onRevert !== undefined && (
                  <button
                    onClick={() => handleRevertClick(f)}
                    // `inline-flex` (NOT plain `inline`) is what
                    // keeps the icon on the same baseline as the
                    // text. `inline` alone would override our
                    // `flex` display and stack the icon below the
                    // label whenever the text wrapped or got too
                    // wide. `group-hover:inline-flex` handles the
                    // visible state on hover.
                    className={
                      revertPending
                        ? "inline-flex items-center gap-1 rounded bg-red-900/40 px-1 py-0.5 text-[10px] text-red-200 light:bg-red-100 light:text-red-800"
                        : "hidden items-center gap-1 text-[10px] text-neutral-500 hover:text-red-300 group-hover:inline-flex light:hover:text-red-700"
                    }
                    title={
                      revertPending
                        ? "Click again to discard local changes (this cannot be undone)"
                        : "Revert: discard local changes for this file"
                    }
                  >
                    <Undo2 size={10} />
                    {revertPending ? "Confirm?" : "Revert"}
                  </button>
                )}
                <button
                  onClick={() => props.onFileAction(f)}
                  // Same `inline-flex` trick as the revert button —
                  // plain `inline` would override the implicit
                  // flex-row layout and let the icon wrap.
                  className="ml-3 hidden items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-200 group-hover:inline-flex"
                >
                  {props.fileActionLabel === "Stage" ? (
                    <Plus size={10} />
                  ) : props.fileActionLabel === "Unstage" ? (
                    <Minus size={10} />
                  ) : null}
                  {props.fileActionLabel}
                </button>
              </div>
              {diffState !== undefined && (
                <div className="border-t border-neutral-900 bg-neutral-950">
                  {diffState === "loading" ? (
                    <p className="px-3 py-2 italic text-neutral-500">Loading…</p>
                  ) : diffState === "error" ? (
                    <p className="px-3 py-2 text-red-400 light:text-red-700">
                      Failed to load diff.
                    </p>
                  ) : diffState.length === 0 ? (
                    <p className="px-3 py-2 italic text-neutral-500">
                      (no diff — file is binary or unchanged)
                    </p>
                  ) : (
                    <DiffBlock
                      diff={diffState}
                      viewType={props.diffViewType}
                      onHunkAction={
                        props.onHunkAction !== undefined
                          ? (idx) => props.onHunkAction?.(f, idx)
                          : undefined
                      }
                      hunkActionLabel={props.staged ? "Unstage hunk" : "Stage hunk"}
                      hunkActionDisabled={props.pendingHunkPath === f.path}
                    />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function kindBadge(kind: GitFileStatus["kind"]): string {
  switch (kind) {
    case "modified":
      return "M";
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "copied":
      return "C";
    case "untracked":
      return "?";
    case "ignored":
      return "!";
    case "conflicted":
      return "U";
    default:
      return "·";
  }
}

// === Log graph rendering (Dif7 follow-up — VSCode-style) ===

const LANE_W = 14; // px per lane
const ROW_H = 36; // px per commit row — matches the two-line layout below

/**
 * Tree-style git log. For each commit row we draw a fixed-width SVG
 * column to the left of the text:
 *   - vertical lines for every "through" lane (passes top→bottom)
 *   - the commit dot in this commit's lane
 *   - edges from incoming lanes (above) joining the dot
 *   - edges to outgoing lanes (below) descending into the next row
 *
 * Multi-parent commits (merges) emit additional outgoing lanes that
 * head off into space at the bottom of the row to be picked up by
 * a later commit (the merge ancestor).
 *
 * No curves / arcs — straight lines and short diagonals. VSCode's
 * graph uses gentle curves; that's pure aesthetics and adds path-
 * generation complexity for no functional gain in our context.
 */
function LogGraph({ commits }: { commits: GitLogEntry[] }) {
  const layouts = layoutCommits(commits);
  const maxLanes = Math.max(1, ...layouts.map((l) => l.width));
  return (
    <ul className="space-y-0">
      {commits.map((c, i) => {
        const layout = layouts[i];
        if (layout === undefined) return null;
        return (
          <li key={c.hash} className="group flex items-stretch">
            <GraphCell layout={layout} isLast={i === layouts.length - 1} maxLanes={maxLanes} />
            <div className="flex flex-col justify-center gap-0.5 pl-2" style={{ minHeight: ROW_H }}>
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-neutral-500">{c.hash.slice(0, 7)}</span>
                {c.refs.map((r, ri) => (
                  // Key on `${index}-${value}` to survive the rare case where
                  // git's %D output emits the same string twice (e.g. duplicate
                  // tags via different prefixes).
                  <RefBadge key={`${ri}-${r}`} ref_={r} />
                ))}
                <span className="truncate text-neutral-200" title={c.message}>
                  {c.message}
                </span>
              </div>
              <span className="font-mono text-[10px] text-neutral-600">
                {c.author} · {new Date(c.date).toLocaleString()}
              </span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function GraphCell({
  layout,
  isLast,
  maxLanes,
}: {
  layout: CommitLayout;
  isLast: boolean;
  maxLanes: number;
}) {
  const w = maxLanes * LANE_W;
  const h = ROW_H;
  const dotX = layout.lane * LANE_W + LANE_W / 2;
  const dotY = h / 2;

  const lines: { x1: number; y1: number; x2: number; y2: number; color: string }[] = [];

  // Through lanes — full-height verticals. Color by lane index so
  // lanes are visually distinct as they pass through.
  for (const lane of layout.through) {
    const x = lane * LANE_W + LANE_W / 2;
    lines.push({ x1: x, y1: 0, x2: x, y2: h, color: laneColor(lane) });
  }

  // Incoming lanes — from top edge to dot. The commit's own lane (if
  // it had a vertical predecessor) renders as a vertical FROM TOP TO
  // DOT in the commit's lane color.
  for (const inLane of layout.incomingLanes) {
    const x = inLane * LANE_W + LANE_W / 2;
    lines.push({
      x1: x,
      y1: 0,
      x2: dotX,
      y2: dotY,
      color: laneColor(inLane),
    });
  }
  // (No top-stub for tip commits mid-history — the absence of an
  // incoming line is the correct visual cue for "branch starts here.")

  // Outgoing lanes — from dot to bottom edge. Each parent gets its
  // own descender. Use the OUTGOING lane index for color so a fork
  // immediately picks up its destination color.
  if (!isLast) {
    for (const out of layout.outgoingLanes) {
      const x = out.lane * LANE_W + LANE_W / 2;
      lines.push({
        x1: dotX,
        y1: dotY,
        x2: x,
        y2: h,
        color: laneColor(out.lane),
      });
    }
  }
  // Last row: stub below the dot to terminate the line so it doesn't
  // float disconnected from any rendered geometry.
  if (isLast && layout.outgoingLanes.length > 0) {
    for (const out of layout.outgoingLanes) {
      const x = out.lane * LANE_W + LANE_W / 2;
      lines.push({
        x1: dotX,
        y1: dotY,
        x2: x,
        y2: dotY + 6,
        color: laneColor(out.lane),
      });
    }
  }

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="shrink-0" aria-hidden>
      {lines.map((l, i) => (
        <line
          key={i}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke={l.color}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      ))}
      <circle cx={dotX} cy={dotY} r={3.5} fill={laneColor(layout.lane)} />
    </svg>
  );
}

/**
 * Render a single ref decoration as a small inline pill. We classify
 * refs into a few visual buckets:
 *   - "HEAD -> <branch>" → emerald, marks the active branch
 *   - "tag: <name>" → amber
 *   - "<remote>/<branch>" (contains /) → neutral, dimmer
 *   - bare branch name → neutral, brighter
 */
function RefBadge({ ref_ }: { ref_: string }) {
  const isHead = ref_.startsWith("HEAD ->") || ref_ === "HEAD";
  const isTag = ref_.startsWith("tag:");
  const text = isHead
    ? ref_.replace(/^HEAD ->\s*/, "")
    : isTag
      ? ref_.replace(/^tag:\s*/, "")
      : ref_;
  const cls = isHead
    ? "bg-emerald-900/40 text-emerald-300 light:bg-emerald-100 light:text-emerald-800"
    : isTag
      ? "bg-amber-900/40 text-amber-300 light:bg-amber-100 light:text-amber-800"
      : ref_.includes("/")
        ? "bg-neutral-800 text-neutral-500"
        : "bg-neutral-800 text-neutral-300";
  return (
    <span className={`shrink-0 rounded px-1.5 py-0 text-[9px] uppercase tracking-wider ${cls}`}>
      {isTag ? `▼ ${text}` : text}
    </span>
  );
}

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type GitStatus } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

const POLL_INTERVAL_MS = 15_000;

/**
 * Polls `GET /git/status` every 15s for the given project AND fires an
 * extra refresh whenever the active session's `agentEndCount` ticks
 * (i.e. an agent_end was just observed). The polling pauses while a
 * session is streaming — no point thrashing the server while the
 * agent is mid-turn since `git status` would race the agent's
 * writes anyway. The agent_end signal then fires the moment streaming
 * stops, so the panel updates within milliseconds instead of waiting
 * up to 15s for the next poll.
 *
 * Terminal-induced changes (the user runs `git checkout -- file` in
 * the integrated terminal) still wait for the 15s polling cycle —
 * pushing those would require a new file-system signal we don't have.
 *
 * Note: each consumer of this hook owns its own interval. Currently
 * App.tsx (for the changed-files badge) and GitPanel.tsx both call
 * it, so the effective server-side rate is ~2× the per-consumer
 * interval when the git panel is open.
 *
 * Returns `undefined` until the first response lands, then the
 * latest status snapshot. Errors are stored separately so a
 * transient network blip doesn't blank the UI.
 *
 * Project-switch race: an in-flight `refresh()` call retains the
 * old `projectId` in its closure, so if the user switches projects
 * while a poll is on the wire, the old response would otherwise
 * overwrite the freshly-reset state. We track the "current" project
 * in a ref + an epoch counter that bumps on every project change;
 * a refresh discards its result if the epoch shifted while it was
 * in flight. (AbortController would also work but adds API surface
 * the api-client doesn't expose.)
 */
export function useGitStatus(
  projectId: string | undefined,
  worktreePath?: string,
): {
  status: GitStatus | undefined;
  error: string | undefined;
  refresh: () => Promise<void>;
} {
  const [status, setStatus] = useState<GitStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const isStreaming = useSessionStore((s) =>
    activeSessionId !== undefined ? (s.streamingBySession[activeSessionId] ?? false) : false,
  );
  // Bumps once per agent_end on the active session — same signal
  // App.tsx and TurnDiffPanel use to refresh after a turn finishes.
  const agentEndCount = useSessionStore((s) =>
    activeSessionId !== undefined ? (s.agentEndCountBySession[activeSessionId] ?? 0) : 0,
  );

  // Epoch bumps on every projectId transition. A refresh captures
  // the epoch at call time and bails on land if it no longer
  // matches — guarantees the latest response wins.
  const epochRef = useRef(0);

  const refresh = async (): Promise<void> => {
    if (projectId === undefined) return;
    const myEpoch = epochRef.current;
    const myProjectId = projectId;
    try {
      const next = await api.gitStatus(myProjectId, worktreePath);
      if (epochRef.current !== myEpoch) return; // stale — project switched
      setStatus(next);
      setError(undefined);
    } catch (err) {
      if (epochRef.current !== myEpoch) return;
      setError(err instanceof ApiError ? err.code : (err as Error).message);
    }
  };

  // Reset between projects so we don't show one project's status
  // briefly when the user switches. Bump the epoch FIRST so any
  // in-flight refresh from the old project no-ops on land.
  useEffect(() => {
    epochRef.current += 1;
    setStatus(undefined);
    setError(undefined);
  }, [projectId, worktreePath]);

  useEffect(() => {
    if (projectId === undefined) return undefined;
    void refresh();
    if (isStreaming) return () => undefined;
    const id = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, worktreePath, isStreaming]);

  // Push refresh on every agent_end. The polling effect above pauses
  // during streaming and only fires once when isStreaming flips back
  // — this catches the same edge but reacts to the explicit signal,
  // closing the worst-case 5s lag right after the agent stops.
  // Include `activeSessionId` in the deps: when the user switches
  // active sessions inside the same project, `agentEndCount` may
  // happen to be the same number for both sessions and React would
  // skip the effect — losing the refresh that should fire because
  // the new session has a different (post-agent-end) state.
  useEffect(() => {
    if (projectId === undefined) return;
    if (agentEndCount === 0) return; // initial value, no agent_end yet
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, worktreePath, activeSessionId, agentEndCount]);

  return { status, error, refresh };
}

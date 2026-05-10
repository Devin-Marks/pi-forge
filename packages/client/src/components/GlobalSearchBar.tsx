import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { api } from "../lib/api-client";
import type { SessionSearchGroup, SessionSearchMatch } from "../lib/api-client";
import { useProjectStore } from "../store/project-store";
import { useSessionStore } from "../store/session-store";

/**
 * Top-of-app cross-session search. Calls `/api/v1/search/sessions` on
 * a debounced query and renders matches in a dropdown popover under
 * the input.
 *
 * Click / Enter on a result switches the active project + session and
 * stages a pending scroll target on the session-store; ChatView reads
 * it on mount and scrolls to the matching message.
 *
 * Hotkeys: Cmd+K / Ctrl+K to focus, Esc to close, ↑/↓ + Enter to
 * navigate the dropdown.
 */
export function GlobalSearchBar() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SessionSearchGroup[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);

  const setActiveProject = useProjectStore((s) => s.setActive);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const setActiveSession = useSessionStore((s) => s.setActiveSession);
  const requestScrollToMessage = useSessionStore((s) => s.requestScrollToMessage);

  // Flatten the grouped results into a click-target list so ↑/↓ can
  // walk every matched message rather than just session headers. Each
  // entry carries enough context to dispatch the click handler.
  const flatTargets = useMemo<
    {
      group: SessionSearchGroup;
      match: SessionSearchMatch;
      groupIndex: number;
      matchIndex: number;
    }[]
  >(() => {
    const out: {
      group: SessionSearchGroup;
      match: SessionSearchMatch;
      groupIndex: number;
      matchIndex: number;
    }[] = [];
    results.forEach((group, gi) => {
      group.matches.forEach((match, mi) => {
        out.push({ group, match, groupIndex: gi, matchIndex: mi });
      });
    });
    return out;
  }, [results]);

  // Reset highlighted row whenever the result set changes so the
  // first row is always pre-selected for "type then Enter."
  useEffect(() => {
    setActiveIndex(0);
  }, [results]);

  // Cmd+K / Ctrl+K focus from anywhere in the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-away closes the dropdown.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (containerRef.current === null) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Debounced query → API call. AbortController on each new request
  // so a slower in-flight call can't race a faster later one and
  // overwrite the dropdown with stale results.
  useEffect(() => {
    if (query.trim().length === 0) {
      setResults([]);
      setError(undefined);
      setLoading(false);
      abortRef.current?.abort();
      return;
    }
    const ctrl = new AbortController();
    abortRef.current?.abort();
    abortRef.current = ctrl;
    setLoading(true);
    setError(undefined);
    const t = window.setTimeout(() => {
      api
        .searchSessions(query.trim(), { signal: ctrl.signal })
        .then((res) => {
          if (ctrl.signal.aborted) return;
          setResults(res.results);
          setLoading(false);
          setOpen(true);
        })
        .catch((err: unknown) => {
          if (ctrl.signal.aborted) return;
          setLoading(false);
          // Keep the previous results visible on transient errors —
          // dropping them under the user's cursor is jarring. Surface
          // the message instead.
          const msg = err instanceof Error ? err.message : "search failed";
          setError(msg);
        });
    }, 250);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [query]);

  const dispatchResult = (group: SessionSearchGroup, match: SessionSearchMatch): void => {
    requestScrollToMessage(group.sessionId, match.messageIndex);
    if (activeProjectId !== group.projectId) setActiveProject(group.projectId);
    setActiveSession(group.sessionId);
    setOpen(false);
    setQuery("");
    inputRef.current?.blur();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
      return;
    }
    if (!open || flatTargets.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(flatTargets.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const t = flatTargets[activeIndex];
      if (t !== undefined) dispatchResult(t.group, t.match);
    }
  };

  const renderSnippet = (m: SessionSearchMatch): React.ReactNode => {
    // Highlight the matched substring inside the snippet. Server
    // already gave us match offset + length relative to the snippet.
    const before = m.snippet.slice(0, m.matchOffset);
    const hit = m.snippet.slice(m.matchOffset, m.matchOffset + m.matchLength);
    const after = m.snippet.slice(m.matchOffset + m.matchLength);
    return (
      <>
        {before}
        <mark className="rounded bg-amber-300/30 text-amber-100">{hit}</mark>
        {after}
      </>
    );
  };

  const kindBadge = (kind: SessionSearchMatch["kind"]): string => {
    if (kind === "user") return "you";
    if (kind === "assistant") return "agent";
    return "tool";
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search
          size={13}
          className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
          aria-hidden="true"
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => {
            if (results.length > 0) setOpen(true);
          }}
          onKeyDown={onKeyDown}
          placeholder="Search sessions…  ⌘K"
          aria-label="Search across all sessions"
          className="w-64 rounded-md border border-neutral-700 bg-neutral-900 py-1 pl-7 pr-7 text-xs text-neutral-200 placeholder-neutral-500 focus:border-neutral-500 focus:outline-none"
        />
        {query.length > 0 && (
          <button
            type="button"
            onClick={() => {
              setQuery("");
              setResults([]);
              setOpen(false);
              inputRef.current?.focus();
            }}
            aria-label="Clear search"
            className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {open && (
        <div
          role="listbox"
          aria-label="Search results"
          className="absolute right-0 top-full z-50 mt-1 max-h-[60vh] w-96 overflow-y-auto rounded-md border border-neutral-700 bg-neutral-900 shadow-xl"
        >
          {loading && <div className="px-3 py-2 text-xs text-neutral-400">Searching…</div>}
          {!loading && error !== undefined && (
            <div className="px-3 py-2 text-xs text-amber-400">{error}</div>
          )}
          {!loading && error === undefined && flatTargets.length === 0 && (
            <div className="px-3 py-2 text-xs text-neutral-500">No matches.</div>
          )}
          {flatTargets.length > 0 && (
            <div>
              {results.map((group, gi) => (
                <div key={group.sessionId} className="border-b border-neutral-800 last:border-b-0">
                  <div className="bg-neutral-950 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
                    <span className="text-neutral-300">{group.projectName}</span>
                    {group.sessionName !== undefined && (
                      <>
                        <span className="mx-1.5 text-neutral-600">/</span>
                        <span className="text-neutral-400 normal-case tracking-normal">
                          {group.sessionName}
                        </span>
                      </>
                    )}
                  </div>
                  {group.matches.map((match, mi) => {
                    const flatIndex = flatTargets.findIndex(
                      (t) => t.groupIndex === gi && t.matchIndex === mi,
                    );
                    const isActive = flatIndex === activeIndex;
                    return (
                      <button
                        key={`${match.messageIndex}-${match.matchOffset}`}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onMouseEnter={() => setActiveIndex(flatIndex)}
                        onClick={() => dispatchResult(group, match)}
                        className={`flex w-full items-start gap-2 px-3 py-1.5 text-left text-xs ${
                          isActive
                            ? "bg-neutral-800 text-neutral-100"
                            : "text-neutral-300 hover:bg-neutral-800/60"
                        }`}
                      >
                        <span className="mt-0.5 shrink-0 rounded bg-neutral-800 px-1 py-0.5 text-[9px] uppercase tracking-wider text-neutral-400">
                          {kindBadge(match.kind)}
                        </span>
                        <span className="flex-1 break-words">{renderSnippet(match)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

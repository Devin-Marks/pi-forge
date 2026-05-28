import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ChevronDown, ChevronRight, FileSearch, Loader2, Search } from "lucide-react";
import { api, ApiError, type SearchMatch, type SearchResponse } from "../lib/api-client";
import { useFileStore } from "../store/file-store";
import { useActiveProject } from "../store/project-store";
import { useUiStore } from "../store/ui-store";

const DEBOUNCE_MS = 250;
const MIN_QUERY_LEN = 2;
const RESULT_LIMIT = 200;

/**
 * Cross-project file search. Drives `GET /api/v1/files/search`, which
 * uses ripgrep when available and falls back to a Node walk otherwise.
 * Result clicks open the matching file in the editor and scroll to the
 * matched line/column via the file-store's `pendingNav` plumbing.
 */
export function SearchPanel() {
  const project = useActiveProject();
  const openFile = useFileStore((s) => s.openFile);
  const openEditorPane = useUiStore((s) => s.openEditorPane);

  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [includeGitignored, setIncludeGitignored] = useState(false);
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [globsOpen, setGlobsOpen] = useState(false);

  const [results, setResults] = useState<SearchResponse | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // Track the in-flight request so a new query cancels the prior one —
  // prevents an older slow response from clobbering a newer one.
  const abortRef = useRef<AbortController | undefined>(undefined);

  const runSearch = useCallback(
    async (q: string) => {
      if (project === undefined) return;
      if (q.length < MIN_QUERY_LEN) {
        setResults(undefined);
        setError(undefined);
        return;
      }
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError(undefined);
      try {
        const opts = {
          query: q,
          regex,
          caseSensitive,
          includeGitignored,
          limit: RESULT_LIMIT,
          ...(include.length > 0 ? { include } : {}),
          ...(exclude.length > 0 ? { exclude } : {}),
        };
        const res = await api.searchFiles(project.id, opts, controller.signal);
        if (controller.signal.aborted) return;
        setResults(res);
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return;
        }
        if (err instanceof ApiError && err.code === "invalid_response_body") {
          setError("server returned an unexpected response");
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError("search failed");
        }
        setResults(undefined);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [project, regex, caseSensitive, includeGitignored, include, exclude],
  );

  // Debounced re-run on any input change. The debouncer also fires on
  // toggle/glob changes so flipping options doesn't require pressing
  // Enter again.
  useEffect(() => {
    const id = window.setTimeout(() => void runSearch(query), DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, runSearch]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const grouped = useMemo(() => groupByPath(results?.matches ?? []), [results]);

  if (project === undefined) {
    return (
      <div className="p-4 text-xs italic text-neutral-500">
        Select a project to search its files.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-800 bg-neutral-900/40 p-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={regex ? "Regex…" : "Search project…"}
            className="w-full rounded border border-neutral-700 bg-neutral-900 py-1.5 pl-7 pr-2 text-xs text-neutral-100 placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none"
            autoFocus
          />
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <Toggle label="Regex" active={regex} onClick={() => setRegex((v) => !v)} />
          <Toggle
            label="Aa"
            title="Case sensitive"
            active={caseSensitive}
            onClick={() => setCaseSensitive((v) => !v)}
          />
          <Toggle
            label="+ignored"
            title="Include files that .gitignore would normally skip"
            active={includeGitignored}
            onClick={() => setIncludeGitignored((v) => !v)}
          />
          <button
            onClick={() => setGlobsOpen((v) => !v)}
            className="ml-auto flex items-center gap-1 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-400 hover:border-neutral-500"
          >
            {globsOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Globs
          </button>
        </div>
        {globsOpen && (
          <div className="mt-2 grid grid-cols-1 gap-1.5">
            <input
              type="text"
              value={include}
              onChange={(e) => setInclude(e.target.value)}
              placeholder="include glob — e.g. **/*.ts"
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none"
            />
            <input
              type="text"
              value={exclude}
              onChange={(e) => setExclude(e.target.value)}
              placeholder="exclude glob — e.g. **/dist/**"
              className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-[11px] text-neutral-200 placeholder:text-neutral-500 focus:border-neutral-500 focus:outline-none"
            />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <SearchStatus
          query={query}
          loading={loading}
          error={error}
          results={results}
          totalFiles={grouped.length}
        />
        <ul className="divide-y divide-neutral-900">
          {grouped.map(([path, matches]) => (
            <FileGroup
              key={path}
              path={path}
              matches={matches}
              onPick={(m) => {
                void openFile(project.id, joinProjectPath(project.path, path), {
                  line: m.line,
                  column: m.column,
                });
                openEditorPane();
              }}
            />
          ))}
        </ul>
      </div>
    </div>
  );
}

/* --------------------------------- helpers --------------------------------- */

function joinProjectPath(projectAbsPath: string, relPath: string): string {
  if (relPath.startsWith("/")) return relPath;
  const sep = projectAbsPath.endsWith("/") ? "" : "/";
  return `${projectAbsPath}${sep}${relPath}`;
}

function groupByPath(matches: SearchMatch[]): [string, SearchMatch[]][] {
  const map = new Map<string, SearchMatch[]>();
  for (const m of matches) {
    const list = map.get(m.path);
    if (list === undefined) map.set(m.path, [m]);
    else list.push(m);
  }
  return Array.from(map.entries());
}

function Toggle({
  label,
  title,
  active,
  onClick,
}: {
  label: string;
  title?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`rounded border px-1.5 py-0.5 text-[10px] ${
        active
          ? "border-neutral-500 bg-neutral-800 text-neutral-100"
          : "border-neutral-700 text-neutral-400 hover:border-neutral-500"
      }`}
    >
      {label}
    </button>
  );
}

function SearchStatus({
  query,
  loading,
  error,
  results,
  totalFiles,
}: {
  query: string;
  loading: boolean;
  error: string | undefined;
  results: SearchResponse | undefined;
  totalFiles: number;
}) {
  if (query.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs text-neutral-500">
        <FileSearch size={20} className="text-neutral-700" />
        <p>Type to search across project files.</p>
        <p className="text-[10px] text-neutral-600">
          Min {MIN_QUERY_LEN} chars · Click a result to jump to that line.
        </p>
      </div>
    );
  }
  if (query.length < MIN_QUERY_LEN) {
    return (
      <div className="px-4 py-3 text-xs italic text-neutral-500">
        Keep typing — at least {MIN_QUERY_LEN} characters.
      </div>
    );
  }
  if (loading && results === undefined) {
    return (
      <div className="flex items-center gap-2 px-4 py-3 text-xs text-neutral-400">
        <Loader2 size={12} className="animate-spin" /> Searching…
      </div>
    );
  }
  if (error !== undefined) {
    return <div className="px-4 py-3 text-xs text-rose-400 light:text-rose-700">{error}</div>;
  }
  if (results === undefined) return null;
  if (results.matches.length === 0) {
    return <div className="px-4 py-3 text-xs italic text-neutral-500">No matches.</div>;
  }
  return (
    <div className="flex items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-950/60 px-3 py-1.5 text-[10px]">
      <span className="text-neutral-400">
        {results.matches.length} match{results.matches.length === 1 ? "" : "es"} in {totalFiles}{" "}
        file{totalFiles === 1 ? "" : "s"}
        {results.truncated && (
          <span className="ml-1 text-amber-400 light:text-amber-700">
            · truncated at {RESULT_LIMIT}
          </span>
        )}
      </span>
      {results.engine === "node" && (
        <span
          className="rounded bg-amber-900/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-amber-300 light:bg-amber-100 light:text-amber-800"
          title="ripgrep was not found on this host — using the slower in-process fallback"
        >
          fallback
        </span>
      )}
    </div>
  );
}

function FileGroup({
  path,
  matches,
  onPick,
}: {
  path: string;
  matches: SearchMatch[];
  onPick: (m: SearchMatch) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <li className="bg-neutral-950">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 truncate px-2 py-1 text-left text-[11px] text-neutral-300 hover:bg-neutral-900"
        title={path}
      >
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <span className="truncate font-mono">{path}</span>
        <span className="ml-auto text-[10px] text-neutral-500">{matches.length}</span>
      </button>
      {open && (
        <ul>
          {matches.map((m, i) => (
            <li key={`${m.line}:${m.column}:${i}`}>
              <button
                onClick={() => onPick(m)}
                className="flex w-full gap-2 px-2 py-0.5 text-left font-mono text-[11px] text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
                title={`${path}:${m.line}:${m.column}`}
              >
                <span className="w-10 shrink-0 text-right text-neutral-600">{m.line}</span>
                <span className="truncate">{renderSnippet(m.lineSnippet, m.column, m.length)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function renderSnippet(snippet: string, column: number, length: number): ReactElement {
  // Columns are 1-based; clamp to the snippet so an off-by-one (or a
  // ripgrep byte/char drift on multi-byte chars) doesn't produce a
  // negative slice.
  const start = Math.max(0, Math.min(snippet.length, column - 1));
  const end = Math.max(start, Math.min(snippet.length, start + length));
  // Trim leading whitespace for display so lines are readable in the
  // narrow panel — we still pass the original `column` to the editor.
  const leadingWs = snippet.length - snippet.trimStart().length;
  const trimStart = Math.min(leadingWs, start);
  const before = snippet.slice(trimStart, start);
  const hit = snippet.slice(start, end);
  const after = snippet.slice(end);
  if (length === 0 || hit.length === 0) {
    return <span>{snippet.slice(trimStart)}</span>;
  }
  return (
    <span>
      <span>{before}</span>
      <span className="bg-amber-700/30 text-amber-100 light:bg-amber-200 light:text-amber-900">
        {hit}
      </span>
      <span>{after}</span>
    </span>
  );
}

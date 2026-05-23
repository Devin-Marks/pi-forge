import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { ChevronDown, ChevronRight, Code2, Loader2, RefreshCw, Search, X } from "lucide-react";
import { Highlight, themes as prismThemes } from "prism-react-renderer";
import { api, ApiError, type ContextTurn, type SessionContextResponse } from "../lib/api-client";
import { useSessionStore } from "../store/session-store";

/**
 * Chars-per-token estimate used by every local approximation in this
 * panel (the breakdown bar, the per-row badge, the per-turn "New"
 * delta). The textbook "4 chars per token" comes from English prose;
 * the inspector's job is to bucket *what's actually in the context*,
 * and that's predominantly tool-call JSON, code, diffs, and search
 * results — content where real tokenizers are denser. Empirically 3.0
 * lands much closer for pi-forge sessions than 4.0 did (4.0 made
 * tool-result-heavy turns visibly under-count by 20–40%). All three
 * callsites read this constant so the breakdown bar, the row badge,
 * and the "New" column stay consistent with each other; the
 * authoritative count still comes from the SDK's `usage.input` and
 * shows on the top context-window bar separately.
 */
const CHARS_PER_TOKEN = 3;

/**
 * Phase 16 — Context & Token Inspector.
 *
 * Right-pane tab showing the messages the agent will send to the
 * LLM (post-compaction view), aggregate token + cost totals, a
 * per-turn breakdown derived from each AssistantMessage.usage, and
 * the SDK's context-window utilization stat.
 *
 * Auto-refreshes once per `agent_end` via the session-store's
 * counter (same trigger pattern the file tree + TurnDiffPanel use).
 * Manual refresh button on the toolbar covers the gap when the SDK
 * mutates messages outside an agent run (compactions emit a
 * dedicated event the store handles, but this panel just refetches
 * defensively).
 *
 * Raw-JSON view is a portal-style full-modal overlay so the message
 * inspector itself can stay compact in the right pane.
 */
export function ContextInspectorPanel() {
  const sessionId = useSessionStore((s) => s.activeSessionId);
  const agentEndCount = useSessionStore((s) =>
    sessionId !== undefined ? (s.agentEndCountBySession[sessionId] ?? 0) : 0,
  );
  const compactionEndCount = useSessionStore((s) =>
    sessionId !== undefined ? (s.compactionEndCountBySession[sessionId] ?? 0) : 0,
  );
  // Ctx1 — live updates between agent_end events. Subscribe to the
  // session-store's streaming text + flag so we can synthesize a
  // tail "streaming assistant" row in the message list while the
  // turn is in flight. Cost / token totals update on agent_end as
  // before; this just keeps the message list from looking frozen
  // mid-turn.
  const isStreaming = useSessionStore((s) =>
    sessionId !== undefined ? (s.streamingBySession[sessionId] ?? false) : false,
  );
  const streamingText = useSessionStore((s) =>
    sessionId !== undefined ? (s.streamingTextBySession[sessionId] ?? "") : "",
  );

  const [data, setData] = useState<SessionContextResponse | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [turnsExpanded, setTurnsExpanded] = useState(false);
  const [showThinking, setShowThinking] = useState(false);
  const [search, setSearch] = useState(""); // Ctx6 — filter the message list
  const [rawView, setRawView] = useState<{ index: number; payload: unknown } | undefined>(
    undefined,
  );
  // Ctx2 — abort any in-flight refresh when a new one starts so a
  // slow earlier response can't clobber a fresh one. Mirrors the
  // pattern in SearchPanel.
  const abortRef = useRef<AbortController | undefined>(undefined);

  const refresh = async (): Promise<void> => {
    if (sessionId === undefined) {
      setData(undefined);
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      const r = await api.getSessionContext(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      setData(r);
    } catch (err) {
      // Aborts (from a newer refresh racing the older one) are
      // expected; never surface as errors.
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return;
      }
      // 404 just means the session isn't loaded yet — clear state
      // rather than scaring the user with a red banner.
      if (err instanceof ApiError && err.status === 404) {
        setData(undefined);
        setError(undefined);
      } else {
        setError(err instanceof ApiError ? err.code : (err as Error).message);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };

  // Initial load + agent_end + compaction_end refresh. Skip the dep
  // on `refresh` because it's a fresh closure each render and would
  // self-loop. The compaction counter is a separate signal so a
  // compaction with no agent_end (the SDK can compact mid-turn)
  // still kicks the pane to refetch token usage.
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, agentEndCount, compactionEndCount]);

  // Cancel any in-flight request on unmount.
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  if (sessionId === undefined) {
    return (
      <div className="flex h-full items-center justify-center px-4 py-6 text-center text-xs italic text-neutral-500">
        Select a session to inspect its context.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-xs text-neutral-200">
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/40 px-3 py-1.5">
        <span className="text-[10px] uppercase tracking-wider text-neutral-400">
          Context inspector
        </span>
        <div className="flex items-center gap-1">
          {loading && <Loader2 size={11} className="animate-spin text-neutral-500" />}
          <button
            onClick={() => void refresh()}
            disabled={loading}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-40"
            title="Refresh"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {error !== undefined && (
        <div className="border-b border-red-700/40 bg-red-900/20 px-3 py-1.5 text-[11px] text-red-300 light:border-red-300 light:bg-red-50 light:text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
        {data === undefined ? (
          <div className="px-4 py-6 text-center text-xs italic text-neutral-500">
            {loading ? "Loading…" : "No data — try refresh."}
          </div>
        ) : (
          <>
            <TokenSummary
              data={data}
              turnsExpanded={turnsExpanded}
              onToggleTurns={() => setTurnsExpanded((v) => !v)}
            />
            <MessageList
              messages={data.messages}
              showThinking={showThinking}
              onToggleThinking={() => setShowThinking((v) => !v)}
              onViewRaw={(index, payload) => setRawView({ index, payload })}
              search={search}
              onSearchChange={setSearch}
              {...(isStreaming && streamingText.length > 0
                ? { streamingTail: { content: streamingText } }
                : {})}
            />
          </>
        )}
      </div>

      {rawView !== undefined && (
        <RawJsonModal
          title={`Message ${rawView.index} — raw AgentMessage JSON`}
          payload={rawView.payload}
          onClose={() => setRawView(undefined)}
        />
      )}
    </div>
  );
}

/* ------------------------------ token summary ------------------------------ */

function TokenSummary({
  data,
  turnsExpanded,
  onToggleTurns,
}: {
  data: SessionContextResponse;
  turnsExpanded: boolean;
  onToggleTurns: () => void;
}) {
  const cu = data.contextUsage;
  // Always derive the bar percent from tokens / contextWindow rather
  // than honoring the SDK's `percent` field. The SDK reports percent
  // as 0..100 (e.g. 1.19 = 1.19%); my earlier code multiplied that
  // by 100 again and produced "119%" for a session that was actually
  // 1% full. Deriving locally avoids the unit ambiguity entirely.
  //
  // `cu.tokens` is the *current* context-window state — what counts
  // toward the next request's input limit. NOT the lifetime token
  // sum (which inflates with cache reads + every prior turn). When
  // the SDK doesn't have a fresh number (right after compaction),
  // we use the per-message breakdown total below as the estimate.
  const breakdown = useMemo(
    () => categorizeContext(data.messages, cu.tokens),
    [data.messages, cu.tokens],
  );
  // Per-turn "new content" delta: sum of estimated tokens for every
  // user / toolResult message between this assistant turn and the
  // prior assistant turn. Answers "what did this turn ACTUALLY add
  // to the context?" — distinct from usage.input which is the full
  // re-sent prompt. Keyed by message index for O(1) lookup in the
  // turn table.
  const newDeltas = useMemo(
    () => computeNewDeltas(data.messages, data.turns),
    [data.messages, data.turns],
  );
  const usageTokens = cu.tokens ?? breakdown.total;
  const usagePct = cu.contextWindow > 0 ? Math.min(1, usageTokens / cu.contextWindow) : 0;
  const usageLabel = cu.tokens === undefined ? "estimate" : "current";
  return (
    <div className="space-y-2 border-b border-neutral-800 px-3 py-2">
      {/* Context-window bar */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[10px] text-neutral-400">
          <span>Context window ({usageLabel})</span>
          <span>
            {formatTokens(usageTokens)} /{" "}
            {cu.contextWindow > 0 ? formatTokens(cu.contextWindow) : "unknown"}
            {cu.contextWindow > 0 && (
              <span className="ml-1 text-neutral-600">({(usagePct * 100).toFixed(1)}%)</span>
            )}
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded bg-neutral-800">
          <div
            className={`h-full ${usagePct > 0.9 ? "bg-red-500" : usagePct > 0.7 ? "bg-amber-500" : "bg-emerald-500"}`}
            style={{ width: `${Math.max(2, Math.min(100, usagePct * 100))}%` }}
          />
        </div>
      </div>

      {/* Per-category breakdown — what's *actually* taking up the
          window, derived client-side from the current message array.
          Estimates are ~chars/3 (same heuristic as estimateTokens).
          The SDK doesn't ship a categorized breakdown, so this is
          best-effort and may differ from the provider's true count. */}
      <ContextBreakdown breakdown={breakdown} contextWindow={cu.contextWindow} />

      {/* Last turn + lifetime totals. Three numbers per row, each
          answering a distinct question:
            - "New": NEW user/tool content the LLM saw this turn,
              derived from the message-array delta since the prior
              assistant turn. NOT usage.input (which is the full
              re-sent prompt and grows monotonically with
              conversation length).
            - "Out": tokens the assistant produced (genuinely per-turn).
            - "Cost": that turn's bill, normalized across input/cache.
          The lifetime row uses sums of the same usage fields the
          per-turn table shows, with explicit "Prompt billed" wording
          so users don't read it as "new tokens entered." */}
      <div className="space-y-0.5 border-t border-neutral-800 pt-1.5">
        {data.turns.length > 0 &&
          (() => {
            const last = data.turns[data.turns.length - 1]!;
            const lastNew = newDeltas.get(last.index) ?? 0;
            return (
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-neutral-500">Last turn</span>
                <span
                  className="font-mono text-neutral-300"
                  title="New = user message + tool results since the prior assistant turn (estimate). Out = assistant output tokens. Cost = that turn's billed cost."
                >
                  ~{formatTokens(lastNew)} new · {formatTokens(last.outputTokens)} out ·{" "}
                  {formatUsd(last.cost)}
                </span>
              </div>
            );
          })()}
        {/* Lifetime billing components on their own lines.
            Combining them into a single "Prompt billed" sum
            (previous iteration) made the number look implausible:
            39 turns × pi's ~12k system prompt + tool defs is ~470k
            of "input" alone, which is correct but offers no
            insight into where the bytes went. Each component on
            its own line lets the user see the actual story:
            usually the cache-served line is dominant because every
            turn re-reads prior context from cache (billed at ~10%
            of input rate). The "Total cost" below is the
            bottom-line dollar amount that normalises everything. */}
        <div className="flex items-center justify-between text-[11px]">
          <span
            className="text-neutral-500"
            title="Sum of `usage.input` per turn — NEW non-cached input the LLM saw across the session. Excludes cached portions (tracked separately below)."
          >
            Input (lifetime)
          </span>
          <span className="font-mono text-neutral-400">{formatTokens(data.totalInputTokens)}</span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span
            className="text-neutral-500"
            title="Sum of `usage.cacheRead` per turn — prior context served from the prompt cache. Counted ONCE PER API CALL: every turn re-reads the same cached content and re-pays the (discounted) read fee, so this number grows ~quadratically with conversation length. Billed at ~10% of input rate on most providers."
          >
            Cache served (lifetime)
          </span>
          <span className="font-mono text-neutral-400">
            {formatTokens(data.totalCacheReadTokens)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span
            className="text-neutral-500"
            title="Sum of `usage.cacheWrite` per turn — portions cached for reuse on subsequent turns. Billed at ~125% of input rate; small premium up front for big savings on the cache-served line."
          >
            Cache written (lifetime)
          </span>
          <span className="font-mono text-neutral-400">
            {formatTokens(data.totalCacheWriteTokens)}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px]">
          <span
            className="text-neutral-500"
            title="Sum of `usage.output` per turn — assistant tokens generated."
          >
            Output (lifetime)
          </span>
          <span className="font-mono text-neutral-400">{formatTokens(data.totalOutputTokens)}</span>
        </div>
        <div className="flex items-center justify-between text-[11px] font-medium">
          <span className="text-neutral-300">Total cost</span>
          <span className="font-mono text-emerald-400 light:text-emerald-700">
            {formatUsd(data.totalCost)}
          </span>
        </div>
      </div>

      {/* Per-turn breakdown */}
      {data.turns.length > 0 && (
        <div>
          <button
            onClick={onToggleTurns}
            className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-400 hover:text-neutral-200"
          >
            {turnsExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            Per-turn ({data.turns.length})
          </button>
          {turnsExpanded && <TurnsTable turns={data.turns} newDeltas={newDeltas} />}
        </div>
      )}
    </div>
  );
}

/* ------------------------- context category breakdown ------------------------- */

interface ContextBreakdownData {
  systemAndTools: number;
  userPrompts: number;
  assistantText: number;
  thinking: number;
  toolCalls: number;
  toolResults: number;
  images: number;
  total: number;
}

const BREAKDOWN_PALETTE: {
  key: keyof Omit<ContextBreakdownData, "total">;
  label: string;
  color: string;
}[] = [
  // System prompt + tool schemas come first because they're the
  // fixed cost of every turn — useful to see at a glance how much
  // budget is "spent" before any user content.
  { key: "systemAndTools", label: "System + tools", color: "#64748b" },
  { key: "userPrompts", label: "User prompts", color: "#0ea5e9" },
  { key: "assistantText", label: "Assistant text", color: "#a78bfa" },
  { key: "thinking", label: "Thinking", color: "#71717a" },
  { key: "toolCalls", label: "Tool calls", color: "#f59e0b" },
  { key: "toolResults", label: "Tool results", color: "#10b981" },
  { key: "images", label: "Images", color: "#ec4899" },
];

function ContextBreakdown({
  breakdown,
  contextWindow,
}: {
  breakdown: ContextBreakdownData;
  contextWindow: number;
}) {
  const total = breakdown.total;
  if (total === 0) return null;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[10px] text-neutral-400">
        <span>What&rsquo;s in the context</span>
        <span className="text-neutral-600" title="Sum of category estimates (~chars/3)">
          ~{formatTokens(total)} tok
          {contextWindow > 0 && (
            <span className="ml-1">({((total / contextWindow) * 100).toFixed(1)}%)</span>
          )}
        </span>
      </div>
      {/* Stacked horizontal bar — one segment per category, widths
          proportional to its share of `total` (not contextWindow,
          so a small session still fills the bar and the relative
          mix is readable). */}
      <div className="flex h-1.5 w-full overflow-hidden rounded bg-neutral-800">
        {BREAKDOWN_PALETTE.map((c) => {
          const v = breakdown[c.key];
          if (v === 0) return null;
          const pct = (v / total) * 100;
          return (
            <div
              key={c.key}
              style={{ width: `${pct}%`, background: c.color }}
              title={`${c.label}: ${formatTokens(v)} tok (${pct.toFixed(1)}%)`}
            />
          );
        })}
      </div>
      <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px]">
        {BREAKDOWN_PALETTE.map((c) => {
          const v = breakdown[c.key];
          if (v === 0) return null;
          const pct = (v / total) * 100;
          return (
            <li key={c.key} className="flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ background: c.color }}
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-neutral-400">{c.label}</span>
              <span className="font-mono text-neutral-300">{formatTokens(v)}</span>
              <span className="w-10 text-right text-neutral-600">{pct.toFixed(0)}%</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Walk the messages array and bucket text into context categories.
 * Token estimate is the same ~chars/CHARS_PER_TOKEN heuristic that
 * `estimateTokens` uses — provider-specific tokenizers would be
 * more accurate, but the per-turn `usage` data above carries the
 * authoritative numbers.
 * This breakdown answers "where did the tokens go?", which is a
 * relative question that survives the heuristic.
 *
 * `actualTotalTokens` (when known via the SDK's getContextUsage)
 * lets us derive the system-prompt + tool-schema residual: the
 * actual context contains all the message-array content PLUS the
 * system instructions PLUS each tool's JSON schema, none of which
 * appear in `session.messages`. Without the residual the breakdown
 * sums to less than the bar, hiding what's often the biggest line
 * item (pi's system prompt + tool defs are several thousand tokens).
 *
 * Image content is counted as a per-attachment placeholder rather
 * than being measured byte-wise — provider image tokens scale with
 * resolution, not file size. (See Ctx3 in DEFERRED.md for the
 * proper fix.)
 */
function categorizeContext(
  messages: Record<string, unknown>[],
  actualTotalTokens?: number,
): ContextBreakdownData {
  let userChars = 0;
  let asstTextChars = 0;
  let thinkingChars = 0;
  let toolCallChars = 0;
  let toolResultChars = 0;
  let imageCount = 0;
  for (const m of messages) {
    const role = typeof m.role === "string" ? m.role : "";
    const content = m.content;
    if (role === "user") {
      if (typeof content === "string") {
        userChars += content.length;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const o = c as { type?: unknown; text?: unknown };
          if (o.type === "text" && typeof o.text === "string") userChars += o.text.length;
          else if (o.type === "image") imageCount += 1;
        }
      }
    } else if (role === "assistant" && Array.isArray(content)) {
      for (const c of content) {
        // Block types per @earendil-works/pi-ai's types.d.ts:
        // TextContent     {type:"text",     text:string}
        // ThinkingContent {type:"thinking", thinking:string}   ← NOT `text`
        // ToolCall        {type:"toolCall", arguments:object}  ← NOT `toolUse`/`input`
        // Earlier revisions of this categorizer used the wire-level
        // Anthropic shape (`toolUse`/`input`), which silently zeroed
        // out the toolCalls + thinking buckets and made every byte
        // they should have held leak into `systemAndTools` (the
        // residual). End-effect: a tool-call turn made it look like
        // the SDK was double-counting the tool result.
        const o = c as {
          type?: unknown;
          text?: unknown;
          thinking?: unknown;
          arguments?: unknown;
        };
        if (o.type === "text" && typeof o.text === "string") {
          asstTextChars += o.text.length;
        } else if (o.type === "thinking" && typeof o.thinking === "string") {
          thinkingChars += o.thinking.length;
        } else if (o.type === "toolCall") {
          // Tool args go through the LLM as a JSON-encoded string;
          // measuring the JSON length is closer to the truth than
          // measuring raw character counts of object values.
          try {
            toolCallChars += JSON.stringify(o.arguments ?? {}).length;
          } catch {
            // circular ref → estimate via toString
            toolCallChars += String(o.arguments ?? "").length;
          }
        }
      }
    } else if (role === "toolResult") {
      if (typeof content === "string") {
        toolResultChars += content.length;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          const o = c as { type?: unknown; text?: unknown };
          if (o.type === "text" && typeof o.text === "string") {
            toolResultChars += o.text.length;
          } else if (o.type === "image") {
            imageCount += 1;
          }
        }
      }
    }
  }
  // CHARS_PER_TOKEN is tuned for code/JSON-heavy pi-forge sessions;
  // see the constant's docstring at the top of the file. Image
  // rough estimate at 1500 tok/image — between Anthropic's ~1200
  // (1024px square) and OpenAI's ~1700 (high-detail). Same numbers
  // used in `estimateTokens` for consistency; both undercount large
  // images.
  const tokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);
  const userPrompts = tokens(userChars);
  const assistantText = tokens(asstTextChars);
  const thinking = tokens(thinkingChars);
  const toolCalls = tokens(toolCallChars);
  const toolResults = tokens(toolResultChars);
  const images = imageCount * 1500;
  const messageTotal = userPrompts + assistantText + thinking + toolCalls + toolResults + images;
  // System + tools = whatever the SDK reports as the actual context
  // total minus what we accounted for in the message array. Falls
  // back to 0 if the SDK didn't report (e.g. right after compaction)
  // — better to under-show than to fabricate a number.
  const systemAndTools =
    actualTotalTokens !== undefined && actualTotalTokens > messageTotal
      ? actualTotalTokens - messageTotal
      : 0;
  return {
    systemAndTools,
    userPrompts,
    assistantText,
    thinking,
    toolCalls,
    toolResults,
    images,
    total: messageTotal + systemAndTools,
  };
}

function TurnsTable({
  turns,
  newDeltas,
}: {
  turns: ContextTurn[];
  newDeltas: Map<number, number>;
}) {
  // Columns answer four distinct questions per turn:
  //   New     — estimated NEW tokens this turn (user message + tool
  //             results since the prior assistant turn). The number
  //             you want when asking "how big was this exchange?"
  //   Prompt  — usage.input + cacheRead + cacheWrite from the
  //             provider. The full input the LLM saw, including
  //             re-sent prior context. Grows monotonically with
  //             conversation length — that's normal LLM behavior,
  //             not a bug.
  //   Out     — assistant output tokens this turn (purely per-turn).
  //   Cost    — that turn's billed cost (normalises across cache
  //             pricing differences).
  // Hover each header for the precise definition; hover the Prompt
  // value for its input/cR/cW breakdown.
  return (
    <div className="mt-1 overflow-x-auto">
      <table className="w-full font-mono text-[10px]">
        <thead className="text-neutral-500">
          <tr>
            <th className="pr-2 text-left font-normal">#</th>
            <th className="pr-2 text-left font-normal">Model</th>
            <th
              className="pr-2 text-right font-normal"
              title="Estimated new tokens this turn — user message + tool results since the prior assistant turn (~chars/3 estimate). Distinct from Prompt."
            >
              New
            </th>
            <th
              className="pr-2 text-right font-normal"
              title="Full prompt sent to the LLM = usage.input + cacheRead + cacheWrite. Includes ALL re-sent prior context — this grows monotonically with conversation length, which is normal LLM behavior."
            >
              Prompt
            </th>
            <th className="pr-2 text-right font-normal" title="Assistant output tokens this turn">
              Out
            </th>
            <th className="text-right font-normal" title="Cost billed for this turn">
              Cost
            </th>
          </tr>
        </thead>
        <tbody className="text-neutral-300">
          {turns.map((t, i) => {
            const promptTotal = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens;
            const newTokens = newDeltas.get(t.index) ?? 0;
            return (
              <tr key={`${t.index}-${t.timestamp}`} className="border-t border-neutral-800/60">
                <td className="pr-2 text-neutral-600">{i + 1}</td>
                <td className="max-w-[140px] truncate pr-2" title={`${t.provider}/${t.model}`}>
                  {t.model}
                </td>
                <td className="pr-2 text-right text-neutral-200" title="New content (estimate)">
                  ~{formatTokens(newTokens)}
                </td>
                <td
                  className="pr-2 text-right"
                  title={`input ${formatTokens(t.inputTokens)} + cR ${formatTokens(
                    t.cacheReadTokens,
                  )} + cW ${formatTokens(t.cacheWriteTokens)}`}
                >
                  {formatTokens(promptTotal)}
                </td>
                <td className="pr-2 text-right">{formatTokens(t.outputTokens)}</td>
                <td className="text-right text-emerald-400 light:text-emerald-700">
                  {formatUsd(t.cost)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------ message list ------------------------------ */

function MessageList({
  messages,
  showThinking,
  onToggleThinking,
  onViewRaw,
  search,
  onSearchChange,
  streamingTail,
}: {
  messages: Record<string, unknown>[];
  showThinking: boolean;
  onToggleThinking: () => void;
  onViewRaw: (index: number, payload: unknown) => void;
  /** Ctx6 — case-insensitive substring filter against role + preview. */
  search: string;
  onSearchChange: (next: string) => void;
  /** Ctx1 — synthetic tail row for the streaming-in-progress assistant. */
  streamingTail?: { content: string };
}) {
  // Ctx6 — case-insensitive search across role + preview text. Empty
  // query means "no filter" (the common case). Indexes are
  // preserved in the filtered view so onViewRaw still passes the
  // ORIGINAL message index to the raw-JSON modal.
  const q = search.trim().toLowerCase();
  const filtered = useMemo(() => {
    if (q.length === 0) return messages.map((m, i) => ({ msg: m, originalIndex: i }));
    return messages
      .map((m, i) => ({ msg: m, originalIndex: i }))
      .filter(({ msg }) => {
        const role = typeof msg.role === "string" ? msg.role.toLowerCase() : "";
        if (role.includes(q)) return true;
        const preview = extractPreview(msg, true).toLowerCase();
        return preview.includes(q);
      });
  }, [messages, q]);
  return (
    <div className="px-2 py-2">
      <div className="mb-1 flex items-center justify-between gap-2 px-1">
        <span className="shrink-0 text-[10px] uppercase tracking-wider text-neutral-400">
          Messages ({q.length > 0 ? `${filtered.length}/${messages.length}` : messages.length})
        </span>
        <label className="flex items-center gap-1 text-[10px] text-neutral-500 hover:text-neutral-300">
          <input
            type="checkbox"
            checked={showThinking}
            onChange={onToggleThinking}
            className="h-3 w-3"
          />
          Show thinking blocks
        </label>
      </div>
      {/* Ctx6 — search box. Mounts only when there are enough
          messages to make scrolling annoying; below ~10, scrolling
          is fine and the input is just clutter. */}
      {messages.length >= 10 && (
        <div className="relative mb-1 px-1">
          <Search
            size={11}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Find in messages…"
            className="w-full rounded border border-neutral-800 bg-neutral-950 py-1 pl-6 pr-2 text-[11px] text-neutral-200 placeholder:text-neutral-600 focus:border-neutral-600 focus:outline-none"
          />
        </div>
      )}
      <ul className="space-y-1">
        {filtered.map(({ msg, originalIndex }) => (
          <MessageRow
            key={originalIndex}
            index={originalIndex}
            message={msg}
            showThinking={showThinking}
            onViewRaw={() => onViewRaw(originalIndex, msg)}
          />
        ))}
        {/* Ctx1 — streaming tail row. Only renders when the agent is
            actively generating; transitions to a real assistant
            message in `messages` on agent_end (route refetches
            within the same effect). The truncate matches the rest
            of the list visually; the row is non-interactive (no
            raw-view button) since the underlying message doesn't
            exist yet. */}
        {streamingTail !== undefined && q.length === 0 && (
          <li className="rounded border border-violet-700/40 bg-violet-900/10 light:border-violet-300 light:bg-violet-50">
            <div className="flex items-start gap-2 px-2 py-1.5">
              <Loader2
                size={11}
                className="mt-0.5 shrink-0 animate-spin text-violet-300 light:text-violet-700"
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="rounded bg-violet-900/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-violet-300 light:bg-violet-100 light:text-violet-800">
                    assistant (streaming)
                  </span>
                </div>
                <p className="line-clamp-2 text-[11px] text-neutral-300">{streamingTail.content}</p>
              </div>
            </div>
          </li>
        )}
      </ul>
    </div>
  );
}

function MessageRow({
  index,
  message,
  showThinking,
  onViewRaw,
}: {
  index: number;
  message: Record<string, unknown>;
  showThinking: boolean;
  onViewRaw: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const role = typeof message.role === "string" ? message.role : "unknown";
  // Pi's compaction emits a synthesized message via
  // `createCompactionSummaryMessage` with `role: "compactionSummary"`
  // — distinct from any standard role. The earlier heuristic
  // (`role: "system" && message.compacted: boolean`) never matched
  // because the SDK doesn't tag system messages that way.
  const isCompacted = role === "compactionSummary";
  // Synthesize a compact preview from the message — the full content
  // (and JSON) is one click away via the raw-view button.
  const preview = useMemo(() => extractPreview(message, showThinking), [message, showThinking]);
  const tokenEstimate = estimateTokens(message);
  const ts = typeof message.timestamp === "number" ? message.timestamp : 0;
  return (
    <li className="rounded border border-neutral-800/70 bg-neutral-900/30">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-neutral-900/60"
      >
        <span className="pt-0.5 text-neutral-600">
          {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className={`rounded px-1.5 py-0.5 text-[9px] uppercase tracking-wider ${roleClass(role)}`}
            >
              {role}
            </span>
            {isCompacted && (
              <span className="rounded bg-fuchsia-900/40 px-1.5 py-0.5 text-[9px] text-fuchsia-300 light:bg-fuchsia-100 light:text-fuchsia-800">
                compacted
              </span>
            )}
            <span className="text-[10px] text-neutral-600">~{formatTokens(tokenEstimate)} tok</span>
            {ts > 0 && (
              <span className="text-[10px] text-neutral-600">
                {new Date(ts).toLocaleTimeString()}
              </span>
            )}
          </div>
          {!expanded && preview.length > 0 && (
            <p className="line-clamp-2 text-[11px] text-neutral-400">{preview}</p>
          )}
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onViewRaw();
          }}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
          title="View raw AgentMessage JSON"
        >
          <Code2 size={11} />
        </button>
      </button>
      {expanded && (
        <div className="space-y-1 border-t border-neutral-800/70 px-3 py-2">
          {renderExpanded(message, showThinking, index)}
        </div>
      )}
    </li>
  );
}

/* ------------------------------ raw json modal ------------------------------ */

function RawJsonModal({
  title,
  payload,
  onClose,
}: {
  title: string;
  payload: unknown;
  onClose: () => void;
}) {
  const json = useMemo(() => {
    try {
      return JSON.stringify(payload, null, 2);
    } catch {
      // Circular ref or non-serializable — fall back to a safe string.
      return String(payload);
    }
  }, [payload]);
  // Esc-to-close + click-outside-to-close. The keydown listener
  // re-binds each open so we don't leak it after unmount.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-8"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-full max-h-[720px] w-full max-w-4xl flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
          <span className="text-xs text-neutral-200">{title}</span>
          <button
            onClick={onClose}
            className="rounded p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
            title="Close (Esc)"
          >
            <X size={20} />
          </button>
        </header>
        {/* Ctx5 — syntax-highlighted via prism-react-renderer (already
            a dep from the diff palette). vsDark theme reads cleanly
            on neutral-950 and matches the rest of the dark-themed
            surfaces. The library renders its own <pre>/<code>; we
            wrap in a flex container so the pre fills the modal and
            scrolls. */}
        <Highlight code={json} language="json" theme={prismThemes.vsDark}>
          {({ style, tokens, getLineProps, getTokenProps }) => (
            <pre
              className="flex-1 overflow-auto whitespace-pre p-3 font-mono text-[11px]"
              style={{ ...style, background: "transparent" }}
            >
              {tokens.map((line, i) => {
                const lineProps = getLineProps({ line });
                return (
                  <div key={i} {...lineProps}>
                    {line.map((token, key) => {
                      const tokenProps = getTokenProps({ token });
                      return <span key={key} {...tokenProps} />;
                    })}
                  </div>
                );
              })}
            </pre>
          )}
        </Highlight>
      </div>
    </div>
  );
}

/* ------------------------------ helpers ------------------------------ */

function roleClass(role: string): string {
  // Each role uses a dark-mode tint (bg-X-900/40 + text-X-300) paired
  // with a light-mode counterpart (bg-X-100 + text-X-800) via the
  // `light:` variant defined in index.css.
  if (role === "user") return "bg-sky-900/40 text-sky-300 light:bg-sky-100 light:text-sky-800";
  if (role === "assistant")
    return "bg-violet-900/40 text-violet-300 light:bg-violet-100 light:text-violet-800";
  if (role === "tool" || role === "toolResult")
    return "bg-amber-900/40 text-amber-300 light:bg-amber-100 light:text-amber-800";
  if (role === "compactionSummary")
    return "bg-fuchsia-900/40 text-fuchsia-300 light:bg-fuchsia-100 light:text-fuchsia-800";
  if (role === "system") return "bg-neutral-800 text-neutral-400";
  return "bg-neutral-800 text-neutral-400";
}

/**
 * Heuristic preview for the collapsed row. Pulls text from the
 * message's content field — string, array of blocks, or
 * tool-result payload — and trims to a one-liner. Filters out
 * thinking blocks unless the user opted into showing them.
 */
function extractPreview(message: Record<string, unknown>, showThinking: boolean): string {
  const content = message.content;
  if (typeof content === "string") return content.slice(0, 200);
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const c of content) {
    const o = c as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown };
    if (o.type === "thinking" && !showThinking) continue;
    if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
    else if (o.type === "thinking" && typeof o.thinking === "string")
      parts.push(`[thinking] ${o.thinking}`);
    else if (o.type === "toolCall" && typeof o.name === "string") parts.push(`[tool: ${o.name}]`);
  }
  return parts.join(" ").slice(0, 200);
}

/**
 * Rough token estimate using CHARS_PER_TOKEN (see top-of-file
 * docstring for why 3 and not 4). Used in the row badge as an
 * at-a-glance signal; the real per-turn counts come from the
 * SDK's usage field rendered in TurnsTable. Image constant
 * matches `categorizeContext` for consistency (1500 tok/image:
 * between Anthropic's ~1200 and OpenAI's ~1700 high-detail).
 */
function estimateTokens(message: Record<string, unknown>): number {
  // Prefer the SDK's actual usage when present (assistant messages).
  const u = message.usage as { totalTokens?: unknown } | undefined;
  if (u !== undefined && typeof u.totalTokens === "number") return u.totalTokens;
  const content = message.content;
  if (typeof content === "string") return Math.ceil(content.length / CHARS_PER_TOKEN);
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  let images = 0;
  for (const c of content) {
    const o = c as { text?: unknown; type?: unknown };
    if (typeof o.text === "string") chars += o.text.length;
    if (o.type === "image") images += 1;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * 1500;
}

/**
 * For each assistant turn, estimate the NEW tokens this turn added
 * to the context — i.e. the user message + tool results between
 * this assistant turn and the previous one. Excludes the assistant
 * turn itself (its output is reported separately) and excludes any
 * earlier history (which is "re-sent context", not new).
 *
 * Returned as a Map keyed by message index for O(1) lookup in the
 * per-turn table. The first turn's "new" includes everything before
 * it (which is normally just the first user message). Subsequent
 * turns' "new" only includes content between consecutive assistant
 * messages.
 *
 * Uses the same ~chars/CHARS_PER_TOKEN heuristic as
 * `estimateTokens` and `categorizeContext` so the three numbers
 * tell a consistent story.
 * This is a UX-grade estimate; the per-turn `Prompt` column shows
 * the provider's authoritative input number alongside.
 */
function computeNewDeltas(
  messages: Record<string, unknown>[],
  turns: ContextTurn[],
): Map<number, number> {
  const result = new Map<number, number>();
  let prevAssistantIdx = -1;
  for (const t of turns) {
    let sum = 0;
    for (let i = prevAssistantIdx + 1; i < t.index; i++) {
      const m = messages[i];
      if (m === undefined) continue;
      const role = typeof m.role === "string" ? m.role : "";
      // Only user prompts and tool results count as "new" — assistant
      // messages between turns shouldn't happen, and meta entries
      // (system_info, etc.) aren't part of the conversation flow.
      if (role !== "user" && role !== "toolResult") continue;
      sum += estimateTokens(m);
    }
    result.set(t.index, sum);
    prevAssistantIdx = t.index;
  }
  return result;
}

function renderExpanded(
  message: Record<string, unknown>,
  showThinking: boolean,
  index: number,
): ReactElement {
  const role = typeof message.role === "string" ? message.role : "unknown";
  const content = message.content;
  if (role === "toolResult") {
    return (
      <div>
        <p className="mb-1 text-[10px] text-neutral-500">
          tool: <span className="font-mono">{String(message.toolName ?? "unknown")}</span>{" "}
          {message.isError === true && (
            <span className="text-red-400 light:text-red-700">(error)</span>
          )}
        </p>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-neutral-950 p-2 font-mono text-[10px] text-neutral-300">
          {jsonish(content)}
        </pre>
      </div>
    );
  }
  if (Array.isArray(content)) {
    return (
      <>
        {content.map((c, i) => {
          const o = c as {
            type?: unknown;
            text?: unknown;
            thinking?: unknown;
            name?: unknown;
            arguments?: unknown;
          };
          if (o.type === "thinking" && !showThinking) return null;
          if (o.type === "text" || o.type === "thinking") {
            const body = o.type === "thinking" ? o.thinking : o.text;
            return (
              <pre
                key={`${index}-${i}`}
                className={`whitespace-pre-wrap break-words font-sans text-[11px] ${
                  o.type === "thinking" ? "italic text-neutral-500" : "text-neutral-200"
                }`}
              >
                {String(body ?? "")}
              </pre>
            );
          }
          if (o.type === "toolCall") {
            return (
              <div key={`${index}-${i}`} className="rounded border border-neutral-800 p-2">
                <p className="mb-1 text-[10px] text-neutral-500">
                  tool call: <span className="font-mono">{String(o.name ?? "unknown")}</span>
                </p>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-neutral-300">
                  {jsonish(o.arguments)}
                </pre>
              </div>
            );
          }
          if (o.type === "image") {
            return (
              <p key={`${index}-${i}`} className="text-[11px] italic text-neutral-500">
                [image attachment]
              </p>
            );
          }
          return (
            <pre
              key={`${index}-${i}`}
              className="whitespace-pre-wrap break-words font-mono text-[10px] text-neutral-500"
            >
              {jsonish(o)}
            </pre>
          );
        })}
      </>
    );
  }
  if (typeof content === "string") {
    return (
      <pre className="whitespace-pre-wrap break-words font-sans text-[11px] text-neutral-200">
        {content}
      </pre>
    );
  }
  return (
    <pre className="whitespace-pre-wrap break-words font-mono text-[10px] text-neutral-500">
      {jsonish(message)}
    </pre>
  );
}

function jsonish(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // Cyclic graph or BigInt — neither is expected from SDK messages
    // but `String(value)` always produces something renderable.
    return String(value);
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

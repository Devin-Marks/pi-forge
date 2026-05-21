import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Loader2, MessageCircle } from "lucide-react";
import { api, ApiError, type AskUserQuestionAnswer } from "../lib/api-client";
import {
  useAskUserQuestionStore,
  type AskQuestion,
  type PendingAskQuestion,
} from "../store/ask-user-question-store";

/**
 * Inline panel that surfaces a pending `ask_user_question` tool
 * call. Renders directly above the chat input rather than as an
 * overlay so the user can still scroll the chat for context while
 * answering. The agent is blocked on this — it cannot continue
 * until we POST an answer or cancel.
 *
 * Three layouts, picked per-question:
 *  - single-select + no preview:   vertical option list + "Type
 *                                  something" free-text fallback
 *  - multi-select:                 checkbox list (no free-text)
 *  - single-select + any preview:  side-by-side; options left,
 *                                  focused option's preview right
 *
 * Multi-question forms are tabbed: each Next advances; final
 * submit POSTs the full answer set. "Chat about this" at any
 * tab cancels the whole questionnaire (the plugin's escape
 * hatch).
 */
interface Props {
  sessionId: string;
}

export function AskUserQuestionPanel({ sessionId }: Props) {
  const pending = useAskUserQuestionStore((s) => s.pendingBySession[sessionId]);
  if (pending === undefined) return null;
  // Keyed by requestId so a different question replacing the
  // current one resets all internal state cleanly.
  return <PanelBody key={pending.requestId} pending={pending} />;
}

interface PendingAnswer {
  // Single-select: option label or null (until picked or custom typed).
  // Multi-select: array of selected labels.
  selectedLabel?: string | undefined;
  customText?: string | undefined;
  multiLabels?: string[] | undefined;
}

function PanelBody({ pending }: { pending: PendingAskQuestion }) {
  const clearPending = useAskUserQuestionStore((s) => s.clearPending);
  const [tab, setTab] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // One answer-draft per question — `null` slots until visited.
  const [drafts, setDrafts] = useState<(PendingAnswer | null)[]>(() =>
    pending.questions.map(() => null),
  );

  const current = pending.questions[tab];
  if (current === undefined) return null;

  const setDraft = (patch: Partial<PendingAnswer>): void => {
    setDrafts((arr) => {
      const next = arr.slice();
      next[tab] = { ...(next[tab] ?? {}), ...patch };
      return next;
    });
  };

  const draft = drafts[tab];

  const validForCurrent = (): boolean => {
    if (current.multiSelect === true) {
      return draft?.multiLabels !== undefined && draft.multiLabels.length > 0;
    }
    if (draft?.selectedLabel !== undefined) return true;
    if (draft?.customText !== undefined && draft.customText.trim().length > 0) return true;
    return false;
  };

  const buildAnswers = (): AskUserQuestionAnswer[] => {
    const out: AskUserQuestionAnswer[] = [];
    for (let i = 0; i < pending.questions.length; i += 1) {
      const q = pending.questions[i]!;
      const d = drafts[i];
      if (d === null || d === undefined) continue;
      if (q.multiSelect === true) {
        out.push({
          questionIndex: i,
          question: q.question,
          kind: "multi",
          answer: null,
          ...(d.multiLabels !== undefined ? { selected: d.multiLabels } : {}),
        });
        continue;
      }
      if (d.selectedLabel !== undefined) {
        const opt = q.options.find((o) => o.label === d.selectedLabel);
        out.push({
          questionIndex: i,
          question: q.question,
          kind: "option",
          answer: d.selectedLabel,
          ...(opt?.preview !== undefined ? { preview: opt.preview } : {}),
        });
        continue;
      }
      if (d.customText !== undefined && d.customText.trim().length > 0) {
        out.push({
          questionIndex: i,
          question: q.question,
          kind: "custom",
          answer: d.customText.trim(),
        });
        continue;
      }
    }
    return out;
  };

  const advanceOrSubmit = async (): Promise<void> => {
    if (!validForCurrent()) return;
    if (tab < pending.questions.length - 1) {
      setTab(tab + 1);
      return;
    }
    // Final tab: submit all answers.
    setSubmitting(true);
    setError(undefined);
    try {
      await api.submitAskUserQuestionAnswer(pending.sessionId, {
        requestId: pending.requestId,
        answers: buildAnswers(),
      });
      // The server emits ask_user_question_cancelled on success, which
      // clears the store — but to avoid the modal flickering while
      // the SSE event round-trips, clear locally too.
      clearPending(pending.sessionId, pending.requestId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
      setSubmitting(false);
    }
  };

  const chatAboutThis = async (): Promise<void> => {
    setSubmitting(true);
    setError(undefined);
    try {
      // "Chat about this" returns ONE chat-kind answer for the
      // current question and cancels the rest. Matches the plugin's
      // semantics: the model sees that the user opted out, with
      // context for which question they bailed on.
      const chatAnswer: AskUserQuestionAnswer = {
        questionIndex: tab,
        question: current.question,
        kind: "chat",
        answer: "Chat about this",
      };
      await api.submitAskUserQuestionAnswer(pending.sessionId, {
        requestId: pending.requestId,
        answers: [chatAnswer],
        cancelled: true,
      });
      clearPending(pending.sessionId, pending.requestId);
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
      setSubmitting(false);
    }
  };

  return (
    // Inline panel: lives between ChatView and ChatInput. The
    // max-h cap keeps a giant questionnaire from pushing the
    // composer off-screen on short viewports — the body scrolls
    // when the content exceeds the cap.
    <div className="flex max-h-[60vh] shrink-0 flex-col overflow-hidden border-t border-amber-700/50 bg-neutral-900/40 light:border-amber-400 light:bg-amber-50/60">
      <div className="flex flex-col overflow-hidden">
        <header className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2 light:border-neutral-200">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 light:text-amber-700">
            Agent question
          </span>
          {pending.questions.length > 1 && (
            <div className="ml-2 flex items-center gap-1 text-[10px] uppercase tracking-wider text-neutral-500">
              {pending.questions.map((q, i) => (
                <span
                  key={i}
                  className={`rounded px-1.5 py-0.5 ${
                    i === tab
                      ? "bg-amber-900/40 text-amber-200 light:bg-amber-100 light:text-amber-900"
                      : drafts[i] !== null
                        ? "bg-neutral-800 text-neutral-300 light:bg-neutral-200 light:text-neutral-700"
                        : "text-neutral-500"
                  }`}
                  title={q.question}
                >
                  {q.header}
                </span>
              ))}
            </div>
          )}
          <div className="flex-1" />
          <span className="text-[10px] uppercase tracking-wider text-neutral-500">
            {tab + 1} of {pending.questions.length}
          </span>
        </header>

        {error !== undefined && (
          <div className="border-b border-red-700/40 bg-red-900/20 px-4 py-2 text-xs text-red-300 light:border-red-300 light:bg-red-50 light:text-red-800">
            {error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <QuestionView
            question={current}
            draft={draft ?? null}
            onChange={(patch) => setDraft(patch)}
          />
        </div>

        <footer className="flex items-center gap-2 border-t border-neutral-800 px-4 py-2 light:border-neutral-200">
          <button
            type="button"
            onClick={() => void chatAboutThis()}
            disabled={submitting}
            className="flex items-center gap-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
            title="Abandon the structured questionnaire and reply in free-form chat"
          >
            <MessageCircle size={12} />
            Chat about this
          </button>
          <div className="flex-1" />
          {tab > 0 && (
            <button
              type="button"
              onClick={() => setTab(tab - 1)}
              disabled={submitting}
              className="flex items-center gap-1 rounded border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:border-neutral-500 disabled:opacity-50 light:border-neutral-400 light:text-neutral-700"
            >
              <ChevronLeft size={12} />
              Back
            </button>
          )}
          <button
            type="button"
            onClick={() => void advanceOrSubmit()}
            disabled={submitting || !validForCurrent()}
            className="flex items-center gap-1 rounded bg-emerald-700 px-3 py-1 text-xs text-white hover:bg-emerald-600 disabled:opacity-50"
          >
            {submitting ? <Loader2 size={12} className="animate-spin" /> : null}
            {tab < pending.questions.length - 1 ? (
              <>
                Next <ChevronRight size={12} />
              </>
            ) : submitting ? (
              "Submitting…"
            ) : (
              "Submit"
            )}
          </button>
        </footer>
      </div>
    </div>
  );
}

function QuestionView({
  question,
  draft,
  onChange,
}: {
  question: AskQuestion;
  draft: PendingAnswer | null;
  onChange: (patch: Partial<PendingAnswer>) => void;
}) {
  const hasAnyPreview = useMemo(
    () => question.options.some((o) => typeof o.preview === "string" && o.preview.length > 0),
    [question.options],
  );
  const isMulti = question.multiSelect === true;
  const showCustomInput = !isMulti && !hasAnyPreview;
  const [focusedLabel, setFocusedLabel] = useState<string | undefined>(undefined);
  const focused = question.options.find((o) => o.label === focusedLabel);

  // When preview is enabled, default-focus the first option so the
  // right pane shows something on mount rather than a blank box.
  useEffect(() => {
    if (hasAnyPreview && focusedLabel === undefined && question.options[0] !== undefined) {
      setFocusedLabel(question.options[0].label);
    }
  }, [hasAnyPreview, focusedLabel, question.options]);

  return (
    <div className="space-y-3">
      <h2 className="text-base font-medium text-neutral-100 light:text-neutral-900">
        {question.question}
      </h2>

      {hasAnyPreview && !isMulti ? (
        // Side-by-side layout: options left (1/3), focused option's
        // preview right (2/3). The "Type something" row is suppressed
        // here — no room and the chat-about-this button covers the
        // escape case.
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-1 space-y-1">
            {question.options.map((o) => {
              const selected = draft?.selectedLabel === o.label;
              return (
                <button
                  key={o.label}
                  type="button"
                  onClick={() => {
                    onChange({ selectedLabel: o.label });
                    setFocusedLabel(o.label);
                  }}
                  onMouseEnter={() => setFocusedLabel(o.label)}
                  className={`w-full rounded border px-2 py-1.5 text-left text-xs ${
                    selected
                      ? "border-emerald-600 bg-emerald-900/30 text-emerald-100 light:bg-emerald-50 light:text-emerald-900"
                      : focusedLabel === o.label
                        ? "border-neutral-600 bg-neutral-900 text-neutral-100 light:border-neutral-400 light:bg-neutral-100 light:text-neutral-900"
                        : "border-neutral-800 bg-neutral-900/40 text-neutral-300 hover:border-neutral-600 light:border-neutral-300 light:bg-neutral-50 light:text-neutral-700"
                  }`}
                >
                  <div className="font-medium">{o.label}</div>
                  <div className="mt-0.5 text-[11px] text-neutral-400 light:text-neutral-600">
                    {o.description}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="col-span-2 overflow-auto rounded border border-neutral-800 bg-neutral-950 p-3 light:border-neutral-300 light:bg-neutral-50">
            {focused?.preview !== undefined && focused.preview.length > 0 ? (
              <pre className="whitespace-pre-wrap font-mono text-[11px] text-neutral-200 light:text-neutral-800">
                {focused.preview}
              </pre>
            ) : (
              <p className="text-xs italic text-neutral-500 light:text-neutral-600">
                No preview for this option.
              </p>
            )}
          </div>
        </div>
      ) : isMulti ? (
        <div className="space-y-1">
          {question.options.map((o) => {
            const selected = (draft?.multiLabels ?? []).includes(o.label);
            const toggle = (): void => {
              const cur = new Set(draft?.multiLabels ?? []);
              if (selected) cur.delete(o.label);
              else cur.add(o.label);
              onChange({ multiLabels: Array.from(cur) });
            };
            return (
              <label
                key={o.label}
                className={`flex cursor-pointer items-start gap-2 rounded border px-2 py-1.5 text-xs ${
                  selected
                    ? "border-emerald-600 bg-emerald-900/30 light:bg-emerald-50"
                    : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-600 light:border-neutral-300 light:bg-neutral-50"
                }`}
              >
                <input type="checkbox" checked={selected} onChange={toggle} className="mt-1" />
                <div>
                  <div className="font-medium text-neutral-100 light:text-neutral-900">
                    {o.label}
                  </div>
                  <div className="mt-0.5 text-[11px] text-neutral-400 light:text-neutral-600">
                    {o.description}
                  </div>
                </div>
              </label>
            );
          })}
        </div>
      ) : (
        // Vertical option list + "Type something" free-text fallback.
        <div className="space-y-1">
          {question.options.map((o) => {
            const selected = draft?.selectedLabel === o.label;
            return (
              <button
                key={o.label}
                type="button"
                onClick={() => onChange({ selectedLabel: o.label, customText: undefined })}
                className={`w-full rounded border px-2 py-1.5 text-left text-xs ${
                  selected
                    ? "border-emerald-600 bg-emerald-900/30 light:bg-emerald-50"
                    : "border-neutral-800 bg-neutral-900/40 hover:border-neutral-600 light:border-neutral-300 light:bg-neutral-50"
                }`}
              >
                <div className="font-medium text-neutral-100 light:text-neutral-900">{o.label}</div>
                <div className="mt-0.5 text-[11px] text-neutral-400 light:text-neutral-600">
                  {o.description}
                </div>
              </button>
            );
          })}
          {showCustomInput && (
            <div className="pt-2">
              <label className="mb-1 block text-[10px] uppercase tracking-wider text-neutral-500 light:text-neutral-600">
                Type something
              </label>
              <textarea
                value={draft?.customText ?? ""}
                onChange={(e) => onChange({ customText: e.target.value, selectedLabel: undefined })}
                rows={2}
                placeholder="Or type your own answer…"
                className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs text-neutral-100 light:border-neutral-300 light:bg-white light:text-neutral-900"
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

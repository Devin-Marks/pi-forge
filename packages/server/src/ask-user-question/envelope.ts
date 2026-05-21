import type { AskUserQuestionDetails, AskUserQuestionResult, QuestionAnswer } from "./types.js";

/**
 * Build the tool result the agent sees. The shape matches the
 * upstream plugin: a single text content block summarising what
 * happened, plus a `details` object the agent can introspect when
 * it needs the structured answers.
 *
 * The `text` summary is the channel the model actually reads when it
 * continues the conversation — short, neutral phrasing, one line
 * per answered question.
 */
export function buildResult(
  answers: QuestionAnswer[],
  opts: { cancelled?: boolean; error?: string; questionCount?: number } = {},
): AskUserQuestionResult {
  const cancelled = opts.cancelled === true;
  const details: AskUserQuestionDetails = { answers, cancelled };
  if (opts.error !== undefined) details.error = opts.error;
  const text = renderText(answers, {
    cancelled,
    error: opts.error,
    questionCount: opts.questionCount ?? answers.length,
  });
  return { content: [{ type: "text", text }], details };
}

function renderText(
  answers: QuestionAnswer[],
  ctx: { cancelled: boolean; error: string | undefined; questionCount: number },
): string {
  if (ctx.error !== undefined && answers.length === 0) {
    return `Error: ${ctx.error}`;
  }
  if (ctx.cancelled && answers.length === 0) {
    return "User cancelled the questionnaire without answering. Continue in free-form conversation.";
  }
  const lines: string[] = [];
  for (const a of answers) {
    lines.push(renderAnswerLine(a));
  }
  if (ctx.cancelled && answers.length < ctx.questionCount) {
    lines.push(
      `(User cancelled the remaining ${ctx.questionCount - answers.length} question(s); continue with what was answered.)`,
    );
  }
  return lines.join("\n");
}

function renderAnswerLine(a: QuestionAnswer): string {
  const prefix = `Q${a.questionIndex + 1} "${a.question}"`;
  switch (a.kind) {
    case "option":
      return `${prefix} → ${a.answer ?? ""}${a.notes !== undefined && a.notes.length > 0 ? ` (note: ${a.notes})` : ""}`;
    case "custom": {
      const text = a.answer ?? "(no text provided)";
      return `${prefix} → custom: ${text}`;
    }
    case "chat":
      return `${prefix} → user chose to chat about this`;
    case "multi": {
      const items = (a.selected ?? []).join(", ");
      return `${prefix} → selected: ${items.length > 0 ? items : "(none)"}`;
    }
  }
}

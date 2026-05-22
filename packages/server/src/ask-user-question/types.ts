/**
 * Shape definitions for the `ask_user_question` tool. The wire schema
 * (questions[1..4] with options[2..4]; header ≤16 chars; label ≤60
 * chars; reserved sentinel labels) is contract-compatible with
 * `@juicesharp/rpiv-ask-user-question` — an agent prompt written
 * against the plugin works against this implementation unchanged.
 *
 * Implementation is independent; constants and validation rules were
 * derived from the plugin's published schema descriptions and test
 * fixtures rather than copied. See `docs/ask-user-question.md` for the
 * cross-reference.
 */

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * Labels the validator rejects at submit time. The four runtime
 * sentinels ("Type something.", "Chat about this", "Next") are
 * appended by the UI so authoring them would collide; "Other" is
 * reserved for CC-style parity (the model often reaches for "Other"
 * when given the chance — we want the runtime sentinel to be the
 * single source of truth).
 */
export const RESERVED_LABELS = ["Other", "Type something.", "Chat about this", "Next"] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

export interface Option {
  label: string;
  description: string;
  /** Optional markdown preview for side-by-side rendering. Single-select only. */
  preview?: string;
}

export interface Question {
  question: string;
  /** Short tag/chip (≤MAX_HEADER_LENGTH chars). */
  header: string;
  options: Option[];
  multiSelect?: boolean;
}

export interface AskUserQuestionParams {
  questions: Question[];
}

/**
 * Per-question answer envelope returned to the agent. Mirrors the
 * plugin's discriminator-by-kind shape so a single prompt
 * authored against the plugin's documented response can parse
 * either implementation.
 *
 * - `option`: user selected one of the author-defined options. `answer` = label.
 * - `custom`: user typed free-text via the "Type something." row. `answer` = text or null.
 * - `chat`:   user picked the chat-about-this escape. `answer` = "Chat about this".
 * - `multi`:  multi-select commit. `selected` carries the chosen labels; `answer` = null.
 */
export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: "option" | "custom" | "chat" | "multi";
  answer: string | null;
  selected?: string[];
  notes?: string;
  /** Markdown preview text from the matched option (kind === "option" only). */
  preview?: string;
}

export interface AskUserQuestionDetails {
  answers: QuestionAnswer[];
  cancelled: boolean;
  error?: string;
}

export interface AskUserQuestionResult {
  content: { type: "text"; text: string }[];
  details: AskUserQuestionDetails;
}

/**
 * Validation outcome — `ok: true` carries the normalised params (same
 * shape; the validator never rewrites content), `ok: false` carries
 * the same `error` code strings the plugin returns so downstream
 * parsers don't have to special-case the implementation.
 */
export type ValidationResult =
  | { ok: true; params: AskUserQuestionParams }
  | { ok: false; error: ValidationError; message: string };

export type ValidationError =
  | "no_questions"
  | "too_many_questions"
  | "missing_question_text"
  | "missing_header"
  | "header_too_long"
  | "too_few_options"
  | "too_many_options"
  | "missing_label"
  | "label_too_long"
  | "missing_description"
  | "reserved_label"
  | "duplicate_label";

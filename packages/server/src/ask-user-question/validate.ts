import {
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  RESERVED_LABELS,
  type AskUserQuestionParams,
  type ValidationResult,
} from "./types.js";

/**
 * Runtime validation for the agent-supplied questionnaire. Mirrors
 * the upstream plugin's rules without porting code. Each failure
 * returns the same error-code vocabulary the plugin uses so a
 * downstream parser doesn't care which implementation answered.
 *
 * The schema layer (Fastify body validation) catches type/shape
 * errors first; this validator enforces the semantic ones: reserved
 * sentinel labels, duplicate labels, the question / option count
 * caps, and the byte-cap on header and label fields. Byte caps live
 * here too (not just in the schema) so a caller that bypassed the
 * schema — e.g. a future programmatic invocation path — still gets
 * the same enforcement.
 */
export function validateQuestionnaire(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: "no_questions", message: "params must be an object" };
  }
  const params = input as Partial<AskUserQuestionParams>;
  const questions = params.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return {
      ok: false,
      error: "no_questions",
      message: "questions[] must have at least one entry",
    };
  }
  if (questions.length > MAX_QUESTIONS) {
    return {
      ok: false,
      error: "too_many_questions",
      message: `at most ${MAX_QUESTIONS} questions per invocation`,
    };
  }
  const reserved = new Set<string>(RESERVED_LABELS);
  for (let qi = 0; qi < questions.length; qi += 1) {
    const q = questions[qi];
    if (typeof q !== "object" || q === null) {
      return {
        ok: false,
        error: "missing_question_text",
        message: `question[${qi}] is not an object`,
      };
    }
    const question = (q as { question?: unknown }).question;
    if (typeof question !== "string" || question.trim().length === 0) {
      return {
        ok: false,
        error: "missing_question_text",
        message: `question[${qi}].question is required`,
      };
    }
    const header = (q as { header?: unknown }).header;
    if (typeof header !== "string" || header.length === 0) {
      return { ok: false, error: "missing_header", message: `question[${qi}].header is required` };
    }
    if (header.length > MAX_HEADER_LENGTH) {
      return {
        ok: false,
        error: "header_too_long",
        message: `question[${qi}].header exceeds ${MAX_HEADER_LENGTH} chars`,
      };
    }
    const options = (q as { options?: unknown }).options;
    if (!Array.isArray(options) || options.length < MIN_OPTIONS) {
      return {
        ok: false,
        error: "too_few_options",
        message: `question[${qi}] requires at least ${MIN_OPTIONS} options`,
      };
    }
    if (options.length > MAX_OPTIONS) {
      return {
        ok: false,
        error: "too_many_options",
        message: `question[${qi}] allows at most ${MAX_OPTIONS} options`,
      };
    }
    const seenLabels = new Set<string>();
    for (let oi = 0; oi < options.length; oi += 1) {
      const opt = options[oi];
      if (typeof opt !== "object" || opt === null) {
        return {
          ok: false,
          error: "missing_label",
          message: `question[${qi}].options[${oi}] is not an object`,
        };
      }
      const label = (opt as { label?: unknown }).label;
      if (typeof label !== "string" || label.length === 0) {
        return {
          ok: false,
          error: "missing_label",
          message: `question[${qi}].options[${oi}].label is required`,
        };
      }
      if (label.length > MAX_LABEL_LENGTH) {
        return {
          ok: false,
          error: "label_too_long",
          message: `question[${qi}].options[${oi}].label exceeds ${MAX_LABEL_LENGTH} chars`,
        };
      }
      // Reserved-label check applies to every kind (multiSelect too)
      // so the runtime sentinels stay the single source of truth even
      // when the UI suppresses them.
      if (reserved.has(label)) {
        return {
          ok: false,
          error: "reserved_label",
          message: `question[${qi}].options[${oi}].label "${label}" is reserved — pick a different label`,
        };
      }
      if (seenLabels.has(label)) {
        return {
          ok: false,
          error: "duplicate_label",
          message: `question[${qi}].options[${oi}].label "${label}" duplicates an earlier option`,
        };
      }
      seenLabels.add(label);
      const description = (opt as { description?: unknown }).description;
      if (typeof description !== "string" || description.length === 0) {
        return {
          ok: false,
          error: "missing_description",
          message: `question[${qi}].options[${oi}].description is required`,
        };
      }
    }
  }
  return { ok: true, params: params as AskUserQuestionParams };
}

/**
 * In-process pi extension that nudges the model to KEEP WORKING on
 * the in-progress task after an overflow-driven auto-compaction,
 * instead of producing a prose status report that paraphrases the
 * compaction summary's "Next Steps" section.
 *
 * ## The problem this solves
 *
 * When the LLM rejects a request with a context-overflow error, the
 * pi SDK auto-compacts and calls `agent.continue()` to resume the
 * loop. The model then sees:
 *
 *   - system prompt + tool defs
 *   - <kept-recent messages — whatever fit under keepRecentTokens>
 *   - <compactionSummary> — a structured doc with sections "## Goal",
 *     "## Progress (Done / In Progress / Blocked)", "## Next Steps",
 *     "## Critical Context"
 *
 * The failed assistant message was stripped by the SDK (per the
 * overflow path in `agent-session.js:_checkCompaction`), so the
 * `compactionSummary` is the LAST message and the next model output
 * starts a fresh turn. Strong models (Claude, GPT-4) usually infer
 * "I'm mid-task — pick up where I left off." Weaker / smaller local
 * models (Gemma-class on vLLM in particular) read the structured
 * summary as a status report addressed TO them and respond with
 * prose paraphrasing the "Next Steps" section instead of actually
 * doing the work. End-effect: the agent stops making progress right
 * when the user needs it to keep going.
 *
 * The next action might be a tool call, a final answer, a follow-up
 * question, or anything else the task requires — we don't prescribe
 * the shape, we just say "keep going."
 *
 * ## How this extension fixes it
 *
 * Registers a `context` event handler. The `context` event fires
 * BEFORE every LLM request, with the messages array that's about to
 * be sent. We never mutate the session itself — we append a
 * synthetic user message to the OUTBOUND copy only. The handler:
 *
 *   1. Looks at the messages array.
 *   2. If the LAST message is a `compactionSummary`, the model is
 *      about to receive a fresh post-compaction context with no
 *      forward prompt. Append `NUDGE_MESSAGE` — a one-line
 *      imperative telling the model to resume by calling tools.
 *   3. Otherwise (last message is a user prompt, assistant turn, or
 *      tool result), do nothing. Threshold compactions don't auto-
 *      continue so the user types the next prompt themselves — which
 *      becomes the last message — and provides the imperative
 *      naturally.
 *
 * The nudge is sent to the LLM but NOT persisted to the session
 * JSONL, so it doesn't leak into compaction summaries, tree views,
 * or session exports.
 *
 * ## Why the `context` hook and not `session_before_compact`
 *
 * `session_before_compact` would let us replace the entire
 * compaction (cancel it, or provide our own). To append text to the
 * SDK-generated summary we'd have to re-implement summarization
 * (call the SDK's exported `compact()` helper, mutate the result,
 * return it). That works but is heavier and couples us to internal
 * SDK shapes. The `context` hook is lighter: SDK does its own
 * summarization, we just inject the imperative at LLM-call time.
 *
 * ## Why a user message and not a system / custom message
 *
 * The `context` hook returns an `AgentMessage[]` that the SDK passes
 * to the provider. Providers expect a system prompt + a user/assistant
 * dialogue; injecting a synthetic `system` mid-stream is non-standard
 * and reorders cache. A trailing user message is the cheapest signal
 * the model interprets as "respond to this now."
 */
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * The text the LLM sees as a synthetic user message after an
 * overflow-driven auto-compaction. Tuned to be imperative and brief:
 *
 *   - "Continue the task in progress" — open-ended about what the
 *     next step is. The agent may need to call a tool, write a
 *     final answer, ask a follow-up question, or anything else the
 *     task requires. We don't prescribe the shape; we just say
 *     keep going.
 *   - "Do not write a summary of what you were doing" — names the
 *     observed failure mode (model paraphrases the summary's
 *     "Next Steps" instead of acting).
 *   - "Pick up from where you left off" — frames the summary as
 *     reference material, not as a fresh prompt addressed to the
 *     model.
 *
 * Kept under 250 characters so the addition to LLM input is
 * negligible (~50 tokens).
 */
export const NUDGE_MESSAGE =
  "[continuation] Continue the task in progress — pick up from where you left off " +
  "based on the summary above. Do not write a status update or summary of what you " +
  "were doing; just proceed with the next action the task requires.";

/**
 * Inspect a messages array and decide whether the post-compaction
 * nudge should be appended. Exported separately so the unit test can
 * exercise the boundary cases (empty, only summary, summary then user
 * prompt, summary then assistant turn) without booting a full SDK
 * session.
 */
export function shouldNudgeAfterCompaction(messages: readonly AgentMessage[]): boolean {
  const last = messages[messages.length - 1];
  if (last === undefined) return false;
  return last.role === "compactionSummary";
}

/**
 * Build the synthetic user message used as the nudge. Timestamp is
 * `Date.now()` so the message sorts after any prior content if a
 * downstream consumer ever inspects timestamps; in practice the SDK
 * doesn't reorder by timestamp at LLM-call time, but it costs nothing
 * to keep monotonic ordering.
 */
function buildNudgeMessage(): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: NUDGE_MESSAGE }],
    timestamp: Date.now(),
  };
}

/**
 * Pi extension factory. Registered via `DefaultResourceLoader`'s
 * `extensionFactories` option in `agent-resource-loader.ts`. No I/O,
 * no async setup — just registers the handler and returns.
 */
export const compactionContinuationExtension: ExtensionFactory = (pi) => {
  pi.on("context", (event) => {
    if (!shouldNudgeAfterCompaction(event.messages)) {
      return undefined;
    }
    return {
      messages: [...event.messages, buildNudgeMessage()],
    };
  });
};

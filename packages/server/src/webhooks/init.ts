/**
 * Boot-time hookup of the webhook event-bridge to the forge-native
 * event sources (ask-user-question registry, processManager). The
 * AgentSession-side bridge is wired directly inside
 * `session-registry.makeSubscribeHandler` because that's where the
 * per-session subscription is created and torn down; this module
 * handles the singleton-channel sources.
 *
 * Mirrors the `initAskUserQuestionFanout` / `initProcessesFanout`
 * pattern in `sse-bridge.ts`. Called once from `index.ts` at
 * server boot; the returned unsubscribe is exposed for tests.
 */
import { subscribe as subscribeAskQuestions } from "../ask-user-question/registry.js";
import { processManager } from "../processes/manager.js";
import { getSession } from "../session-registry.js";
import { bridgeAskUserQuestion, bridgeProcessAlert } from "./event-bridge.js";

/**
 * Wire `ask_user_question` registry events to the webhook dispatcher.
 * We only fire for fresh requests (not cancellations) since "agent
 * needs you" is the actionable signal; cancellations are bookkeeping.
 *
 * The projectId comes from looking up the live session — the
 * registry event doesn't carry it directly. If the session is
 * tombstoned/disposed in the brief window between event emission
 * and webhook dispatch, we skip rather than fire with a missing
 * project (per-project webhooks would never match anyway).
 */
export function initAskUserQuestionWebhookBridge(): () => void {
  return subscribeAskQuestions((event) => {
    if (event.type !== "ask_user_question") return;
    const live = getSession(event.sessionId);
    if (live === undefined) return;
    bridgeAskUserQuestion(
      { sessionId: event.sessionId, projectId: live.projectId },
      event.questions,
      event.requestId,
    );
  });
}

/**
 * Wire `processManager` events to the webhook dispatcher. Only
 * the `process_alert` variant gets forwarded — that's the curated
 * "completion with intent to notify" signal the manager already
 * filters on the alertOn* flags. The chatty per-line output and
 * watch-match events stay in the SSE fanout where they belong.
 */
export function initProcessesWebhookBridge(): () => void {
  return processManager.subscribe((event) => {
    if (event.type !== "process_alert") return;
    const live = getSession(event.sessionId);
    if (live === undefined) return;
    bridgeProcessAlert(
      { sessionId: event.sessionId, projectId: live.projectId },
      event.info,
      event.reason,
    );
  });
}

/**
 * Boot-time wiring of the orchestration event bridge to the
 * forge-native singleton event channels (ask-user-question, processes).
 *
 * Per-AgentSession events (agent_end, auto_retry_end) are dispatched
 * from inside `session-registry.makeSubscribeHandler` — those need
 * the LiveSession context at construction time. session-registry
 * also calls `notifySupervisorIdle` on supervisor agent_end and
 * `notifySupervisorDisposed` on supervisor dispose.
 *
 * The DELETE-side `worker.deleted` event is fired from the sessions
 * DELETE route, alongside the existing webhook `session_deleted`
 * fan-out.
 *
 * No instance-level guard here: the subscribers are cheap (filter
 * to "is the event source a registered worker?" then route). The
 * actual gating against `isOrchestrationEnabled()` happens at tool
 * registration and route entry — events still need to be observed
 * so a session that becomes a worker mid-stream gets its later
 * events picked up.
 */
import { subscribe as subscribeAskQuestions } from "../ask-user-question/registry.js";
import { processManager } from "../processes/manager.js";
import { bridgeWorkerAskUserQuestion, bridgeWorkerProcessAlert } from "./event-bridge.js";

export function initOrchestrationAskUserQuestionBridge(): () => void {
  return subscribeAskQuestions((event) => {
    if (event.type !== "ask_user_question") return;
    void bridgeWorkerAskUserQuestion(event.sessionId, event.questions, event.requestId);
  });
}

export function initOrchestrationProcessesBridge(): () => void {
  return processManager.subscribe((event) => {
    if (event.type !== "process_alert") return;
    void bridgeWorkerProcessAlert(event.sessionId, event.info, event.reason);
  });
}

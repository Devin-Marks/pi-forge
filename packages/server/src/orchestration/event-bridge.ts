/**
 * Bridges forge-side event channels into the supervisor inbox.
 *
 * Four event sources feed the inbox (mirroring the webhooks bridge):
 *
 *   AgentSession events (per-session subscribe in session-registry):
 *     - `agent_end`        → inbox `worker.ended`
 *     - `auto_retry_end` (success=false) → inbox `worker.auto_retry_failed`
 *
 *   ask-user-question registry (forge-native):
 *     - `ask_user_question` → inbox `worker.ask_user`
 *
 *   processManager (forge-native):
 *     - `process_alert` is intentionally not bridged to the supervisor inbox
 *
 *   session-registry lifecycle (sessions DELETE route):
 *     - cold/hot delete    → inbox `worker.deleted`
 *
 * All bridges are fire-and-forget. Each one looks up the supervisor
 * via `getSupervisorIdForWorker` and skips silently if the source
 * session isn't a registered worker — by far the steady state, since
 * the same SDK event subscriber fires for every live session, not
 * just orchestrated ones.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ProcessAlertReason, ProcessInfo } from "../processes/types.js";
import type { Question } from "../ask-user-question/types.js";
import { bridgeWorkerEvent } from "./inbox.js";

interface LastAssistantSummary {
  stopReason?: string;
  errorMessage?: string;
  text?: string;
}

function findLastAssistant(messages: readonly unknown[]): LastAssistantSummary | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string } | undefined;
    if (m?.role !== "assistant") continue;
    const a = m as {
      stopReason?: string;
      errorMessage?: string;
      content?: unknown;
    };
    const text = extractAssistantText(a.content);
    const out: LastAssistantSummary = {};
    if (a.stopReason !== undefined) out.stopReason = a.stopReason;
    if (a.errorMessage !== undefined) out.errorMessage = a.errorMessage;
    if (text !== undefined) out.text = text;
    return out;
  }
  return undefined;
}

function extractAssistantText(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    const o = c as { type?: string; text?: string };
    if (o.type === "text" && typeof o.text === "string") parts.push(o.text);
  }
  if (parts.length === 0) return undefined;
  // Cap to 600 chars in the inbox payload — the supervisor LLM
  // sees this as a quick summary; if it wants more it calls
  // `orchestrate_read_worker`. Bigger payloads bloat the inbox
  // file and the supervisor's tool-result context.
  const joined = parts.join("\n");
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

/**
 * Called from `session-registry.makeSubscribeHandler` for every
 * AgentSessionEvent on every live session. Filters for the two SDK
 * events that map to inbox items; everything else is ignored.
 */
export async function bridgeWorkerAgentEvent(
  meta: { sessionId: string; session: AgentSession },
  event: AgentSessionEvent,
): Promise<void> {
  const e = event as unknown as {
    type: string;
    message?: { stopReason?: string; errorMessage?: string };
    success?: boolean;
    finalError?: string;
    attempt?: number;
    maxAttempts?: number;
  };
  if (e.type === "agent_end") {
    const messages = meta.session.messages;
    const lastAssistant = findLastAssistant(messages);
    const errorMessage =
      (meta.session as unknown as { errorMessage?: string }).errorMessage ??
      lastAssistant?.errorMessage;
    await bridgeWorkerEvent(meta.sessionId, "worker.ended", {
      stopReason: lastAssistant?.stopReason ?? null,
      errorMessage: errorMessage ?? null,
      assistantTextPreview: lastAssistant?.text ?? null,
    });
    return;
  }
  if (e.type === "auto_retry_end" && e.success === false) {
    await bridgeWorkerEvent(meta.sessionId, "worker.auto_retry_failed", {
      attempt: e.attempt ?? null,
      maxAttempts: e.maxAttempts ?? null,
      finalError: e.finalError ?? null,
    });
    return;
  }
}

export async function bridgeWorkerAskUserQuestion(
  sessionId: string,
  questions: readonly Question[],
  requestId: string,
): Promise<void> {
  await bridgeWorkerEvent(sessionId, "worker.ask_user", {
    requestId,
    questionCount: questions.length,
    // Keep the inbox payload tight — preview is the first question's
    // header so the supervisor sees enough to decide whether to read
    // the worker's transcript. Full question detail is in the
    // worker's session, fetched via orchestrate_read_worker.
    firstQuestionHeader: questions[0]?.header ?? null,
    firstQuestionText: questions[0]?.question ?? null,
  });
}

export function shouldBridgeWorkerProcessAlert(_reason: ProcessAlertReason): boolean {
  // Worker process alerts are intentionally not escalated to the
  // supervisor inbox. The worker session itself still receives the
  // in-chat process alert because it explicitly requested an
  // alertOn* notification, and the running worker agent can react
  // locally. Waking the orchestrator for process success/failure/kill
  // outcomes has proven too noisy and duplicative.
  return false;
}

export async function bridgeWorkerProcessAlert(
  sessionId: string,
  info: ProcessInfo,
  reason: ProcessAlertReason,
): Promise<void> {
  if (!shouldBridgeWorkerProcessAlert(reason)) return;
  await bridgeWorkerEvent(sessionId, "worker.process_alert", {
    reason,
    processId: info.id,
    name: info.name,
    pid: info.pid,
    exitCode: info.exitCode,
    success: info.success,
  });
}

export async function bridgeWorkerDeleted(
  sessionId: string,
  meta: { wasLive: boolean },
): Promise<void> {
  await bridgeWorkerEvent(sessionId, "worker.deleted", {
    wasLive: meta.wasLive,
  });
}

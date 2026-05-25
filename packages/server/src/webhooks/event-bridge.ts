/**
 * Wires the pi-forge event streams into the webhook dispatcher.
 *
 * Four event sources feed the six webhook event types:
 *
 *   AgentSession events (per-session subscribe in session-registry):
 *     - `agent_end`         → webhook `agent_end`
 *     - `auto_retry_end` (success=false only) → webhook `auto_retry_end`
 *     - `compaction_end`    → webhook `compaction_end`
 *
 *   ask-user-question registry (forge-native):
 *     - `ask_user_question` → webhook `ask_user_question`
 *
 *   processManager (forge-native):
 *     - `process_alert`     → webhook `process_alert`
 *
 *   session-registry lifecycle (forge-native):
 *     - `session_created`   → webhook `session_created`
 *     - `session_deleted`   → webhook `session_deleted`
 *
 * Per-event payload shapes are kept stable as part of the public
 * webhook contract — adding fields is fine, renaming or removing
 * requires a major-version bump. Field names follow the SDK's
 * conventions when forwarding SDK events; new fields use
 * lowerCamelCase.
 *
 * All dispatches are fire-and-forget. This module never blocks
 * the source event handler — the dispatcher returns as soon as
 * the per-webhook attempt is queued, and retries run in the
 * background.
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ProcessInfo, ProcessAlertReason } from "../processes/types.js";
import { dispatch } from "./dispatcher.js";

/**
 * Called from `session-registry.makeSubscribeHandler` for every
 * AgentSessionEvent that fires on a live session. We filter inside
 * for the 3 SDK events we care about — the rest are ignored.
 */
export function bridgeAgentSessionEvent(
  meta: { sessionId: string; projectId: string; session: AgentSession },
  event: AgentSessionEvent,
): void {
  // `event` is the SDK's union; some fields are typed loose enough
  // that we cast through unknown to read them. That matches the
  // pattern session-registry.ts itself uses for the same union.
  const e = event as unknown as {
    type: string;
    message?: {
      stopReason?: string;
      errorMessage?: string;
      usage?: unknown;
      provider?: string;
      model?: string;
    };
    success?: boolean;
    finalError?: string;
    attempt?: number;
    maxAttempts?: number;
    reason?: string;
    tokensBefore?: number;
    aborted?: boolean;
  };

  if (e.type === "agent_end") {
    // session.messages is post-turn; pull the final assistant
    // message for the payload's primary content. The SDK guarantees
    // session.errorMessage is the authoritative error field on
    // agent_end.
    const messages = meta.session.messages;
    const lastAssistant = findLastAssistant(messages);
    const errorMessage =
      (meta.session as unknown as { errorMessage?: string }).errorMessage ??
      lastAssistant?.errorMessage;
    void dispatch({
      event: "agent_end",
      sessionId: meta.sessionId,
      projectId: meta.projectId,
      data: {
        stopReason: lastAssistant?.stopReason ?? null,
        errorMessage: errorMessage ?? null,
        assistantText: lastAssistant?.text ?? null,
        usage: lastAssistant?.usage ?? null,
        provider: lastAssistant?.provider ?? null,
        model: lastAssistant?.model ?? null,
      },
    });
    return;
  }
  if (e.type === "auto_retry_end" && e.success === false) {
    void dispatch({
      event: "auto_retry_end",
      sessionId: meta.sessionId,
      projectId: meta.projectId,
      data: {
        attempt: e.attempt ?? null,
        maxAttempts: e.maxAttempts ?? null,
        finalError: e.finalError ?? null,
      },
    });
    return;
  }
  if (e.type === "compaction_end") {
    // Only fire on completed compactions (aborted ones aren't
    // useful for "your context just shrank" integrations).
    if (e.aborted === true) return;
    void dispatch({
      event: "compaction_end",
      sessionId: meta.sessionId,
      projectId: meta.projectId,
      data: {
        reason: e.reason ?? null,
        tokensBefore: e.tokensBefore ?? null,
      },
    });
    return;
  }
}

interface LastAssistantSummary {
  stopReason?: string;
  errorMessage?: string;
  text?: string;
  usage?: unknown;
  provider?: string;
  model?: string;
}

function findLastAssistant(messages: readonly unknown[]): LastAssistantSummary | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string } | undefined;
    if (m?.role !== "assistant") continue;
    const a = m as {
      stopReason?: string;
      errorMessage?: string;
      content?: unknown;
      usage?: unknown;
      provider?: string;
      model?: string;
    };
    const text = extractAssistantText(a.content);
    const result: LastAssistantSummary = {};
    if (a.stopReason !== undefined) result.stopReason = a.stopReason;
    if (a.errorMessage !== undefined) result.errorMessage = a.errorMessage;
    if (text !== undefined) result.text = text;
    if (a.usage !== undefined) result.usage = a.usage;
    if (a.provider !== undefined) result.provider = a.provider;
    if (a.model !== undefined) result.model = a.model;
    return result;
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
  return parts.join("\n");
}

// ---- ask-user-question ----

import type { Question } from "../ask-user-question/types.js";

/**
 * Called from a subscriber on the ask-user-question registry.
 * Fires the `ask_user_question` webhook when a NEW request lands;
 * cancellations aren't a webhook event (no obvious consumer use
 * case yet).
 */
export function bridgeAskUserQuestion(
  meta: { sessionId: string; projectId: string },
  questions: readonly Question[],
  requestId: string,
): void {
  void dispatch({
    event: "ask_user_question",
    sessionId: meta.sessionId,
    projectId: meta.projectId,
    data: {
      requestId,
      questions: questions.map((q) => ({
        header: q.header,
        question: q.question,
        multiSelect: q.multiSelect,
        options: q.options.map((o: { label: string; description: string }) => ({
          label: o.label,
          description: o.description,
        })),
      })),
    },
  });
}

// ---- processes ----

/**
 * Called from a subscriber on processManager. Fires the
 * `process_alert` webhook with the same trigger conditions the
 * agent-side alert uses (manager filters alertOn* flags before
 * emitting the manager event).
 */
export function bridgeProcessAlert(
  meta: { sessionId: string; projectId: string },
  info: ProcessInfo,
  reason: ProcessAlertReason,
): void {
  void dispatch({
    event: "process_alert",
    sessionId: meta.sessionId,
    projectId: meta.projectId,
    data: {
      reason,
      processId: info.id,
      name: info.name,
      pid: info.pid,
      command: info.command,
      cwd: info.cwd,
      startTime: info.startTime,
      endTime: info.endTime,
      exitCode: info.exitCode,
      success: info.success,
    },
  });
}

// ---- session lifecycle ----

/**
 * Called from session-registry on session creation. Fires
 * `session_created` with enough metadata for an audit-log
 * consumer to record "session X was created in project Y at T."
 */
export function bridgeSessionCreated(meta: {
  sessionId: string;
  projectId: string;
  workspacePath: string;
}): void {
  void dispatch({
    event: "session_created",
    sessionId: meta.sessionId,
    projectId: meta.projectId,
    data: {
      workspacePath: meta.workspacePath,
    },
  });
}

/**
 * Called from session-registry on session deletion (cold delete
 * via the DELETE route). The wasLive flag distinguishes "we
 * disposed an active session" from "we removed a cold JSONL."
 */
export function bridgeSessionDeleted(meta: {
  sessionId: string;
  projectId?: string;
  wasLive: boolean;
}): void {
  void dispatch({
    event: "session_deleted",
    sessionId: meta.sessionId,
    ...(meta.projectId !== undefined ? { projectId: meta.projectId } : {}),
    data: {
      wasLive: meta.wasLive,
    },
  });
}

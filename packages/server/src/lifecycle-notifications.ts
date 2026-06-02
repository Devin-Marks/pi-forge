import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

export interface CustomLifecycleMessage {
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
}

interface LifecycleSession {
  isStreaming: boolean;
  messages: readonly unknown[];
  sendCustomMessage: AgentSession["sendCustomMessage"];
}

/**
 * Send a custom lifecycle/status card with explicit active-run behavior.
 *
 * While streaming, lifecycle cards use `steer` so the card is available
 * to the active run's next model step rather than being delivered after
 * `agent_end` as a follow-up. If the current LLM request is already in
 * flight, the SDK cannot inject into that already-sent request; the earliest
 * possible context point is the next agent step.
 *
 * When idle, `triggerTurn` controls whether the card starts a new model turn:
 * failures trigger; success/informational cards only append/display.
 */
export function sendCustomLifecycleMessage(
  session: LifecycleSession,
  message: CustomLifecycleMessage,
  options: {
    triggerTurn: boolean;
    dedupe?: { detailKey: string; detailValue: string };
    onError?: (err: unknown) => void;
  },
): void {
  if (
    options.dedupe !== undefined &&
    hasExistingNotification(session.messages, message.customType, options.dedupe)
  ) {
    return;
  }

  const send = (sendOptions: { deliverAs?: "steer" | "followUp"; triggerTurn: boolean }): void => {
    void session.sendCustomMessage(message, sendOptions).catch((err: unknown) => {
      options.onError?.(err);
    });
  };

  if (session.isStreaming) {
    send({ deliverAs: "steer", triggerTurn: options.triggerTurn });
    return;
  }

  if (
    options.dedupe !== undefined &&
    hasExistingNotification(session.messages, message.customType, options.dedupe)
  ) {
    return;
  }
  send({ triggerTurn: options.triggerTurn });
}

function hasExistingNotification(
  messages: readonly unknown[],
  customType: string,
  dedupe: { detailKey: string; detailValue: string },
): boolean {
  return messages.some((message) => {
    const m = message as { role?: unknown; customType?: unknown; details?: unknown };
    if (m.role !== "custom" || m.customType !== customType) return false;
    if (typeof m.details !== "object" || m.details === null) return false;
    const details = m.details as Record<string, unknown>;
    return details[dedupe.detailKey] === dedupe.detailValue;
  });
}

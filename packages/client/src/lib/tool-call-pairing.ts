export interface PairableAgentMessage {
  role?: string;
  type?: string;
  content?: unknown;
  toolCallId?: unknown;
  [key: string]: unknown;
}

/**
 * Build the assistant-tool-call ↔ tool-result relationship for a transcript
 * slice. Pi stores tool calls as `toolCall` blocks inside assistant messages
 * and stores outputs as standalone `role: "toolResult"` messages keyed by
 * `toolCallId`.
 */
export interface ToolCallPairing {
  /** Tool result keyed by the assistant-side tool call id. */
  toolResultsById: Map<string, PairableAgentMessage>;
  /** Assistant-side tool call ids that have a matched standalone result. */
  pairedIds: Set<string>;
  /** Result message object identities that have been paired and should not render standalone. */
  pairedResultMessages: Set<PairableAgentMessage>;
}

export function buildToolCallPairing(messages: readonly PairableAgentMessage[]): ToolCallPairing {
  const toolResultsById = new Map<string, PairableAgentMessage>();
  const pairedIds = new Set<string>();
  const pairedResultMessages = new Set<PairableAgentMessage>();

  const callIds = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const block of m.content as Record<string, unknown>[]) {
      if (!isToolCallBlock(block)) continue;
      const id = getToolCallId(block);
      if (id !== undefined) callIds.add(id);
    }
  }

  for (const m of messages) {
    if (m.role !== "toolResult" || typeof m.toolCallId !== "string") continue;
    if (!callIds.has(m.toolCallId)) continue;
    toolResultsById.set(m.toolCallId, m);
    pairedIds.add(m.toolCallId);
    pairedResultMessages.add(m);
  }

  return { toolResultsById, pairedIds, pairedResultMessages };
}

export function isPairedToolResult(
  pairing: ToolCallPairing,
  message: PairableAgentMessage,
): boolean {
  return pairing.pairedResultMessages.has(message);
}

export function isToolCallBlock(
  block: Record<string, unknown> | undefined,
): block is Record<string, unknown> {
  return block?.type === "toolCall";
}

export function getToolCallId(block: Record<string, unknown>): string | undefined {
  return typeof block.id === "string" && block.id.length > 0 ? block.id : undefined;
}

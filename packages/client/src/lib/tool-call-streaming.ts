export interface ToolCallGeneration {
  id?: string;
  contentIndex?: number;
  name?: string;
  partialJson?: string;
  arguments?: unknown;
}

interface MessageUpdateLike {
  assistantMessageEvent?: unknown;
  message?: unknown;
  [key: string]: unknown;
}

interface AssistantStreamEventLike {
  type?: unknown;
  contentIndex?: unknown;
  partial?: unknown;
}

/**
 * Extract the SDK/provider's in-progress tool-call blocks from a
 * `message_update` event. pi-ai normalizes provider deltas to
 * `toolcall_start` / `toolcall_delta` / `toolcall_end`; for providers
 * that stream JSON args (Anthropic input_json_delta, OpenAI Responses
 * function-call arguments deltas, etc.) the `partial` assistant message
 * contains the currently parsed `toolCall` block(s) on every delta.
 *
 * Parallel tool calls can be generated in the same assistant message, so
 * return every current `toolCall` block from `partial.content`, not only
 * the block at the event's `contentIndex`. Some providers interleave
 * thinking/text/tool-call updates; as long as the SDK event carries a
 * `partial` assistant message with tool calls, surface it.
 *
 * If a provider only emits complete function calls, this still returns
 * the complete blocks once they arrive; the UI must not invent args before
 * the SDK exposes them.
 */
export function extractToolCallGenerations(event: MessageUpdateLike): ToolCallGeneration[] {
  const streamEvent = event.assistantMessageEvent as AssistantStreamEventLike | undefined;
  if (streamEvent === undefined || typeof streamEvent.type !== "string") return [];

  const partial = asRecord(streamEvent.partial) ?? asRecord(event.message);
  const content = Array.isArray(partial?.content) ? partial.content : undefined;
  if (content === undefined) return [];

  return content.flatMap((entry, index) => {
    const block = asRecord(entry);
    if (block?.type !== "toolCall") return [];
    return [toolCallGenerationFromBlock(block, index)];
  });
}

function toolCallGenerationFromBlock(
  block: Record<string, unknown>,
  contentIndex: number,
): ToolCallGeneration {
  const id = typeof block.id === "string" && block.id.length > 0 ? block.id : undefined;
  const name = typeof block.name === "string" && block.name.length > 0 ? block.name : undefined;
  const partialJson =
    typeof block.partialJson === "string" && block.partialJson.length > 0
      ? block.partialJson
      : undefined;
  const args = Object.prototype.hasOwnProperty.call(block, "arguments")
    ? block.arguments
    : undefined;

  const generation: ToolCallGeneration = { contentIndex };
  if (id !== undefined) generation.id = id;
  if (name !== undefined) generation.name = name;
  if (partialJson !== undefined) generation.partialJson = partialJson;
  if (args !== undefined) generation.arguments = args;
  return generation;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

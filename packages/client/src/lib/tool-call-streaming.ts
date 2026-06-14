export interface ToolCallGeneration {
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
 * Extract the SDK/provider's in-progress tool-call block from a
 * `message_update` event. pi-ai normalizes provider deltas to
 * `toolcall_start` / `toolcall_delta` / `toolcall_end`; for providers
 * that stream JSON args (Anthropic input_json_delta, OpenAI Responses
 * function-call arguments deltas, etc.) the `partial` assistant message
 * contains the currently parsed `toolCall` block on every delta.
 *
 * If a provider only emits a complete function call, this still returns
 * the complete block once it arrives; the UI must not invent args before
 * the SDK exposes them.
 */
export function extractToolCallGeneration(
  event: MessageUpdateLike,
): ToolCallGeneration | undefined {
  const streamEvent = event.assistantMessageEvent as AssistantStreamEventLike | undefined;
  if (streamEvent === undefined || typeof streamEvent.type !== "string") return undefined;
  if (!isToolCallStreamEvent(streamEvent.type)) return undefined;

  const contentIndex =
    typeof streamEvent.contentIndex === "number" ? streamEvent.contentIndex : undefined;
  const partial = asRecord(streamEvent.partial) ?? asRecord(event.message);
  const content = Array.isArray(partial?.content) ? partial.content : undefined;
  const block =
    contentIndex !== undefined
      ? asRecord(content?.[contentIndex])
      : content?.map(asRecord).find((candidate) => candidate?.type === "toolCall");

  if (block?.type !== "toolCall") return undefined;

  const name = typeof block.name === "string" && block.name.length > 0 ? block.name : undefined;
  const partialJson =
    typeof block.partialJson === "string" && block.partialJson.length > 0
      ? block.partialJson
      : undefined;
  const args = Object.prototype.hasOwnProperty.call(block, "arguments")
    ? block.arguments
    : undefined;

  const generation: ToolCallGeneration = {};
  if (name !== undefined) generation.name = name;
  if (partialJson !== undefined) generation.partialJson = partialJson;
  if (args !== undefined) generation.arguments = args;
  return generation;
}

function isToolCallStreamEvent(type: string): boolean {
  return type === "toolcall_start" || type === "toolcall_delta" || type === "toolcall_end";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

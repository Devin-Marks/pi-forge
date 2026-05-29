import {
  buildToolCallPairing,
  isPairedToolResult,
  type PairableAgentMessage,
} from "../packages/client/src/lib/tool-call-pairing";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
}

function assistantToolCalls(ids: string[], names = ["grep", "read"]): PairableAgentMessage {
  return {
    role: "assistant",
    content: ids.map((id, index) => ({
      type: "toolCall",
      id,
      name: names[index] ?? "tool",
      arguments: { path: `file-${index}.ts` },
    })),
  };
}

function toolResult(id: string, text: string, toolName = "grep"): PairableAgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName,
    content: [{ type: "text", text }],
  };
}

function visibleMessages(
  messages: PairableAgentMessage[],
  pairing = buildToolCallPairing(messages),
) {
  return messages.filter((m) => !isPairedToolResult(pairing, m));
}

async function main(): Promise<void> {
  console.log("[test-tool-call-pairing] canonical tool call pairing");

  const batchedMessages: PairableAgentMessage[] = [
    { role: "user", content: [{ type: "text", text: "inspect files" }] },
    assistantToolCalls(["call-a", "call-b"], ["grep", "read"]),
    toolResult("call-a", "grep output", "grep"),
    toolResult("call-b", "read output", "read"),
  ];
  const batchedPairing = buildToolCallPairing(batchedMessages);
  assert("pairs first batched tool result", batchedPairing.toolResultsById.has("call-a"));
  assert("pairs second batched tool result", batchedPairing.toolResultsById.has("call-b"));
  assert("marks first result suppressible", batchedPairing.pairedIds.has("call-a"));
  assert("marks second result suppressible", batchedPairing.pairedIds.has("call-b"));
  assert(
    "standalone paired outputs are suppressed",
    visibleMessages(batchedMessages, batchedPairing).length === 2,
    `visible length ${visibleMessages(batchedMessages, batchedPairing).length}`,
  );

  const archivedOneToolTurns: PairableAgentMessage[] = [
    assistantToolCalls(["todo-1"], ["todo"]),
    toolResult("todo-1", "Created #1", "todo"),
    assistantToolCalls(["subagent-1"], ["subagent"]),
    toolResult("subagent-1", "delegate finished", "subagent"),
  ];
  const archivedPairing = buildToolCallPairing(archivedOneToolTurns);
  assert("pairs archived todo one-tool turn", archivedPairing.toolResultsById.has("todo-1"));
  assert(
    "pairs archived subagent one-tool turn",
    archivedPairing.toolResultsById.has("subagent-1"),
  );
  assert(
    "suppresses archived one-tool-turn outputs before batching render",
    visibleMessages(archivedOneToolTurns, archivedPairing).length === 2,
    `visible length ${visibleMessages(archivedOneToolTurns, archivedPairing).length}`,
  );

  const orphanMessages: PairableAgentMessage[] = [toolResult("orphan", "loose output")];
  const orphanPairing = buildToolCallPairing(orphanMessages);
  assert("orphan result stays visible", !isPairedToolResult(orphanPairing, orphanMessages[0]!));

  const mismatchedIdMessages: PairableAgentMessage[] = [
    assistantToolCalls(["call-real"], ["grep"]),
    toolResult("call-replayed-different-id", "grep output after replay", "grep"),
  ];
  const mismatchedPairing = buildToolCallPairing(mismatchedIdMessages);
  assert(
    "does not pair mismatched ids by name/order",
    !mismatchedPairing.toolResultsById.has("call-real"),
  );
  assert(
    "mismatched result remains visible",
    visibleMessages(mismatchedIdMessages, mismatchedPairing).length === 2,
  );

  if (failures > 0) {
    console.log(`\n[test-tool-call-pairing] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-tool-call-pairing] PASS");
}

void main();

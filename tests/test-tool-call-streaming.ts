import assert from "node:assert/strict";
import { extractToolCallGenerations } from "../packages/client/src/lib/tool-call-streaming.js";

const partial = extractToolCallGenerations({
  assistantMessageEvent: {
    type: "toolcall_delta",
    contentIndex: 1,
    delta: '": "src/index.ts"}',
    partial: {
      role: "assistant",
      content: [
        { type: "text", text: "I'll inspect the file." },
        {
          type: "toolCall",
          id: "call_1",
          name: "read",
          arguments: { filePath: "src/index.ts" },
          partialJson: '{"filePath": "src/index.ts"}',
        },
      ],
    },
  },
});

assert.deepEqual(partial, [
  {
    id: "call_1",
    contentIndex: 1,
    name: "read",
    partialJson: '{"filePath": "src/index.ts"}',
    arguments: { filePath: "src/index.ts" },
  },
]);

const completeOnly = extractToolCallGenerations({
  assistantMessageEvent: {
    type: "toolcall_end",
    contentIndex: 0,
    partial: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "call_2",
          name: "bash",
          arguments: { command: "npm test" },
        },
      ],
    },
  },
});

assert.deepEqual(completeOnly, [
  {
    id: "call_2",
    contentIndex: 0,
    name: "bash",
    arguments: { command: "npm test" },
  },
]);

const parallel = extractToolCallGenerations({
  assistantMessageEvent: {
    type: "toolcall_delta",
    contentIndex: 2,
    partial: {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call_a", name: "read", arguments: { filePath: "a.ts" } },
        { type: "text", text: "and" },
        { type: "toolCall", id: "call_b", name: "grep", arguments: { pattern: "TODO" } },
      ],
    },
  },
});

assert.deepEqual(parallel, [
  { id: "call_a", contentIndex: 0, name: "read", arguments: { filePath: "a.ts" } },
  { id: "call_b", contentIndex: 2, name: "grep", arguments: { pattern: "TODO" } },
]);

const ignored = extractToolCallGenerations({
  assistantMessageEvent: { type: "text_delta", delta: "hello" },
});

assert.deepEqual(ignored, []);

console.log("test-tool-call-streaming: ok");

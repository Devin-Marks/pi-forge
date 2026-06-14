import assert from "node:assert/strict";
import { extractToolCallGeneration } from "../packages/client/src/lib/tool-call-streaming.js";

const partial = extractToolCallGeneration({
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

assert.deepEqual(partial, {
  name: "read",
  partialJson: '{"filePath": "src/index.ts"}',
  arguments: { filePath: "src/index.ts" },
});

const completeOnly = extractToolCallGeneration({
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

assert.deepEqual(completeOnly, {
  name: "bash",
  arguments: { command: "npm test" },
});

const ignored = extractToolCallGeneration({
  assistantMessageEvent: { type: "text_delta", delta: "hello" },
});

assert.equal(ignored, undefined);

console.log("test-tool-call-streaming: ok");

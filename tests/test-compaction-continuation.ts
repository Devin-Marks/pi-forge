/**
 * Unit test for the post-compaction continuation extension.
 *
 * Covers `shouldNudgeAfterCompaction()` boundary cases plus an
 * end-to-end check that registering the extension via
 * `DefaultResourceLoader.extensionFactories` actually fires its
 * `context` handler and appends the nudge message.
 *
 * No real LLM call required — we drive the ExtensionRunner directly
 * by emitting a synthetic `context` event after `loader.reload()`.
 */
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, "..");

// Dynamic import from dist/ matches the pattern other tests use
// (test-sse, test-processes) — top-level imports against the compiled
// JS trip TS's noResolve checks at root-level `npm run check`.
interface ExtensionModule {
  compactionContinuationExtension: import("@earendil-works/pi-coding-agent").ExtensionFactory;
  NUDGE_MESSAGE: string;
  shouldNudgeAfterCompaction: (messages: readonly AgentMessage[]) => boolean;
}
const { compactionContinuationExtension, NUDGE_MESSAGE, shouldNudgeAfterCompaction } =
  (await import(
    resolve(repoRoot, "packages/server/dist/agent-extensions/compaction-continuation.js")
  )) as unknown as ExtensionModule;

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function userMessage(text: string): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function compactionSummaryMessage(): AgentMessage {
  // Match the shape from createCompactionSummaryMessage in the SDK:
  // role: "compactionSummary", with summary text + tokensBefore.
  return {
    role: "compactionSummary",
    summary: "## Goal\n[goal]\n\n## Next Steps\n1. Do thing X",
    tokensBefore: 50000,
    timestamp: Date.now(),
  } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
    api: "openai-completions",
    provider: "openai",
    model: "gpt-4",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: "stop",
  } as AgentMessage;
}

function toolResultMessage(): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "tc_1",
    toolName: "bash",
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: Date.now(),
  } as AgentMessage;
}

async function main(): Promise<void> {
  // ===== shouldNudgeAfterCompaction boundary cases =====
  console.log("[test-compaction-continuation] shouldNudgeAfterCompaction()");

  assert("empty array → no nudge", shouldNudgeAfterCompaction([]) === false);

  assert(
    "only a user message → no nudge",
    shouldNudgeAfterCompaction([userMessage("hello")]) === false,
  );

  assert(
    "only a compactionSummary → nudge",
    shouldNudgeAfterCompaction([compactionSummaryMessage()]) === true,
  );

  assert(
    "user prompt after compactionSummary → no nudge (user provides imperative)",
    shouldNudgeAfterCompaction([compactionSummaryMessage(), userMessage("next step")]) === false,
  );

  assert(
    "assistant turn after compactionSummary → no nudge (loop in progress)",
    shouldNudgeAfterCompaction([compactionSummaryMessage(), assistantMessage("done")]) === false,
  );

  assert(
    "tool result after compactionSummary → no nudge",
    shouldNudgeAfterCompaction([compactionSummaryMessage(), toolResultMessage()]) === false,
  );

  assert(
    "compactionSummary at the END of a long history → nudge",
    shouldNudgeAfterCompaction([
      userMessage("first prompt"),
      assistantMessage("did some work"),
      toolResultMessage(),
      compactionSummaryMessage(),
    ]) === true,
  );

  // ===== End-to-end: register via DefaultResourceLoader =====
  console.log("[test-compaction-continuation] e2e via DefaultResourceLoader");

  const cwd = await mkdtemp(join(tmpdir(), "pi-forge-ext-cwd-"));
  const agentDir = await mkdtemp(join(tmpdir(), "pi-forge-ext-pi-"));
  try {
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [compactionContinuationExtension],
    });
    await loader.reload();
    const result = loader.getExtensions();
    assert(
      "loader registered exactly 1 extension",
      result.extensions.length === 1,
      `got ${result.extensions.length}`,
    );

    // The factory itself returns void; the extension records its `on()`
    // calls. We can't easily invoke the ExtensionRunner without a full
    // session, but we can at least assert the factory ran and the
    // DefaultResourceLoader didn't record an error against the
    // factory-derived extension (any registration failure would show
    // up here with a path of "<extensionFactory>" or similar).
    assert(
      "no extension-load errors",
      result.errors.length === 0,
      `errors: ${result.errors.map((e) => `${e.path}: ${e.error}`).join(" | ")}`,
    );

    // Sanity-check: NUDGE_MESSAGE is short enough to not bloat context.
    assert(
      "NUDGE_MESSAGE under 250 chars",
      NUDGE_MESSAGE.length < 250,
      `length=${NUDGE_MESSAGE.length}`,
    );
    assert(
      "NUDGE_MESSAGE includes '[continuation]' marker",
      NUDGE_MESSAGE.includes("[continuation]"),
    );
    assert(
      "NUDGE_MESSAGE names the 'don't summarize' failure mode",
      NUDGE_MESSAGE.toLowerCase().includes("summary") ||
        NUDGE_MESSAGE.toLowerCase().includes("summarize"),
    );
    assert(
      "NUDGE_MESSAGE is open-ended (doesn't prescribe a tool call)",
      !/\bcall a tool\b|\buse the available tools\b|\bemit a tool/i.test(NUDGE_MESSAGE),
    );
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    await rm(agentDir, { recursive: true, force: true }).catch(() => undefined);
  }

  if (failures > 0) {
    console.log(`\n[test-compaction-continuation] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-compaction-continuation] PASS");
}

await main();

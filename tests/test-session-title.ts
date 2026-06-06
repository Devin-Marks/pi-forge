import {
  generateSessionTitleFromPrompt,
  isGenericSessionName,
} from "../packages/server/src/session-title";

let failures = 0;
function assertEqual<T>(label: string, actual: T, expected: T): void {
  const ok = Object.is(actual, expected);
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(
      `  FAIL  ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  }
}

assertEqual(
  "summarizes first prompt into meaningful title",
  generateSessionTitleFromPrompt("Please implement session tab title summaries for the browser UI"),
  "Implement Session Tab Title Summaries",
);
assertEqual(
  "uses referenced file basename",
  generateSessionTitleFromPrompt("Review @packages/server/src/session-registry.ts for title bugs"),
  "Review session-registry.ts Title Bugs",
);
assertEqual(
  "ignores fenced code blocks",
  generateSessionTitleFromPrompt("Fix this crash\n```ts\nconst secret = hugeContext();\n```"),
  "Fix Crash",
);
assertEqual("empty prompt has no title", generateSessionTitleFromPrompt("   \n\t"), undefined);
assertEqual("default name is generic", isGenericSessionName("New session (2)"), true);
assertEqual("manual name is not generic", isGenericSessionName("Release notes"), false);

if (failures > 0) {
  console.error(`test-session-title failed with ${failures} failure(s)`);
  process.exit(1);
}
console.log("test-session-title passed");

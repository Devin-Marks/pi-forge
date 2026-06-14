import { isChatSubmitShortcut } from "../packages/client/src/lib/chat-input-keys.js";

let failures = 0;
function assert(label: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
}

assert("plain Enter does not submit", !isChatSubmitShortcut({ key: "Enter" }));
assert("Shift+Enter does not submit", !isChatSubmitShortcut({ key: "Enter", shiftKey: true }));
assert("Cmd+Enter submits", isChatSubmitShortcut({ key: "Enter", metaKey: true }));
assert("Ctrl+Enter submits", isChatSubmitShortcut({ key: "Enter", ctrlKey: true }));
assert("other keys do not submit", !isChatSubmitShortcut({ key: "Tab", ctrlKey: true }));

if (failures > 0) {
  console.log(`\n[test-chat-input-keys] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[test-chat-input-keys] PASS");

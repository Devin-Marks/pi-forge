import { isChatSubmitShortcut } from "../packages/client/src/lib/chat-input-keys.js";

let failures = 0;
function assert(label: string, ok: boolean): void {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}`);
  }
}

assert("desktop plain Enter submits", isChatSubmitShortcut({ key: "Enter" }, { isMobile: false }));
assert(
  "desktop Shift+Enter does not submit",
  !isChatSubmitShortcut({ key: "Enter", shiftKey: true }, { isMobile: false }),
);
assert(
  "mobile plain Enter does not submit",
  !isChatSubmitShortcut({ key: "Enter" }, { isMobile: true }),
);
assert(
  "Cmd+Enter submits",
  isChatSubmitShortcut({ key: "Enter", metaKey: true }, { isMobile: true }),
);
assert(
  "Ctrl+Enter submits",
  isChatSubmitShortcut({ key: "Enter", ctrlKey: true }, { isMobile: false }),
);
assert(
  "other keys do not submit",
  !isChatSubmitShortcut({ key: "Tab", ctrlKey: true }, { isMobile: false }),
);

if (failures > 0) {
  console.log(`\n[test-chat-input-keys] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[test-chat-input-keys] PASS");

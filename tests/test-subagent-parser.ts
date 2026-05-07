/**
 * Unit tests for `parseSubagentDetails` — the pure-function input to the
 * SubagentResultCard. Pure parser, no DOM, no async — runs in <50ms.
 *
 * Coverage targets:
 *   - SINGLE / PARALLEL / CHAIN / MANAGEMENT mode tagging
 *   - Per-result sessionId derived from sessionFile basename
 *   - Posix and Windows-style separators in sessionFile paths
 *   - Missing optional fields (no sessionFile, no finalOutput)
 *   - Malformed payloads (null, non-object, non-array results) → safe default
 *   - Unrecognised mode strings → "unknown"
 *
 * The pi-subagents source of truth is `src/shared/types.ts` in
 * https://github.com/nicobailon/pi-subagents — see also the integration
 * report captured in `notes/MOBILE.md` for the full schema.
 */
import { parseSubagentDetails } from "../packages/client/src/lib/subagent-parser";

let failures = 0;

function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

function assertEqual<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(label, a === e, `\n    expected: ${e}\n    actual:   ${a}`);
}

// --- Malformed inputs ------------------------------------------------

assertEqual("null details → empty unknown", parseSubagentDetails(null), {
  mode: "unknown",
  results: [],
});
assertEqual("undefined details → empty unknown", parseSubagentDetails(undefined), {
  mode: "unknown",
  results: [],
});
assertEqual("string details → empty unknown", parseSubagentDetails("oops"), {
  mode: "unknown",
  results: [],
});
assertEqual(
  "unrecognised mode → unknown but results still parse",
  parseSubagentDetails({
    mode: "sideways",
    results: [{ agent: "a", task: "t", exitCode: 0 }],
  }),
  {
    mode: "unknown",
    results: [{ agent: "a", task: "t", exitCode: 0 }],
  },
);
assertEqual(
  "non-array results coerce to empty",
  parseSubagentDetails({ mode: "single", results: "nope" }),
  { mode: "single", results: [] },
);

// --- SINGLE mode -----------------------------------------------------

assertEqual(
  "single mode with sessionFile yields a sessionId from the basename",
  parseSubagentDetails({
    mode: "single",
    runId: "run-abc",
    context: "fresh",
    results: [
      {
        agent: "researcher",
        task: "investigate auth",
        exitCode: 0,
        sessionFile:
          "/Users/devin/.pi/agent/sessions/parent-id/run-abc/00000000-1111-2222-3333-444444444444.jsonl",
        finalOutput: "All good.",
      },
    ],
  }),
  {
    mode: "single",
    runId: "run-abc",
    context: "fresh",
    results: [
      {
        agent: "researcher",
        task: "investigate auth",
        exitCode: 0,
        sessionFile:
          "/Users/devin/.pi/agent/sessions/parent-id/run-abc/00000000-1111-2222-3333-444444444444.jsonl",
        sessionId: "00000000-1111-2222-3333-444444444444",
        finalOutput: "All good.",
      },
    ],
  },
);

assertEqual(
  "single mode without sessionFile leaves sessionId undefined",
  parseSubagentDetails({
    mode: "single",
    results: [{ agent: "writer", task: "draft summary", exitCode: 0 }],
  }),
  {
    mode: "single",
    results: [{ agent: "writer", task: "draft summary", exitCode: 0 }],
  },
);

// --- PARALLEL mode (multiple results) --------------------------------

assertEqual(
  "parallel mode with two results, mixed exit codes",
  parseSubagentDetails({
    mode: "parallel",
    runId: "p-1",
    results: [
      {
        agent: "tester",
        task: "run unit",
        exitCode: 0,
        sessionFile: "/abs/parent/p-1/aaa.jsonl",
      },
      {
        agent: "tester",
        task: "run integration",
        exitCode: 1,
        sessionFile: "/abs/parent/p-1/bbb.jsonl",
      },
    ],
  }),
  {
    mode: "parallel",
    runId: "p-1",
    results: [
      {
        agent: "tester",
        task: "run unit",
        exitCode: 0,
        sessionFile: "/abs/parent/p-1/aaa.jsonl",
        sessionId: "aaa",
      },
      {
        agent: "tester",
        task: "run integration",
        exitCode: 1,
        sessionFile: "/abs/parent/p-1/bbb.jsonl",
        sessionId: "bbb",
      },
    ],
  },
);

// --- CHAIN mode ------------------------------------------------------

assertEqual(
  "chain mode tags as chain",
  parseSubagentDetails({
    mode: "chain",
    runId: "c-1",
    context: "fork",
    results: [
      { agent: "step1", task: "do A", exitCode: 0, sessionFile: "/x/y/c-1/step1.jsonl" },
      { agent: "step2", task: "do B", exitCode: 0, sessionFile: "/x/y/c-1/step2.jsonl" },
    ],
  }),
  {
    mode: "chain",
    runId: "c-1",
    context: "fork",
    results: [
      {
        agent: "step1",
        task: "do A",
        exitCode: 0,
        sessionFile: "/x/y/c-1/step1.jsonl",
        sessionId: "step1",
      },
      {
        agent: "step2",
        task: "do B",
        exitCode: 0,
        sessionFile: "/x/y/c-1/step2.jsonl",
        sessionId: "step2",
      },
    ],
  },
);

// --- MANAGEMENT mode (no results.sessionFile) ------------------------

assertEqual(
  "management mode tags correctly even with empty results",
  parseSubagentDetails({ mode: "management", results: [] }),
  { mode: "management", results: [] },
);

// --- Path separator handling ----------------------------------------

assertEqual(
  "windows-style backslashes in sessionFile still extract sessionId",
  parseSubagentDetails({
    mode: "single",
    results: [
      {
        agent: "win",
        task: "t",
        exitCode: 0,
        sessionFile: "C:\\Users\\u\\.pi\\agent\\sessions\\p\\r\\child-id.jsonl",
      },
    ],
  }),
  {
    mode: "single",
    results: [
      {
        agent: "win",
        task: "t",
        exitCode: 0,
        sessionFile: "C:\\Users\\u\\.pi\\agent\\sessions\\p\\r\\child-id.jsonl",
        sessionId: "child-id",
      },
    ],
  },
);

assertEqual(
  "non-jsonl extension means no sessionId is extracted",
  parseSubagentDetails({
    mode: "single",
    results: [{ agent: "x", task: "t", exitCode: 0, sessionFile: "/var/tmp/run/something.json" }],
  }),
  {
    mode: "single",
    results: [{ agent: "x", task: "t", exitCode: 0, sessionFile: "/var/tmp/run/something.json" }],
  },
);

// --- Final tally -----------------------------------------------------

if (failures > 0) {
  console.log(`\n[test-subagent-parser] FAIL — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("\n[test-subagent-parser] PASS");

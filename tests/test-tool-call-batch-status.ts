import { getToolBatchStatus } from "../packages/client/src/lib/tool-call-batch-status";

let failures = 0;
function assert(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`PASS ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL ${label}${detail !== undefined ? ` — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  console.log("[test-tool-call-batch-status] aggregated tool-call status");

  const mixedStatus = getToolBatchStatus([
    { result: { isError: true } },
    { result: { isError: false } },
    { result: { isError: undefined } },
  ]);
  assert("counts failed child calls", mixedStatus.failedChildCount === 1);
  assert("flags child failures", mixedStatus.hasChildFailures);
  assert(
    "does not promote child failure to aggregate error",
    !mixedStatus.hasAggregateError,
    JSON.stringify(mixedStatus),
  );
  assert("completed siblings are not treated as running", mixedStatus.inFlightCount === 0);

  const runningStatus = getToolBatchStatus([{ result: undefined }, { result: { isError: false } }]);
  assert("counts only missing results as in-flight", runningStatus.inFlightCount === 1);
  assert("does not report failures for successful/running batch", !runningStatus.hasChildFailures);
  assert("running batch is not an aggregate error", !runningStatus.hasAggregateError);

  const successStatus = getToolBatchStatus([
    { result: { isError: false } },
    { result: { content: [{ type: "text", text: "ok" }] } },
  ]);
  assert("successful batch has no failed children", successStatus.failedChildCount === 0);
  assert("successful batch has no aggregate error", !successStatus.hasAggregateError);

  const aggregateErrorStatus = getToolBatchStatus([{ result: { isError: false } }], {
    aggregateError: true,
  });
  assert("explicit aggregate-level errors are preserved", aggregateErrorStatus.hasAggregateError);

  if (failures > 0) {
    console.log(`\n[test-tool-call-batch-status] FAIL — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("\n[test-tool-call-batch-status] PASS");
}

void main();

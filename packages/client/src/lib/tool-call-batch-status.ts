export interface ToolBatchStatusInput {
  result: unknown | undefined;
}

export interface ToolBatchStatus {
  inFlightCount: number;
  failedChildCount: number;
  hasChildFailures: boolean;
  /**
   * True only for failures that belong to the aggregate container itself.
   * Individual child tool failures must not promote the whole batch to an
   * errored state; callers should surface them separately with child-oriented
   * copy and keep each child row responsible for its own error styling.
   */
  hasAggregateError: boolean;
}

export function getToolBatchStatus(
  entries: ToolBatchStatusInput[],
  options: { aggregateError?: boolean } = {},
): ToolBatchStatus {
  const inFlightCount = entries.filter((entry) => entry.result === undefined).length;
  const failedChildCount = entries.filter((entry) => isErrorResult(entry.result)).length;
  return {
    inFlightCount,
    failedChildCount,
    hasChildFailures: failedChildCount > 0,
    hasAggregateError: options.aggregateError === true,
  };
}

function isErrorResult(result: unknown): boolean {
  return (
    typeof result === "object" && result !== null && "isError" in result && result.isError === true
  );
}

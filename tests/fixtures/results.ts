import type { AgentResult } from "../../src/shared/types.js";

export function makeResult(
  overrides?: Partial<AgentResult>
): AgentResult {
  return {
    status: overrides?.status ?? "complete",
    summary: overrides?.summary ?? "Task completed successfully",
    artifacts_created: overrides?.artifacts_created ?? ["src/reports/csv-export.ts"],
    artifacts_modified: overrides?.artifacts_modified ?? [],
    issues: overrides?.issues ?? [],
    rework_reason: overrides?.rework_reason,
    rework_target: overrides?.rework_target,
    metadata: overrides?.metadata ?? {},
  };
}

export function makeFailedResult(
  overrides?: Partial<AgentResult>
): AgentResult {
  return makeResult({
    status: "failed",
    summary: "Task failed",
    artifacts_created: [],
    issues: ["Something went wrong"],
    ...overrides,
  });
}

export function makeReworkResult(
  overrides?: Partial<AgentResult>
): AgentResult {
  return makeResult({
    status: "needs_rework",
    summary: "Tests failed, need code fixes",
    artifacts_created: ["tests/csv-export.test.ts"],
    issues: ["3 tests failing"],
    rework_reason: "Unit tests found bugs in CSV export",
    rework_target: "developer",
    ...overrides,
  });
}

/**
 * Test helper: create realistic TaskRun and StepExecution objects.
 */

import type {
  TaskRun,
  StepExecution,
  RunStatus,
  StepStatus,
  AgentResult,
  ExecutionPlan,
  TicketDetails,
} from "../../src/shared/types.js";
import { makeTicket } from "../fixtures/tickets.js";
import { makePlan, makeStep } from "../fixtures/plans.js";
import { makeResult } from "../fixtures/results.js";

let counter = 0;

export function makeStepExecution(overrides?: Partial<StepExecution>): StepExecution {
  return {
    step_number: overrides?.step_number ?? 1,
    agent: overrides?.agent ?? "developer",
    status: overrides?.status ?? "pending",
    container_id: overrides?.container_id ?? null,
    tokens_used: overrides?.tokens_used ?? 0,
    cost_usd: overrides?.cost_usd ?? 0,
    started_at: overrides?.started_at ?? null,
    completed_at: overrides?.completed_at ?? null,
    result: overrides?.result ?? null,
    rework_count: overrides?.rework_count ?? 0,
    runtime_metadata: overrides?.runtime_metadata ?? null,
  };
}

export function makeTaskRun(overrides?: Partial<TaskRun>): TaskRun {
  counter++;
  const now = new Date();
  return {
    run_id: overrides?.run_id ?? `run-test-${counter}`,
    project_id: overrides?.project_id ?? "test-project",
    ticket: overrides?.ticket ?? makeTicket(),
    plan: overrides && "plan" in overrides ? overrides.plan! : makePlan(),
    validated_plan: overrides && "validated_plan" in overrides
      ? overrides.validated_plan!
      : overrides && "plan" in overrides
        ? overrides.plan!
        : makePlan(),
    status: overrides?.status ?? "executing",
    steps: overrides?.steps ?? [
      makeStepExecution({ step_number: 1, agent: "developer", status: "completed", result: makeResult() }),
      makeStepExecution({ step_number: 2, agent: "qa", status: "running" }),
    ],
    total_tokens_used: overrides?.total_tokens_used ?? 150_000,
    total_cost_usd: overrides?.total_cost_usd ?? 2.50,
    created_at: overrides?.created_at ?? now,
    updated_at: overrides?.updated_at ?? now,
    completed_at: overrides?.completed_at ?? null,
    pr_url: overrides?.pr_url ?? null,
    error: overrides?.error ?? null,
  };
}

/** Create a completed run with all steps done. */
export function makeCompletedRun(overrides?: Partial<TaskRun>): TaskRun {
  const completed = new Date();
  return makeTaskRun({
    status: "completed",
    steps: [
      makeStepExecution({
        step_number: 1,
        agent: "developer",
        status: "completed",
        started_at: new Date(completed.getTime() - 60_000),
        completed_at: new Date(completed.getTime() - 30_000),
        tokens_used: 80_000,
        cost_usd: 1.20,
        result: makeResult(),
      }),
      makeStepExecution({
        step_number: 2,
        agent: "qa",
        status: "completed",
        started_at: new Date(completed.getTime() - 29_000),
        completed_at: completed,
        tokens_used: 50_000,
        cost_usd: 0.80,
        result: makeResult({ summary: "All tests pass" }),
      }),
    ],
    total_tokens_used: 130_000,
    total_cost_usd: 2.00,
    completed_at: completed,
    pr_url: "https://github.com/test/repo/pull/42",
    ...overrides,
  });
}

/** Create a failed run. */
export function makeFailedRun(overrides?: Partial<TaskRun>): TaskRun {
  return makeTaskRun({
    status: "failed",
    steps: [
      makeStepExecution({
        step_number: 1,
        agent: "developer",
        status: "failed",
        result: {
          status: "failed",
          summary: "Build errors",
          artifacts_created: [],
          artifacts_modified: [],
          issues: ["TypeScript compilation failed"],
          metadata: {},
        },
      }),
    ],
    error: "Step 1 failed: Build errors",
    ...overrides,
  });
}

/** Create a run waiting for human review. */
export function makeWaitingRun(overrides?: Partial<TaskRun>): TaskRun {
  return makeTaskRun({
    status: "waiting_human_review",
    steps: [
      makeStepExecution({ step_number: 1, agent: "developer", status: "completed", result: makeResult() }),
      makeStepExecution({ step_number: 2, agent: "qa", status: "completed", result: makeResult() }),
    ],
    ...overrides,
  });
}

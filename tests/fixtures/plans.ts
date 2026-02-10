import type { ExecutionPlan, PlanStep, HumanGate } from "../../src/shared/types.js";

export function makePlan(overrides?: {
  steps?: PlanStep[];
  gates?: HumanGate[];
  classification?: ExecutionPlan["classification"];
}): ExecutionPlan {
  return {
    plan_id: `plan-${Date.now()}`,
    ticket_id: "TEST-123",
    classification: overrides?.classification ?? "new_feature",
    reasoning: "This is a new feature that needs dev and QA",
    steps: overrides?.steps ?? [
      makeStep({ step_number: 1, agent: "developer", task: "Implement CSV export" }),
      makeStep({
        step_number: 2,
        agent: "qa",
        task: "Write tests for CSV export",
        depends_on: [1],
      }),
    ],
    parallel_groups: [],
    human_gates: overrides?.gates ?? [],
  };
}

export function makeStep(overrides?: Partial<PlanStep>): PlanStep {
  return {
    step_number: overrides?.step_number ?? 1,
    agent: overrides?.agent ?? "developer",
    task: overrides?.task ?? "Implement the feature",
    context_inputs: overrides?.context_inputs ?? [{ type: "ticket" }],
    depends_on: overrides?.depends_on ?? [],
    estimated_complexity: overrides?.estimated_complexity ?? "medium",
  };
}

export function makeDevQaPlan(): ExecutionPlan {
  return makePlan({
    steps: [
      makeStep({ step_number: 1, agent: "developer", task: "Implement feature" }),
      makeStep({
        step_number: 2,
        agent: "qa",
        task: "Test feature",
        depends_on: [1],
      }),
    ],
  });
}

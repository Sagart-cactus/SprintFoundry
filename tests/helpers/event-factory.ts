/**
 * Test helper: create realistic TaskEvent objects.
 */

import type { TaskEvent, EventType } from "../../src/shared/types.js";

let eventCounter = 0;

export function makeEvent(overrides?: Partial<TaskEvent>): TaskEvent {
  eventCounter++;
  return {
    event_id: overrides?.event_id ?? `evt-${eventCounter}`,
    run_id: overrides?.run_id ?? "run-test-1",
    event_type: overrides?.event_type ?? "task.created",
    timestamp: overrides?.timestamp ?? new Date(),
    data: overrides?.data ?? {},
  };
}

/** Create a sequence of events for a typical successful run. */
export function makeRunEventSequence(runId = "run-test-1"): TaskEvent[] {
  const base = Date.now();
  return [
    makeEvent({
      run_id: runId,
      event_type: "task.created",
      timestamp: new Date(base),
      data: { ticket_id: "TEST-123" },
    }),
    makeEvent({
      run_id: runId,
      event_type: "task.plan_generated",
      timestamp: new Date(base + 1000),
      data: { plan: { classification: "new_feature", steps: [] } },
    }),
    makeEvent({
      run_id: runId,
      event_type: "task.plan_validated",
      timestamp: new Date(base + 2000),
      data: {},
    }),
    makeEvent({
      run_id: runId,
      event_type: "step.started",
      timestamp: new Date(base + 3000),
      data: { step: 1, agent: "developer" },
    }),
    makeEvent({
      run_id: runId,
      event_type: "step.completed",
      timestamp: new Date(base + 30_000),
      data: { step: 1, agent: "developer", tokens: 80_000 },
    }),
    makeEvent({
      run_id: runId,
      event_type: "step.started",
      timestamp: new Date(base + 31_000),
      data: { step: 2, agent: "qa" },
    }),
    makeEvent({
      run_id: runId,
      event_type: "step.completed",
      timestamp: new Date(base + 55_000),
      data: { step: 2, agent: "qa", tokens: 50_000 },
    }),
    makeEvent({
      run_id: runId,
      event_type: "task.completed",
      timestamp: new Date(base + 60_000),
      data: { pr_url: "https://github.com/test/repo/pull/42" },
    }),
  ];
}

/** Create events that lead to a failure. */
export function makeFailureEventSequence(runId = "run-fail-1"): TaskEvent[] {
  const base = Date.now();
  return [
    makeEvent({
      run_id: runId,
      event_type: "task.created",
      timestamp: new Date(base),
      data: {},
    }),
    makeEvent({
      run_id: runId,
      event_type: "task.plan_generated",
      timestamp: new Date(base + 1000),
      data: { plan: { classification: "bug_fix", steps: [] } },
    }),
    makeEvent({
      run_id: runId,
      event_type: "step.started",
      timestamp: new Date(base + 2000),
      data: { step: 1, agent: "developer" },
    }),
    makeEvent({
      run_id: runId,
      event_type: "step.failed",
      timestamp: new Date(base + 20_000),
      data: { step: 1, agent: "developer", error: "Build failed" },
    }),
    makeEvent({
      run_id: runId,
      event_type: "task.failed",
      timestamp: new Date(base + 21_000),
      data: { error: "Step 1 failed" },
    }),
  ];
}

/** Create events that include a rework cycle. */
export function makeReworkEventSequence(runId = "run-rework-1"): TaskEvent[] {
  const base = Date.now();
  return [
    makeEvent({ run_id: runId, event_type: "task.created", timestamp: new Date(base), data: {} }),
    makeEvent({ run_id: runId, event_type: "task.plan_generated", timestamp: new Date(base + 1000), data: {} }),
    makeEvent({ run_id: runId, event_type: "step.started", timestamp: new Date(base + 2000), data: { step: 1, agent: "developer" } }),
    makeEvent({ run_id: runId, event_type: "step.completed", timestamp: new Date(base + 20_000), data: { step: 1, agent: "developer" } }),
    makeEvent({ run_id: runId, event_type: "step.started", timestamp: new Date(base + 21_000), data: { step: 2, agent: "qa" } }),
    makeEvent({ run_id: runId, event_type: "step.completed", timestamp: new Date(base + 40_000), data: { step: 2, agent: "qa" } }),
    makeEvent({ run_id: runId, event_type: "step.rework_triggered", timestamp: new Date(base + 41_000), data: { step: 2, target: "developer", reason: "Tests failing" } }),
    makeEvent({ run_id: runId, event_type: "step.started", timestamp: new Date(base + 42_000), data: { step: 901, agent: "developer" } }),
    makeEvent({ run_id: runId, event_type: "step.completed", timestamp: new Date(base + 60_000), data: { step: 901, agent: "developer" } }),
    makeEvent({ run_id: runId, event_type: "task.completed", timestamp: new Date(base + 61_000), data: {} }),
  ];
}

/** Create events for a human gate scenario. */
export function makeHumanGateEventSequence(runId = "run-gate-1"): TaskEvent[] {
  const base = Date.now();
  return [
    makeEvent({ run_id: runId, event_type: "task.created", timestamp: new Date(base), data: {} }),
    makeEvent({ run_id: runId, event_type: "task.plan_generated", timestamp: new Date(base + 1000), data: {} }),
    makeEvent({ run_id: runId, event_type: "step.started", timestamp: new Date(base + 2000), data: { step: 1, agent: "developer" } }),
    makeEvent({ run_id: runId, event_type: "step.completed", timestamp: new Date(base + 20_000), data: { step: 1, agent: "developer" } }),
    makeEvent({ run_id: runId, event_type: "human_gate.requested", timestamp: new Date(base + 21_000), data: { after_step: 1, reason: "P0 requires review" } }),
  ];
}

import { describe, expect, it } from "vitest";
import type {
  ExecutionBackend,
  RunEnvironmentHandle,
  SandboxTeardownReason,
} from "../src/service/execution/index.js";
import type { AgentRunConfig, AgentRunResult } from "../src/service/agent-runner.js";
import type { ExecutionPlan, PlanStep, TaskRun } from "../src/shared/types.js";

class TestExecutionBackend implements ExecutionBackend {
  async prepareRunEnvironment(
    run: TaskRun,
    _plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    return {
      run_id: run.run_id,
      project_id: run.project_id,
      sandbox_id: "sandbox-test",
      execution_backend: "test",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {},
    };
  }

  async executeStep(
    _handle: RunEnvironmentHandle,
    _step: PlanStep,
    _config: AgentRunConfig
  ): Promise<AgentRunResult> {
    return {
      agentResult: {
        status: "complete",
        summary: "ok",
        artifacts_created: [],
        artifacts_modified: [],
        issues: [],
        metadata: {},
      },
      tokens_used: 0,
      cost_usd: 0,
      duration_seconds: 0,
      container_id: "sandbox-test",
    };
  }

  async pauseRun(_handle: RunEnvironmentHandle): Promise<void> {}

  async resumeRun(handle: RunEnvironmentHandle): Promise<RunEnvironmentHandle> {
    return handle;
  }

  async teardownRun(
    _handle: RunEnvironmentHandle,
    _reason: SandboxTeardownReason
  ): Promise<void> {}
}

describe("ExecutionBackend", () => {
  it("can be implemented by a run-scoped backend", async () => {
    const backend: ExecutionBackend = new TestExecutionBackend();

    const handle = await backend.prepareRunEnvironment(
      {
        run_id: "run-1",
        project_id: "proj-1",
        ticket: {
          id: "T-1",
          source: "prompt",
          title: "Title",
          description: "Description",
          labels: [],
          priority: "p2",
          acceptance_criteria: [],
          linked_tickets: [],
          comments: [],
          author: "tester",
          raw: {},
        },
        plan: null,
        validated_plan: null,
        status: "pending",
        steps: [],
        total_tokens_used: 0,
        total_cost_usd: 0,
        created_at: new Date(),
        updated_at: new Date(),
        completed_at: null,
        pr_url: null,
        error: null,
      },
      {
        plan_id: "plan-1",
        ticket_id: "T-1",
        classification: "direct",
        reasoning: "test",
        steps: [],
        parallel_groups: [],
        human_gates: [],
      },
      "/tmp/workspace"
    );

    expect(handle.execution_backend).toBe("test");
    expect(handle.workspace_path).toBe("/tmp/workspace");
    await expect(backend.resumeRun(handle)).resolves.toEqual(handle);
  });
});

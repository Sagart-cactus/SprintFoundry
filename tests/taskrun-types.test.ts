import { describe, expect, it } from "vitest";
import type { StepExecution, TaskRun } from "../src/shared/types.js";

describe("TaskRun run-environment fields", () => {
  it("supports legacy task run objects without sandbox metadata", () => {
    const run: TaskRun = {
      run_id: "run-1",
      project_id: "project-1",
      ticket: {
        id: "T-1",
        source: "prompt",
        title: "Legacy run",
        description: "No sandbox metadata yet",
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
    };

    expect(run.project_id).toBe("project-1");
    expect(run.run_environment).toBeUndefined();
  });

  it("supports enriched task and step records with sandbox identity", () => {
    const step: StepExecution = {
      step_number: 1,
      agent: "developer",
      status: "running",
      sandbox_id: "sandbox-1",
      execution_backend: "local",
      attempted_with_resume: true,
      container_id: "runtime-1",
      tokens_used: 10,
      cost_usd: 0.01,
      started_at: new Date(),
      completed_at: null,
      result: null,
      rework_count: 0,
      runtime_metadata: null,
    };

    const run: TaskRun = {
      run_id: "run-2",
      project_id: "project-2",
      tenant_id: "tenant-a",
      ticket: {
        id: "T-2",
        source: "prompt",
        title: "Sandboxed run",
        description: "Carries run environment metadata",
        labels: [],
        priority: "p1",
        acceptance_criteria: [],
        linked_tickets: [],
        comments: [],
        author: "tester",
        raw: {},
      },
      plan: null,
      validated_plan: null,
      status: "executing",
      sandbox_id: "sandbox-1",
      execution_backend: "local",
      workspace_volume_ref: "workspace-1",
      network_profile: "github-only",
      secret_profile: "minimal",
      isolation_level: "standard_isolated",
      resume_token: "resume-1",
      checkpoint_generation: 2,
      run_environment: {
        run_id: "run-2",
        project_id: "project-2",
        tenant_id: "tenant-a",
        sandbox_id: "sandbox-1",
        execution_backend: "local",
        workspace_path: "/tmp/workspace",
        workspace_volume_ref: "workspace-1",
        network_profile: "github-only",
        secret_profile: "minimal",
        isolation_level: "standard_isolated",
        resume_token: "resume-1",
        checkpoint_generation: 2,
        metadata: {},
      },
      steps: [step],
      total_tokens_used: 10,
      total_cost_usd: 0.01,
      created_at: new Date(),
      updated_at: new Date(),
      completed_at: null,
      pr_url: null,
      error: null,
    };

    expect(run.run_environment).toMatchObject({
      sandbox_id: "sandbox-1",
      execution_backend: "local",
    });
    expect(run.steps[0].attempted_with_resume).toBe(true);
  });
});

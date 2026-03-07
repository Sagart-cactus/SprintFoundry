import type { AgentRunConfig, AgentRunResult } from "../agent-runner.js";
import type { ExecutionPlan, PlanStep, TaskRun } from "../../shared/types.js";

export type SandboxTeardownReason = "completed" | "failed" | "cancelled";

export type ExecutionIsolationLevel =
  | "standard_isolated"
  | "hardened_isolated"
  | "strong_isolated";

/**
 * Stable run-scoped identity and policy metadata owned by an execution backend.
 */
export interface RunEnvironmentHandle {
  run_id: string;
  project_id: string;
  tenant_id?: string;
  sandbox_id: string;
  execution_backend: string;
  workspace_path: string;
  workspace_volume_ref?: string;
  network_profile?: string;
  secret_profile?: string;
  isolation_level?: ExecutionIsolationLevel;
  resume_token?: string;
  checkpoint_generation: number;
  metadata: Record<string, unknown>;
}

/**
 * Run-scoped sandbox lifecycle contract used by the orchestration layer.
 */
export interface ExecutionBackend {
  /**
   * Create or bind to the sandbox that will execute all steps for a run.
   */
  prepareRunEnvironment(
    run: TaskRun,
    plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle>;

  /**
   * Execute a single plan step inside an already-prepared run sandbox.
   */
  executeStep(
    handle: RunEnvironmentHandle,
    step: PlanStep,
    config: AgentRunConfig
  ): Promise<AgentRunResult>;

  /**
   * Pause sandbox execution. May be a no-op depending on backend capabilities.
   */
  pauseRun(handle: RunEnvironmentHandle): Promise<void>;

  /**
   * Resume sandbox execution and return the current handle if it changed.
   * May be a no-op depending on backend capabilities.
   */
  resumeRun(handle: RunEnvironmentHandle): Promise<RunEnvironmentHandle>;

  /**
   * Tear down the sandbox for a run after completion, failure, or cancellation.
   */
  teardownRun(
    handle: RunEnvironmentHandle,
    reason: SandboxTeardownReason
  ): Promise<void>;
}

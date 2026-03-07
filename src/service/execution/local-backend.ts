import type { AgentRunConfig, AgentRunResult } from "../agent-runner.js";
import type { ExecutionPlan, PlanStep, TaskRun } from "../../shared/types.js";
import { RuntimeFactory } from "../runtime/runtime-factory.js";
import type { ExecutionBackend, RunEnvironmentHandle, SandboxTeardownReason } from "./backend.js";

export class LocalExecutionBackend implements ExecutionBackend {
  constructor(private runtimeFactory: RuntimeFactory = new RuntimeFactory()) {}

  async prepareRunEnvironment(
    run: TaskRun,
    _plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    return {
      run_id: run.run_id,
      project_id: run.project_id,
      sandbox_id: `local-${run.run_id}`,
      execution_backend: "local",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {},
    };
  }

  async executeStep(
    _handle: RunEnvironmentHandle,
    _step: PlanStep,
    config: AgentRunConfig
  ): Promise<AgentRunResult> {
    if (!config.runtime) {
      throw new Error("LocalExecutionBackend requires config.runtime");
    }

    const runtimeImpl = this.runtimeFactory.create(config.runtime);
    const result = await runtimeImpl.runStep({
      runId: config.runId,
      stepNumber: config.stepNumber,
      stepAttempt: config.stepAttempt,
      agent: config.agent,
      task: config.task,
      context_inputs: config.context_inputs,
      workspacePath: config.workspacePath,
      modelConfig: config.modelConfig,
      apiKey: config.apiKey,
      timeoutMinutes: config.timeoutMinutes,
      tokenBudget: config.tokenBudget,
      previousStepResults: config.previousStepResults,
      plugins: config.resolvedPluginPaths ?? [],
      cliFlags: config.cliFlags,
      containerResources: config.containerResources,
      runtime: config.runtime,
      containerImage: config.containerImage,
      codexHomeDir: config.codexHomeDir,
      codexSkillNames: config.codexSkillNames,
      resumeSessionId: config.resumeSessionId,
      resumeReason: config.resumeReason,
      guardrails: config.guardrails,
      onActivity: config.onRuntimeActivity,
      sinkClient: config.sinkClient,
    });

    return {
      agentResult: {
        status: "complete",
        summary: "",
        artifacts_created: [],
        artifacts_modified: [],
        issues: [],
        metadata: {},
      },
      tokens_used: result.tokens_used,
      cost_usd: result.cost_usd ?? 0,
      duration_seconds: 0,
      container_id: result.runtime_id,
      usage: result.usage,
      resume_used: result.resume_used,
      resume_failed: result.resume_failed,
      resume_fallback: result.resume_fallback,
      token_savings: result.token_savings,
      runtime_metadata: result.runtime_metadata,
    };
  }

  async pauseRun(_handle: RunEnvironmentHandle): Promise<void> {
    console.warn("[execution-backend] LocalExecutionBackend does not support pause/resume");
  }

  async resumeRun(handle: RunEnvironmentHandle): Promise<RunEnvironmentHandle> {
    console.warn("[execution-backend] LocalExecutionBackend does not support pause/resume");
    return handle;
  }

  async teardownRun(
    _handle: RunEnvironmentHandle,
    _reason: SandboxTeardownReason
  ): Promise<void> {
    // Workspace cleanup remains owned by OrchestrationService and workspace managers.
  }
}

// ============================================================
// SprintFoundry — Orchestration Service
// The "hard shell" — enforces guardrails, manages execution
// ============================================================

import { execSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  TaskRun,
  TicketDetails,
  ExecutionPlan,
  PlanStep,
  StepExecution,
  AgentResult,
  ProjectConfig,
  PlatformConfig,
  BudgetConfig,
  PlatformRule,
  AgentType,
  AgentRole,
  HumanReview,
  TaskEvent,
  EventType,
  RunStatus,
  RuntimeConfig,
} from "../shared/types.js";
import { PlanValidator } from "./plan-validator.js";
import { AgentRunner } from "./agent-runner.js";
import { EventStore } from "./event-store.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { TicketFetcher } from "./ticket-fetcher.js";
import { GitManager } from "./git-manager.js";
import { NotificationService } from "./notification-service.js";
import { RuntimeSessionStore } from "./runtime-session-store.js";
import type { PlannerRuntime } from "./runtime/types.js";
import { PlannerFactory } from "./runtime/planner-factory.js";

export class OrchestrationService {
  private validator: PlanValidator;
  private agentRunner: AgentRunner;
  private plannerRuntime: PlannerRuntime;
  private events: EventStore;
  private workspace: WorkspaceManager;
  private tickets: TicketFetcher;
  private git: GitManager;
  private notifications: NotificationService;
  private sessions: RuntimeSessionStore;

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig
  ) {
    this.validator = new PlanValidator(platformConfig, projectConfig);
    this.agentRunner = new AgentRunner(platformConfig, projectConfig);
    this.plannerRuntime = new PlannerFactory().create(platformConfig, projectConfig);
    this.events = new EventStore(platformConfig.events_dir);
    this.workspace = new WorkspaceManager(projectConfig);
    this.tickets = new TicketFetcher(projectConfig.integrations);
    this.git = new GitManager(projectConfig.repo, projectConfig.branch_strategy);
    this.notifications = new NotificationService(projectConfig.integrations);
    this.sessions = new RuntimeSessionStore();
  }

  // ---- Main entry point ----

  async handleTask(
    ticketId: string,
    source: "linear" | "github" | "jira" | "prompt",
    promptText?: string
  ): Promise<TaskRun> {
    // 1. Create the run
    const run = this.createRun(ticketId);
    await this.emitEvent(run.run_id, "task.created", { ticketId, source });

    try {
      // 2. Fetch ticket details (or create from prompt)
      const ticket = source === "prompt"
        ? this.createTicketFromPrompt(ticketId, promptText!)
        : await this.tickets.fetch(ticketId, source);

      run.ticket = ticket;
      await this.emitEvent(run.run_id, "task.created", { ticket });

      // 3. Prepare workspace (clone repo, create branch)
      console.log(`[orchestrator] Creating workspace for run ${run.run_id}...`);
      const workspacePath = await this.workspace.create(run.run_id);
      console.log(`[orchestrator] Workspace created: ${workspacePath}`);

      console.log(`[orchestrator] Cloning repo and creating branch...`);
      await this.git.cloneAndBranch(workspacePath, ticket);
      console.log(`[orchestrator] Repo cloned successfully.`);

      // Initialize event store after clone. Initializing earlier can create
      // workspace files (e.g. .events.jsonl) that make `git clone ... .` fail.
      await this.events.initialize(workspacePath);

      await this.runRegistryPreflight(workspacePath);

      // 4. Get plan from orchestrator agent
      run.status = "planning";
      console.log(`[orchestrator] Generating execution plan via ${this.plannerRuntime.constructor.name}...`);
      const plan = await this.plannerRuntime.generatePlan(
        ticket,
        this.platformConfig.agent_definitions,
        this.getMergedRules(),
        workspacePath
      );
      run.plan = plan;
      console.log(`[orchestrator] Plan generated: ${plan.steps.length} steps, classification=${plan.classification}`);
      for (const step of plan.steps) {
        console.log(`  Step ${step.step_number}: ${step.agent} — ${step.task.slice(0, 80)}`);
      }
      await this.emitEvent(run.run_id, "task.plan_generated", { plan });

      // 5. Validate and enforce rules on the plan
      console.log(`[orchestrator] Validating plan against rules...`);
      const validatedPlan = this.validator.validate(plan, ticket);
      run.validated_plan = validatedPlan;
      console.log(`[orchestrator] Plan validated: ${validatedPlan.steps.length} steps (${validatedPlan.steps.length - plan.steps.length} injected by rules)`);
      await this.emitEvent(run.run_id, "task.plan_validated", {
        original_steps: plan.steps.length,
        validated_steps: validatedPlan.steps.length,
        injected_steps: validatedPlan.steps.length - plan.steps.length,
      });

      // 6. Execute the plan
      run.status = "executing";
      console.log(`[orchestrator] Starting plan execution...`);
      await this.executePlan(run, validatedPlan, workspacePath);

      // 7. If all passed, create PR and update ticket
      if ((run.status as string) === "completed") {
        const prUrl = await this.git.createPullRequest(workspacePath, run);
        run.pr_url = prUrl;
        await this.emitEvent(run.run_id, "pr.created", { prUrl });

        await this.tickets.updateStatus(ticket, "in_review", prUrl);
        await this.emitEvent(run.run_id, "ticket.updated", { status: "in_review" });

        await this.notifications.send(
          `Task ${ticket.id} completed. PR: ${prUrl}`
        );
      }

      return run;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await this.emitEvent(run.run_id, "task.failed", { error: run.error });
      await this.notifications.send(
        `Task ${run.ticket?.id ?? ticketId} failed: ${run.error}`
      );
      return run;
    } finally {
      await this.events.close();
    }
  }

  // ---- Plan Execution Engine ----

  private async executePlan(
    run: TaskRun,
    plan: ExecutionPlan,
    workspacePath: string
  ): Promise<void> {
    const completed = new Set<number>();
    const reworkCounts = new Map<number, number>();

    // Build dependency graph
    const steps = new Map(plan.steps.map((s) => [s.step_number, s]));

    while (completed.size < plan.steps.length) {
      // Find steps that are ready to execute (all dependencies met)
      const ready = plan.steps.filter(
        (s) =>
          !completed.has(s.step_number) &&
          s.depends_on.every((d) => completed.has(d))
      );

      if (ready.length === 0) {
        run.status = "failed";
        run.error = "Deadlock: no executable steps remaining";
        return;
      }

      // Check if any ready steps can be parallelized
      const parallelGroup = this.findParallelGroup(ready, plan.parallel_groups);

      if (parallelGroup.length > 1) {
        // Phase 1: Execute in parallel, collecting rework signals instead of handling them inline.
        // This prevents multiple parallel steps from each spawning an independent developer rework call.
        const reworkSignals: Array<{ step: PlanStep; agentResult: AgentResult; currentRework: number }> = [];
        const results = await Promise.all(
          parallelGroup.map((step) =>
            this.executeStep(run, step, workspacePath, reworkCounts, reworkSignals)
          )
        );

        // Hard failures take precedence
        for (let i = 0; i < parallelGroup.length; i++) {
          if (results[i] === "failed") {
            run.status = "failed";
            return;
          }
        }

        // Phase 2: If any steps need rework, merge them into a single planRework call
        if (reworkSignals.length > 0) {
          const budget = this.resolveBudget(run.ticket);
          const maxRework = budget.max_rework_cycles ?? this.platformConfig.defaults.max_rework_cycles;

          if (reworkSignals.some((s) => s.currentRework >= maxRework)) {
            run.status = "failed";
            await this.notifications.send(
              `Parallel group exceeded max rework cycles (${maxRework}). Escalating.`
            );
            return;
          }

          const mergedReason =
            reworkSignals.length === 1
              ? (reworkSignals[0].agentResult.rework_reason ?? "Rework requested")
              : reworkSignals
                  .map((s) => `[${s.step.agent}] ${s.agentResult.rework_reason ?? "Rework requested"}`)
                  .join("; ");

          const primarySignal = reworkSignals[0];
          const mergedAgentResult: AgentResult = { ...primarySignal.agentResult, rework_reason: mergedReason };

          for (const signal of reworkSignals) {
            reworkCounts.set(signal.step.step_number, signal.currentRework + 1);
            await this.emitEvent(run.run_id, "step.rework_triggered", {
              step: signal.step.step_number,
              reason: signal.agentResult.rework_reason,
              rework_count: signal.currentRework + 1,
              merged: reworkSignals.length > 1,
            });
          }

          const previousReworkResults = run.steps
            .filter((s) => s.step_number === primarySignal.step.step_number && s.status === "needs_rework" && s.result)
            .map((s) => s.result!);

          const reworkPlan = await this.plannerRuntime.planRework(
            run.ticket,
            primarySignal.step,
            mergedAgentResult,
            workspacePath,
            run.steps,
            primarySignal.currentRework + 1,
            previousReworkResults
          );

          for (const reworkStep of reworkPlan.steps) {
            const reworkResult = await this.executeStep(
              run,
              reworkStep,
              workspacePath,
              reworkCounts,
              undefined,
              "rework_plan"
            );
            if (reworkResult === "failed") {
              run.status = "failed";
              return;
            }
          }

          // Retry the parallel group — while loop will pick it up since none were added to `completed`
          continue;
        }

        for (let i = 0; i < parallelGroup.length; i++) {
          if (results[i] === "completed") {
            completed.add(parallelGroup[i].step_number);
          }
        }
      } else {
        // Execute sequentially
        const step = ready[0];
        const result = await this.executeStep(run, step, workspacePath, reworkCounts);

        if (result === "completed") {
          completed.add(step.step_number);
        } else if (result === "failed") {
          run.status = "failed";
          return;
        }
      }

      // Check for human gates after completed steps
      for (const stepNum of completed) {
        const gate = plan.human_gates.find(
          (g) => g.after_step === stepNum && g.required
        );
        if (gate) {
          // Remove from completed to prevent re-triggering
          const alreadyReviewed = run.steps.find(
            (s) => s.step_number === stepNum
          )?.result?.metadata?.["human_reviewed"];

          if (!alreadyReviewed) {
            run.status = "waiting_human_review";
            const approved = await this.requestHumanReview(
              run,
              stepNum,
              gate.reason,
              workspacePath
            );

            if (!approved) {
              run.status = "failed";
              run.error = "Human review rejected";
              return;
            }
            const reviewedStep = run.steps.find(
              (s) => s.step_number === stepNum && s.status === "completed"
            );
            if (reviewedStep?.result) {
              reviewedStep.result.metadata = {
                ...reviewedStep.result.metadata,
                human_reviewed: true,
              };
            }
            run.status = "executing";
          }
        }
      }
    }

    run.status = "completed";
    run.completed_at = new Date();
    await this.emitEvent(run.run_id, "task.completed", {
      total_tokens: run.total_tokens_used,
      total_cost: run.total_cost_usd,
    });
  }

  // ---- Single Step Execution ----

  private async executeStep(
    run: TaskRun,
    step: PlanStep,
    workspacePath: string,
    reworkCounts: Map<number, number>,
    parallelReworkSignals?: Array<{ step: PlanStep; agentResult: AgentResult; currentRework: number }>,
    resumeReason?: string
  ): Promise<"completed" | "failed" | "rework"> {
    const budget = this.resolveBudget(run.ticket);
    const maxRework = budget.max_rework_cycles ?? this.platformConfig.defaults.max_rework_cycles;
    const currentRework = reworkCounts.get(step.step_number) ?? 0;

    // Initialize step execution record
    const stepExec: StepExecution = {
      step_number: step.step_number,
      agent: step.agent,
      status: "running",
      container_id: null,
      tokens_used: 0,
      cost_usd: 0,
      started_at: new Date(),
      completed_at: null,
      result: null,
      rework_count: currentRework,
    };
    run.steps.push(stepExec);

    // Resolve model + budget for this agent (project overrides > platform defaults)
    const modelConfig = this.resolveModel(step.agent);
    const runtime = this.resolveRuntimeForAgent(step.agent);
    const cliFlags = this.platformConfig.defaults.agent_cli_flags;
    const containerResources = this.platformConfig.defaults.container_resources;
    const resumeSession = resumeReason
      ? await this.sessions.findLatestByAgent(workspacePath, run.run_id, step.agent)
      : null;
    const resumeSessionId = resumeSession?.session_id;
    const initialResumeTelemetry = {
      resume_used: Boolean(resumeSessionId),
      resume_failed: false,
      resume_fallback: false,
    };
    let finalResumeTelemetry = { ...initialResumeTelemetry };
    let tokenSavings: Record<string, number> | undefined;

    await this.emitEvent(run.run_id, "step.started", {
      step: step.step_number,
      agent: step.agent,
      task: step.task,
      ...initialResumeTelemetry,
    });

    const apiKey = this.resolveApiKey(modelConfig.provider, runtime);

    console.log(
      `[step ${step.step_number}] Debug auth: provider=${modelConfig.provider}, model=${modelConfig.model}, runtime=${runtime.provider}/${runtime.mode}, api_key_present=${apiKey.length > 0}`
    );

    // Check total task budget (tokens)
    if (run.total_tokens_used >= budget.per_task_total_tokens) {
      stepExec.status = "failed";
      await this.emitEvent(run.run_id, "agent.token_limit_exceeded", {
        step: step.step_number,
        total_used: run.total_tokens_used,
        limit: budget.per_task_total_tokens,
      });
      return "failed";
    }

    // Check total task cost cap
    if (budget.per_task_max_cost_usd > 0 && run.total_cost_usd >= budget.per_task_max_cost_usd) {
      stepExec.status = "failed";
      await this.emitEvent(run.run_id, "agent.token_limit_exceeded", {
        step: step.step_number,
        total_cost: run.total_cost_usd,
        cost_limit: budget.per_task_max_cost_usd,
        reason: "per_task_max_cost_usd exceeded",
      });
      return "failed";
    }

    // Check total task timeout
    const taskTimeoutMinutes = this.platformConfig.defaults.timeouts.task_timeout_minutes;
    if (taskTimeoutMinutes > 0) {
      const elapsedMinutes = (Date.now() - run.created_at.getTime()) / 60_000;
      if (elapsedMinutes >= taskTimeoutMinutes) {
        stepExec.status = "failed";
        await this.emitEvent(run.run_id, "task.failed", {
          step: step.step_number,
          elapsed_minutes: Math.round(elapsedMinutes),
          timeout_minutes: taskTimeoutMinutes,
          reason: "task_timeout_minutes exceeded",
        });
        return "failed";
      }
    }

    try {
      // Resolve plugin paths for this agent
      const agentDef = this.platformConfig.agent_definitions.find(
        (d) => d.type === step.agent
      );

      console.log(`[step ${step.step_number}] Spawning agent ${step.agent} (runtime: ${runtime.provider}/${runtime.mode})...`);

      // Spawn the agent container and run
      const result = await this.agentRunner.run({
        stepNumber: step.step_number,
        stepAttempt: currentRework + 1,
        agent: step.agent,
        task: step.task,
        context_inputs: step.context_inputs,
        workspacePath,
        modelConfig,
        apiKey,
        tokenBudget: budget.per_agent_tokens,
        timeoutMinutes: this.platformConfig.defaults.timeouts.agent_timeout_minutes,
        previousStepResults: this.gatherPreviousResults(run, step),
        plugins: agentDef?.plugins,
        cliFlags,
        containerResources,
        resumeSessionId,
        resumeReason,
      });

      console.log(`[step ${step.step_number}] Agent ${step.agent} finished: status=${result.agentResult.status}, tokens=${result.tokens_used}, cost=$${result.cost_usd.toFixed(2)}, duration=${result.duration_seconds.toFixed(1)}s`);
      if (result.agentResult.summary) {
        console.log(`[step ${step.step_number}] Summary: ${result.agentResult.summary.slice(0, 120)}`);
      }

      stepExec.tokens_used = result.tokens_used;
      stepExec.cost_usd = result.cost_usd;
      stepExec.container_id = result.container_id;
      stepExec.result = result.agentResult;
      stepExec.completed_at = new Date();
      finalResumeTelemetry = {
        resume_used: result.resume_used ?? initialResumeTelemetry.resume_used,
        resume_failed: result.resume_failed ?? initialResumeTelemetry.resume_failed,
        resume_fallback: result.resume_fallback ?? initialResumeTelemetry.resume_fallback,
      };
      tokenSavings = result.token_savings;

      await this.recordRuntimeSession(
        workspacePath,
        run.run_id,
        step,
        currentRework + 1,
        runtime,
        result.container_id,
        resumeReason,
        finalResumeTelemetry,
        tokenSavings
      );

      // Update run totals
      run.total_tokens_used += result.tokens_used;
      run.total_cost_usd += result.cost_usd;

      // Handle result
      if (result.agentResult.status === "complete") {
        // Create a git checkpoint commit before emitting step.completed
        try {
          const committed = await this.git.commitStepCheckpoint(
            workspacePath,
            run.run_id,
            step.step_number,
            step.agent
          );
          if (committed) {
            await this.emitEvent(run.run_id, "step.committed", {
              step: step.step_number,
              agent: step.agent,
            });
          }
        } catch (commitError) {
          const message = commitError instanceof Error ? commitError.message : String(commitError);
          stepExec.status = "failed";
          stepExec.completed_at = new Date();
          await this.emitEvent(run.run_id, "step.failed", {
            step: step.step_number,
            error: `Git checkpoint commit failed: ${message}`,
            ...finalResumeTelemetry,
            ...(tokenSavings ? { token_savings: tokenSavings } : {}),
          });
          run.status = "failed";
          run.error = `Git checkpoint commit failed at step ${step.step_number}: ${message}`;
          return "failed";
        }

        stepExec.status = "completed";
        await this.emitEvent(run.run_id, "step.completed", {
          step: step.step_number,
          tokens: result.tokens_used,
          artifacts: result.agentResult.artifacts_created,
          ...finalResumeTelemetry,
          ...(tokenSavings ? { token_savings: tokenSavings } : {}),
        });

        // Run quality gate after developer-role steps
        const agentRole = this.platformConfig.agent_definitions.find(
          (d) => d.type === step.agent
        )?.role;
        if (agentRole === "developer") {
          const gateResult = await this.runQualityGate(workspacePath, step);
          if (!gateResult.passed) {
            stepExec.status = "needs_rework";
            stepExec.result = {
              ...result.agentResult,
              status: "needs_rework",
              rework_reason: `Quality gate failed: ${gateResult.failures.join("; ")}`,
              rework_target: step.agent,
            };
            await this.emitEvent(run.run_id, "step.rework_triggered", {
              step: step.step_number,
              reason: "quality_gate_failed",
              failures: gateResult.failures,
            });

            if (currentRework >= maxRework) {
              stepExec.status = "failed";
              return "failed";
            }

            reworkCounts.set(step.step_number, currentRework + 1);
            return this.executeStep(run, step, workspacePath, reworkCounts, undefined, "quality_gate_retry");
          }
        }

        return "completed";
      }

      if (result.agentResult.status === "needs_rework") {
        stepExec.status = "needs_rework";

        // Defer rework handling to parallel group coordinator
        if (parallelReworkSignals) {
          parallelReworkSignals.push({ step, agentResult: result.agentResult, currentRework });
          await this.emitEvent(run.run_id, "step.rework_triggered", {
            step: step.step_number,
            reason: result.agentResult.rework_reason,
            deferred_to_parallel_coordinator: true,
          });
          return "rework";
        }

        // Check rework budget
        if (currentRework >= maxRework) {
          stepExec.status = "failed";
          await this.notifications.send(
            `Step ${step.step_number} (${step.agent}) exceeded max rework cycles (${maxRework}). Escalating.`
          );
          await this.emitEvent(run.run_id, "step.failed", {
            step: step.step_number,
            reason: "max_rework_exceeded",
            ...finalResumeTelemetry,
            ...(tokenSavings ? { token_savings: tokenSavings } : {}),
          });
          return "failed";
        }

        reworkCounts.set(step.step_number, currentRework + 1);
        await this.emitEvent(run.run_id, "step.rework_triggered", {
          step: step.step_number,
          reason: result.agentResult.rework_reason,
          rework_count: currentRework + 1,
        });

        // Gather previous rework results for this step
        const previousReworkResults = run.steps
          .filter(
            (s) => s.step_number === step.step_number &&
            s.status === "needs_rework" &&
            s.result
          )
          .map((s) => s.result!);

        // Ask orchestrator agent how to handle the rework (with full context)
        const reworkPlan = await this.plannerRuntime.planRework(
          run.ticket,
          step,
          result.agentResult,
          workspacePath,
          run.steps,
          currentRework + 1,
          previousReworkResults
        );

        // Execute the rework step(s) then retry this step
        for (const reworkStep of reworkPlan.steps) {
          const reworkResult = await this.executeStep(
            run, reworkStep, workspacePath, reworkCounts, undefined, "rework_plan"
          );
          if (reworkResult === "failed") return "failed";
        }

        // Retry the original step
        return this.executeStep(run, step, workspacePath, reworkCounts, undefined, "rework_retry");
      }

      // Blocked or failed
      stepExec.status = "failed";
      await this.emitEvent(run.run_id, "step.failed", {
        step: step.step_number,
        reason: result.agentResult.status,
        issues: result.agentResult.issues,
        ...finalResumeTelemetry,
        ...(tokenSavings ? { token_savings: tokenSavings } : {}),
      });
      return "failed";
    } catch (error) {
      stepExec.status = "failed";
      stepExec.completed_at = new Date();
      const errorResumeTelemetry = this.extractResumeTelemetry(error);
      const terminalResumeTelemetry = {
        resume_used: errorResumeTelemetry.resume_used ?? finalResumeTelemetry.resume_used,
        resume_failed: errorResumeTelemetry.resume_failed ?? finalResumeTelemetry.resume_failed,
        resume_fallback: errorResumeTelemetry.resume_fallback ?? finalResumeTelemetry.resume_fallback,
      };
      await this.emitEvent(run.run_id, "step.failed", {
        step: step.step_number,
        error: error instanceof Error ? error.message : String(error),
        ...terminalResumeTelemetry,
        ...(tokenSavings ? { token_savings: tokenSavings } : {}),
      });
      return "failed";
    }
  }

  private async recordRuntimeSession(
    workspacePath: string,
    runId: string,
    step: PlanStep,
    stepAttempt: number,
    runtime: RuntimeConfig,
    runtimeId: string,
    resumeReason?: string,
    resumeTelemetry?: {
      resume_used: boolean;
      resume_failed: boolean;
      resume_fallback: boolean;
    },
    tokenSavings?: Record<string, number>
  ): Promise<void> {
    if (!this.isResumableRuntime(runtime)) return;
    const sessionId = runtimeId.trim();
    if (!this.isLikelySessionId(sessionId)) return;
    await this.sessions.record(workspacePath, {
      run_id: runId,
      agent: step.agent,
      step_number: step.step_number,
      step_attempt: stepAttempt,
      runtime_provider: runtime.provider,
      runtime_mode: runtime.mode,
      session_id: sessionId,
      resume_reason: resumeReason,
      resume_used: resumeTelemetry?.resume_used,
      resume_failed: resumeTelemetry?.resume_failed,
      resume_fallback: resumeTelemetry?.resume_fallback,
      token_savings_cached_input_tokens:
        typeof tokenSavings?.cached_input_tokens === "number"
          ? tokenSavings.cached_input_tokens
          : undefined,
      updated_at: new Date().toISOString(),
    });
  }

  private isResumableRuntime(runtime: RuntimeConfig): boolean {
    if (runtime.mode === "container" || runtime.mode === "remote") return false;
    return runtime.provider === "codex" || runtime.provider === "claude-code";
  }

  private isLikelySessionId(runtimeId: string): boolean {
    if (!runtimeId) return false;
    if (runtimeId.startsWith("local-")) return false;
    if (runtimeId.startsWith("sprintfoundry-")) return false;
    return true;
  }

  private extractResumeTelemetry(
    error: unknown
  ): Partial<{
    resume_used: boolean;
    resume_failed: boolean;
    resume_fallback: boolean;
  }> {
    if (!error || typeof error !== "object") return {};
    const withTelemetry = error as Partial<{
      resume_used: unknown;
      resume_failed: unknown;
      resume_fallback: unknown;
    }>;
    return {
      resume_used:
        typeof withTelemetry.resume_used === "boolean" ? withTelemetry.resume_used : undefined,
      resume_failed:
        typeof withTelemetry.resume_failed === "boolean" ? withTelemetry.resume_failed : undefined,
      resume_fallback:
        typeof withTelemetry.resume_fallback === "boolean"
          ? withTelemetry.resume_fallback
          : undefined,
    };
  }

  // ---- Human Review ----

  private async requestHumanReview(
    run: TaskRun,
    afterStep: number,
    reason: string,
    workspacePath: string
  ): Promise<boolean> {
    const review: HumanReview = {
      review_id: `review-${Date.now()}`,
      run_id: run.run_id,
      after_step: afterStep,
      status: "pending",
      summary: this.buildReviewSummary(run, afterStep),
      artifacts_to_review: this.getReviewArtifacts(run, afterStep),
    };

    await this.emitEvent(run.run_id, "human_gate.requested", { review });
    await this.notifications.send(
      `Human review requested for task ${run.ticket.id} after step ${afterStep}: ${reason}`
    );

    const decision = await this.waitForReviewDecision(review, workspacePath);

    if (decision.status === "approved") {
      await this.emitEvent(run.run_id, "human_gate.approved", { review: decision });
      return true;
    } else {
      await this.emitEvent(run.run_id, "human_gate.rejected", {
        review: decision,
        feedback: decision.reviewer_feedback,
      });
      return false;
    }
  }

  // ---- Quality Gate ----

  private async runRegistryPreflight(workspacePath: string): Promise<void> {
    if (process.env.SPRINTFOUNDRY_SKIP_REGISTRY_PREFLIGHT === "true") {
      return;
    }

    const hasPackageJson = await fs
      .access(path.join(workspacePath, "package.json"))
      .then(() => true, () => false);
    if (!hasPackageJson) return;

    const registry = this.resolveNpmRegistry(workspacePath);
    const endpoint = this.buildRegistryPingUrl(registry);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(endpoint, {
        method: "GET",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      console.log(`[orchestrator] Registry preflight OK: ${endpoint}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        [
          `Registry preflight failed for JavaScript workspace.`,
          `Checked endpoint: ${endpoint}`,
          `Failure: ${message}`,
          `How to fix: allow outbound DNS/HTTPS to your npm registry (default: registry.npmjs.org), or set NPM_CONFIG_REGISTRY to a reachable mirror/proxy.`,
          `To bypass this check (not recommended): set SPRINTFOUNDRY_SKIP_REGISTRY_PREFLIGHT=true.`,
        ].join(" ")
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private resolveNpmRegistry(workspacePath: string): string {
    const envRegistry = process.env.NPM_CONFIG_REGISTRY ?? process.env.npm_config_registry;
    if (envRegistry && envRegistry.trim().length > 0) {
      return envRegistry.trim();
    }

    try {
      const raw = execSync("npm config get registry", {
        cwd: workspacePath,
        encoding: "utf-8",
        stdio: "pipe",
      }).trim();
      if (raw) return raw;
    } catch {
      // fall through to default
    }

    return "https://registry.npmjs.org/";
  }

  private buildRegistryPingUrl(registry: string): string {
    const normalized = registry.endsWith("/") ? registry : `${registry}/`;
    return new URL("-/ping", normalized).toString();
  }

  async runQualityGate(
    workspacePath: string,
    step: PlanStep
  ): Promise<{ passed: boolean; failures: string[] }> {
    const failures: string[] = [];

    // Detect stack from workspace
    const hasPackageJson = await fs.access(path.join(workspacePath, "package.json")).then(() => true, () => false);
    const hasGoMod = await fs.access(path.join(workspacePath, "go.mod")).then(() => true, () => false);

    const run = (cmd: string): boolean => {
      try {
        execSync(cmd, {
          cwd: workspacePath,
          encoding: "utf-8",
          timeout: 120_000,
          stdio: "pipe",
        });
        return true;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failures.push(`${cmd}: ${msg.slice(0, 200)}`);
        return false;
      }
    };

    if (hasPackageJson) {
      run("npm run lint --if-present");
      run("npx tsc --noEmit");
      run("npm run build --if-present");
    }

    if (hasGoMod) {
      run("go build ./...");
      run("go vet ./...");
      run("go test ./...");
    }

    return { passed: failures.length === 0, failures };
  }

  // ---- Helper Methods ----

  private createRun(ticketId: string): TaskRun {
    return {
      run_id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      project_id: this.projectConfig.project_id,
      ticket: null as any, // will be set immediately after
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
  }

  private createTicketFromPrompt(id: string, prompt: string): TicketDetails {
    return {
      id,
      source: "prompt",
      title: prompt.slice(0, 100),
      description: prompt,
      labels: [],
      priority: "p1",
      acceptance_criteria: [],
      linked_tickets: [],
      comments: [],
      author: "user",
      raw: { prompt },
    };
  }

  private resolveModel(agent: AgentType) {
    // Fallback chain: exact agent ID → platform default for ID → role-based fallback
    if (this.projectConfig.model_overrides?.[agent]) {
      return this.projectConfig.model_overrides[agent]!;
    }
    if (this.platformConfig.defaults.model_per_agent[agent]) {
      return this.platformConfig.defaults.model_per_agent[agent];
    }
    // Role-based fallback: find the agent's role and look up by role name
    const agentDef = this.platformConfig.agent_definitions.find(
      (d) => d.type === agent
    );
    if (agentDef?.role && this.platformConfig.defaults.model_per_agent[agentDef.role]) {
      return this.platformConfig.defaults.model_per_agent[agentDef.role];
    }
    // Last resort: developer model
    return (
      this.platformConfig.defaults.model_per_agent.developer ?? {
        provider: "anthropic" as const,
        model: "claude-sonnet-4-5-20250929",
      }
    );
  }

  private resolveBudget(ticket?: TicketDetails) {
    const base: BudgetConfig = {
      ...this.platformConfig.defaults.budgets,
      ...this.projectConfig.budget_overrides,
    };
    if (!ticket) return base;
    for (const rule of this.getMergedRules()) {
      if (rule.action.type !== "set_budget") continue;
      if (!this.evaluateRuleConditionForTicket(rule.condition, ticket)) continue;
      Object.assign(base, rule.action.budget);
    }
    return base;
  }

  private evaluateRuleConditionForTicket(
    condition: PlatformRule["condition"],
    ticket: TicketDetails
  ): boolean {
    switch (condition.type) {
      case "always":
        return true;
      case "label_contains":
        return ticket.labels.some((l) =>
          l.toLowerCase().includes(condition.value.toLowerCase())
        );
      case "priority_is":
        return condition.values.includes(ticket.priority);
      default:
        return false;
    }
  }

  private resolveApiKey(provider: string, runtime?: RuntimeConfig): string {
    const keys = this.projectConfig.api_keys;
    const key = keys[provider as keyof typeof keys];
    const resolved = typeof key === "string" ? key : key?.[0]?.key ?? "";
    if (!resolved && runtime?.mode !== "local_process") {
      throw new Error(`No API key configured for provider: ${provider}`);
    }
    return resolved;
  }

  private resolveRuntimeForAgent(agent: AgentType): RuntimeConfig {
    const override = this.projectConfig.runtime_overrides?.[agent];
    if (override) return override;

    const fromDefaults = this.platformConfig.defaults.runtime_per_agent?.[agent];
    if (fromDefaults) return fromDefaults;

    const role = this.platformConfig.agent_definitions.find((d) => d.type === agent)?.role;
    if (role && this.platformConfig.defaults.runtime_per_agent?.[role]) {
      return this.platformConfig.defaults.runtime_per_agent[role];
    }

    const useContainer = process.env.SPRINTFOUNDRY_USE_CONTAINERS === "true";
    if (useContainer) {
      console.warn(
        "[sprintfoundry] Container mode is deprecated and will be removed in v0.3.0. " +
        "Use local_process instead."
      );
    }
    return {
      provider: "claude-code",
      mode: useContainer ? "container" : "local_process",
    };
  }

  private getMergedRules() {
    return [
      ...this.platformConfig.rules,
      ...this.projectConfig.rules,
    ];
  }

  private findParallelGroup(
    ready: PlanStep[],
    groups: Array<number[] | { step_numbers?: number[] }>
  ): PlanStep[] {
    for (const group of groups) {
      const stepNumbers = Array.isArray(group)
        ? group
        : (group?.step_numbers ?? []);
      const matching = ready.filter((s) => stepNumbers.includes(s.step_number));
      if (matching.length > 1) return matching;
    }
    return [ready[0]]; // no parallel group found, run first ready step
  }

  private gatherPreviousResults(run: TaskRun, step: PlanStep) {
    return run.steps
      .filter(
        (s) =>
          step.depends_on.includes(s.step_number) &&
          s.status === "completed" &&
          s.result
      )
      .map((s) => ({ step_number: s.step_number, agent: s.agent, result: s.result! }));
  }

  private buildReviewSummary(run: TaskRun, afterStep: number): string {
    const completedSteps = run.steps.filter(s => s.status === "completed");
    return completedSteps
      .map(s => `Step ${s.step_number} (${s.agent}): ${s.result?.summary ?? "completed"}`)
      .join("\n");
  }

  private getReviewArtifacts(run: TaskRun, afterStep: number): string[] {
    return run.steps
      .filter(s => s.step_number <= afterStep && s.result)
      .flatMap(s => [
        ...(s.result?.artifacts_created ?? []),
        ...(s.result?.artifacts_modified ?? []),
      ]);
  }

  private getReviewDir(workspacePath: string): string {
    return path.join(workspacePath, ".sprintfoundry", "reviews");
  }

  private getPendingReviewPath(workspacePath: string, reviewId: string): string {
    return path.join(this.getReviewDir(workspacePath), `${reviewId}.pending.json`);
  }

  private getDecisionPath(workspacePath: string, reviewId: string): string {
    return path.join(this.getReviewDir(workspacePath), `${reviewId}.decision.json`);
  }

  private async waitForReviewDecision(
    review: HumanReview,
    workspacePath: string
  ): Promise<HumanReview> {
    const reviewDir = this.getReviewDir(workspacePath);
    const pendingPath = this.getPendingReviewPath(workspacePath, review.review_id);
    const decisionPath = this.getDecisionPath(workspacePath, review.review_id);

    await fs.mkdir(reviewDir, { recursive: true });
    await fs.writeFile(pendingPath, JSON.stringify(review, null, 2), "utf-8");

    const timeoutMs =
      this.platformConfig.defaults.timeouts.human_gate_timeout_hours * 60 * 60 * 1000;
    const pollIntervalMs = 1_000;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      try {
        const decisionRaw = await fs.readFile(decisionPath, "utf-8");
        const parsed = JSON.parse(decisionRaw) as {
          status?: "approved" | "rejected";
          reviewer_feedback?: string;
        };
        if (parsed.status === "approved" || parsed.status === "rejected") {
          const decided: HumanReview = {
            ...review,
            status: parsed.status,
            reviewer_feedback: parsed.reviewer_feedback,
            decided_at: new Date(),
          };
          await fs.rm(pendingPath, { force: true });
          return decided;
        }
      } catch {
        // Keep polling until timeout or decision appears.
      }

      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }

    const timedOut: HumanReview = {
      ...review,
      status: "rejected",
      reviewer_feedback: "Human review timed out",
      decided_at: new Date(),
    };
    await fs.rm(pendingPath, { force: true });
    return timedOut;
  }

  private async emitEvent(runId: string, type: EventType, data: Record<string, unknown>) {
    const event: TaskEvent = {
      event_id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      run_id: runId,
      event_type: type,
      timestamp: new Date(),
      data,
    };
    await this.events.store(event);
  }
}

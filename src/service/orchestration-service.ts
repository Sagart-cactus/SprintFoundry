// ============================================================
// AgentSDLC — Orchestration Service
// The "hard shell" — enforces guardrails, manages execution
// ============================================================

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

      // Initialize event store with workspace path for per-run logs
      await this.events.initialize(workspacePath);

      console.log(`[orchestrator] Cloning repo and creating branch...`);
      await this.git.cloneAndBranch(workspacePath, ticket);
      console.log(`[orchestrator] Repo cloned successfully.`);

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
        // Execute in parallel
        const results = await Promise.all(
          parallelGroup.map((step) =>
            this.executeStep(run, step, workspacePath, reworkCounts)
          )
        );

        for (let i = 0; i < parallelGroup.length; i++) {
          if (results[i] === "completed") {
            completed.add(parallelGroup[i].step_number);
          } else if (results[i] === "failed") {
            run.status = "failed";
            return;
          }
          // "rework" is handled inside executeStep via recursion
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
    reworkCounts: Map<number, number>
  ): Promise<"completed" | "failed" | "rework"> {
    const maxRework = this.platformConfig.defaults.max_rework_cycles;
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

    await this.emitEvent(run.run_id, "step.started", {
      step: step.step_number,
      agent: step.agent,
      task: step.task,
    });

    // Resolve model + budget for this agent (project overrides > platform defaults)
    const modelConfig = this.resolveModel(step.agent);
    const runtime = this.resolveRuntimeForAgent(step.agent);
    const budget = this.resolveBudget();
    const cliFlags = this.platformConfig.defaults.agent_cli_flags;
    const containerResources = this.platformConfig.defaults.container_resources;
    const apiKey = this.resolveApiKey(modelConfig.provider, runtime);

    console.log(
      `[step ${step.step_number}] Debug auth: provider=${modelConfig.provider}, model=${modelConfig.model}, runtime=${runtime.provider}/${runtime.mode}, api_key_present=${apiKey.length > 0}`
    );

    // Check total task budget
    if (run.total_tokens_used >= budget.per_task_total_tokens) {
      stepExec.status = "failed";
      await this.emitEvent(run.run_id, "agent.token_limit_exceeded", {
        step: step.step_number,
        total_used: run.total_tokens_used,
        limit: budget.per_task_total_tokens,
      });
      return "failed";
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
      });

      console.log(`[step ${step.step_number}] Agent ${step.agent} finished: status=${result.agentResult.status}, tokens=${result.tokens_used}, cost=$${result.cost_usd.toFixed(2)}, duration=${result.duration_seconds.toFixed(1)}s`);
      if (result.agentResult.summary) {
        console.log(`[step ${step.step_number}] Summary: ${result.agentResult.summary.slice(0, 120)}`);
      }

      stepExec.tokens_used = result.tokens_used;
      stepExec.cost_usd = result.cost_usd;
      stepExec.result = result.agentResult;
      stepExec.completed_at = new Date();

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
        });

        return "completed";
      }

      if (result.agentResult.status === "needs_rework") {
        // Check rework budget
        if (currentRework >= maxRework) {
          stepExec.status = "failed";
          await this.notifications.send(
            `Step ${step.step_number} (${step.agent}) exceeded max rework cycles (${maxRework}). Escalating.`
          );
          await this.emitEvent(run.run_id, "step.failed", {
            step: step.step_number,
            reason: "max_rework_exceeded",
          });
          return "failed";
        }

        reworkCounts.set(step.step_number, currentRework + 1);
        stepExec.status = "needs_rework";
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
            run, reworkStep, workspacePath, reworkCounts
          );
          if (reworkResult === "failed") return "failed";
        }

        // Retry the original step
        return this.executeStep(run, step, workspacePath, reworkCounts);
      }

      // Blocked or failed
      stepExec.status = "failed";
      await this.emitEvent(run.run_id, "step.failed", {
        step: step.step_number,
        reason: result.agentResult.status,
        issues: result.agentResult.issues,
      });
      return "failed";
    } catch (error) {
      stepExec.status = "failed";
      stepExec.completed_at = new Date();
      await this.emitEvent(run.run_id, "step.failed", {
        step: step.step_number,
        error: error instanceof Error ? error.message : String(error),
      });
      return "failed";
    }
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

  private resolveBudget() {
    return {
      ...this.platformConfig.defaults.budgets,
      ...this.projectConfig.budget_overrides,
    };
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

    const useContainer = process.env.AGENTSDLC_USE_CONTAINERS === "true";
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
    return path.join(workspacePath, ".agentsdlc", "reviews");
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

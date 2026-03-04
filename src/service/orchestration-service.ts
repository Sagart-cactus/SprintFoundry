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
  AgentDefinition,
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
  RuntimeMetadataEnvelope,
  ProjectStack,
  TaskSource,
} from "../shared/types.js";
import { parse as parseYaml } from "yaml";
import { PlanValidator } from "./plan-validator.js";
import { AgentRunner } from "./agent-runner.js";
import { EventStore } from "./event-store.js";
import { EventSinkClient } from "./event-sink-client.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { TicketFetcher } from "./ticket-fetcher.js";
import { GitManager } from "./git-manager.js";
import { NotificationService } from "./notification-service.js";
import { RuntimeSessionStore } from "./runtime-session-store.js";
import { ArtifactUploader } from "./artifact-uploader.js";
import type { PlannerRuntime } from "./runtime/types.js";
import { PlannerFactory } from "./runtime/planner-factory.js";
import type { RuntimeActivityEvent } from "./runtime/types.js";
import type { PluginRegistry } from "./plugin-registry.js";
import type {
  WorkspacePlugin,
  TrackerPlugin,
  NotifierPlugin,
  SCMPlugin,
} from "../shared/plugin-types.js";
import { SessionManager } from "./session-manager.js";
import { LifecycleManager, defaultLifecycleConfig } from "./lifecycle-manager.js";
import { NotificationRouter, defaultRoutingConfig } from "./notification-router.js";
import { MetricsService } from "./metrics-service.js";
import { trace, type Span } from "@opentelemetry/api";

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
  private sessionManager: SessionManager;
  private lifecycleManager: LifecycleManager | null = null;
  private notificationRouter: NotificationRouter | null = null;
  private registry: PluginRegistry | null;
  private metricsService: MetricsService;
  private artifactUploader: ArtifactUploader;
  private tracer = trace.getTracer("sprintfoundry", "1.0.0");

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig,
    registry?: PluginRegistry
  ) {
    this.registry = registry ?? null;
    this.metricsService = new MetricsService(process.env.SPRINTFOUNDRY_OTEL_ENABLED === "1");
    this.artifactUploader = new ArtifactUploader();
    this.validator = new PlanValidator(platformConfig, projectConfig);
    this.agentRunner = new AgentRunner(platformConfig, projectConfig);
    this.plannerRuntime = new PlannerFactory().create(platformConfig, projectConfig);
    const eventSinkUrl = process.env.SPRINTFOUNDRY_EVENT_SINK_URL?.trim();
    const internalApiToken = process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN?.trim();
    const eventSinkClient = eventSinkUrl ? new EventSinkClient(eventSinkUrl, globalThis.fetch, internalApiToken) : undefined;
    this.events = new EventStore(platformConfig.events_dir, eventSinkClient);
    this.workspace = new WorkspaceManager(projectConfig);
    this.tickets = new TicketFetcher(projectConfig.integrations);
    this.git = new GitManager(projectConfig.repo, projectConfig.branch_strategy);
    this.notifications = new NotificationService(projectConfig.integrations);
    this.sessions = new RuntimeSessionStore();
    this.sessionManager = new SessionManager(undefined, eventSinkClient);

    // Initialize lifecycle manager if an SCM plugin is available
    const scmPlugin = this.registry?.getFirst<SCMPlugin>("scm") ?? null;
    if (scmPlugin) {
      const lifecycleConfig = this.platformConfig.lifecycle ?? defaultLifecycleConfig();
      const notifierPlugins = new Map<string, NotifierPlugin>();
      const notifierPlugin = this.registry?.getFirst<NotifierPlugin>("notifier");
      if (notifierPlugin) {
        notifierPlugins.set(notifierPlugin.name, notifierPlugin);
      }
      this.notificationRouter = new NotificationRouter(
        notifierPlugins,
        lifecycleConfig.notification_routing ?? defaultRoutingConfig()
      );
      this.lifecycleManager = new LifecycleManager(
        lifecycleConfig,
        scmPlugin,
        this.sessionManager,
        this.notificationRouter
      );
    }
  }

  // ---- Session persistence (fire-and-forget, never fails the run) ----

  private persistSession(run: TaskRun, extra?: { workspace_path?: string; branch?: string }): void {
    this.sessionManager.persist(run, extra).catch((err) => {
      console.warn(`[session] Failed to persist session ${run.run_id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async uploadArtifactsIfConfigured(runId: string, workspacePath: string): Promise<void> {
    try {
      const summary = await this.artifactUploader.uploadRunArtifacts(runId, workspacePath);
      if (!summary.skipped && summary.attempted > summary.uploaded) {
        console.warn(
          `[artifacts] Partial upload for run ${runId}: uploaded ${summary.uploaded}/${summary.attempted} to s3://${summary.bucket}/${summary.prefix}`
        );
      }
    } catch (err) {
      console.warn(`[artifacts] Upload skipped for run ${runId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ---- Lifecycle watch (non-blocking, only when SCM plugin is available) ----

  private startLifecycleWatch(run: TaskRun, _workspacePath: string): void {
    if (!this.lifecycleManager || !run.pr_url) return;

    // Use the ticket ID as a fallback branch identifier
    const branch = run.ticket?.id ?? run.run_id;

    this.lifecycleManager.watch(
      run.run_id,
      branch,
      run.pr_url,
      this.projectConfig.repo.url
    );
    this.lifecycleManager.start();
  }

  // ---- Plugin accessors (prefer plugin if registered, else legacy) ----

  private getWorkspacePlugin(): WorkspacePlugin | null {
    return this.registry?.getFirst<WorkspacePlugin>("workspace") ?? null;
  }

  private getTrackerPlugin(): TrackerPlugin | null {
    return this.registry?.getFirst<TrackerPlugin>("tracker") ?? null;
  }

  private getNotifierPlugin(): NotifierPlugin | null {
    return this.registry?.getFirst<NotifierPlugin>("notifier") ?? null;
  }

  private async fetchTicket(ticketId: string, source: TaskSource): Promise<TicketDetails> {
    const tracker = this.getTrackerPlugin();
    if (tracker) return tracker.fetch(ticketId, source);
    return this.tickets.fetch(ticketId, source);
  }

  private resolveTicketUrl(ticket: TicketDetails): string | null {
    const raw = ticket?.raw;
    if (!raw || typeof raw !== "object") return null;
    const obj = raw as Record<string, unknown>;
    const candidate = obj.html_url ?? obj.url ?? obj.webUrl ?? obj.permalink;
    return typeof candidate === "string" && candidate.trim() ? candidate : null;
  }

  private resolveProjectRepoUrl(): string | null {
    const input = String(this.projectConfig?.repo?.url ?? "").trim();
    if (!input) return null;

    const sshMatch = input.match(/^git@([^:]+):(.+?)(?:\.git)?$/i);
    if (sshMatch) {
      return `https://${sshMatch[1]}/${sshMatch[2]}`.replace(/\/+$/, "");
    }

    const sshUrlMatch = input.match(/^ssh:\/\/git@([^/]+)\/(.+?)(?:\.git)?$/i);
    if (sshUrlMatch) {
      return `https://${sshUrlMatch[1]}/${sshUrlMatch[2]}`.replace(/\/+$/, "");
    }

    try {
      const parsed = new URL(input);
      parsed.username = "";
      parsed.password = "";
      parsed.pathname = parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "");
      return parsed.toString().replace(/\/$/, "");
    } catch {
      return input;
    }
  }

  private async updateTicketStatus(
    ticket: TicketDetails,
    status: string,
    prUrl?: string
  ): Promise<void> {
    const tracker = this.getTrackerPlugin();
    if (tracker) {
      await tracker.updateStatus(ticket, status, prUrl);
      return;
    }
    await this.tickets.updateStatus(ticket, status, prUrl);
  }

  private async sendNotification(message: string): Promise<void> {
    const notifier = this.getNotifierPlugin();
    if (notifier) {
      await notifier.notify(message);
      return;
    }
    await this.notifications.send(message);
  }

  private async commitStepChanges(
    workspacePath: string,
    runId: string,
    stepNumber: number,
    agent: AgentType
  ): Promise<boolean> {
    const wsPlugin = this.getWorkspacePlugin();
    if (wsPlugin) {
      return wsPlugin.commitStepChanges(workspacePath, runId, stepNumber, agent);
    }
    return this.git.commitStepCheckpoint(workspacePath, runId, stepNumber, agent);
  }

  private async createPullRequest(workspacePath: string, run: TaskRun): Promise<string> {
    const wsPlugin = this.getWorkspacePlugin();
    if (wsPlugin) return wsPlugin.createPullRequest(workspacePath, run);
    return this.git.createPullRequest(workspacePath, run);
  }

  // ---- Main entry point ----

  async handleTask(
    ticketId: string,
    source: "linear" | "github" | "jira" | "prompt",
    promptText?: string,
    opts?: { dryRun?: boolean; agent?: string; agentFile?: string }
  ): Promise<TaskRun> {
    return this.tracer.startActiveSpan(
      "task.run",
      { attributes: { project_id: this.projectConfig.project_id, source } },
      async (span) => {
        try {
          return await this.handleTaskBody(ticketId, source, promptText, opts, span);
        } finally {
          span.end();
        }
      }
    );
  }

  private async handleTaskBody(
    ticketId: string,
    source: "linear" | "github" | "jira" | "prompt",
    promptText: string | undefined,
    opts: { dryRun?: boolean; agent?: string; agentFile?: string } | undefined,
    span: Span
  ): Promise<TaskRun> {
    // 1. Create the run
    const run = this.createRun(ticketId);
    let workspacePath: string | null = null;
    const triggerSource = process.env.SPRINTFOUNDRY_TRIGGER_SOURCE ?? null;
    span.setAttribute("run_id", run.run_id);
    const runStartMs = Date.now();
    await this.emitEvent(run.run_id, "task.created", { ticketId, source, trigger_source: triggerSource });
    this.metricsService.recordRunStarted({ project_id: this.projectConfig.project_id, source, run_id: run.run_id });

    try {
      // 2. Fetch ticket details (or create from prompt)
      const ticket = source === "prompt"
        ? this.createTicketFromPrompt(ticketId, promptText!)
        : await this.fetchTicket(ticketId, source);

      run.ticket = ticket;
      await this.emitEvent(run.run_id, "task.created", {
        ticket,
        source,
        trigger_source: triggerSource,
        ticket_url: this.resolveTicketUrl(ticket),
        ticket_repo_url: this.resolveProjectRepoUrl(),
      });
      this.persistSession(run);

      // 3. Prepare workspace (clone repo, create branch)
      const wsPlugin = this.getWorkspacePlugin();

      if (!opts?.dryRun && wsPlugin) {
        console.log(`[orchestrator] Creating workspace for run ${run.run_id} via plugin ${wsPlugin.name}...`);
        const workspace = await wsPlugin.create(
          run.run_id,
          this.projectConfig.repo,
          this.projectConfig.branch_strategy,
          ticket
        );
        workspacePath = workspace.path;
        console.log(`[orchestrator] Workspace created: ${workspacePath} (branch: ${workspace.branch})`);
      } else {
        console.log(`[orchestrator] Creating workspace for run ${run.run_id}...`);
        workspacePath = await this.workspace.create(run.run_id);
        console.log(`[orchestrator] Workspace created: ${workspacePath}`);

        if (opts?.dryRun) {
          // Skip git clone in dry-run — plan is generated from ticket context only
          console.log(`[orchestrator] Dry-run mode — skipping git clone.`);
        } else {
          console.log(`[orchestrator] Cloning repo and creating branch...`);
          await this.git.cloneAndBranch(workspacePath, ticket);
          console.log(`[orchestrator] Repo cloned successfully.`);
        }
      }

      if (!opts?.dryRun) {
        // Detect project stack once — write .agent-context/stack.json for planner + all agents
        const stack = await this.detectProjectStack(workspacePath);
        console.log(
          `[orchestrator] Stack detected: ${stack.stack}${stack.package_manager ? `/${stack.package_manager}` : ""}` +
          (stack.pre_commit_hooks !== "none" ? ` (pre-commit: ${stack.pre_commit_hooks})` : "")
        );
        await this.emitEvent(run.run_id, "task.stack_detected", { stack });
      }

      // Initialize event store after clone. Initializing earlier can create
      // workspace files (e.g. .events.jsonl) that make `git clone ... .` fail.
      await this.events.initialize(workspacePath);

      if (!opts?.dryRun) {
        await this.runRegistryPreflight(workspacePath);
      }

      // 4a. Direct single-agent mode (bypasses orchestrator + plan validator)
      if (opts?.agent) {
        if (opts?.dryRun) {
          run.status = "completed";
          console.log(`[orchestrator] Dry-run mode — skipping direct agent execution.`);
          return run;
        }
        return await this.runDirectAgent(run, opts.agent, ticket, workspacePath, opts.agentFile);
      }

      // 4. Get plan from orchestrator agent
      run.status = "planning";
      this.persistSession(run, { workspace_path: workspacePath });
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

      // 6. Execute the plan (skip if dry-run)
      if (opts?.dryRun) {
        run.status = "completed";
        console.log(`[orchestrator] Dry-run mode — skipping execution.`);
        return run;
      }
      run.status = "executing";
      this.persistSession(run, { workspace_path: workspacePath });
      console.log(`[orchestrator] Starting plan execution...`);
      await this.executePlan(run, validatedPlan, workspacePath);

      // 7. If all passed, create PR and update ticket
      if ((run.status as string) === "completed") {
        const gitStart = Date.now();
        let prCreationStatus: "success" | "error" = "success";
        try {
          const prUrl = await this.createPullRequest(workspacePath, run);
          run.pr_url = prUrl;
          await this.emitEvent(run.run_id, "pr.created", { prUrl });
          this.metricsService.recordGitOperation({ operation: "pr_create", status: "success", durationMs: Date.now() - gitStart });
          this.metricsService.recordPrCreated({ project_id: this.projectConfig.project_id, status: "success" });
        } catch (prErr) {
          prCreationStatus = "error";
          this.metricsService.recordGitOperation({ operation: "pr_create", status: "error", durationMs: Date.now() - gitStart });
          this.metricsService.recordPrCreated({ project_id: this.projectConfig.project_id, status: "error" });
          throw prErr;
        }

        await this.updateTicketStatus(ticket, "in_review", run.pr_url!);
        await this.emitEvent(run.run_id, "ticket.updated", { status: "in_review" });

        await this.sendNotification(
          `Task ${ticket.id} completed. PR: ${run.pr_url}`
        );
        this.persistSession(run, { workspace_path: workspacePath });

        // Start lifecycle monitoring for this PR (non-blocking)
        this.startLifecycleWatch(run, workspacePath);
      }

      this.metricsService.recordRunCompleted({
        project_id: this.projectConfig.project_id,
        run_id: run.run_id,
        source,
        status: (run.status as string) === "completed" ? "completed" : "failed",
        durationMs: Date.now() - runStartMs,
        planSteps: run.validated_plan?.steps.length ?? run.plan?.steps.length,
      });

      return run;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await this.emitEvent(run.run_id, "task.failed", { error: run.error });
      this.metricsService.recordRunCompleted({
        project_id: this.projectConfig.project_id,
        run_id: run.run_id,
        source,
        status: "failed",
        durationMs: Date.now() - runStartMs,
        planSteps: run.validated_plan?.steps.length ?? run.plan?.steps.length,
      });
      await this.sendNotification(
        `Task ${run.ticket?.id ?? ticketId} failed: ${run.error}`
      );
      this.persistSession(run, workspacePath ? { workspace_path: workspacePath } : undefined);
      return run;
    } finally {
      if (workspacePath) {
        await this.uploadArtifactsIfConfigured(run.run_id, workspacePath);
      }
      await this.events.close();
    }
  }

  // ---- Direct Single-Agent Execution ----

  private async runDirectAgent(
    run: TaskRun,
    agentId: string,
    ticket: TicketDetails,
    workspacePath: string,
    agentFile?: string
  ): Promise<TaskRun> {
    // If an inline agent file was provided, load and register it temporarily
    if (agentFile) {
      try {
        const raw = await fs.readFile(agentFile, "utf-8");
        const def = parseYaml(raw) as AgentDefinition;
        if (!def?.type) throw new Error("Agent file must contain a 'type' field");
        if (!this.platformConfig.agent_definitions.find((a) => a.type === def.type)) {
          this.platformConfig.agent_definitions.push(def);
        }
      } catch (err) {
        throw new Error(`Failed to load agent file "${agentFile}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Validate agent ID exists in the catalog
    const agentDef = this.platformConfig.agent_definitions.find((a) => a.type === agentId);
    if (!agentDef) {
      const available = this.platformConfig.agent_definitions.map((a) => a.type).join(", ");
      throw new Error(`Agent '${agentId}' not found. Available agents: ${available}`);
    }

    console.log(`[orchestrator] Direct mode: running agent '${agentId}' (role: ${agentDef.role})`);

    // Build a synthetic single-step plan — no LLM, no validator
    const plan: ExecutionPlan = {
      plan_id: `direct-${Date.now()}`,
      ticket_id: ticket.id,
      classification: "direct",
      reasoning: `Direct single-agent run: ${agentId}`,
      steps: [
        {
          step_number: 1,
          agent: agentId,
          task: ticket.description || ticket.title,
          context_inputs: [{ type: "ticket" }],
          depends_on: [],
          estimated_complexity: "medium",
        },
      ],
      parallel_groups: [],
      human_gates: [],
    };

    run.plan = plan;
    run.validated_plan = plan;
    run.status = "executing";

    await this.emitEvent(run.run_id, "task.plan_generated", { plan });

    await this.executePlan(run, plan, workspacePath);

    if ((run.status as string) === "completed") {
      const prUrl = await this.createPullRequest(workspacePath, run);
      run.pr_url = prUrl;
      await this.emitEvent(run.run_id, "pr.created", { prUrl });
      await this.updateTicketStatus(ticket, "in_review", prUrl);
      await this.sendNotification(`Task ${ticket.id} completed. PR: ${prUrl}`);

      // Start lifecycle monitoring for this PR (non-blocking)
      this.startLifecycleWatch(run, workspacePath);
    }

    return run;
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

        // Use sub-worktree isolation when the workspace plugin supports it.
        // Each parallel step gets its own worktree so file changes can't conflict.
        const wsPlugin = this.getWorkspacePlugin();
        const useSubWorktrees = wsPlugin?.supportsSubWorktrees === true
          && typeof wsPlugin.createSubWorktree === "function"
          && typeof wsPlugin.mergeSubWorktree === "function";

        const results = await Promise.all(
          parallelGroup.map(async (step) => {
            let stepWorkspace = workspacePath;
            try {
              if (useSubWorktrees) {
                stepWorkspace = await wsPlugin!.createSubWorktree!(workspacePath, step.step_number);
                console.log(`[parallel] Step ${step.step_number} using sub-worktree: ${stepWorkspace}`);
              }
              const result = await this.executeStep(run, step, stepWorkspace, reworkCounts, reworkSignals);
              if (useSubWorktrees && result === "completed") {
                await wsPlugin!.mergeSubWorktree!(workspacePath, stepWorkspace, step.step_number);
                console.log(`[parallel] Step ${step.step_number} merged back to parent.`);
              } else if (useSubWorktrees) {
                // Clean up sub-worktree on failure/rework without merging
                await wsPlugin!.removeSubWorktree?.(stepWorkspace);
              }
              return result;
            } catch (err) {
              // Clean up sub-worktree on unexpected error
              if (useSubWorktrees && stepWorkspace !== workspacePath) {
                try { await wsPlugin!.removeSubWorktree?.(stepWorkspace); } catch { /* best effort */ }
              }
              throw err;
            }
          })
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
            await this.sendNotification(
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
              await this.emitEvent(run.run_id, "task.failed", {
                error: run.error,
                reason: "human_gate_rejected",
                step: stepNum,
              });
              this.persistSession(run, { workspace_path: workspacePath });
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
    this.persistSession(run, { workspace_path: workspacePath });
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
    return this.tracer.startActiveSpan(
      "agent.step",
      { attributes: { run_id: run.run_id, step_id: String(step.step_number), "step.agent": step.agent } },
      async (span) => {
        try {
          return await this.executeStepBody(run, step, workspacePath, reworkCounts, parallelReworkSignals, resumeReason);
        } finally {
          span.end();
        }
      }
    );
  }

  private async executeStepBody(
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
      runtime_metadata: null,
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
    let runtimeMetadata = this.buildRuntimeMetadataEnvelope({
      runtime,
      stepAttempt: currentRework + 1,
      runtimeId: "",
      resumeSessionId,
      resumeReason,
      resumeTelemetry: initialResumeTelemetry,
    });
    stepExec.runtime_metadata = runtimeMetadata;

    await this.emitEvent(run.run_id, "step.started", {
      step: step.step_number,
      agent: step.agent,
      task: step.task,
      ...initialResumeTelemetry,
      runtime_metadata: runtimeMetadata,
    });
    const stepStartMs = Date.now();
    this.metricsService.recordStepStarted({ run_id: run.run_id, step_id: String(step.step_number), agent: step.agent, provider: runtime.provider, mode: runtime.mode });

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
      this.metricsService.recordTokenLimitExceeded({ agent: step.agent, provider: runtime.provider, reason: "per_task_total_tokens" });
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
      this.metricsService.recordTokenLimitExceeded({ agent: step.agent, provider: runtime.provider, reason: "per_task_max_cost_usd" });
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
        onRuntimeActivity: async (activity: RuntimeActivityEvent) => {
          await this.emitEvent(run.run_id, activity.type, {
            step: step.step_number,
            agent: step.agent,
            ...activity.data,
          });
          // Mirror selected activity events as metrics
          switch (activity.type) {
            case "agent_tool_call": {
              const toolName = typeof activity.data.tool_name === "string" ? activity.data.tool_name : "unknown";
              this.metricsService.recordToolCall({ agent: step.agent, tool_name: toolName });
              break;
            }
            case "agent_file_edit": {
              const filePath = typeof activity.data.path === "string" ? activity.data.path : "";
              const ext = filePath.includes(".") ? filePath.split(".").pop() ?? "unknown" : "unknown";
              this.metricsService.recordFileEdit({ agent: step.agent, extension: ext });
              break;
            }
            case "agent_command_run":
              this.metricsService.recordCommandRun({ agent: step.agent });
              break;
            case "agent_guardrail_block":
              this.metricsService.recordGuardrailBlock({ agent: step.agent, provider: runtime.provider });
              break;
          }
        },
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
      runtimeMetadata = this.buildRuntimeMetadataEnvelope({
        runtime,
        stepAttempt: currentRework + 1,
        runtimeId: result.container_id,
        runtimeMetadata: result.runtime_metadata,
        resumeSessionId,
        resumeReason,
        resumeTelemetry: finalResumeTelemetry,
        tokenSavings,
      });
      stepExec.runtime_metadata = runtimeMetadata;

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
          const committed = await this.commitStepChanges(
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
            runtime_metadata: runtimeMetadata,
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
          runtime_metadata: runtimeMetadata,
        });
        this.metricsService.recordStepCompleted({
          run_id: run.run_id,
          step_id: String(step.step_number),
          agent: step.agent,
          provider: runtime.provider,
          mode: runtime.mode,
          status: "completed",
          durationMs: Date.now() - stepStartMs,
          tokensUsed: result.tokens_used,
          costUsd: result.cost_usd,
          tokenBudget: budget.per_agent_tokens,
          cacheTokensSaved: tokenSavings?.cache_read_tokens,
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
            this.metricsService.recordReworkTriggered({ project_id: this.projectConfig.project_id, agent: step.agent });

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
          await this.sendNotification(
            `Step ${step.step_number} (${step.agent}) exceeded max rework cycles (${maxRework}). Escalating.`
          );
          await this.emitEvent(run.run_id, "step.failed", {
            step: step.step_number,
            reason: "max_rework_exceeded",
            ...finalResumeTelemetry,
            ...(tokenSavings ? { token_savings: tokenSavings } : {}),
            runtime_metadata: runtimeMetadata,
          });
          return "failed";
        }

        reworkCounts.set(step.step_number, currentRework + 1);
        await this.emitEvent(run.run_id, "step.rework_triggered", {
          step: step.step_number,
          reason: result.agentResult.rework_reason,
          rework_count: currentRework + 1,
        });
        this.metricsService.recordReworkTriggered({ project_id: this.projectConfig.project_id, agent: step.agent });

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
        runtime_metadata: runtimeMetadata,
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
      runtimeMetadata = this.buildRuntimeMetadataEnvelope({
        runtime,
        stepAttempt: currentRework + 1,
        runtimeId: runtimeMetadata.runtime.runtime_id,
        runtimeMetadata,
        resumeSessionId,
        resumeReason,
        resumeTelemetry: terminalResumeTelemetry,
        tokenSavings,
      });
      stepExec.runtime_metadata = runtimeMetadata;
      await this.emitEvent(run.run_id, "step.failed", {
        step: step.step_number,
        error: error instanceof Error ? error.message : String(error),
        ...terminalResumeTelemetry,
        ...(tokenSavings ? { token_savings: tokenSavings } : {}),
        runtime_metadata: runtimeMetadata,
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

  private buildRuntimeMetadataEnvelope(params: {
    runtime: RuntimeConfig;
    stepAttempt: number;
    runtimeId: string;
    runtimeMetadata?: RuntimeMetadataEnvelope;
    resumeSessionId?: string;
    resumeReason?: string;
    resumeTelemetry?: {
      resume_used: boolean;
      resume_failed: boolean;
      resume_fallback: boolean;
    };
    tokenSavings?: Record<string, number>;
  }): RuntimeMetadataEnvelope {
    const merged: RuntimeMetadataEnvelope = {
      schema_version: 1,
      runtime: {
        provider: params.runtime.provider,
        mode: params.runtime.mode,
        runtime_id: params.runtimeId,
        step_attempt: params.stepAttempt,
      },
      ...(params.runtimeMetadata ?? {}),
    };
    merged.runtime = {
      provider: params.runtime.provider,
      mode: params.runtime.mode,
      runtime_id: params.runtimeId || params.runtimeMetadata?.runtime.runtime_id || "",
      step_attempt: params.stepAttempt,
    };
    if (params.resumeTelemetry) {
      merged.resume = {
        requested: Boolean(params.resumeSessionId),
        used: params.resumeTelemetry.resume_used,
        failed: params.resumeTelemetry.resume_failed,
        fallback_to_fresh: params.resumeTelemetry.resume_fallback,
        ...(params.resumeSessionId ? { source_session_id: params.resumeSessionId } : {}),
        ...(params.resumeReason ? { reason: params.resumeReason } : {}),
      };
    } else if (params.resumeSessionId || params.resumeReason) {
      merged.resume = {
        requested: Boolean(params.resumeSessionId),
        used: Boolean(params.resumeSessionId),
        failed: false,
        fallback_to_fresh: false,
        ...(params.resumeSessionId ? { source_session_id: params.resumeSessionId } : {}),
        ...(params.resumeReason ? { reason: params.resumeReason } : {}),
      };
    }
    if (params.tokenSavings) {
      merged.token_savings = {
        ...(merged.token_savings ?? {}),
        ...(typeof params.tokenSavings.cached_input_tokens === "number"
          ? { cached_input_tokens: params.tokenSavings.cached_input_tokens }
          : {}),
      };
    }
    return merged;
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
    await this.sendNotification(
      `Human review requested for task ${run.ticket.id} after step ${afterStep}: ${reason}`
    );

    const gateOpenMs = Date.now();
    const decision = await this.waitForReviewDecision(review, workspacePath);
    const gateWaitMs = Date.now() - gateOpenMs;

    if (decision.status === "approved") {
      await this.emitEvent(run.run_id, "human_gate.approved", { review: decision });
      this.metricsService.recordHumanGateDecision({ project_id: this.projectConfig.project_id, decision: "approved", waitMs: gateWaitMs });
      return true;
    } else {
      await this.emitEvent(run.run_id, "human_gate.rejected", {
        review: decision,
        feedback: decision.reviewer_feedback,
      });
      this.metricsService.recordHumanGateDecision({ project_id: this.projectConfig.project_id, decision: "rejected", waitMs: gateWaitMs });
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

  // ---- Project Stack Detection ----

  async detectProjectStack(workspacePath: string): Promise<ProjectStack> {
    const check = (f: string) =>
      fs.access(path.join(workspacePath, f)).then(() => true, () => false);

    let stack: ProjectStack["stack"] = "unknown";
    let package_manager: string | undefined;
    const detected_from: string[] = [];

    if (await check("go.mod")) {
      stack = "go"; detected_from.push("go.mod");
    } else if (await check("Cargo.toml")) {
      stack = "rust"; detected_from.push("Cargo.toml");
    } else if (
      await check("pyproject.toml") || await check("requirements.txt") || await check("setup.py")
    ) {
      stack = "python";
      detected_from.push("pyproject.toml/requirements.txt/setup.py");
      if (await check("poetry.lock")) package_manager = "poetry";
      else if (await check("uv.lock")) package_manager = "uv";
      else if (await check("Pipfile.lock")) package_manager = "pipenv";
      else package_manager = "pip";
    } else if (await check("Gemfile")) {
      stack = "ruby"; detected_from.push("Gemfile");
    } else if (await check("mix.exs")) {
      stack = "elixir"; detected_from.push("mix.exs");
    } else if (await check("pom.xml") || await check("build.gradle") || await check("build.gradle.kts")) {
      stack = "jvm"; detected_from.push("pom.xml/build.gradle");
    } else if (await check("package.json")) {
      stack = "node"; detected_from.push("package.json");
      if (await check("pnpm-lock.yaml")) package_manager = "pnpm";
      else if (await check("yarn.lock")) package_manager = "yarn";
      else if (await check("bun.lockb")) package_manager = "bun";
      else package_manager = "npm";
    }

    // Detect pre-commit hooks
    let pre_commit_hooks: ProjectStack["pre_commit_hooks"] = "none";
    if (await check(".husky/pre-commit")) pre_commit_hooks = "husky";
    else if (await check(".lefthook.yml") || await check("lefthook.yml")) pre_commit_hooks = "lefthook";
    else if (await check(".pre-commit-config.yaml")) pre_commit_hooks = "pre-commit";

    // Detect monorepo
    const monorepo =
      (await check("pnpm-workspace.yaml")) ||
      (await check("go.work")) ||
      (await check("nx.json")) ||
      (await check("turbo.json"));

    const commands = this.deriveStackCommands(stack, package_manager);
    const stackInfo: ProjectStack = {
      stack,
      ...(package_manager ? { package_manager } : {}),
      detected_from,
      pre_commit_hooks,
      monorepo,
      ...commands,
    };

    // Write to .agent-context/stack.json — available to planner + all agents
    const contextDir = path.join(workspacePath, ".agent-context");
    await fs.mkdir(contextDir, { recursive: true });
    await fs.writeFile(
      path.join(contextDir, "stack.json"),
      JSON.stringify(stackInfo, null, 2),
      "utf-8"
    );

    return stackInfo;
  }

  private deriveStackCommands(
    stack: string,
    pm?: string
  ): Partial<Pick<ProjectStack, "install_cmd" | "build_cmd" | "test_cmd" | "lint_cmd" | "typecheck_cmd">> {
    switch (stack) {
      case "node": {
        const c = pm ?? "npm";
        return {
          install_cmd: `${c} install --frozen-lockfile`,
          build_cmd: `${c} run build`,
          test_cmd: `${c} test`,
          lint_cmd: `${c} run lint`,
          typecheck_cmd: `${c} run typecheck`,
        };
      }
      case "go":
        return {
          install_cmd: "go mod download",
          build_cmd: "go build ./...",
          test_cmd: "go test -race ./...",
          lint_cmd: "go vet ./...",
          typecheck_cmd: "",
        };
      case "python": {
        const run = pm === "poetry" ? "poetry run" : pm === "uv" ? "uv run" : "";
        return {
          install_cmd: pm === "poetry" ? "poetry install" : pm === "uv" ? "uv sync" : "pip install -e .",
          build_cmd: "",
          test_cmd: run ? `${run} pytest` : "pytest",
          lint_cmd: run ? `${run} ruff check .` : "ruff check . || flake8 .",
          typecheck_cmd: run ? `${run} mypy .` : "mypy .",
        };
      }
      case "rust":
        return {
          install_cmd: "cargo fetch",
          build_cmd: "cargo build",
          test_cmd: "cargo test",
          lint_cmd: "cargo clippy",
          typecheck_cmd: "",
        };
      case "ruby":
        return {
          install_cmd: "bundle install",
          build_cmd: "",
          test_cmd: "bundle exec rspec",
          lint_cmd: "bundle exec rubocop",
          typecheck_cmd: "",
        };
      default:
        return {};
    }
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
    groups: Array<number[] | { step_numbers?: number[]; steps?: number[] }>
  ): PlanStep[] {
    for (const group of groups) {
      const stepNumbers = Array.isArray(group)
        ? group
        : (group?.step_numbers ?? group?.steps ?? []);
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

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
  RunSessionMetadata,
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
import type {
  ExecutionBackend,
  RunEnvironmentHandle,
  SandboxTeardownReason,
} from "./execution/index.js";

const RUN_STATE_DIR = ".sprintfoundry";
const RUN_STATE_FILE = "run-state.json";

interface ExecutePlanOptions {
  initialCompletedSteps?: Set<number>;
  resumeFromStep?: number;
  operatorPrompt?: string;
}

interface ResumeTaskOptions {
  step?: number;
  prompt?: string;
  allowInProgressRecovery?: boolean;
}

type TaskRunWithEnvironment = TaskRun & {
  run_environment?: RunEnvironmentHandle | null;
};

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
  private eventSinkClient?: EventSinkClient;
  private lifecycleManager: LifecycleManager | null = null;
  private notificationRouter: NotificationRouter | null = null;
  private registry: PluginRegistry | null;
  private metricsService: MetricsService;
  private artifactUploader: ArtifactUploader;
  private tracer = trace.getTracer("sprintfoundry", "1.0.0");

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig,
    registry?: PluginRegistry,
    private executionBackend?: ExecutionBackend
  ) {
    this.registry = registry ?? null;
    this.metricsService = new MetricsService(process.env.SPRINTFOUNDRY_OTEL_ENABLED === "1");
    this.artifactUploader = new ArtifactUploader();
    this.validator = new PlanValidator(platformConfig, projectConfig);
    this.agentRunner = new AgentRunner(platformConfig, projectConfig, executionBackend);
    this.plannerRuntime = new PlannerFactory().create(platformConfig, projectConfig);
    const eventSinkUrl = process.env.SPRINTFOUNDRY_EVENT_SINK_URL?.trim();
    const internalApiToken = process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN?.trim();
    const eventSinkClient = eventSinkUrl ? new EventSinkClient(eventSinkUrl, globalThis.fetch, internalApiToken) : undefined;
    this.eventSinkClient = eventSinkClient;
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
    if (extra?.workspace_path) {
      this.persistRunState(run, extra.workspace_path).catch((err) => {
        console.warn(`[session] Failed to persist run state ${run.run_id}: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    this.sessionManager.persist(run, extra).catch((err) => {
      console.warn(`[session] Failed to persist session ${run.run_id}: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private async persistSessionBlocking(run: TaskRun, extra?: { workspace_path?: string; branch?: string }): Promise<void> {
    try {
      await this.sessionManager.persist(run, extra);
    } catch (err) {
      console.warn(`[session] Failed to persist session ${run.run_id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async uploadArtifactsIfConfigured(run: TaskRun, workspacePath: string): Promise<void> {
    try {
      const summary = await this.artifactUploader.uploadRunArtifacts({
        run_id: run.run_id,
        project_id: run.project_id,
        tenant_id: run.tenant_id,
      }, workspacePath);
      if (!summary.skipped && summary.attempted > summary.uploaded) {
        console.warn(
          `[artifacts] Partial upload for run ${run.run_id}: uploaded ${summary.uploaded}/${summary.attempted} to s3://${summary.bucket}/${summary.prefix}`
        );
      }
    } catch (err) {
      console.warn(`[artifacts] Upload skipped for run ${run.run_id}: ${err instanceof Error ? err.message : String(err)}`);
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
      try {
        return await wsPlugin.commitStepChanges(workspacePath, runId, stepNumber, agent);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Workspace not initialized")) throw error;
        console.warn("[workspace] Plugin workspace state unavailable for checkpoint commit. Falling back to git manager.");
      }
    }
    return this.git.commitStepCheckpoint(workspacePath, runId, stepNumber, agent);
  }

  private async createPullRequest(workspacePath: string, run: TaskRun): Promise<string> {
    const wsPlugin = this.getWorkspacePlugin();
    if (wsPlugin) {
      try {
        return await wsPlugin.createPullRequest(workspacePath, run);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("Workspace not initialized")) throw error;
        console.warn("[workspace] Plugin workspace state unavailable for PR creation. Falling back to git manager.");
      }
    }
    return this.git.createPullRequest(workspacePath, run);
  }

  private async finalizeCompletedRun(run: TaskRun, workspacePath: string): Promise<void> {
    if (!run.pr_url) {
      const gitStart = Date.now();
      try {
        const prUrl = await this.createPullRequest(workspacePath, run);
        run.pr_url = prUrl;
        await this.emitEvent(run.run_id, "pr.created", { prUrl });
        this.metricsService.recordGitOperation({ operation: "pr_create", status: "success", durationMs: Date.now() - gitStart });
        this.metricsService.recordPrCreated({ project_id: this.projectConfig.project_id, status: "success" });
      } catch (prErr) {
        this.metricsService.recordGitOperation({ operation: "pr_create", status: "error", durationMs: Date.now() - gitStart });
        this.metricsService.recordPrCreated({ project_id: this.projectConfig.project_id, status: "error" });
        throw prErr;
      }
    }

    await this.updateTicketStatus(run.ticket, "in_review", run.pr_url ?? undefined);
    await this.emitEvent(run.run_id, "ticket.updated", { status: "in_review" });

    await this.sendNotification(
      `Task ${run.ticket.id} completed. PR: ${run.pr_url ?? "n/a"}`
    );
    this.persistSession(run, { workspace_path: workspacePath });

    // Start lifecycle monitoring for this PR (non-blocking)
    this.startLifecycleWatch(run, workspacePath);
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

  async resumeTask(
    runId: string,
    options?: ResumeTaskOptions
  ): Promise<TaskRun> {
    return this.tracer.startActiveSpan(
      "task.resume",
      { attributes: { project_id: this.projectConfig.project_id, run_id: runId } },
      async (span) => {
        try {
          return await this.resumeTaskBody(runId, options, span);
        } finally {
          span.end();
        }
      }
    );
  }

  private async resumeTaskBody(
    runId: string,
    options: ResumeTaskOptions | undefined,
    span: Span
  ): Promise<TaskRun> {
    const session = await this.sessionManager.get(runId);
    if (!session) {
      throw new Error(`Session not found for run: ${runId}`);
    }
    if (!session.workspace_path) {
      throw new Error(`Run ${runId} does not have a workspace path; resume is not available.`);
    }

    const workspacePath = session.workspace_path;
    const run = (await this.loadRunState(workspacePath, runId))
      ?? (await this.rebuildRunStateFromEvents(workspacePath, session));
    if (!run) {
      throw new Error(`Run state not found for run: ${runId}. Expected ${path.join(workspacePath, RUN_STATE_DIR, RUN_STATE_FILE)}`);
    }

    // Session status is authoritative for terminal cancel/fail actions such as `sprintfoundry cancel`.
    if (
      (session.status === "failed" || session.status === "cancelled") &&
      run.status !== "failed" &&
      run.status !== "cancelled"
    ) {
      run.status = session.status;
      if (session.completed_at && !run.completed_at) {
        run.completed_at = new Date(session.completed_at);
      }
      if (session.error && !run.error) {
        run.error = session.error;
      }
    }

    const allowInProgressRecovery = options?.allowInProgressRecovery === true;
    const resumableStatus =
      run.status === "failed" ||
      run.status === "cancelled" ||
      (allowInProgressRecovery && run.status === "executing");
    if (!resumableStatus) {
      throw new Error(`Run ${runId} status is '${run.status}'. Only failed/cancelled runs can be resumed.`);
    }

    const plan = run.validated_plan ?? run.plan;
    if (!plan) {
      throw new Error(`Run ${runId} has no execution plan to resume.`);
    }

    this.markInterruptedStepsForResume(run);
    await this.events.initialize(workspacePath);

    const resumeFromStep = this.resolveResumeStep(run, plan, options?.step);
    const initialCompletedSteps = this.buildInitialCompletedSteps(run, plan, resumeFromStep);
    span.setAttribute("resume_step", resumeFromStep);

    run.status = "executing";
    run.error = null;
    run.completed_at = null;
    run.updated_at = new Date();

    await this.emitEvent(run.run_id, "task.started", {
      resumed: true,
      resume_step: resumeFromStep,
      additional_prompt: Boolean(options?.prompt?.trim()),
      ...this.buildSandboxEventData(run),
    });
    this.persistSession(run, { workspace_path: workspacePath });

    try {
      await this.executePlan(run, plan, workspacePath, {
        initialCompletedSteps,
        resumeFromStep,
        operatorPrompt: options?.prompt?.trim() || undefined,
      });

      if ((run.status as string) === "completed") {
        await this.finalizeCompletedRun(run, workspacePath);
      }
      return run;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      await this.emitEvent(run.run_id, "task.failed", {
        error: run.error,
        resumed: true,
        ...this.buildSandboxEventData(run),
      });
      this.persistSession(run, { workspace_path: workspacePath });
      return run;
    } finally {
      await this.events.close();
    }
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
    this.metricsService.recordRunStarted({ project_id: this.projectConfig.project_id, source, run_id: run.run_id });

    try {
      // 2. Fetch ticket details (or create from prompt)
      const ticket = source === "prompt"
        ? this.createTicketFromPrompt(ticketId, promptText!)
        : await this.fetchTicket(ticketId, source);

      run.ticket = ticket;
      await this.persistSessionBlocking(run);
      await this.emitEvent(run.run_id, "task.created", { ticketId, source, trigger_source: triggerSource });
      await this.emitEvent(run.run_id, "task.created", {
        ticket,
        source,
        trigger_source: triggerSource,
        ticket_url: this.resolveTicketUrl(ticket),
        ticket_repo_url: this.resolveProjectRepoUrl(),
      });

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
        await this.finalizeCompletedRun(run, workspacePath);
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
      await this.emitEvent(run.run_id, "task.failed", {
        error: run.error,
        ...this.buildSandboxEventData(run),
      });
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
        await this.uploadArtifactsIfConfigured(run, workspacePath);
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
    workspacePath: string,
    options?: ExecutePlanOptions
  ): Promise<void> {
    const runEnvironment = await this.prepareRunEnvironment(run, plan, workspacePath);
    const planStepNumbers = new Set(plan.steps.map((s) => s.step_number));
    const completed = new Set<number>(
      options?.initialCompletedSteps
        ? Array.from(options.initialCompletedSteps).filter((stepNum) => planStepNumbers.has(stepNum))
        : []
    );
    const reworkCounts = new Map<number, number>();

    try {
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
          this.persistSession(run, { workspace_path: workspacePath });
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
                const operatorPrompt =
                  options?.operatorPrompt && options.resumeFromStep === step.step_number
                    ? options.operatorPrompt
                    : undefined;
                const result = await this.executeStep(
                  run,
                  step,
                  stepWorkspace,
                  runEnvironment,
                  reworkCounts,
                  reworkSignals,
                  undefined,
                  operatorPrompt
                );
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
              this.persistSession(run, { workspace_path: workspacePath });
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
              this.persistSession(run, { workspace_path: workspacePath });
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
                runEnvironment,
                reworkCounts,
                undefined,
                "rework_plan"
              );
              if (reworkResult === "failed") {
                run.status = "failed";
                this.persistSession(run, { workspace_path: workspacePath });
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
          const operatorPrompt =
            options?.operatorPrompt && options.resumeFromStep === step.step_number
              ? options.operatorPrompt
              : undefined;
          const result = await this.executeStep(
            run,
            step,
            workspacePath,
            runEnvironment,
            reworkCounts,
            undefined,
            undefined,
            operatorPrompt
          );

          if (result === "completed") {
            completed.add(step.step_number);
          } else if (result === "failed") {
            run.status = "failed";
            this.persistSession(run, { workspace_path: workspacePath });
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
        ...this.buildSandboxEventData(run),
      });
      this.persistSession(run, { workspace_path: workspacePath });
    } finally {
      await this.teardownRunEnvironment(run, runEnvironment, workspacePath);
    }
  }

  // ---- Single Step Execution ----

  private async executeStep(
    run: TaskRun,
    step: PlanStep,
    workspacePath: string,
    runEnvironment: RunEnvironmentHandle,
    reworkCounts: Map<number, number>,
    parallelReworkSignals?: Array<{ step: PlanStep; agentResult: AgentResult; currentRework: number }>,
    resumeReason?: string,
    operatorPrompt?: string
  ): Promise<"completed" | "failed" | "rework"> {
    return this.tracer.startActiveSpan(
      "agent.step",
      { attributes: { run_id: run.run_id, step_id: String(step.step_number), "step.agent": step.agent } },
      async (span) => {
        try {
          return await this.executeStepBody(
            run,
            step,
            workspacePath,
            runEnvironment,
            reworkCounts,
            parallelReworkSignals,
            resumeReason,
            operatorPrompt
          );
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
    runEnvironment: RunEnvironmentHandle,
    reworkCounts: Map<number, number>,
    parallelReworkSignals?: Array<{ step: PlanStep; agentResult: AgentResult; currentRework: number }>,
    resumeReason?: string,
    operatorPrompt?: string
  ): Promise<"completed" | "failed" | "rework"> {
    const budget = this.resolveBudget(run.ticket);
    const maxRework = budget.max_rework_cycles ?? this.platformConfig.defaults.max_rework_cycles;
    const currentRework = reworkCounts.get(step.step_number) ?? 0;
    const effectiveTask = operatorPrompt
      ? `${step.task}\n\n## Operator Resume Prompt\n${operatorPrompt}`
      : step.task;

    // Initialize step execution record
    const stepExec: StepExecution = {
      step_number: step.step_number,
      agent: step.agent,
      task: effectiveTask,
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
      task: effectiveTask,
      ...(operatorPrompt ? { operator_prompt: operatorPrompt } : {}),
      ...initialResumeTelemetry,
      ...this.buildSandboxEventData(run),
      runtime_metadata: runtimeMetadata,
    });
    await this.persistRunState(run, workspacePath);
    await this.persistSessionBlocking(run, { workspace_path: workspacePath });
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
      let runtimeActivityCount = 0;
      const result = await this.agentRunner.run({
        runId: run.run_id,
        stepNumber: step.step_number,
        stepAttempt: currentRework + 1,
        agent: step.agent,
        task: effectiveTask,
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
        runEnvironment,
        resumeSessionId,
        resumeReason,
        onRuntimeActivity: async (activity: RuntimeActivityEvent) => {
          runtimeActivityCount += 1;
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
        sinkClient: this.eventSinkClient,
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
      if (runtimeActivityCount === 0) {
        await this.postFallbackActivityLog(
          run.run_id,
          workspacePath,
          step.step_number,
          currentRework + 1,
          step.agent,
          runtime.provider
        );
      }
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
      stepExec.sandbox_id = run.sandbox_id;
      stepExec.execution_backend = run.execution_backend;
      stepExec.attempted_with_resume = Boolean(resumeSessionId);

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
            ...this.buildSandboxEventData(run),
            ...(tokenSavings ? { token_savings: tokenSavings } : {}),
            runtime_metadata: runtimeMetadata,
          });
          run.status = "failed";
          run.error = `Git checkpoint commit failed at step ${step.step_number}: ${message}`;
          return "failed";
        }

        stepExec.status = "completed";
        await this.upsertStepResultToSink(run.run_id, stepExec, currentRework + 1);
        await this.emitEvent(run.run_id, "step.completed", {
          step: step.step_number,
          tokens: result.tokens_used,
          artifacts: result.agentResult.artifacts_created,
          ...finalResumeTelemetry,
          ...this.buildSandboxEventData(run),
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
            return this.executeStep(
              run,
              step,
              workspacePath,
              runEnvironment,
              reworkCounts,
              undefined,
              "quality_gate_retry",
              operatorPrompt
            );
          }
        }

        return "completed";
      }

      if (result.agentResult.status === "needs_rework") {
        stepExec.status = "needs_rework";
        await this.upsertStepResultToSink(run.run_id, stepExec, currentRework + 1);

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
            ...this.buildSandboxEventData(run),
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
            run,
            reworkStep,
            workspacePath,
            runEnvironment,
            reworkCounts,
            undefined,
            "rework_plan"
          );
          if (reworkResult === "failed") return "failed";
        }

        // Retry the original step
        return this.executeStep(
          run,
          step,
          workspacePath,
          runEnvironment,
          reworkCounts,
          undefined,
          "rework_retry",
          operatorPrompt
        );
      }

      // Blocked or failed
      stepExec.status = "failed";
      await this.emitEvent(run.run_id, "step.failed", {
        step: step.step_number,
        reason: result.agentResult.status,
        issues: result.agentResult.issues,
        ...finalResumeTelemetry,
        ...this.buildSandboxEventData(run),
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
        ...this.buildSandboxEventData(run),
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
    if (runtime.mode === "remote") return false;
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

  private getRunStatePath(workspacePath: string): string {
    return path.join(workspacePath, RUN_STATE_DIR, RUN_STATE_FILE);
  }

  private getRunEnvironment(run: TaskRun): RunEnvironmentHandle | null {
    return (run as TaskRunWithEnvironment).run_environment ?? null;
  }

  private setRunEnvironment(run: TaskRun, handle: RunEnvironmentHandle | null): void {
    (run as TaskRunWithEnvironment).run_environment = handle;
  }

  private createFallbackRunEnvironment(run: TaskRun, workspacePath: string): RunEnvironmentHandle {
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

  private async prepareRunEnvironment(
    run: TaskRun,
    plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    const existing = this.getRunEnvironment(run);
    const prepared = existing
      ? await this.resumeRunEnvironment(existing)
      : await this.createRunEnvironment(run, plan, workspacePath);

    this.setRunEnvironment(run, prepared);
    this.applyRunEnvironmentMetadata(run, prepared);
    this.recordSandboxProvisioningMetrics(prepared);
    if (existing) {
      await this.emitEvent(run.run_id, "sandbox.resumed", this.buildSandboxEventData(run, {
        checkpoint_generation: prepared.checkpoint_generation,
      }));
    } else {
      await this.emitEvent(run.run_id, "sandbox.created", this.buildSandboxEventData(run, {
        workspace_path: prepared.workspace_path,
        checkpoint_generation: prepared.checkpoint_generation,
      }));
    }
    this.persistSession(run, { workspace_path: workspacePath });
    return prepared;
  }

  private recordSandboxProvisioningMetrics(handle: RunEnvironmentHandle): void {
    const rawTimings = handle.metadata["provisioning_timing_ms"];
    if (!rawTimings || typeof rawTimings !== "object") {
      return;
    }

    for (const [stage, durationMs] of Object.entries(rawTimings as Record<string, unknown>)) {
      if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) {
        continue;
      }
      this.metricsService.recordSandboxProvisioning({
        project_id: this.projectConfig.project_id,
        execution_backend: handle.execution_backend,
        stage,
        durationMs,
      });
    }
  }

  private async createRunEnvironment(
    run: TaskRun,
    plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    if (!this.executionBackend) {
      return this.createFallbackRunEnvironment(run, workspacePath);
    }

    return this.executionBackend.prepareRunEnvironment(run, plan, workspacePath);
  }

  private async resumeRunEnvironment(
    handle: RunEnvironmentHandle
  ): Promise<RunEnvironmentHandle> {
    if (!this.executionBackend) {
      return handle;
    }

    return this.executionBackend.resumeRun(handle);
  }

  private async teardownRunEnvironment(
    run: TaskRun,
    handle: RunEnvironmentHandle,
    workspacePath: string
  ): Promise<void> {
    const reason = this.resolveTeardownReason(run.status);
    if (this.executionBackend) {
      try {
        await this.executionBackend.teardownRun(handle, reason);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[execution-backend] Failed to teardown sandbox ${handle.sandbox_id}: ${message}`);
      }
    }
    await this.emitEvent(run.run_id, "sandbox.destroyed", this.buildSandboxEventData(run, {
      reason,
    }));
    this.persistSession(run, { workspace_path: workspacePath });
  }

  private resolveTeardownReason(status: RunStatus): SandboxTeardownReason {
    switch (status) {
      case "completed":
        return "completed";
      case "cancelled":
        return "cancelled";
      default:
        return "failed";
    }
  }

  private applyRunEnvironmentMetadata(run: TaskRun, handle: RunEnvironmentHandle): void {
    run.sandbox_id = handle.sandbox_id;
    run.execution_backend = handle.execution_backend;
    run.workspace_volume_ref = handle.workspace_volume_ref;
    run.network_profile = handle.network_profile;
    run.secret_profile = handle.secret_profile;
    run.isolation_level = handle.isolation_level;
    run.resume_token = handle.resume_token;
    run.checkpoint_generation = handle.checkpoint_generation;
  }

  private buildSandboxEventData(
    run: TaskRun,
    extra?: Record<string, unknown>
  ): Record<string, unknown> {
    const handle = this.getRunEnvironment(run);
    return {
      sandbox_id: handle?.sandbox_id ?? run.sandbox_id,
      execution_backend: handle?.execution_backend ?? run.execution_backend,
      tenant_id: run.tenant_id,
      workspace_volume_ref: handle?.workspace_volume_ref ?? run.workspace_volume_ref,
      network_profile: handle?.network_profile ?? run.network_profile,
      isolation_level: handle?.isolation_level ?? run.isolation_level,
      ...(extra ?? {}),
    };
  }

  private async persistRunState(run: TaskRun, workspacePath: string): Promise<void> {
    const statePath = this.getRunStatePath(workspacePath);
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const payload = this.serializeRun(run);
    await fs.writeFile(statePath, JSON.stringify(payload, null, 2), "utf-8");
  }

  private async loadRunState(workspacePath: string, runId: string): Promise<TaskRun | null> {
    const statePath = this.getRunStatePath(workspacePath);
    try {
      const raw = await fs.readFile(statePath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (String(parsed.run_id ?? "") !== runId) return null;
      return this.deserializeRun(parsed);
    } catch {
      return null;
    }
  }

  private serializeRun(run: TaskRun): Record<string, unknown> {
    return {
      ...run,
      created_at: run.created_at.toISOString(),
      updated_at: run.updated_at.toISOString(),
      completed_at: run.completed_at ? run.completed_at.toISOString() : null,
      steps: run.steps.map((step) => ({
        ...step,
        started_at: step.started_at ? step.started_at.toISOString() : null,
        completed_at: step.completed_at ? step.completed_at.toISOString() : null,
      })),
    };
  }

  private deserializeRun(payload: Record<string, unknown>): TaskRun {
    const raw = payload as unknown as TaskRun;
    return {
      ...raw,
      created_at: new Date(raw.created_at),
      updated_at: new Date(raw.updated_at),
      completed_at: raw.completed_at ? new Date(raw.completed_at) : null,
      steps: (raw.steps ?? []).map((step) => ({
        ...step,
        started_at: step.started_at ? new Date(step.started_at) : null,
        completed_at: step.completed_at ? new Date(step.completed_at) : null,
      })),
    };
  }

  private async rebuildRunStateFromEvents(
    workspacePath: string,
    session: RunSessionMetadata
  ): Promise<TaskRun | null> {
    const eventsPath = path.join(workspacePath, ".events.jsonl");
    const raw = await fs.readFile(eventsPath, "utf-8").catch(() => "");
    if (!raw.trim()) return null;

    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as TaskEvent;
        } catch {
          return null;
        }
      })
      .filter((event): event is TaskEvent => Boolean(event))
      .filter((event) => event.run_id === session.run_id);
    if (events.length === 0) return null;

    const latestTicketEvent = [...events]
      .reverse()
      .find((event) => event.event_type === "task.created" && event.data.ticket);
    const ticket = (latestTicketEvent?.data.ticket as TicketDetails | undefined)
      ?? this.createTicketFromPrompt(session.ticket_id, session.ticket_title);

    const latestPlanEvent = [...events]
      .reverse()
      .find((event) => event.event_type === "task.plan_generated" && event.data.plan);
    const plan = latestPlanEvent?.data.plan as ExecutionPlan | undefined;
    if (!plan) return null;

    const stepExecutions: StepExecution[] = [];
    let recoveredRunEnvironment: RunEnvironmentHandle | null = null;
    for (const event of events) {
      if (
        event.event_type === "sandbox.created" ||
        event.event_type === "sandbox.resumed"
      ) {
        recoveredRunEnvironment = this.rebuildRunEnvironmentFromEvent(session, event, recoveredRunEnvironment);
      }

      if (event.event_type === "step.started") {
        const stepNum = Number(event.data.step ?? 0);
        const agent = String(event.data.agent ?? "unknown");
        if (!stepNum) continue;
        stepExecutions.push({
          step_number: stepNum,
          agent,
          task: typeof event.data.task === "string" ? event.data.task : undefined,
          status: "running",
          container_id: null,
          tokens_used: 0,
          cost_usd: 0,
          started_at: event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp),
          completed_at: null,
          result: null,
          rework_count: 0,
          runtime_metadata: null,
        });
        continue;
      }

      if (event.event_type === "step.completed" || event.event_type === "step.failed") {
        const stepNum = Number(event.data.step ?? 0);
        if (!stepNum) continue;
        const target = [...stepExecutions]
          .reverse()
          .find((entry) => entry.step_number === stepNum && entry.completed_at === null);
        if (!target) continue;
        target.status = event.event_type === "step.completed" ? "completed" : "failed";
        target.completed_at = event.timestamp instanceof Date ? event.timestamp : new Date(event.timestamp);
        if (typeof event.data.tokens === "number") {
          target.tokens_used = event.data.tokens;
        }
      }

      if (event.event_type === "step.rework_triggered") {
        const stepNum = Number(event.data.step ?? 0);
        if (!stepNum) continue;
        const target = [...stepExecutions]
          .reverse()
          .find((entry) => entry.step_number === stepNum && entry.completed_at === null);
        if (target) {
          target.status = "needs_rework";
        }
      }
    }

    return {
      run_id: session.run_id,
      project_id: session.project_id,
      ticket,
      plan,
      validated_plan: plan,
      status: session.status,
      steps: stepExecutions,
      sandbox_id: recoveredRunEnvironment?.sandbox_id,
      execution_backend: recoveredRunEnvironment?.execution_backend,
      workspace_volume_ref: recoveredRunEnvironment?.workspace_volume_ref,
      checkpoint_generation: recoveredRunEnvironment?.checkpoint_generation,
      run_environment: recoveredRunEnvironment,
      total_tokens_used: session.total_tokens,
      total_cost_usd: session.total_cost_usd,
      created_at: new Date(session.created_at),
      updated_at: new Date(session.updated_at),
      completed_at: session.completed_at ? new Date(session.completed_at) : null,
      pr_url: session.pr_url,
      error: session.error,
    };
  }

  private markInterruptedStepsForResume(run: TaskRun): void {
    for (const step of run.steps) {
      if (step.status !== "running") continue;
      step.status = "failed";
      step.completed_at = step.completed_at ?? new Date();
      step.result = step.result ?? {
        status: "failed",
        summary: "Step interrupted before resume",
        artifacts_created: [],
        artifacts_modified: [],
        issues: ["Run resumed after interruption; step marked failed for explicit replay."],
        metadata: {
          interrupted: true,
        },
      };
    }
  }

  private rebuildRunEnvironmentFromEvent(
    session: RunSessionMetadata,
    event: TaskEvent,
    previous: RunEnvironmentHandle | null
  ): RunEnvironmentHandle {
    return {
      run_id: session.run_id,
      project_id: session.project_id,
      tenant_id: typeof event.data.tenant_id === "string" ? event.data.tenant_id : previous?.tenant_id,
      sandbox_id: String(event.data.sandbox_id ?? previous?.sandbox_id ?? ""),
      execution_backend: String(event.data.execution_backend ?? previous?.execution_backend ?? "local"),
      workspace_path: session.workspace_path ?? previous?.workspace_path ?? "",
      workspace_volume_ref:
        typeof event.data.workspace_volume_ref === "string"
          ? event.data.workspace_volume_ref
          : previous?.workspace_volume_ref,
      network_profile:
        typeof event.data.network_profile === "string"
          ? event.data.network_profile
          : previous?.network_profile,
      isolation_level:
        typeof event.data.isolation_level === "string"
          ? (event.data.isolation_level as RunEnvironmentHandle["isolation_level"])
          : previous?.isolation_level,
      checkpoint_generation:
        typeof event.data.checkpoint_generation === "number"
          ? event.data.checkpoint_generation
          : previous?.checkpoint_generation ?? 0,
      metadata: {
        ...(previous?.metadata ?? {}),
        recovered_from_events: true,
      },
    };
  }

  private resolveResumeStep(run: TaskRun, plan: ExecutionPlan, requestedStep?: number): number {
    const planSteps = new Set(plan.steps.map((step) => step.step_number));
    const failedHistory = run.steps.filter((step) => step.status === "failed" || step.status === "needs_rework");

    if (requestedStep !== undefined) {
      if (!Number.isInteger(requestedStep) || requestedStep <= 0) {
        throw new Error(`Invalid --step value: ${requestedStep}`);
      }
      if (!planSteps.has(requestedStep)) {
        throw new Error(`Step ${requestedStep} is not part of the validated plan and cannot be resumed.`);
      }
      if (!failedHistory.some((step) => step.step_number === requestedStep)) {
        throw new Error(`Step ${requestedStep} does not appear as failed/needs_rework in run ${run.run_id}.`);
      }
      return requestedStep;
    }

    const latestFailed = [...failedHistory]
      .reverse()
      .find((step) => planSteps.has(step.step_number));
    if (!latestFailed) {
      throw new Error(`Run ${run.run_id} has no failed plan step to resume.`);
    }
    return latestFailed.step_number;
  }

  private buildInitialCompletedSteps(
    run: TaskRun,
    plan: ExecutionPlan,
    resumeFromStep: number
  ): Set<number> {
    const completed = new Set<number>();
    const allowed = new Set(plan.steps.map((step) => step.step_number));
    for (let i = run.steps.length - 1; i >= 0; i -= 1) {
      const step = run.steps[i];
      if (step.status !== "completed") continue;
      if (step.step_number >= resumeFromStep) continue;
      if (!allowed.has(step.step_number)) continue;
      if (completed.has(step.step_number)) continue;
      completed.add(step.step_number);
    }
    return completed;
  }

  private createRun(ticketId: string): TaskRun {
    const presetRunId = String(process.env.SPRINTFOUNDRY_RUN_ID ?? "").trim();
    return {
      run_id: presetRunId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

    return {
      provider: "claude-code",
      mode: "local_process",
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
    const needed = new Set(step.depends_on);
    const latestByStep = new Map<number, { step_number: number; agent: AgentType; result: AgentResult }>();
    for (let i = run.steps.length - 1; i >= 0; i -= 1) {
      const entry = run.steps[i];
      if (!needed.has(entry.step_number)) continue;
      if (entry.status !== "completed" || !entry.result) continue;
      if (latestByStep.has(entry.step_number)) continue;
      latestByStep.set(entry.step_number, {
        step_number: entry.step_number,
        agent: entry.agent,
        result: entry.result,
      });
    }
    return step.depends_on
      .map((stepNumber) => latestByStep.get(stepNumber))
      .filter((entry): entry is { step_number: number; agent: AgentType; result: AgentResult } => Boolean(entry));
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

  private async upsertStepResultToSink(
    runId: string,
    step: StepExecution,
    stepAttempt: number
  ): Promise<void> {
    if (!this.eventSinkClient) return;
    if (!(step.started_at instanceof Date) || !(step.completed_at instanceof Date)) return;

    const fallbackResult: Record<string, unknown> = {
      status: step.status,
      summary: "",
      artifacts_created: [],
      artifacts_modified: [],
      issues: [],
    };
    const resultPayload =
      step.result && typeof step.result === "object"
        ? (step.result as unknown as Record<string, unknown>)
        : fallbackResult;

    try {
      await this.eventSinkClient.upsertStepResult({
        run_id: runId,
        step_number: step.step_number,
        step_attempt: stepAttempt,
        agent: step.agent,
        status: step.status,
        started_at: step.started_at.toISOString(),
        completed_at: step.completed_at.toISOString(),
        result: resultPayload,
      });
    } catch (error) {
      console.warn(
        `[event-sink] Failed to upsert step result run=${runId} step=${step.step_number} attempt=${stepAttempt}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async postFallbackActivityLog(
    runId: string,
    workspacePath: string,
    stepNumber: number,
    stepAttempt: number,
    agent: AgentType,
    runtimeProvider: RuntimeConfig["provider"]
  ): Promise<void> {
    if (!this.eventSinkClient) return;

    const runtimeLogPrefix = this.runtimeLogFilePrefix(runtimeProvider);
    const stdoutPath = path.join(
      workspacePath,
      `.${runtimeLogPrefix}-runtime.step-${stepNumber}.attempt-${stepAttempt}.stdout.log`
    );
    const raw = await fs.readFile(stdoutPath, "utf-8").catch(() => "");
    if (!raw.trim()) return;

    const chunks = this.chunkUtf8(raw, 4 * 1024);
    if (chunks.length === 0) return;

    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      try {
        await this.eventSinkClient.postLog({
          run_id: runId,
          step_number: stepNumber,
          step_attempt: stepAttempt,
          agent,
          runtime_provider: runtimeProvider,
          sequence: i,
          chunk,
          byte_length: Buffer.byteLength(chunk, "utf-8"),
          stream: "activity",
          is_final: i === chunks.length - 1,
          timestamp: new Date().toISOString(),
        });
      } catch (error) {
        console.warn(
          `[event-sink] Failed fallback activity log run=${runId} step=${stepNumber} attempt=${stepAttempt}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        break;
      }
    }
  }

  private runtimeLogFilePrefix(runtimeProvider: RuntimeConfig["provider"]): string {
    switch (runtimeProvider) {
      case "claude-code":
        return "claude";
      case "codex":
        return "codex";
      default:
        return runtimeProvider;
    }
  }

  private chunkUtf8(text: string, maxBytes: number): string[] {
    if (!text) return [];

    const chunks: string[] = [];
    let start = 0;
    let currentBytes = 0;
    let index = 0;

    while (index < text.length) {
      const codePoint = text.codePointAt(index);
      if (codePoint === undefined) break;
      const char = String.fromCodePoint(codePoint);
      const charBytes = Buffer.byteLength(char, "utf-8");

      if (currentBytes + charBytes > maxBytes && index > start) {
        chunks.push(text.slice(start, index));
        start = index;
        currentBytes = 0;
        continue;
      }

      currentBytes += charBytes;
      index += char.length;
    }

    if (start < text.length) {
      chunks.push(text.slice(start));
    }

    return chunks;
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

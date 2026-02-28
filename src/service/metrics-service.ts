// ============================================================
// SprintFoundry — Metrics Service
// Wraps the OpenTelemetry Metrics API to emit custom
// SprintFoundry metrics from the orchestration service.
//
// All methods are no-ops when telemetry is disabled.
// Activate by setting SPRINTFOUNDRY_OTEL_ENABLED=1.
// ============================================================

import { metrics, trace, type Counter, type Histogram, type UpDownCounter, type Meter } from "@opentelemetry/api";
import type { AgentType, RuntimeMode } from "../shared/types.js";

const METER_NAME = "sprintfoundry";
const METER_VERSION = "1.0.0";

export class MetricsService {
  private enabled: boolean;
  private meter: Meter;

  // ---- Run lifecycle ----
  private runsTotal: Counter;
  private runDurationSeconds: Histogram;
  private activeRuns: UpDownCounter;
  private planStepsCount: Histogram;

  // ---- Step / agent execution ----
  private stepsTotal: Counter;
  private stepAttemptsTotal: Counter;
  private agentSpawnsTotal: Counter;
  private stepDurationSeconds: Histogram;

  // ---- Cost & tokens ----
  private tokensUsedTotal: Counter;
  private costUsdTotal: Counter;
  private cacheTokensSavedTotal: Counter;
  private tokenLimitExceededTotal: Counter;
  private tokenBudgetUtilizationRatio: Histogram;

  // ---- Quality & rework ----
  private reworkCyclesTotal: Counter;
  private humanGateDecisionsTotal: Counter;
  private humanGateWaitSeconds: Histogram;

  // ---- Safety ----
  private guardrailBlocksTotal: Counter;
  private agentTimeoutsTotal: Counter;
  private planValidationInjectionsTotal: Counter;

  // ---- Infrastructure ----
  private gitOperationDurationSeconds: Histogram;
  private gitErrorsTotal: Counter;
  private prCreatedTotal: Counter;
  private workspacePrepDurationSeconds: Histogram;

  // ---- Agent activity ----
  private agentToolCallsTotal: Counter;
  private agentFileEditsTotal: Counter;
  private agentCommandsTotal: Counter;

  constructor(enabled: boolean) {
    this.enabled = enabled;
    this.meter = metrics.getMeter(METER_NAME, METER_VERSION);

    // Run lifecycle
    this.runsTotal = this.meter.createCounter("sprintfoundry_runs_total", {
      description: "Total SprintFoundry runs by project, source, and status",
    });
    this.runDurationSeconds = this.meter.createHistogram("sprintfoundry_run_duration_seconds", {
      description: "End-to-end run duration from ticket fetch to PR creation",
      unit: "s",
    });
    this.activeRuns = this.meter.createUpDownCounter("sprintfoundry_active_runs", {
      description: "Currently in-flight SprintFoundry runs",
    });
    this.planStepsCount = this.meter.createHistogram("sprintfoundry_plan_steps_count", {
      description: "Number of agent steps in the generated execution plan",
    });

    // Step / agent execution
    this.stepsTotal = this.meter.createCounter("sprintfoundry_steps_total", {
      description: "Total agent steps executed, labelled by outcome",
    });
    this.stepAttemptsTotal = this.meter.createCounter("sprintfoundry_step_attempts_total", {
      description: "Total step attempt invocations (includes retries and rework)",
    });
    this.agentSpawnsTotal = this.meter.createCounter("sprintfoundry_agent_spawns_total", {
      description: "Total agent process/container spawns",
    });
    this.stepDurationSeconds = this.meter.createHistogram("sprintfoundry_step_duration_seconds", {
      description: "Individual agent step execution duration",
      unit: "s",
    });

    // Cost & tokens
    this.tokensUsedTotal = this.meter.createCounter("sprintfoundry_tokens_used_total", {
      description: "Total tokens consumed by agents",
      unit: "tokens",
    });
    this.costUsdTotal = this.meter.createCounter("sprintfoundry_cost_usd_total", {
      description: "Total estimated cost in USD spent by agents",
      unit: "USD",
    });
    this.cacheTokensSavedTotal = this.meter.createCounter("sprintfoundry_cache_tokens_saved_total", {
      description: "Tokens saved via prompt caching",
      unit: "tokens",
    });
    this.tokenLimitExceededTotal = this.meter.createCounter("sprintfoundry_token_limit_exceeded_total", {
      description: "Times an agent hit the token or cost budget ceiling before finishing",
    });
    this.tokenBudgetUtilizationRatio = this.meter.createHistogram("sprintfoundry_token_budget_utilization_ratio", {
      description: "Ratio of tokens used to tokens budgeted per agent step (0.0 – 1.0+)",
    });

    // Quality & rework
    this.reworkCyclesTotal = this.meter.createCounter("sprintfoundry_rework_cycles_total", {
      description: "Total rework loops triggered (e.g. QA rejecting developer output)",
    });
    this.humanGateDecisionsTotal = this.meter.createCounter("sprintfoundry_human_gate_decisions_total", {
      description: "Human gate decisions recorded",
    });
    this.humanGateWaitSeconds = this.meter.createHistogram("sprintfoundry_human_gate_wait_seconds", {
      description: "Time a human gate stayed open before a decision was made",
      unit: "s",
    });

    // Safety
    this.guardrailBlocksTotal = this.meter.createCounter("sprintfoundry_guardrail_blocks_total", {
      description: "Tool calls blocked by the guardrail deny-list",
    });
    this.agentTimeoutsTotal = this.meter.createCounter("sprintfoundry_agent_timeouts_total", {
      description: "Agent processes/containers killed for exceeding the timeout",
    });
    this.planValidationInjectionsTotal = this.meter.createCounter("sprintfoundry_plan_validation_injections_total", {
      description: "Agent or role injections added by plan-validator rules (shows which rules fire most)",
    });

    // Infrastructure
    this.gitOperationDurationSeconds = this.meter.createHistogram("sprintfoundry_git_operation_duration_seconds", {
      description: "Duration of git operations: clone, commit, push, pr_create",
      unit: "s",
    });
    this.gitErrorsTotal = this.meter.createCounter("sprintfoundry_git_errors_total", {
      description: "Git operation failures",
    });
    this.prCreatedTotal = this.meter.createCounter("sprintfoundry_pr_created_total", {
      description: "Pull requests created",
    });
    this.workspacePrepDurationSeconds = this.meter.createHistogram("sprintfoundry_workspace_prep_duration_seconds", {
      description: "Time to prepare the agent workspace (context writing, file setup)",
      unit: "s",
    });

    // Agent activity
    this.agentToolCallsTotal = this.meter.createCounter("sprintfoundry_agent_tool_calls_total", {
      description: "Tool calls made by agents — reveals which tools are used most",
    });
    this.agentFileEditsTotal = this.meter.createCounter("sprintfoundry_agent_file_edits_total", {
      description: "File edits made by agents, labelled by file extension",
    });
    this.agentCommandsTotal = this.meter.createCounter("sprintfoundry_agent_commands_total", {
      description: "Shell commands run by agents",
    });
  }

  // ---- Run lifecycle ----

  recordRunStarted(attrs: { project_id: string; source: string; run_id: string }): void {
    if (!this.enabled) return;
    const { run_id, ...counterAttrs } = attrs;
    trace.getActiveSpan()?.setAttributes({ project_id: attrs.project_id, source: attrs.source, run_id });
    this.activeRuns.add(1, counterAttrs);
  }

  recordRunCompleted(attrs: {
    project_id: string;
    source: string;
    run_id: string;
    status: "completed" | "failed";
    durationMs: number;
    planSteps?: number;
  }): void {
    if (!this.enabled) return;
    const { run_id, durationMs, planSteps, ...labels } = attrs;
    trace.getActiveSpan()?.setAttributes({
      run_id,
      status: attrs.status,
      duration_ms: durationMs,
      plan_steps: planSteps ?? 0,
    });
    this.activeRuns.add(-1, { project_id: attrs.project_id, source: attrs.source });
    this.runsTotal.add(1, labels);
    this.runDurationSeconds.record(durationMs / 1000, labels);
    if (planSteps !== undefined) {
      this.planStepsCount.record(planSteps, { project_id: attrs.project_id });
    }
  }

  // ---- Step / agent execution ----

  recordStepStarted(attrs: { run_id: string; step_id: string; agent: AgentType; provider: string; mode: RuntimeMode }): void {
    if (!this.enabled) return;
    const { run_id, step_id, ...counterAttrs } = attrs;
    trace.getActiveSpan()?.setAttributes({ run_id, step_id });
    this.stepAttemptsTotal.add(1, counterAttrs);
    this.agentSpawnsTotal.add(1, counterAttrs);
  }

  recordStepCompleted(attrs: {
    run_id: string;
    step_id: string;
    agent: AgentType;
    provider: string;
    mode: RuntimeMode;
    status: string;
    durationMs: number;
    tokensUsed: number;
    costUsd: number;
    tokenBudget: number;
    cacheTokensSaved?: number;
  }): void {
    if (!this.enabled) return;
    const { run_id, step_id, durationMs, tokensUsed, costUsd, tokenBudget, cacheTokensSaved, ...labels } = attrs;
    trace.getActiveSpan()?.setAttributes({
      run_id,
      step_id,
      tokens_used: tokensUsed,
      cost_usd: costUsd,
      cache_tokens_saved: cacheTokensSaved ?? 0,
      duration_ms: durationMs,
      status: attrs.status,
    });
    this.stepsTotal.add(1, labels);
    this.stepDurationSeconds.record(durationMs / 1000, labels);

    const agentAttrs = { agent: attrs.agent, provider: attrs.provider, mode: attrs.mode };
    this.tokensUsedTotal.add(tokensUsed, agentAttrs);
    this.costUsdTotal.add(costUsd, agentAttrs);

    if (tokenBudget > 0) {
      this.tokenBudgetUtilizationRatio.record(tokensUsed / tokenBudget, { agent: attrs.agent });
    }
    if (cacheTokensSaved && cacheTokensSaved > 0) {
      this.cacheTokensSavedTotal.add(cacheTokensSaved, { agent: attrs.agent, provider: attrs.provider });
    }
  }

  // ---- Token / cost limits ----

  recordTokenLimitExceeded(attrs: { agent: AgentType; provider: string; reason: string }): void {
    if (!this.enabled) return;
    this.tokenLimitExceededTotal.add(1, attrs);
  }

  // ---- Rework ----

  recordReworkTriggered(attrs: { project_id: string; agent: AgentType }): void {
    if (!this.enabled) return;
    this.reworkCyclesTotal.add(1, attrs);
  }

  // ---- Human gates ----

  recordHumanGateDecision(attrs: {
    project_id: string;
    decision: "approved" | "rejected";
    waitMs: number;
  }): void {
    if (!this.enabled) return;
    const { waitMs, ...labels } = attrs;
    this.humanGateDecisionsTotal.add(1, labels);
    this.humanGateWaitSeconds.record(waitMs / 1000, { project_id: attrs.project_id });
  }

  // ---- Safety ----

  recordGuardrailBlock(attrs: { agent: AgentType; provider: string }): void {
    if (!this.enabled) return;
    this.guardrailBlocksTotal.add(1, attrs);
  }

  recordAgentTimeout(attrs: { agent: AgentType; provider: string }): void {
    if (!this.enabled) return;
    this.agentTimeoutsTotal.add(1, attrs);
  }

  recordPlanValidationInjection(attrs: { rule_id: string }): void {
    if (!this.enabled) return;
    this.planValidationInjectionsTotal.add(1, attrs);
  }

  // ---- Infrastructure ----

  recordGitOperation(attrs: {
    operation: string;
    status: "success" | "error";
    durationMs: number;
  }): void {
    if (!this.enabled) return;
    const { durationMs, ...labels } = attrs;
    this.gitOperationDurationSeconds.record(durationMs / 1000, labels);
    if (attrs.status === "error") {
      this.gitErrorsTotal.add(1, { operation: attrs.operation });
    }
  }

  recordPrCreated(attrs: { project_id: string; status: "success" | "error" }): void {
    if (!this.enabled) return;
    this.prCreatedTotal.add(1, attrs);
  }

  recordWorkspacePrep(attrs: { agent: AgentType; durationMs: number }): void {
    if (!this.enabled) return;
    this.workspacePrepDurationSeconds.record(attrs.durationMs / 1000, { agent: attrs.agent });
  }

  // ---- Agent activity (from runtime event stream) ----

  recordToolCall(attrs: { agent: AgentType; tool_name: string }): void {
    if (!this.enabled) return;
    this.agentToolCallsTotal.add(1, attrs);
  }

  recordFileEdit(attrs: { agent: AgentType; extension: string }): void {
    if (!this.enabled) return;
    this.agentFileEditsTotal.add(1, attrs);
  }

  recordCommandRun(attrs: { agent: AgentType }): void {
    if (!this.enabled) return;
    this.agentCommandsTotal.add(1, attrs);
  }
}

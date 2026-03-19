#!/usr/bin/env node

import { Command } from "commander";
import { Option } from "commander";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { spawn } from "child_process";

const require = createRequire(import.meta.url);
const { version } = require("../package.json");
import type { PlatformConfig, ProjectConfig, RuntimeConfig, TaskRun, TaskSource } from "./shared/types.js";
import { OrchestrationService } from "./service/orchestration-service.js";
import { loadConfig } from "./service/config-loader.js";
import { migrateEnvVars } from "./service/env-compat.js";
import { runProjectCreate } from "./commands/project-create.js";
import { runAgentCreate } from "./commands/agent-create.js";
import { SessionManager } from "./service/session-manager.js";
import { resolveAutoResumeAction } from "./service/auto-resume.js";
import { getActivityState } from "./service/activity-detector.js";
import { PluginRegistry } from "./service/plugin-registry.js";
import { createExecutionBackend, resolveExecutionBackendName } from "./service/execution/index.js";
import { tmpdirWorkspaceModule } from "./plugins/workspace-tmpdir/index.js";
import { worktreeWorkspaceModule } from "./plugins/workspace-worktree/index.js";
import { defaultTrackerModule } from "./plugins/tracker-default/index.js";
import { consoleNotifierModule } from "./plugins/notifier-console/index.js";
import { githubSCMModule } from "./plugins/scm-github/index.js";
import { startDispatchControllerServer } from "./service/dispatch-controller.js";
import { resolveDefaultDirectAgent } from "./service/direct-agent-default.js";
import { RunSnapshotExportService } from "./service/run-snapshot-export-service.js";
import { RunSnapshotStore } from "./service/run-snapshot-store.js";
import { WorkspaceManager } from "./service/workspace-manager.js";
import { K8sRunSnapshotController } from "./service/k8s-run-snapshot-controller.js";
import { validateAgentSandboxWholeRunHosting } from "./service/agent-sandbox-platform.js";
import { EventSinkClient } from "./service/event-sink-client.js";
import { EventStore } from "./service/event-store.js";
import {
  hasFailingChecks,
  resolvePreflightProfile,
  runPreflight,
  summarizePreflight,
  type PreflightProfile,
} from "./service/preflight.js";

const RUN_SANDBOX_MODE_ENV = "SPRINTFOUNDRY_RUN_SANDBOX_MODE";
const WHOLE_RUN_SANDBOX_MODE = "k8s-whole-run";
const AUTO_RESUME_ENV = "SPRINTFOUNDRY_AUTO_RESUME_EXISTING_RUN";

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeDoctorProfile(value: unknown): PreflightProfile | undefined {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "local" || normalized === "distributed" || normalized === "k8s") {
    return normalized;
  }
  return undefined;
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

function summarizeEventData(data: Record<string, unknown>): string {
  if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
  if (typeof data.reason === "string" && data.reason.trim()) return data.reason.trim();
  if (typeof data.agent === "string" && typeof data.step === "number") {
    return `step ${data.step} (${data.agent})`;
  }
  if (typeof data.step === "number") {
    return `step ${data.step}`;
  }
  if (typeof data.ticketId === "string") {
    return data.ticketId;
  }
  return "";
}

function resolveEventSinkClient(
  project: ProjectConfig,
  env: NodeJS.ProcessEnv = process.env
): EventSinkClient | undefined {
  const sinkUrl =
    env.SPRINTFOUNDRY_EVENT_SINK_URL?.trim() ||
    project.integrations?.event_sink?.url?.trim() ||
    "";
  if (!sinkUrl) return undefined;
  const internalApiToken = env.SPRINTFOUNDRY_INTERNAL_API_TOKEN?.trim() || undefined;
  return new EventSinkClient(sinkUrl, globalThis.fetch, internalApiToken);
}

async function maybeRunRuntimeCliPassthrough(): Promise<void> {
  const runtimeCli = process.argv[2];
  if (runtimeCli !== "claude" && runtimeCli !== "codex") {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(runtimeCli, process.argv.slice(3), { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve();
      process.exit(code ?? 0);
    });
  });
}

await maybeRunRuntimeCliPassthrough();

// Migrate deprecated AGENTSDLC_* env vars to SPRINTFOUNDRY_*
migrateEnvVars();

// Initialize OpenTelemetry metrics SDK before anything else so that the global
// MeterProvider is registered when MetricsService creates its instruments.
// Only active when SPRINTFOUNDRY_OTEL_ENABLED=1.
if (process.env.SPRINTFOUNDRY_OTEL_ENABLED === "1") {
  const { MeterProvider, PeriodicExportingMetricReader } = await import("@opentelemetry/sdk-metrics");
  const { OTLPMetricExporter } = await import("@opentelemetry/exporter-metrics-otlp-http");
  const { metrics } = await import("@opentelemetry/api");

  // Use HTTP OTLP (port 4318) by default — avoids native gRPC dependencies.
  // Users can point this at any OTLP-compatible collector.
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318";
  const exporter = new OTLPMetricExporter({ url: `${endpoint}/v1/metrics` });
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 15_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  console.log(`[otel] Metrics enabled — exporting to ${endpoint}/v1/metrics every 15s`);
}

const program = new Command();

function buildPluginRegistry(platform: PlatformConfig, project: ProjectConfig): PluginRegistry {
  const registry = new PluginRegistry();
  const wholeRunSandbox = process.env[RUN_SANDBOX_MODE_ENV] === WHOLE_RUN_SANDBOX_MODE;

  const workspaceStrategy =
    (wholeRunSandbox ? "tmpdir" : project.workspace?.strategy) ??
    platform.workspace?.strategy ??
    "tmpdir";
  const baseRepoDir =
    project.workspace?.base_repo_dir ??
    platform.workspace?.base_repo_dir ??
    path.join(os.tmpdir(), "sprintfoundry-worktrees");

  if (workspaceStrategy === "worktree") {
    registry.register(worktreeWorkspaceModule, {
      project_id: project.project_id,
      base_repo_dir: baseRepoDir,
    });
  } else {
    registry.register(tmpdirWorkspaceModule, {
      project_id: project.project_id,
    });
  }

  registry.register(defaultTrackerModule, {
    integrations: project.integrations,
  });
  registry.register(consoleNotifierModule, {
    integrations: project.integrations,
  });

  const scmIntegration =
    project.integrations?.scm?.type === "github"
      ? project.integrations.scm
      : project.integrations?.ticket_source?.type === "github"
        ? {
            type: "github" as const,
            config: project.integrations.ticket_source.config,
          }
        : null;
  if (scmIntegration?.type === "github") {
    const token = String(scmIntegration.config?.token ?? "").trim();
    const owner = String(scmIntegration.config?.owner ?? "").trim();
    const repo = String(scmIntegration.config?.repo ?? "").trim();
    if (token && owner && repo) {
      registry.register(githubSCMModule, { token, owner, repo });
    } else {
      console.warn("[sprintfoundry] SCM plugin github not registered: missing token/owner/repo");
    }
  }

  return registry;
}

program
  .name("sprintfoundry")
  .description("AI-powered multi-agent software development lifecycle")
  .version(version);

program
  .command("run")
  .description("Run the agent pipeline on a ticket or prompt")
  .requiredOption("--source <source>", "Ticket source: linear, github, jira, or prompt")
  .option("--ticket <id>", "Ticket ID (required for linear/github/jira)")
  .option("--prompt <text>", "Direct prompt text (required for source=prompt)")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
  .option("--dry-run", "Plan only — generate and print the execution plan without running agents")
  .option("--agent <agent>", "Run a single agent directly, bypassing SDLC orchestration (default: generic agent)")
  .option("--agent-file <path>", "Path to a YAML/JSON file defining a custom agent inline (used with --agent)")
  .addOption(new Option("--workflow-stage <stage>").hideHelp())
  .addOption(new Option("--workflow-branch <branch>").hideHelp())
  .addOption(new Option("--workflow-pr-url <url>").hideHelp())
  .action(async (opts) => {
    const source = opts.source as TaskSource;

    if (source === "prompt" && !opts.prompt) {
      console.error("Error: --prompt is required when --source is prompt");
      process.exit(1);
    }
    if (source !== "prompt" && !opts.ticket) {
      console.error("Error: --ticket is required when --source is not prompt");
      process.exit(1);
    }

    const { platform, project } = await loadConfig(opts.config, opts.project);
    await validateAgentSandboxWholeRunHosting(platform);
    const eventSinkClient = resolveEventSinkClient(project);
    const registry = buildPluginRegistry(platform, project);
    const executionBackendName = resolveExecutionBackendName(platform, project);
    const executionBackend = createExecutionBackend(platform, project);
    const service = new OrchestrationService(platform, project, registry, executionBackend);
    const directAgent = opts.agent || resolveDefaultDirectAgent(platform, project);
    const directAgentWasDefaulted = !opts.agent && Boolean(directAgent);

    const ticketId = opts.ticket ?? `prompt-${Date.now()}`;
    const sessionManager = new SessionManager(undefined, eventSinkClient);
    let currentRunId = process.env.SPRINTFOUNDRY_RUN_ID?.trim() || "";
    let shuttingDown = false;
    const markCancelledAndExit = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const exitCode = signal === "SIGINT" ? 130 : 143;
      void (async () => {
        if (currentRunId) {
          try {
            const session = await sessionManager.get(currentRunId);
            const updated = await sessionManager.updateStatus(currentRunId, "cancelled");
            if (updated && session?.workspace_path) {
              const events = new EventStore(platform.events_dir, eventSinkClient);
              await events.initialize(session.workspace_path);
              await events.store({
                event_id: `task-cancelled-${currentRunId}-${Date.now()}`,
                run_id: currentRunId,
                event_type: "task.cancelled",
                timestamp: new Date(),
                data: {
                  signal,
                  hosting_mode: session.hosting_mode ?? process.env.SPRINTFOUNDRY_HOSTING_MODE ?? null,
                  execution_backend: process.env.SPRINTFOUNDRY_EXECUTION_BACKEND ?? null,
                },
              });
              await events.close();
            }
            if (updated) {
              console.error(`[run] Received ${signal}; marked run ${currentRunId} as cancelled and emitted task.cancelled.`);
            } else {
              console.error(`[run] Received ${signal}; run ${currentRunId} session was not available for cancellation.`);
            }
          } catch (error) {
            console.error(
              `[run] Received ${signal}; failed to mark run ${currentRunId} as cancelled: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        } else {
          console.error(`[run] Received ${signal}; no run id was available to mark as cancelled.`);
        }
        process.exit(exitCode);
      })();
    };

    process.once("SIGINT", () => {
      markCancelledAndExit("SIGINT");
    });
    process.once("SIGTERM", () => {
      markCancelledAndExit("SIGTERM");
    });

    console.log(`Starting SprintFoundry run...`);
    console.log(`  Source: ${source}`);
    console.log(`  Ticket: ${ticketId}`);
    console.log(`  Project: ${project.name} (${project.project_id})`);
    console.log(`  Execution backend: ${executionBackendName}`);
    if (project.stack) console.log(`  Stack: ${project.stack}`);
    if (project.agents) console.log(`  Agents: ${project.agents.join(", ")}`);
    if (opts.dryRun) console.log(`  Mode: dry-run (plan only)`);
    if (directAgent) {
      console.log(
        `  Direct agent: ${directAgent}${directAgentWasDefaulted ? " (default)" : ""}${opts.agentFile ? ` (from ${opts.agentFile})` : ""}`
      );
    }
    console.log("  Tip: run `sprintfoundry monitor` in another terminal to watch live progress at http://127.0.0.1:4310/");
    console.log("");

    let run: TaskRun;
    const autoResumeExistingRun = isTruthy(process.env[AUTO_RESUME_ENV]);
    const envRunId = process.env.SPRINTFOUNDRY_RUN_ID?.trim();
    if (autoResumeExistingRun && envRunId) {
      const session = await new SessionManager().get(envRunId);
      const autoResumeAction = resolveAutoResumeAction(envRunId, session);
      if (autoResumeAction === "resume") {
        console.log(`Detected existing run state for ${envRunId}; attempting recovery/resume.`);
        currentRunId = envRunId;
        run = await service.resumeTask(envRunId, {
          allowInProgressRecovery: true,
        });
      } else if (autoResumeAction === "restart") {
        console.log(
          `Detected session for ${envRunId} without a workspace path; restarting the run with the same run_id.`
        );
        run = await service.handleTask(ticketId, source, opts.prompt, {
          dryRun: !!opts.dryRun,
          agent: directAgent,
          agentFile: opts.agentFile,
          workflowStage: opts.workflowStage,
          workflowBranch: opts.workflowBranch,
          workflowPrUrl: opts.workflowPrUrl,
        });
        currentRunId = run.run_id;
      } else {
        run = await service.handleTask(ticketId, source, opts.prompt, {
          dryRun: !!opts.dryRun,
          agent: directAgent,
          agentFile: opts.agentFile,
          workflowStage: opts.workflowStage,
          workflowBranch: opts.workflowBranch,
          workflowPrUrl: opts.workflowPrUrl,
        });
        currentRunId = run.run_id;
      }
    } else {
      run = await service.handleTask(ticketId, source, opts.prompt, {
        dryRun: !!opts.dryRun,
        agent: directAgent,
        agentFile: opts.agentFile,
        workflowStage: opts.workflowStage,
        workflowBranch: opts.workflowBranch,
        workflowPrUrl: opts.workflowPrUrl,
      });
      currentRunId = run.run_id;
    }

    console.log("");
    if (opts.dryRun) {
      console.log(`Dry-run complete. Execution plan:`);
      const plan = run.validated_plan ?? run.plan;
      if (plan) {
        console.log(`  Classification: ${plan.classification}`);
        console.log(`  Steps: ${plan.steps.length}`);
        for (const step of plan.steps) {
          console.log(`    ${step.step_number}. [${step.agent}] ${step.task.slice(0, 100)}`);
        }
      }
    } else {
      console.log(`Run complete.`);
      console.log(`  Status: ${run.status}`);
      console.log(`  Steps executed: ${run.steps.length}`);
      console.log(`  Total tokens: ${run.total_tokens_used.toLocaleString()}`);
      console.log(`  Total cost: $${run.total_cost_usd.toFixed(2)}`);
    }

    if (run.pr_url) {
      console.log(`  PR: ${run.pr_url}`);
    }
    if (run.error) {
      console.error(`  Error: ${run.error}`);
      process.exit(1);
    }
  });

program
  .command("validate")
  .description("Validate project configuration")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
  .option("--strict", "Fail when environment-backed config values resolve to empty strings")
  .action(async (opts) => {
    try {
      const { platform, project } = await loadConfig(opts.config, opts.project, {
        strictEnv: Boolean(opts.strict),
      });
      await validateAgentSandboxWholeRunHosting(platform);
      const executionBackendName = resolveExecutionBackendName(platform, project);
      const detectedProfile = resolvePreflightProfile(platform, project);
      console.log("Configuration valid.");
      console.log(`  Project: ${project.name} (${project.project_id})`);
      console.log(`  Execution backend: ${executionBackendName}`);
      console.log(`  Run profile: ${detectedProfile}`);
      console.log(`  Repo: ${project.repo.url}`);
      if (project.stack) console.log(`  Stack: ${project.stack}`);
      if (project.agents) console.log(`  Agents: ${project.agents.join(", ")}`);
      console.log(`  Agents defined: ${platform.agent_definitions.length}`);
      console.log(`  Platform rules: ${platform.rules.length}`);
      console.log(`  Project rules: ${project.rules.length}`);
      console.log(`  Budget: $${platform.defaults.budgets.per_task_max_cost_usd}/task`);
      if (platform.events_dir) console.log(`  Events dir: ${platform.events_dir}`);
    } catch (err) {
      console.error("Configuration error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program
  .command("review")
  .description("Record a human review decision for a pending gate")
  .requiredOption("--workspace <path>", "Workspace path for the run")
  .requiredOption("--review-id <id>", "Review ID to resolve")
  .requiredOption("--decision <decision>", "approved or rejected")
  .option("--feedback <text>", "Optional reviewer feedback")
  .action(async (opts) => {
    const decision = String(opts.decision);
    if (decision !== "approved" && decision !== "rejected") {
      console.error("Error: --decision must be either 'approved' or 'rejected'");
      process.exit(1);
    }

    const reviewDir = path.join(opts.workspace, ".sprintfoundry", "reviews");
    await fs.mkdir(reviewDir, { recursive: true });
    const decisionPath = path.join(reviewDir, `${opts.reviewId}.decision.json`);
    await fs.writeFile(
      decisionPath,
      JSON.stringify(
        {
          status: decision,
          reviewer_feedback: opts.feedback ?? "",
          decided_at: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf-8"
    );
    console.log(`Review decision written: ${decisionPath}`);
  });

program
  .command("resume [id]")
  .description("Resume a failed/cancelled run from the last failed step or a specific step")
  .option("--latest", "Resume the most recent failed or cancelled run")
  .option("--step <number>", "Step number to resume from")
  .option("--prompt <text>", "Additional operator prompt for the resumed step")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
  .action(async (id, opts) => {
    if (!id && !opts.latest) {
      console.error("Error: provide a run id or use --latest");
      process.exit(1);
    }
    if (id && opts.latest) {
      console.error("Error: use either a run id or --latest, not both");
      process.exit(1);
    }
    const step =
      opts.step !== undefined
        ? Number.parseInt(String(opts.step), 10)
        : undefined;
    if (opts.step !== undefined && (!Number.isInteger(step) || (step as number) <= 0)) {
      console.error("Error: --step must be a positive integer");
      process.exit(1);
    }

    const { platform, project } = await loadConfig(opts.config, opts.project);
    await validateAgentSandboxWholeRunHosting(platform);
    const registry = buildPluginRegistry(platform, project);
    const executionBackend = createExecutionBackend(platform, project);
    const service = new OrchestrationService(platform, project, registry, executionBackend);
    const sessionManager = new SessionManager();
    const targetRunId = opts.latest
      ? (await sessionManager.getLatestByStatus(["failed", "cancelled"], { projectId: project.project_id }))?.run_id
      : String(id);

    if (!targetRunId) {
      console.error(`Error: no failed or cancelled runs were found for project ${project.project_id}.`);
      process.exit(1);
    }

    console.log(`Resuming run ${targetRunId}...`);
    if (step !== undefined) {
      console.log(`  Resume step: ${step}`);
    }
    if (opts.prompt) {
      console.log("  Operator prompt: provided");
    }

    const run = await service.resumeTask(targetRunId, {
      ...(step !== undefined ? { step } : {}),
      ...(opts.prompt ? { prompt: String(opts.prompt) } : {}),
    });

    console.log("");
    console.log(`Resume complete.`);
    console.log(`  Status: ${run.status}`);
    console.log(`  Steps executed: ${run.steps.length}`);
    console.log(`  Total tokens: ${run.total_tokens_used.toLocaleString()}`);
    console.log(`  Total cost: $${run.total_cost_usd.toFixed(2)}`);
    if (run.pr_url) {
      console.log(`  PR: ${run.pr_url}`);
    }
    if (run.error) {
      console.error(`  Error: ${run.error}`);
      process.exit(1);
    }
  });

program
  .command("logs <id>")
  .description("Show a run event timeline from the workspace event log")
  .action(async (id) => {
    const mgr = new SessionManager();
    const session = await mgr.get(String(id));
    if (!session) {
      console.error(`Session not found: ${id}`);
      process.exit(1);
    }
    if (!session.workspace_path) {
      console.error(`Run ${id} does not have a workspace path; logs are not available.`);
      process.exit(1);
    }

    const eventsPath = path.join(session.workspace_path, ".events.jsonl");
    const store = new EventStore();
    const events = await store.loadFromFile(eventsPath).catch(() => []);
    if (events.length === 0) {
      console.error(`No events found at ${eventsPath}`);
      process.exit(1);
    }

    console.log(`\n  Timeline: ${session.run_id}`);
    console.log(`  ${"─".repeat(80)}`);
    const startedAt = Date.parse(session.created_at);
    for (const event of events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())) {
      const timestamp = event.timestamp.toISOString().slice(11, 19);
      const elapsed = Number.isFinite(startedAt)
        ? formatDurationMs(event.timestamp.getTime() - startedAt)
        : "-";
      const summary = summarizeEventData(event.data);
      console.log(`  ${timestamp}  ${elapsed.padEnd(7)} [${event.event_type}]${summary ? ` ${summary}` : ""}`);
    }
    console.log("");
  });

program
  .command("snapshot-export <id>")
  .description("Export a terminal run workspace snapshot to durable storage")
  .action(async (id) => {
    const service = new RunSnapshotExportService();
    const result = await service.exportRun(String(id));
    console.log(`Snapshot export complete.`);
    console.log(`  Run: ${id}`);
    console.log(`  Bucket: ${result.durableSnapshot.bucket}`);
    console.log(`  Manifest: ${result.durableSnapshot.manifest_key}`);
    console.log(`  Archive: ${result.durableSnapshot.archive_key}`);
  });

program
  .command("restore <id>")
  .description("Restore a previously exported run snapshot into the local runs root")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
  .option("--destination <path>", "Explicit destination path for the restored workspace")
  .action(async (id, opts) => {
    const { project } = await loadConfig(opts.config, opts.project);
    const workspaceManager = new WorkspaceManager(project);
    const destination = String(opts.destination ?? "").trim() || workspaceManager.getPath(String(id));
    const store = new RunSnapshotStore();
    const result = await store.restoreRunSnapshot(
      {
        run_id: String(id),
        project_id: project.project_id,
      },
      destination
    );

    const eventSinkUrl = project.integrations?.event_sink?.url?.trim() || process.env.SPRINTFOUNDRY_EVENT_SINK_URL?.trim() || "";
    const internalApiToken = process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN?.trim() || undefined;
    const sinkClient = eventSinkUrl ? new EventSinkClient(eventSinkUrl, globalThis.fetch, internalApiToken) : undefined;
    const sessionManager = new SessionManager(undefined, sinkClient);
    const restoredAt = new Date().toISOString();
    const restoredSession = {
      ...result.session,
      workspace_path: destination,
      updated_at: restoredAt,
    };
    await sessionManager.upsertMetadata(restoredSession);
    const events = new EventStore(undefined, sinkClient);
    await events.initialize(destination);
    await events.store({
      event_id: `workspace-snapshot-restored-${id}-${Date.now()}`,
      run_id: String(id),
      event_type: "workspace.snapshot.restored",
      timestamp: new Date(restoredAt),
      data: {
        manifest_archive_key: result.manifest.archive_key,
        session_key: result.manifest.session_key,
        archive_key: result.manifest.archive_key,
        runtime_home_path: result.runtimeHomePath,
        compatibility_warnings: result.compatibilityWarnings,
      },
    });
    await events.close();

    console.log(`Snapshot restore complete.`);
    console.log(`  Run: ${id}`);
    console.log(`  Workspace: ${destination}`);
    if (result.runtimeHomePath) {
      console.log(`  Runtime home: ${result.runtimeHomePath}`);
    }
    console.log(`  Status: ${restoredSession.status}`);
    for (const warning of result.compatibilityWarnings) {
      console.log(`  Warning: ${warning}`);
    }
  });

program
  .command("snapshot-reconcile")
  .description("Reconcile terminal whole-run Kubernetes jobs and launch snapshot exporters")
  .option("--namespace <name>", "Kubernetes namespace to reconcile")
  .option("--once", "Run a single reconcile loop and exit")
  .option("--interval-ms <ms>", "Polling interval when running continuously", "5000")
  .action(async (opts) => {
    const controller = new K8sRunSnapshotController({
      namespace: opts.namespace ? String(opts.namespace) : undefined,
    });

    const runOnce = async () => {
      const summary = await controller.reconcileOnce();
      console.log(
        `[snapshot-reconcile] inspected=${summary.inspectedRuns} exporters_created=${summary.exportersCreated} pvc_cleanup_completed=${summary.pvcCleanupCompleted} failures=${summary.snapshotFailuresDetected}`
      );
    };

    if (opts.once) {
      await runOnce();
      return;
    }

    const intervalMs = Number.parseInt(String(opts.intervalMs ?? "5000"), 10);
    if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
      console.error("Error: --interval-ms must be a positive integer");
      process.exit(1);
    }

    let stopping = false;
    const shutdown = () => {
      stopping = true;
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    while (!stopping) {
      await runOnce();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  });

program
  .command("monitor")
  .description("Start the monitor web UI")
  .option("--port <port>", "Port to listen on", "4310")
  .action(async (opts) => {
    const { spawn } = await import("child_process");
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // Works for both: npm global install (dist/) and source (src/)
    const serverPath = path.resolve(__dirname, "../monitor/server.mjs");
    try {
      await fs.access(serverPath);
    } catch {
      console.error(`Monitor server not found at ${serverPath}`);
      console.error("If installed from source, run: pnpm monitor");
      process.exit(1);
    }
    console.log(`Starting monitor on http://127.0.0.1:${opts.port}/`);
    const proc = spawn("node", [serverPath, "--port", opts.port], { stdio: "inherit" });
    proc.on("exit", (code) => process.exit(code ?? 0));
  });

program
  .command("dispatch")
  .description("Start the dispatch controller API and queue consumer")
  .option("--port <port>", "Port to listen on", "4320")
  .option("--host <host>", "Host to bind", "0.0.0.0")
  .option("--config <dir>", "Config directory", "config")
  .action(async (opts) => {
    const port = Number.parseInt(String(opts.port ?? ""), 10);
    if (!Number.isInteger(port) || port <= 0) {
      console.error("Error: --port must be a positive integer");
      process.exit(1);
    }

    const runtime = await startDispatchControllerServer({
      port,
      host: String(opts.host ?? "0.0.0.0"),
      configDir: String(opts.config ?? "config"),
    });

    const bound = runtime.server.address();
    const boundPort = bound && typeof bound === "object" ? bound.port : port;
    const host = String(opts.host ?? "0.0.0.0");
    console.log(`Dispatch Controller listening on http://${host}:${boundPort}`);

    const shutdown = async () => {
      await runtime.close();
      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
  });

program
  .command("doctor")
  .description("Check that all SprintFoundry system dependencies are installed and configured")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
  .option("--profile <profile>", "Check a specific profile: local | distributed | k8s")
  .action(async (opts) => {
    try {
      const { platform, project } = await loadConfig(opts.config, opts.project);
      const profile = normalizeDoctorProfile(opts.profile) ?? resolvePreflightProfile(platform, project);
      const result = await runPreflight(platform, project, { profile });
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const monitorServerPath = path.resolve(__dirname, "../monitor/server.mjs");
      console.log("");
      console.log(`SprintFoundry Doctor (${result.profile})`);
      console.log("");
      for (const line of summarizePreflight(result)) {
        console.log(line);
      }
      try {
        await fs.access(monitorServerPath);
        console.log(`  [OK] Monitor assets       ${monitorServerPath}`);
      } catch {
        console.log(`  [FAIL] Monitor assets     missing ${monitorServerPath}`);
        console.log("         Fix: reinstall SprintFoundry or rebuild the repository.");
      }
      console.log("");
      if (hasFailingChecks(result)) {
        console.log("  Found failing checks. Fix these before running.\n");
        process.exit(1);
      }
      const warningCount = result.checks.filter((check) => check.severity === "warn").length;
      if (warningCount > 0) {
        console.log(`  Completed with ${warningCount} warning(s).\n`);
      } else {
        console.log("  All checks passed.\n");
      }
    } catch (error) {
      console.error(`Doctor failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

const projectCmd = new Command("project").description("Project management commands");

program
  .command("init")
  .description("Guided SprintFoundry setup")
  .option("--config <dir>", "Config directory", "config")
  .action(async (opts) => {
    await runProjectCreate(opts.config);
  });

projectCmd
  .command("create")
  .description("Interactively create a new project configuration")
  .option("--config <dir>", "Config directory", "config")
  .action(async (opts) => {
    await runProjectCreate(opts.config);
  });

program.addCommand(projectCmd);

const agentCmd = new Command("agent").description("Agent management commands");

agentCmd
  .command("create")
  .description("Interactively create a new custom agent definition")
  .option("--config <dir>", "Config directory", "config")
  .action(async (opts) => {
    await runAgentCreate(opts.config);
  });

program.addCommand(agentCmd);

// ---- Session management commands ----

program
  .command("sessions")
  .description("List all tracked run sessions")
  .option("--status <status>", "Filter by status (pending, planning, executing, completed, failed, cancelled)")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const mgr = new SessionManager();
    let sessions = await mgr.list();

    if (opts.status) {
      sessions = sessions.filter((s) => s.status === opts.status);
    }

    if (opts.json) {
      console.log(JSON.stringify(sessions, null, 2));
      return;
    }

    if (sessions.length === 0) {
      console.log("No sessions found.");
      return;
    }

    console.log(`\n  ${"RUN ID".padEnd(20)} ${"STATUS".padEnd(14)} ${"STEP".padEnd(7)} ${"COST".padEnd(10)} ${"TICKET".padEnd(20)} TITLE`);
    console.log(`  ${"─".repeat(20)} ${"─".repeat(14)} ${"─".repeat(7)} ${"─".repeat(10)} ${"─".repeat(20)} ${"─".repeat(30)}`);

    for (const s of sessions) {
      const step = s.total_steps > 0 ? `${s.current_step}/${s.total_steps}` : "-";
      const cost = `$${s.total_cost_usd.toFixed(2)}`;
      const title = s.ticket_title.length > 40 ? s.ticket_title.slice(0, 37) + "..." : s.ticket_title;
      console.log(
        `  ${s.run_id.padEnd(20)} ${s.status.padEnd(14)} ${step.padEnd(7)} ${cost.padEnd(10)} ${s.ticket_id.padEnd(20)} ${title}`
      );
    }
    console.log(`\n  ${sessions.length} session(s)\n`);
  });

program
  .command("session <id>")
  .description("Show details for a specific run session")
  .option("--json", "Output as JSON")
  .option("--activity", "Check agent activity state (reads Claude Code JSONL)")
  .action(async (id, opts) => {
    const mgr = new SessionManager();
    const session = await mgr.get(id);

    if (!session) {
      console.error(`Session not found: ${id}`);
      process.exit(1);
    }

    if (opts.json) {
      const output: Record<string, unknown> = { ...session };
      if (opts.activity && session.workspace_path) {
        output.activity = await getActivityState(session.workspace_path);
      }
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    console.log(`\n  Session: ${session.run_id}`);
    console.log(`  ${"─".repeat(50)}`);
    console.log(`  Status:         ${session.status}`);
    if (session.hosting_mode) {
      console.log(`  Hosting:        ${session.hosting_mode}`);
    }
    console.log(`  Project:        ${session.project_id}`);
    console.log(`  Ticket:         ${session.ticket_id} (${session.ticket_source})`);
    console.log(`  Title:          ${session.ticket_title}`);
    if (session.plan_classification) {
      console.log(`  Classification: ${session.plan_classification}`);
    }
    console.log(`  Steps:          ${session.current_step}/${session.total_steps}`);
    console.log(`  Tokens:         ${session.total_tokens.toLocaleString()}`);
    console.log(`  Cost:           $${session.total_cost_usd.toFixed(2)}`);
    if (session.terminal_workflow_state) {
      console.log(`  Terminal flow:  ${session.terminal_workflow_state}`);
    }
    if (session.workspace_path) {
      console.log(`  Workspace:      ${session.workspace_path}`);
    }
    if (session.branch) {
      console.log(`  Branch:         ${session.branch}`);
    }
    if (session.pr_url) {
      console.log(`  PR:             ${session.pr_url}`);
    }
    console.log(`  Created:        ${session.created_at}`);
    console.log(`  Updated:        ${session.updated_at}`);
    if (session.completed_at) {
      console.log(`  Completed:      ${session.completed_at}`);
    }
    if (session.error) {
      console.log(`  Error:          ${session.error}`);
    }
    if (session.durable_snapshot?.manifest_key) {
      console.log(`  Snapshot:       ${session.durable_snapshot.manifest_key}`);
    }

    if (opts.activity && session.workspace_path) {
      console.log(`\n  Agent Activity`);
      console.log(`  ${"─".repeat(50)}`);
      const activity = await getActivityState(session.workspace_path);
      console.log(`  State:          ${activity.state}`);
      if (activity.last_event_at) {
        console.log(`  Last event:     ${activity.last_event_at}`);
      }
      if (activity.elapsed_ms !== null) {
        console.log(`  Elapsed:        ${Math.round(activity.elapsed_ms / 1000)}s`);
      }
      if (activity.detail) {
        console.log(`  Detail:         ${activity.detail}`);
      }
    }

    console.log("");
  });

program
  .command("cancel <id>")
  .description("Mark a run session as cancelled")
  .action(async (id) => {
    const mgr = new SessionManager();
    const session = await mgr.get(id);

    if (!session) {
      console.error(`Session not found: ${id}`);
      process.exit(1);
    }

    if (session.status === "completed" || session.status === "cancelled") {
      console.log(`Session ${id} is already ${session.status}.`);
      return;
    }

    const updated = await mgr.updateStatus(id, "cancelled");
    if (updated) {
      console.log(`Session ${id} marked as cancelled.`);
    } else {
      console.error(`Failed to update session ${id}.`);
      process.exit(1);
    }
  });

const argv =
  process.argv[2] === "--"
    ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
    : process.argv;

program.parse(argv);

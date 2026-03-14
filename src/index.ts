#!/usr/bin/env node

import { Command } from "commander";
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

const RUN_SANDBOX_MODE_ENV = "SPRINTFOUNDRY_RUN_SANDBOX_MODE";
const WHOLE_RUN_SANDBOX_MODE = "k8s-whole-run";
const AUTO_RESUME_ENV = "SPRINTFOUNDRY_AUTO_RESUME_EXISTING_RUN";

function isTruthy(value: string | undefined): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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

  const ticketSource = project.integrations?.ticket_source;
  if (ticketSource?.type === "github") {
    const token = String(ticketSource.config?.token ?? "").trim();
    const owner = String(ticketSource.config?.owner ?? "").trim();
    const repo = String(ticketSource.config?.repo ?? "").trim();
    if (token && owner && repo) {
      registry.register(githubSCMModule, {
        token,
        owner,
        repo,
      });
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
    const registry = buildPluginRegistry(platform, project);
    const executionBackendName = resolveExecutionBackendName(platform, project);
    const executionBackend = createExecutionBackend(platform, project);
    const service = new OrchestrationService(platform, project, registry, executionBackend);
    const directAgent = opts.agent || resolveDefaultDirectAgent(platform, project);
    const directAgentWasDefaulted = !opts.agent && Boolean(directAgent);

    const ticketId = opts.ticket ?? `prompt-${Date.now()}`;
    const sessionManager = new SessionManager();
    let currentRunId = process.env.SPRINTFOUNDRY_RUN_ID?.trim() || "";
    let shuttingDown = false;
    const markCancelledAndExit = (signal: NodeJS.Signals) => {
      if (shuttingDown) return;
      shuttingDown = true;
      const exitCode = signal === "SIGINT" ? 130 : 143;
      void (async () => {
        if (currentRunId) {
          try {
            const updated = await sessionManager.updateStatus(currentRunId, "cancelled");
            if (updated) {
              console.error(`[run] Received ${signal}; marked run ${currentRunId} as cancelled.`);
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
        });
        currentRunId = run.run_id;
      } else {
        run = await service.handleTask(ticketId, source, opts.prompt, {
          dryRun: !!opts.dryRun,
          agent: directAgent,
          agentFile: opts.agentFile,
        });
        currentRunId = run.run_id;
      }
    } else {
      run = await service.handleTask(ticketId, source, opts.prompt, {
        dryRun: !!opts.dryRun,
        agent: directAgent,
        agentFile: opts.agentFile,
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
  .action(async (opts) => {
    try {
      const { platform, project } = await loadConfig(opts.config, opts.project);
      await validateAgentSandboxWholeRunHosting(platform);
      const executionBackendName = resolveExecutionBackendName(platform, project);
      console.log("Configuration valid.");
      console.log(`  Project: ${project.name} (${project.project_id})`);
      console.log(`  Execution backend: ${executionBackendName}`);
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
  .command("resume <id>")
  .description("Resume a failed/cancelled run from the last failed step or a specific step")
  .option("--step <number>", "Step number to resume from")
  .option("--prompt <text>", "Additional operator prompt for the resumed step")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
  .action(async (id, opts) => {
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

    console.log(`Resuming run ${id}...`);
    if (step !== undefined) {
      console.log(`  Resume step: ${step}`);
    }
    if (opts.prompt) {
      console.log("  Operator prompt: provided");
    }

    const run = await service.resumeTask(id, {
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

    const sessionManager = new SessionManager();
    const restoredAt = new Date().toISOString();
    const restoredSession = {
      ...result.session,
      workspace_path: destination,
      updated_at: restoredAt,
    };
    await sessionManager.upsertMetadata(restoredSession);

    console.log(`Snapshot restore complete.`);
    console.log(`  Run: ${id}`);
    console.log(`  Workspace: ${destination}`);
    console.log(`  Status: ${restoredSession.status}`);
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
  .action(async (opts) => {
    const { execFile } = await import("child_process");
    const os = await import("os");
    const { promisify } = await import("util");
    const exec = promisify(execFile);

    type Severity = "pass" | "warn" | "fail";
    type Check = { severity: Severity; label: string; detail: string };
    const checks: Check[] = [];

    const add = (severity: Severity, label: string, detail: string) => {
      checks.push({ severity, label, detail });
    };

    const run = async (cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }> => {
      try {
        const { stdout } = await exec(cmd, args, { timeout: 5000 });
        return { ok: true, stdout: stdout.trim() };
      } catch {
        return { ok: false, stdout: "" };
      }
    };

    const nodeVer = process.version;
    const nodeMajor = parseInt(nodeVer.slice(1).split(".")[0], 10);
    if (nodeMajor >= 20) {
      add("pass", "Node.js", `${nodeVer} (required: >=20)`);
    } else {
      add("fail", "Node.js", `${nodeVer} (requires >=20)`);
    }

    const gitVer = await run("git", ["--version"]);
    add(gitVer.ok ? "pass" : "fail", "Git", gitVer.ok ? gitVer.stdout : "not found in PATH");

    const npmVer = await run("npm", ["--version"]);
    add(npmVer.ok ? "pass" : "warn", "npm", npmVer.ok ? `v${npmVer.stdout}` : "not found (needed for npm install flow)");

    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const monitorServerPath = path.resolve(__dirname, "../monitor/server.mjs");
    try {
      await fs.access(monitorServerPath);
      add("pass", "Monitor assets", `found ${monitorServerPath}`);
    } catch {
      add("fail", "Monitor assets", `missing ${monitorServerPath}`);
    }

    try {
      const runsRoot = path.join(
        process.env.SPRINTFOUNDRY_RUNS_ROOT || os.tmpdir(),
        "sprintfoundry-doctor-write-test"
      );
      await fs.mkdir(runsRoot, { recursive: true });
      await fs.writeFile(path.join(runsRoot, ".doctor"), "ok", "utf-8");
      add("pass", "Runs root writable", runsRoot);
    } catch (err) {
      add("fail", "Runs root writable", err instanceof Error ? err.message : String(err));
    }

    let platform: PlatformConfig | null = null;
    let project: ProjectConfig | null = null;
    try {
      const loaded = await loadConfig(opts.config, opts.project);
      platform = loaded.platform;
      project = loaded.project;
      add("pass", "Config load", `project=${project.project_id} config_dir=${opts.config}`);
    } catch (err) {
      add(
        "warn",
        "Config load",
        `could not load config (${err instanceof Error ? err.message : String(err)})`
      );
    }

    const anthropicKey = process.env.SPRINTFOUNDRY_ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY;
    const openaiKey =
      process.env.SPRINTFOUNDRY_OPENAI_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.AGENTSDLC_OPENAI_KEY;

    let needsClaudeCli = false;
    let needsCodexCli = false;
    let needsAnthropicKey = false;
    let needsOpenaiKey = false;
    let needsDocker = false;

    const applyRuntimeNeeds = (rt: RuntimeConfig) => {
      if (rt.provider === "claude-code") {
        if (rt.mode === "local_process") needsClaudeCli = true;
        if (rt.mode === "local_sdk") needsAnthropicKey = true;
      } else if (rt.provider === "codex") {
        if (rt.mode === "local_process") needsCodexCli = true;
        if (rt.mode === "local_sdk") needsOpenaiKey = true;
      }
    };

    if (platform && project) {
      const executionBackendName = resolveExecutionBackendName(platform, project);
      if (executionBackendName === "docker") {
        needsDocker = true;
      }
      const byAgent = platform.defaults.runtime_per_agent ?? {};
      const agentRoleById = new Map(
        platform.agent_definitions.map((a) => [a.type, a.role] as const)
      );
      const fallbackRuntime: RuntimeConfig = {
        provider: "claude-code",
        mode: "local_process",
      };

      const resolveRuntime = (agentId: string): RuntimeConfig => {
        return (
          project!.runtime_overrides?.[agentId] ??
          byAgent[agentId] ??
          byAgent[agentRoleById.get(agentId) ?? ""] ??
          fallbackRuntime
        );
      };

      const configuredAgents =
        project.agents && project.agents.length > 0
          ? project.agents
          : platform.agent_definitions.map((a) => a.type);

      for (const agentId of configuredAgents) {
        applyRuntimeNeeds(resolveRuntime(agentId));
      }

      applyRuntimeNeeds(
        project.planner_runtime_override ??
        platform.defaults.planner_runtime ?? {
          provider: "claude-code",
          mode: "local_process",
        }
      );

      const ticketType = project.integrations?.ticket_source?.type;
      if (ticketType === "github" && !process.env.GITHUB_TOKEN && !project.repo.token) {
        add(
          "warn",
          "GitHub auth",
          "ticket source is github but GITHUB_TOKEN/repo.token is not set"
        );
      }
    } else {
      // Conservative defaults when config cannot be loaded.
      needsClaudeCli = true;
      needsAnthropicKey = true;
    }

    if (needsClaudeCli) {
      const claudeVer = await run("claude", ["--version"]);
      add(
        claudeVer.ok ? "pass" : "fail",
        "Claude CLI",
        claudeVer.ok ? claudeVer.stdout : "required by runtime but not found in PATH"
      );
    } else {
      add("pass", "Claude CLI", "not required by current runtime config");
    }

    if (needsCodexCli) {
      const codexVer = await run("codex", ["--version"]);
      add(
        codexVer.ok ? "pass" : "fail",
        "Codex CLI",
        codexVer.ok ? codexVer.stdout : "required by runtime but not found in PATH"
      );
    } else {
      add("pass", "Codex CLI", "not required by current runtime config");
    }

    if (needsDocker) {
      const dockerBin = await run("docker", ["--version"]);
      if (!dockerBin.ok) {
        add("fail", "Docker", "required by docker execution backend but docker is not installed");
      } else {
        const dockerDaemon = await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
        add(
          dockerDaemon.ok ? "pass" : "fail",
          "Docker daemon",
          dockerDaemon.ok
            ? `running (server ${dockerDaemon.stdout})`
            : "docker installed but daemon is not reachable"
        );
      }
    } else {
      const dockerBin = await run("docker", ["--version"]);
      add(
        dockerBin.ok ? "pass" : "warn",
        "Docker",
        dockerBin.ok ? "installed (optional for current config)" : "not installed (optional)"
      );
    }

    if (needsAnthropicKey) {
      add(
        anthropicKey ? "pass" : "fail",
        "Anthropic key",
        anthropicKey
          ? "set (SPRINTFOUNDRY_ANTHROPIC_KEY/ANTHROPIC_API_KEY)"
          : "missing but required for claude-code runtime"
      );
    } else {
      add("pass", "Anthropic key", anthropicKey ? "set" : "not required by current runtime config");
    }

    if (needsOpenaiKey) {
      add(
        openaiKey ? "pass" : "fail",
        "OpenAI key",
        openaiKey
          ? "set (SPRINTFOUNDRY_OPENAI_KEY/OPENAI_API_KEY)"
          : "missing but required for codex runtime"
      );
    } else {
      add("pass", "OpenAI key", openaiKey ? "set" : "not required by current runtime config");
    }

    console.log("\nSprintFoundry Doctor\n");
    let failed = 0;
    let warned = 0;
    for (const c of checks) {
      const icon =
        c.severity === "pass" ? "[OK]" : c.severity === "warn" ? "[WARN]" : "[FAIL]";
      const label = c.label.padEnd(20);
      console.log(`  ${icon} ${label} ${c.detail}`);
      if (c.severity === "fail") failed += 1;
      if (c.severity === "warn") warned += 1;
    }
    console.log("");
    if (failed === 0) {
      if (warned > 0) {
        console.log(`  Completed with ${warned} warning(s).\n`);
      } else {
        console.log("  All checks passed.\n");
      }
    } else {
      console.log(`  Found ${failed} failing check(s). Fix these before running.\n`);
      process.exit(1);
    }
  });

const projectCmd = new Command("project").description("Project management commands");

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

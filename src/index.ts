#!/usr/bin/env node

import { Command } from "commander";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import type { PlatformConfig, ProjectConfig, RuntimeConfig, TaskSource } from "./shared/types.js";
import { OrchestrationService } from "./service/orchestration-service.js";
import { loadConfig } from "./service/config-loader.js";
import { migrateEnvVars } from "./service/env-compat.js";
import { runProjectCreate } from "./commands/project-create.js";

// Migrate deprecated AGENTSDLC_* env vars to SPRINTFOUNDRY_*
migrateEnvVars();

const program = new Command();

program
  .name("sprintfoundry")
  .description("AI-powered multi-agent software development lifecycle")
  .version("0.2.1");

program
  .command("run")
  .description("Run the agent pipeline on a ticket or prompt")
  .requiredOption("--source <source>", "Ticket source: linear, github, jira, or prompt")
  .option("--ticket <id>", "Ticket ID (required for linear/github/jira)")
  .option("--prompt <text>", "Direct prompt text (required for source=prompt)")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
  .option("--dry-run", "Plan only — generate and print the execution plan without running agents")
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
    const service = new OrchestrationService(platform, project);

    const ticketId = opts.ticket ?? `prompt-${Date.now()}`;

    console.log(`Starting SprintFoundry run...`);
    console.log(`  Source: ${source}`);
    console.log(`  Ticket: ${ticketId}`);
    console.log(`  Project: ${project.name} (${project.project_id})`);
    if (project.stack) console.log(`  Stack: ${project.stack}`);
    if (project.agents) console.log(`  Agents: ${project.agents.join(", ")}`);
    if (opts.dryRun) console.log(`  Mode: dry-run (plan only)`);
    console.log("");

    const run = await service.handleTask(ticketId, source, opts.prompt, { dryRun: !!opts.dryRun });

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
      console.log("Configuration valid.");
      console.log(`  Project: ${project.name} (${project.project_id})`);
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

    const useContainers =
      String(process.env.SPRINTFOUNDRY_USE_CONTAINERS || "").toLowerCase() === "true";

    const applyRuntimeNeeds = (rt: RuntimeConfig) => {
      if (rt.provider === "claude-code") {
        if (rt.mode === "local_process") needsClaudeCli = true;
        if (rt.mode === "local_sdk" || rt.mode === "container") needsAnthropicKey = true;
        if (rt.mode === "container") needsDocker = true;
      } else if (rt.provider === "codex") {
        if (rt.mode === "local_process") needsCodexCli = true;
        if (rt.mode === "local_sdk") needsOpenaiKey = true;
      }
    };

    if (platform && project) {
      const byAgent = platform.defaults.runtime_per_agent ?? {};
      const agentRoleById = new Map(
        platform.agent_definitions.map((a) => [a.type, a.role] as const)
      );
      const fallbackRuntime: RuntimeConfig = {
        provider: "claude-code",
        mode: useContainers ? "container" : "local_process",
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
          mode: useContainers ? "container" : "local_process",
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
        add("fail", "Docker", "required by container runtime but docker is not installed");
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

const argv =
  process.argv[2] === "--"
    ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
    : process.argv;

program.parse(argv);

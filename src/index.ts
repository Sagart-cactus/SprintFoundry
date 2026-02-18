#!/usr/bin/env node

import { Command } from "commander";
import * as fs from "fs/promises";
import * as path from "path";
import type { TaskSource } from "./shared/types.js";
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
  .version("0.1.0");

program
  .command("run")
  .description("Run the agent pipeline on a ticket or prompt")
  .requiredOption("--source <source>", "Ticket source: linear, github, jira, or prompt")
  .option("--ticket <id>", "Ticket ID (required for linear/github/jira)")
  .option("--prompt <text>", "Direct prompt text (required for source=prompt)")
  .option("--config <dir>", "Config directory", "config")
  .option("--project <name>", "Project name (loads <name>.yaml or project-<name>.yaml)")
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
    console.log("");

    const run = await service.handleTask(ticketId, source, opts.prompt);

    console.log("");
    console.log(`Run complete.`);
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

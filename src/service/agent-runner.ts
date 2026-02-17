// ============================================================
// SprintFoundry — Agent Runner
// Spawns agent containers, manages execution, captures results
// ============================================================

import { spawn, type ChildProcess } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import type {
  AgentType,
  AgentResult,
  AgentCliFlags,
  ContainerResources,
  ModelConfig,
  ContextInput,
  PlatformConfig,
  ProjectConfig,
  RuntimeConfig,
} from "../shared/types.js";
import { RuntimeFactory } from "./runtime/runtime-factory.js";
import { CodexSkillManager } from "./runtime/codex-skill-manager.js";
import { parseTokenUsage as parseRuntimeTokenUsage } from "./runtime/process-utils.js";

export interface AgentRunConfig {
  stepNumber: number;
  stepAttempt: number;
  agent: AgentType;
  task: string;
  context_inputs: ContextInput[];
  workspacePath: string;
  modelConfig: ModelConfig;
  apiKey: string;
  tokenBudget: number;
  timeoutMinutes: number;
  previousStepResults: {
    step_number: number;
    agent: AgentType;
    result: AgentResult;
  }[];
  plugins?: string[];
  cliFlags?: AgentCliFlags;
  containerResources?: ContainerResources;
}

interface WorkspacePrepResult {
  codexHomeDir?: string;
  codexSkillNames?: string[];
}

export interface AgentRunResult {
  agentResult: AgentResult;
  tokens_used: number;
  cost_usd: number;
  duration_seconds: number;
  container_id: string;
}

export class AgentRunner {
  private agentDir: string;
  private codexAgentDir: string;
  private projectRoot: string;
  private runtimeFactory: RuntimeFactory;
  private codexSkillManager: CodexSkillManager;

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig
  ) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.agentDir = path.resolve(__dirname, "../agents");
    this.codexAgentDir = path.resolve(__dirname, "../agents-codex");
    this.projectRoot = path.resolve(__dirname, "../..");
    this.runtimeFactory = new RuntimeFactory();
    this.codexSkillManager = new CodexSkillManager(
      platformConfig,
      projectConfig,
      this.projectRoot
    );
  }

  async run(config: AgentRunConfig): Promise<AgentRunResult> {
    const startTime = Date.now();
    const runtime = this.resolveRuntime(config.agent);

    console.log(`[agent-runner] Running agent ${config.agent} (runtime: ${runtime.provider}/${runtime.mode})`);

    // 1. Prepare the workspace for this agent
    console.log(`[agent-runner] Preparing workspace at ${config.workspacePath}...`);
    const prep = (await this.prepareWorkspace(config, runtime)) ?? {};

    // 3. Spawn runtime selected for this agent
    const agentDef = this.platformConfig.agent_definitions.find((d) => d.type === config.agent);
    const runtimeImpl = this.runtimeFactory.create(runtime);
    console.log(`[agent-runner] Spawning ${runtime.provider} runtime for ${config.agent}...`);
    const result = await runtimeImpl.runStep({
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
      plugins: this.resolvePluginPaths(config.plugins),
      cliFlags: config.cliFlags,
      containerResources: config.containerResources,
      runtime,
      containerImage: agentDef?.container_image,
      codexHomeDir: prep.codexHomeDir,
      codexSkillNames: prep.codexSkillNames,
    });

    console.log(`[agent-runner] Runtime completed for ${config.agent}. Reading result...`);

    // 4. Read the agent's result file
    const agentResult = await this.readAgentResult(config.workspacePath);

    const duration = (Date.now() - startTime) / 1000;

    return {
      agentResult,
      tokens_used: result.tokens_used,
      cost_usd: this.estimateCost(result.tokens_used, config.modelConfig),
      duration_seconds: duration,
      container_id: result.runtime_id,
    };
  }

  // ---- Workspace Preparation ----

  private async prepareWorkspace(
    config: AgentRunConfig,
    runtime: RuntimeConfig
  ): Promise<WorkspacePrepResult> {
    const workspacePath = config.workspacePath;

    const instructionSource =
      runtime.provider === "codex"
        ? path.join(this.codexAgentDir, config.agent, "CODEX.md")
        : path.join(this.agentDir, config.agent, "CLAUDE.md");
    const fallbackSource = path.join(this.agentDir, config.agent, "CLAUDE.md");
    const existingSource = await fs
      .access(instructionSource)
      .then(() => instructionSource)
      .catch(async () => {
        await fs.access(fallbackSource);
        return fallbackSource;
      });
    const primaryDest = runtime.provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
    const primaryDestPath = path.join(workspacePath, primaryDest);
    await fs.copyFile(existingSource, primaryDestPath);
    await fs.copyFile(existingSource, path.join(workspacePath, ".agent-profile.md"));

    // Write the task file
    const taskContent = this.buildTaskPrompt(config);
    await fs.writeFile(
      path.join(workspacePath, ".agent-task.md"),
      taskContent,
      "utf-8"
    );

    // Write previous step results as context
    if (config.previousStepResults.length > 0) {
      const contextDir = path.join(workspacePath, ".agent-context");
      await fs.mkdir(contextDir, { recursive: true });

      for (const prev of config.previousStepResults) {
        await fs.writeFile(
          path.join(contextDir, `step-${prev.step_number}-${prev.agent}.json`),
          JSON.stringify(prev.result, null, 2),
          "utf-8"
        );
      }
    }

    // Ensure artifacts directory exists
    await fs.mkdir(path.join(workspacePath, "artifacts"), { recursive: true });
    await fs.mkdir(path.join(workspacePath, "artifacts", "handoff"), { recursive: true });

    if (runtime.provider !== "codex") {
      return {};
    }

    const resolved = this.codexSkillManager.resolveForAgent(config.agent);
    if (!resolved.enabled) {
      return {};
    }

    const staged = await this.codexSkillManager.stageSkills(
      workspacePath,
      resolved.skillNames
    );

    if (staged.skillNames.length > 0) {
      await this.appendCodexSkillsSection(primaryDestPath, staged.skillNames);
    }

    return {
      codexHomeDir: staged.codexHomeDir,
      codexSkillNames: staged.skillNames,
    };
  }

  private async appendCodexSkillsSection(
    agentsPath: string,
    skillNames: string[]
  ): Promise<void> {
    const existing = await fs.readFile(agentsPath, "utf-8");
    const section = [
      "",
      "## Runtime Skills",
      "",
      "These Codex skills are available for this run:",
      ...skillNames.map((name) => `- ${name}`),
      "",
      "Use these skills when relevant to the assigned task.",
      "",
    ].join("\n");
    await fs.writeFile(agentsPath, `${existing}${section}`, "utf-8");
  }

  // ---- Task Prompt Building ----

  private buildTaskPrompt(config: AgentRunConfig): string {
    const sections: string[] = [];

    sections.push(`# Task for ${config.agent} Agent`);
    sections.push("");
    sections.push(`## Task Description`);
    sections.push(config.task);
    sections.push("");

    // Context inputs
    if (config.context_inputs.length > 0) {
      sections.push(`## Context`);
      for (const input of config.context_inputs) {
        switch (input.type) {
          case "ticket":
            sections.push(`- Read ticket details in \`.agent-task.md\``);
            break;
          case "file":
            sections.push(`- Relevant file: \`${input.path}\``);
            break;
          case "directory":
            sections.push(`- Relevant directory: \`${input.path}\``);
            break;
          case "step_output":
            sections.push(
              `- Output from step ${input.step_number}: see \`.agent-context/step-${input.step_number}-*.json\``
            );
            break;
          case "artifact":
            sections.push(`- Artifact: \`artifacts/${input.name}\``);
            break;
        }
      }
      sections.push("");
    }

    // Previous results summary
    if (config.previousStepResults.length > 0) {
      sections.push(`## Previous Steps`);
      for (const prev of config.previousStepResults) {
        sections.push(`### Step ${prev.step_number} (${prev.agent})`);
        sections.push(`Status: ${prev.result.status}`);
        sections.push(`Summary: ${prev.result.summary}`);
        if (prev.result.artifacts_created.length > 0) {
          sections.push(`Artifacts: ${prev.result.artifacts_created.join(", ")}`);
        }
        if (prev.result.issues.length > 0) {
          sections.push(`Issues: ${prev.result.issues.join("; ")}`);
        }
        sections.push("");
      }
    }

    // Result format instructions
    sections.push(`## Required Output`);
    sections.push(`When finished, write your results to \`.agent-result.json\` with this format:`);
    sections.push("```json");
    sections.push(JSON.stringify({
      status: "complete | needs_rework | blocked | failed",
      summary: "brief description of what you did",
      artifacts_created: ["list of files you created"],
      artifacts_modified: ["list of files you modified"],
      issues: ["any problems or concerns"],
      rework_reason: "if needs_rework, explain why",
      rework_target: "if needs_rework, which agent should fix it",
      metadata: {},
    }, null, 2));
    sections.push("```");

    return sections.join("\n");
  }

  // ---- CLI Args Builder (shared by both modes) ----

  private buildClaudeCliArgs(
    taskPrompt: string,
    config: AgentRunConfig
  ): string[] {
    const flags = config.cliFlags ?? {};
    const args: string[] = ["-p", taskPrompt];

    // Output format
    args.push("--output-format", flags.output_format ?? "json");

    // Skip permissions (default: true for autonomous operation)
    if (flags.skip_permissions !== false) {
      args.push("--dangerously-skip-permissions");
    }

    // Budget control (replaces invalid --max-turns)
    const budgetUsd = flags.max_budget_usd;
    if (budgetUsd !== undefined && budgetUsd > 0) {
      args.push("--max-budget-usd", String(budgetUsd));
    }

    // Plugin directories
    if (config.plugins && config.plugins.length > 0) {
      for (const plugin of config.plugins) {
        const pluginPath = path.resolve(this.projectRoot, "plugins", plugin);
        args.push("--plugin-dir", pluginPath);
      }
    }

    return args;
  }

  private resolvePluginPaths(plugins: string[] | undefined): string[] {
    if (!plugins || plugins.length === 0) return [];
    return plugins.map((p) => path.resolve(this.projectRoot, "plugins", p));
  }

  private resolveRuntime(agent: AgentType): RuntimeConfig {
    const override = this.projectConfig.runtime_overrides?.[agent];
    if (override) return override;

    const def = this.platformConfig.defaults.runtime_per_agent?.[agent];
    if (def) return def;

    const role = this.platformConfig.agent_definitions.find((d) => d.type === agent)?.role;
    if (role && this.platformConfig.defaults.runtime_per_agent?.[role]) {
      return this.platformConfig.defaults.runtime_per_agent[role];
    }

    const useContainer = process.env.SPRINTFOUNDRY_USE_CONTAINERS === "true";
    return {
      provider: "claude-code",
      mode: useContainer ? "container" : "local_process",
    };
  }

  // ---- Agent Spawning ----

  private async spawnAgent(
    config: AgentRunConfig,
    taskPrompt: string
  ): Promise<{ tokens_used: number; container_id: string }> {
    // Determine execution mode: container or local
    const useContainer = process.env.SPRINTFOUNDRY_USE_CONTAINERS === "true";

    if (useContainer) {
      return this.spawnContainer(config, taskPrompt);
    } else {
      return this.spawnLocalClaudeCode(config, taskPrompt);
    }
  }

  // -- Local mode: run Claude Code directly --

  private async spawnLocalClaudeCode(
    config: AgentRunConfig,
    taskPrompt: string
  ): Promise<{ tokens_used: number; container_id: string }> {
    return new Promise((resolve, reject) => {
      const args = this.buildClaudeCliArgs(taskPrompt, config);

      const proc = spawn("claude", args, {
        cwd: config.workspacePath,
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: config.apiKey,
          ANTHROPIC_MODEL: config.modelConfig.model,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      // Timeout enforcement
      const timeout = setTimeout(() => {
        proc.kill("SIGTERM");
        reject(new Error(`Agent ${config.agent} timed out after ${config.timeoutMinutes} minutes`));
      }, config.timeoutMinutes * 60 * 1000);

      proc.on("close", (code) => {
        clearTimeout(timeout);

        if (code !== 0) {
          reject(
            new Error(
              `Agent ${config.agent} exited with code ${code}. ${stderr.trim()}`
            )
          );
          return;
        }

        // Parse token usage from Claude Code output if available
        const tokensUsed = this.parseTokenUsage(stdout);

        resolve({
          tokens_used: tokensUsed,
          container_id: `local-${proc.pid}`,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // -- Container mode: run in Docker --

  private async spawnContainer(
    config: AgentRunConfig,
    taskPrompt: string
  ): Promise<{ tokens_used: number; container_id: string }> {
    const agentDef = this.platformConfig.agent_definitions.find(
      (d) => d.type === config.agent
    );
    if (!agentDef) {
      throw new Error(`No agent definition found for: ${config.agent}`);
    }

    const containerName = `sprintfoundry-${config.agent}-${Date.now()}`;
    const resources = config.containerResources ?? {};
    const flags = config.cliFlags ?? {};

    // Resolve plugin paths for volume mounts
    const pluginPaths = this.resolvePluginPaths(config.plugins);

    return new Promise((resolve, reject) => {
      const dockerArgs: string[] = [
        "run",
        "--name", containerName,
        "--rm",
        // Mount workspace
        "-v", `${config.workspacePath}:/workspace`,
        // Pass environment
        "-e", `ANTHROPIC_API_KEY=${config.apiKey}`,
        "-e", `ANTHROPIC_MODEL=${config.modelConfig.model}`,
        "-e", `AGENT_TYPE=${config.agent}`,
        // Pass CLI config as env vars for entrypoint.sh
        "-e", `AGENT_MAX_BUDGET=${flags.max_budget_usd ?? ""}`,
        "-e", `AGENT_OUTPUT_FORMAT=${flags.output_format ?? "json"}`,
        "-e", `AGENT_SKIP_PERMISSIONS=${flags.skip_permissions !== false ? "true" : "false"}`,
        // Resource limits (configurable)
        "--memory", resources.memory ?? "4g",
        "--cpus", resources.cpus ?? "2",
        // Network access
        "--network", resources.network ?? "bridge",
      ];

      // Mount plugin directories and pass as env var
      if (pluginPaths.length > 0) {
        const containerPluginDirs: string[] = [];
        for (const pluginPath of pluginPaths) {
          const pluginName = path.basename(pluginPath);
          const containerPath = `/plugins/${pluginName}`;
          dockerArgs.push("-v", `${pluginPath}:${containerPath}:ro`);
          containerPluginDirs.push(containerPath);
        }
        dockerArgs.push("-e", `AGENT_PLUGIN_DIRS=${containerPluginDirs.join(":")}`);
      }

      // Image
      dockerArgs.push(agentDef.container_image);

      const proc = spawn("docker", dockerArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      const timeout = setTimeout(() => {
        spawn("docker", ["kill", containerName]);
        reject(new Error(`Agent container ${config.agent} timed out`));
      }, config.timeoutMinutes * 60 * 1000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (code !== 0) {
          reject(
            new Error(
              `Agent container ${config.agent} exited with code ${code}`
            )
          );
          return;
        }
        const tokensUsed = this.parseTokenUsage(stdout);
        resolve({
          tokens_used: tokensUsed,
          container_id: containerName,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // ---- Result Reading ----

  private async readAgentResult(workspacePath: string): Promise<AgentResult> {
    const resultPath = path.join(workspacePath, ".agent-result.json");

    try {
      const content = await fs.readFile(resultPath, "utf-8");
      const parsed = JSON.parse(content);

      // Validate required fields
      if (!parsed.status || !parsed.summary) {
        return {
          status: "failed",
          summary: "Agent did not produce a valid result file",
          artifacts_created: [],
          artifacts_modified: [],
          issues: ["Missing required fields in .agent-result.json"],
          metadata: { raw_output: content },
        };
      }

      return parsed as AgentResult;
    } catch (error) {
      return {
        status: "failed",
        summary: "Agent did not produce a result file",
        artifacts_created: [],
        artifacts_modified: [],
        issues: [`Failed to read .agent-result.json: ${error}`],
        metadata: {},
      };
    }
  }

  // ---- Utilities ----

  private parseTokenUsage(output: string): number {
    return parseRuntimeTokenUsage(output);
  }

  private estimateCost(tokens: number, model: ModelConfig): number {
    // Rough cost estimation per 1M tokens
    const costPer1M: Record<string, number> = {
      "claude-sonnet-4-5-20250929": 3.0,    // input
      "claude-opus-4-5-20250929": 15.0,      // input
      "claude-haiku-4-5-20251001": 0.25,     // input
    };

    const rate = costPer1M[model.model] ?? 3.0;
    return (tokens / 1_000_000) * rate;
  }
}

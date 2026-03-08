// ============================================================
// SprintFoundry — Agent Runner
// Prepares agent workspaces, delegates step execution, captures results
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import type {
  AgentType,
  AgentResult,
  AgentCliFlags,
  ContainerResources,
  GuardrailConfig,
  ModelConfig,
  ContextInput,
  PlatformConfig,
  ProjectConfig,
  RuntimeConfig,
  RuntimeMetadataEnvelope,
} from "../shared/types.js";
import { RuntimeFactory } from "./runtime/runtime-factory.js";
import { CodexSkillManager } from "./runtime/codex-skill-manager.js";
import type { RuntimeActivityEvent } from "./runtime/types.js";
import type { EventSinkClient } from "./event-sink-client.js";
import {
  LocalExecutionBackend,
  type ExecutionBackend,
  type RunEnvironmentHandle,
} from "./execution/index.js";

export interface AgentRunConfig {
  runId: string;
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
  runEnvironment?: RunEnvironmentHandle;
  runtime?: RuntimeConfig;
  resolvedPluginPaths?: string[];
  containerImage?: string;
  codexHomeDir?: string;
  codexSkillNames?: string[];
  guardrails?: GuardrailConfig;
  resumeSessionId?: string;
  resumeReason?: string;
  onRuntimeActivity?: (event: RuntimeActivityEvent) => Promise<void> | void;
  sinkClient?: Pick<EventSinkClient, "postLog">;
}

interface WorkspacePrepResult {
  codexHomeDir?: string;
  codexSkillNames?: string[];
  runtimeSkillProvider?: RuntimeConfig["provider"];
  runtimeSkillsDir?: string;
  skillWarnings?: string[];
  skillHashes?: Record<string, string>;
}

export interface AgentRunResult {
  agentResult: AgentResult;
  tokens_used: number;
  cost_usd: number;
  duration_seconds: number;
  container_id: string;
  usage?: Record<string, number>;
  resume_used?: boolean;
  resume_failed?: boolean;
  resume_fallback?: boolean;
  token_savings?: Record<string, number>;
  runtime_metadata?: RuntimeMetadataEnvelope;
}

export class AgentRunner {
  private agentDir: string;
  private codexAgentDir: string;
  private projectRoot: string;
  private codexSkillManager: CodexSkillManager;
  private executionBackend: ExecutionBackend;

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig,
    executionBackend?: ExecutionBackend
  ) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.agentDir = path.resolve(__dirname, "../agents");
    this.codexAgentDir = path.resolve(__dirname, "../agents-codex");
    this.projectRoot = path.resolve(__dirname, "../..");
    this.codexSkillManager = new CodexSkillManager(
      platformConfig,
      projectConfig,
      this.projectRoot
    );
    this.executionBackend = executionBackend ?? new LocalExecutionBackend();
  }

  async run(config: AgentRunConfig): Promise<AgentRunResult> {
    const startTime = Date.now();
    const runtime = this.resolveRuntime(config.agent);

    console.log(`[agent-runner] Running agent ${config.agent} (runtime: ${runtime.provider}/${runtime.mode})`);

    // 1. Prepare the workspace for this agent
    console.log(`[agent-runner] Preparing workspace at ${config.workspacePath}...`);
    const prep = (await this.prepareWorkspace(config, runtime)) ?? {};

    const agentDef = this.platformConfig.agent_definitions.find((d) => d.type === config.agent);
    console.log(`[agent-runner] Spawning ${runtime.provider} runtime for ${config.agent}...`);
    const runEnvironment =
      config.runEnvironment
      ?? this.createFallbackRunEnvironment(config);
    const result = await this.executionBackend.executeStep(
      runEnvironment,
      this.toPlanStep(config),
      {
        ...config,
        runEnvironment,
        runtime,
        resolvedPluginPaths: this.resolvePluginPaths(config.plugins),
        containerImage: agentDef?.container_image,
        codexHomeDir: prep.codexHomeDir,
        codexSkillNames: prep.codexSkillNames,
        guardrails: this.resolveGuardrails(),
      }
    );

    if ((prep.codexSkillNames?.length ?? 0) > 0 || (prep.skillWarnings?.length ?? 0) > 0) {
      result.runtime_metadata = this.mergeSkillMetadata(result.runtime_metadata, prep);
    }

    console.log(`[agent-runner] Runtime completed for ${config.agent}. Reading result...`);

    // 4. Read the agent's result file
    const agentResult = await this.readAgentResult(config.workspacePath);
    agentResult.metadata = {
      ...(agentResult.metadata ?? {}),
      runtime: {
        usage: result.usage,
        resume_used: result.resume_used,
        resume_failed: result.resume_failed,
        resume_fallback: result.resume_fallback,
        token_savings: result.token_savings,
      },
      runtime_metadata: result.runtime_metadata,
    };
    await this.persistStepResultSnapshot(
      config.workspacePath,
      config.stepNumber,
      config.stepAttempt,
      config.agent,
      agentResult
    );

    const duration = (Date.now() - startTime) / 1000;
    const costUsd =
      result.cost_usd ?? this.estimateCost(result.tokens_used, config.modelConfig);

    return {
      agentResult,
      tokens_used: result.tokens_used,
      cost_usd: costUsd,
      duration_seconds: duration,
      container_id: result.container_id,
      usage: result.usage,
      resume_used: result.resume_used,
      resume_failed: result.resume_failed,
      resume_fallback: result.resume_fallback,
      token_savings: result.token_savings,
      runtime_metadata: result.runtime_metadata,
    };
  }

  private createFallbackRunEnvironment(config: AgentRunConfig): RunEnvironmentHandle {
    return {
      run_id: config.runId,
      project_id: this.projectConfig.project_id,
      sandbox_id: `local-${config.runId || config.stepNumber}`,
      execution_backend: "local",
      workspace_path: config.workspacePath,
      checkpoint_generation: 0,
      metadata: {},
    };
  }

  private toPlanStep(config: AgentRunConfig): import("../shared/types.js").PlanStep {
    return {
      step_number: config.stepNumber,
      agent: config.agent,
      task: config.task,
      context_inputs: config.context_inputs,
      depends_on: [],
      estimated_complexity: "medium",
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

    const resolved = this.codexSkillManager.resolveForAgent(
      config.agent,
      runtime.provider
    );
    if (!resolved.enabled) {
      return {};
    }
    for (const warning of resolved.warnings) {
      console.warn(`[agent-runner] Skill guardrail warning: ${warning}`);
    }

    const staged = await this.codexSkillManager.stageSkills(
      workspacePath,
      resolved.skillNames,
      runtime.provider
    );
    for (const warning of staged.warnings) {
      console.warn(`[agent-runner] Skill staging warning: ${warning}`);
    }

    if (staged.skillNames.length > 0) {
      await this.appendCodexSkillsSection(primaryDestPath, staged.skillNames);
    }

    return {
      codexHomeDir: runtime.provider === "codex" ? staged.codexHomeDir : undefined,
      codexSkillNames: staged.skillNames,
      runtimeSkillProvider: staged.runtimeProvider,
      runtimeSkillsDir: staged.skillsDir,
      skillWarnings: [...resolved.warnings, ...staged.warnings],
      skillHashes: staged.skillHashes,
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
      "These runtime skills are available for this run:",
      ...skillNames.map((name) => `- ${name}`),
      "",
      "Use these skills when relevant to the assigned task.",
      "",
    ].join("\n");
    await fs.writeFile(agentsPath, `${existing}${section}`, "utf-8");
  }

  private mergeSkillMetadata(
    runtimeMetadata: RuntimeMetadataEnvelope | undefined,
    prep: WorkspacePrepResult
  ): RuntimeMetadataEnvelope {
    const base: RuntimeMetadataEnvelope = runtimeMetadata ?? {
      schema_version: 1,
      runtime: {
        provider: prep.runtimeSkillProvider ?? "codex",
        mode: "local_process",
        runtime_id: "",
        step_attempt: 0,
      },
    };
    return {
      ...base,
      provider_metadata: {
        ...(base.provider_metadata ?? {}),
        skills: {
          names: prep.codexSkillNames ?? [],
          provider: prep.runtimeSkillProvider ?? "codex",
          skills_dir: prep.runtimeSkillsDir,
          warnings: prep.skillWarnings ?? [],
          hashes: prep.skillHashes ?? {},
        },
      },
    };
  }

  private resolveGuardrails(): GuardrailConfig | undefined {
    const defaults = this.platformConfig.defaults.guardrails;
    const overrides = this.projectConfig.guardrails;
    if (!defaults && !overrides) return undefined;
    return {
      deny_commands: overrides?.deny_commands ?? defaults?.deny_commands ?? [],
      deny_paths: overrides?.deny_paths ?? defaults?.deny_paths ?? [],
      allow_paths: overrides?.allow_paths ?? defaults?.allow_paths ?? [],
    };
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

    return {
      provider: "claude-code",
      mode: "local_process",
    };
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

  private async persistStepResultSnapshot(
    workspacePath: string,
    stepNumber: number,
    stepAttempt: number,
    agent: AgentType,
    result: AgentResult
  ): Promise<void> {
    const dir = path.join(workspacePath, ".sprintfoundry", "step-results");
    await fs.mkdir(dir, { recursive: true });
    const safeAgent = agent.replace(/[^a-z0-9_-]/gi, "-");
    const filePath = path.join(
      dir,
      `step-${stepNumber}.attempt-${stepAttempt}.${safeAgent}.json`
    );
    await fs.writeFile(filePath, JSON.stringify(result, null, 2), "utf-8");
  }

  // ---- Utilities ----

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

import * as path from "path";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import { query, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { AgentRuntime, RuntimeStepContext, RuntimeStepResult } from "./types.js";
import { runProcess, parseTokenUsage } from "./process-utils.js";
import type { RuntimeMetadataEnvelope } from "../../shared/types.js";

export class ClaudeCodeRuntime implements AgentRuntime {
  async runStep(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    await fs.mkdir(config.workspacePath, { recursive: true });
    if (config.runtime.mode === "container") {
      console.warn(
        "[sprintfoundry] Container mode is deprecated and will be removed in v0.3.0. " +
        "Use local_process instead."
      );
      return this.runContainer(config);
    }
    if (config.runtime.mode === "local_sdk") return this.runSdk(config);
    return this.runLocal(config);
  }

  private async runLocal(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    const args = this.buildCliArgs(config);
    const paths = this.buildLogPaths(config);
    await this.writeDebugFiles(paths, {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_mode: config.runtime.mode,
      runtime_provider: config.runtime.provider,
      runtime_command: "claude",
      model: config.modelConfig.model,
      api_key_present: Boolean(config.apiKey),
    });
    const result = await runProcess("claude", args, {
      cwd: config.workspacePath,
      env: {
        ...process.env,
        ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
        ANTHROPIC_MODEL: config.modelConfig.model,
        ...(config.runtime.env ?? {}),
      },
      timeoutMs: config.timeoutMinutes * 60 * 1000,
      parseTokensFromStdout: true,
      outputFiles: {
        stdoutPath: paths.stepStdoutPath,
        stderrPath: paths.stepStderrPath,
      },
    });
    await this.copyLatestLogs(paths.stepStdoutPath, paths.stepStderrPath, paths.latestStdoutPath, paths.latestStderrPath);
    const runtimeId = this.extractSessionIdFromOutput(result.stdout) ?? result.runtimeId;
    const runtimeMetadata = this.buildRuntimeMetadata(config, runtimeId, {
      resume: this.buildResumeMetadata(config),
      provider_metadata: {
        output_parsing: "jsonl",
        session_id_source: "stdout_json_line",
      },
    });
    return {
      tokens_used: result.tokensUsed,
      runtime_id: runtimeId,
      resume_used: runtimeMetadata.resume?.used,
      resume_failed: runtimeMetadata.resume?.failed,
      resume_fallback: runtimeMetadata.resume?.fallback_to_fresh,
      runtime_metadata: runtimeMetadata,
    };
  }

  private buildCliArgs(config: RuntimeStepContext): string[] {
    const flags = config.cliFlags ?? {};
    const taskPrompt = this.readTaskPrompt();
    const args: string[] = config.resumeSessionId
      ? ["--resume", config.resumeSessionId, "-p", taskPrompt]
      : ["-p", taskPrompt];
    args.push("--output-format", flags.output_format ?? "json");
    if (flags.skip_permissions !== false) {
      args.push("--dangerously-skip-permissions");
    }
    const budgetUsd = flags.max_budget_usd;
    if (budgetUsd !== undefined && budgetUsd > 0) {
      args.push("--max-budget-usd", String(budgetUsd));
    }
    if (config.plugins && config.plugins.length > 0) {
      for (const pluginPath of config.plugins) {
        args.push("--plugin-dir", pluginPath);
      }
    }
    return args;
  }

  private readTaskPrompt(): string {
    return `Read task details in .agent-task.md and follow CLAUDE.md.`;
  }

  private async runSdk(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    const paths = this.buildLogPaths(config);
    const prompts = await this.readPrompts(config.workspacePath);
    const flags = config.cliFlags ?? {};
    const env = {
      ...process.env,
      ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
      ANTHROPIC_MODEL: config.modelConfig.model,
      ...(config.runtime.env ?? {}),
    };
    await this.writeDebugFiles(paths, {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_mode: config.runtime.mode,
      runtime_provider: config.runtime.provider,
      runtime_command: "claude-sdk",
      model: config.modelConfig.model,
      api_key_present: Boolean(config.apiKey),
    });
    const timeoutMs = config.timeoutMinutes * 60 * 1000;
    const timeoutAbortController = new AbortController();
    const timeout = setTimeout(() => {
      timeoutAbortController.abort();
    }, timeoutMs);

    let runtimeId = `local-claude-sdk-${Date.now()}`;
    let stdout = "";
    let stderr = "";
    let finalResultMessage: SDKResultMessage | null = null;

    try {
      const queryOptions: Record<string, unknown> = {
        cwd: config.workspacePath,
        model: config.modelConfig.model,
        env,
        systemPrompt: prompts.systemPrompt,
        maxBudgetUsd:
          flags.max_budget_usd !== undefined && flags.max_budget_usd > 0
            ? flags.max_budget_usd
            : undefined,
        permissionMode: flags.skip_permissions !== false ? "bypassPermissions" : undefined,
        allowDangerouslySkipPermissions: flags.skip_permissions !== false ? true : undefined,
        plugins: config.plugins?.map((pluginPath) => ({ type: "local" as const, path: pluginPath })),
        abortController: timeoutAbortController,
        stderr: (data: string) => {
          stderr += data;
        },
      };
      if (config.resumeSessionId) {
        queryOptions.resume = config.resumeSessionId;
      }
      for await (const message of query({
        prompt: prompts.taskPrompt,
        options: queryOptions as any,
      })) {
        stdout += `${JSON.stringify(message)}\n`;
        if ("session_id" in message && typeof message.session_id === "string") {
          runtimeId = message.session_id;
        }
        if (message.type === "result") {
          finalResultMessage = message;
        }
      }
    } catch (error) {
      if (!timeoutAbortController.signal.aborted) {
        throw error;
      }
    } finally {
      clearTimeout(timeout);
      await Promise.all([
        fs.writeFile(paths.stepStdoutPath, stdout, "utf-8"),
        fs.writeFile(paths.stepStderrPath, stderr, "utf-8"),
      ]);
      await this.copyLatestLogs(paths.stepStdoutPath, paths.stepStderrPath, paths.latestStdoutPath, paths.latestStderrPath);
    }

    if (timeoutAbortController.signal.aborted && !finalResultMessage) {
      throw new Error("Process claude timed out");
    }
    if (!finalResultMessage) {
      throw new Error("Claude SDK did not return a result message");
    }
    if (finalResultMessage.subtype !== "success") {
      const details = finalResultMessage.errors.join("; ");
      throw new Error(`Process claude exited with code 1. ${details}`);
    }

    const usage = this.normalizeUsage(finalResultMessage.usage);
    const tokensUsed = this.tokensFromUsage(usage);
    const runtimeMetadata = this.buildRuntimeMetadata(config, runtimeId, {
      usage,
      billing: {
        cost_usd: finalResultMessage.total_cost_usd,
        cost_source: "runtime_reported",
      },
      resume: this.buildResumeMetadata(config),
      provider_metadata: {
        output_parsing: "sdk_stream",
        session_id_source: "sdk_message",
      },
    });
    return {
      tokens_used: tokensUsed,
      runtime_id: runtimeId,
      cost_usd: finalResultMessage.total_cost_usd,
      usage,
      resume_used: runtimeMetadata.resume?.used,
      resume_failed: runtimeMetadata.resume?.failed,
      resume_fallback: runtimeMetadata.resume?.fallback_to_fresh,
      runtime_metadata: runtimeMetadata,
    };
  }

  private async readPrompts(workspacePath: string): Promise<{ systemPrompt: string; taskPrompt: string }> {
    const [systemPrompt, taskPrompt] = await Promise.all([
      fs.readFile(path.join(workspacePath, "CLAUDE.md"), "utf-8"),
      fs.readFile(path.join(workspacePath, ".agent-task.md"), "utf-8"),
    ]);
    return { systemPrompt, taskPrompt };
  }

  private normalizeUsage(usage: Record<string, unknown>): Record<string, number> {
    const normalized: Record<string, number> = {};
    for (const [key, value] of Object.entries(usage)) {
      const num = this.toNumber(value);
      if (num !== null) {
        normalized[key] = num;
      }
    }
    return normalized;
  }

  private tokensFromUsage(usage: Record<string, number>): number {
    const total = usage.total_tokens;
    if (typeof total === "number" && Number.isFinite(total)) {
      return total;
    }
    const input = usage.input_tokens ?? usage.inputTokens ?? 0;
    const output = usage.output_tokens ?? usage.outputTokens ?? 0;
    return input + output;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    return null;
  }

  private extractSessionIdFromOutput(stdout: string): string | null {
    const trimmed = stdout.trim();
    if (!trimmed) return null;
    for (const line of trimmed.split(/\r?\n/)) {
      const candidate = this.extractSessionIdFromJson(line.trim());
      if (candidate) return candidate;
    }
    return this.extractSessionIdFromJson(trimmed);
  }

  private extractSessionIdFromJson(jsonText: string): string | null {
    if (!jsonText || (!jsonText.startsWith("{") && !jsonText.startsWith("["))) return null;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const sessionId = parsed["session_id"];
      if (typeof sessionId === "string" && sessionId.trim()) return sessionId;
      return null;
    } catch {
      return null;
    }
  }

  private async runContainer(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    const containerName = `sprintfoundry-${config.agent}-${Date.now()}`;
    const resources = config.containerResources ?? {};
    const flags = config.cliFlags ?? {};
    const image = config.runtime.image ?? config.containerImage;
    if (!image) throw new Error(`No container image configured for ${config.agent}`);

    const dockerArgs: string[] = [
      "run",
      "--name", containerName,
      "--rm",
      "-v", `${config.workspacePath}:/workspace`,
      "-e", `ANTHROPIC_API_KEY=${config.apiKey}`,
      "-e", `ANTHROPIC_MODEL=${config.modelConfig.model}`,
      "-e", `AGENT_TYPE=${config.agent}`,
      "-e", `AGENT_MAX_BUDGET=${flags.max_budget_usd ?? ""}`,
      "-e", `AGENT_OUTPUT_FORMAT=${flags.output_format ?? "json"}`,
      "-e", `AGENT_SKIP_PERMISSIONS=${flags.skip_permissions !== false ? "true" : "false"}`,
      "--memory", resources.memory ?? "4g",
      "--cpus", resources.cpus ?? "2",
      "--network", resources.network ?? "bridge",
    ];

    if (config.plugins && config.plugins.length > 0) {
      const containerPluginDirs: string[] = [];
      for (const pluginPath of config.plugins) {
        const pluginName = path.basename(pluginPath);
        const containerPath = `/plugins/${pluginName}`;
        dockerArgs.push("-v", `${pluginPath}:${containerPath}:ro`);
        containerPluginDirs.push(containerPath);
      }
      dockerArgs.push("-e", `AGENT_PLUGIN_DIRS=${containerPluginDirs.join(":")}`);
    }

    dockerArgs.push(image);
    const paths = this.buildLogPaths(config);
    await this.writeDebugFiles(paths, {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_mode: config.runtime.mode,
      runtime_provider: config.runtime.provider,
      runtime_command: "docker",
      container_name: containerName,
      image,
      model: config.modelConfig.model,
      api_key_present: Boolean(config.apiKey),
    });

    return new Promise((resolve, reject) => {
      const proc = spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        spawn("docker", ["kill", containerName]);
        void this.persistContainerLogs(paths, stdout, stderr).finally(() => {
          reject(new Error(`Agent container ${config.agent} timed out`));
        });
      }, config.timeoutMinutes * 60 * 1000);

      proc.on("close", (code) => {
        clearTimeout(timeout);
        void this.persistContainerLogs(paths, stdout, stderr).finally(() => {
          if (code !== 0) {
            reject(new Error(`Agent container ${config.agent} exited with code ${code}`));
            return;
          }
          const runtimeMetadata = this.buildRuntimeMetadata(config, containerName, {
            provider_metadata: {
              output_parsing: "container_stdout",
            },
          });
          resolve({
            tokens_used: parseTokenUsage(stdout),
            runtime_id: containerName,
            runtime_metadata: runtimeMetadata,
          });
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        void this.persistContainerLogs(paths, stdout, stderr).finally(() => {
          reject(err);
        });
      });
    });
  }

  private buildLogPaths(config: RuntimeStepContext) {
    const stepPrefix = `.claude-runtime.step-${config.stepNumber}.attempt-${config.stepAttempt}`;
    return {
      stepDebugPath: path.join(config.workspacePath, `${stepPrefix}.debug.json`),
      stepStdoutPath: path.join(config.workspacePath, `${stepPrefix}.stdout.log`),
      stepStderrPath: path.join(config.workspacePath, `${stepPrefix}.stderr.log`),
      latestDebugPath: path.join(config.workspacePath, ".claude-runtime.debug.json"),
      latestStdoutPath: path.join(config.workspacePath, ".claude-runtime.stdout.log"),
      latestStderrPath: path.join(config.workspacePath, ".claude-runtime.stderr.log"),
    };
  }

  private async writeDebugFiles(
    paths: { stepDebugPath: string; latestDebugPath: string },
    payload: Record<string, unknown>
  ): Promise<void> {
    const content = JSON.stringify(payload, null, 2);
    await Promise.all([
      fs.writeFile(paths.stepDebugPath, content, "utf-8"),
      fs.writeFile(paths.latestDebugPath, content, "utf-8"),
    ]);
  }

  private async copyLatestLogs(
    stepStdoutPath: string,
    stepStderrPath: string,
    latestStdoutPath: string,
    latestStderrPath: string
  ): Promise<void> {
    const stdout = await fs.readFile(stepStdoutPath, "utf-8").catch(() => "");
    const stderr = await fs.readFile(stepStderrPath, "utf-8").catch(() => "");
    await Promise.all([
      fs.writeFile(latestStdoutPath, stdout, "utf-8"),
      fs.writeFile(latestStderrPath, stderr, "utf-8"),
    ]);
  }

  private async persistContainerLogs(
    paths: {
      stepStdoutPath: string;
      stepStderrPath: string;
      latestStdoutPath: string;
      latestStderrPath: string;
    },
    stdout: string,
    stderr: string
  ): Promise<void> {
    await Promise.all([
      fs.writeFile(paths.stepStdoutPath, stdout, "utf-8"),
      fs.writeFile(paths.stepStderrPath, stderr, "utf-8"),
    ]);
    await this.copyLatestLogs(
      paths.stepStdoutPath,
      paths.stepStderrPath,
      paths.latestStdoutPath,
      paths.latestStderrPath
    );
  }

  private buildRuntimeMetadata(
    config: RuntimeStepContext,
    runtimeId: string,
    extras?: Omit<RuntimeMetadataEnvelope, "schema_version" | "runtime">
  ): RuntimeMetadataEnvelope {
    return {
      schema_version: 1,
      runtime: {
        provider: config.runtime.provider,
        mode: config.runtime.mode,
        runtime_id: runtimeId,
        step_attempt: config.stepAttempt,
      },
      ...extras,
    };
  }

  private buildResumeMetadata(config: RuntimeStepContext): RuntimeMetadataEnvelope["resume"] | undefined {
    if (!config.resumeSessionId) return undefined;
    return {
      requested: true,
      used: true,
      failed: false,
      fallback_to_fresh: false,
      source_session_id: config.resumeSessionId,
      reason: config.resumeReason,
    };
  }
}

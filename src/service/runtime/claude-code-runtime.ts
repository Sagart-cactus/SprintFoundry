import * as path from "path";
import { spawn } from "child_process";
import * as fs from "fs/promises";
import type { AgentRuntime, RuntimeStepContext, RuntimeStepResult } from "./types.js";
import { runProcess, parseTokenUsage } from "./process-utils.js";

export class ClaudeCodeRuntime implements AgentRuntime {
  async runStep(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    await fs.mkdir(config.workspacePath, { recursive: true });
    if (config.runtime.mode === "container") {
      return this.runContainer(config);
    }
    return this.runLocal(config);
  }

  private buildCliArgs(config: RuntimeStepContext): string[] {
    const flags = config.cliFlags ?? {};
    const taskPrompt = this.readTaskPrompt(config);
    const args: string[] = ["-p", taskPrompt];

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

  private readTaskPrompt(config: RuntimeStepContext): string {
    return `Read task details in .agent-task.md and follow CLAUDE.md.`;
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
      },
      timeoutMs: config.timeoutMinutes * 60 * 1000,
      parseTokensFromStdout: true,
      outputFiles: {
        stdoutPath: paths.stepStdoutPath,
        stderrPath: paths.stepStderrPath,
      },
    });
    await this.copyLatestLogs(paths.stepStdoutPath, paths.stepStderrPath, paths.latestStdoutPath, paths.latestStderrPath);
    return {
      tokens_used: result.tokensUsed,
      runtime_id: result.runtimeId,
    };
  }

  private async runContainer(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    const containerName = `agentsdlc-${config.agent}-${Date.now()}`;
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
          resolve({
            tokens_used: parseTokenUsage(stdout),
            runtime_id: containerName,
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
}

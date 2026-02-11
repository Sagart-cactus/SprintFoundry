import * as path from "path";
import { spawn } from "child_process";
import type { AgentRuntime, RuntimeStepContext, RuntimeStepResult } from "./types.js";
import { runProcess, parseTokenUsage } from "./process-utils.js";

export class ClaudeCodeRuntime implements AgentRuntime {
  async runStep(config: RuntimeStepContext): Promise<RuntimeStepResult> {
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
    const result = await runProcess("claude", args, {
      cwd: config.workspacePath,
      env: {
        ...process.env,
        ...(config.apiKey ? { ANTHROPIC_API_KEY: config.apiKey } : {}),
        ANTHROPIC_MODEL: config.modelConfig.model,
      },
      timeoutMs: config.timeoutMinutes * 60 * 1000,
      parseTokensFromStdout: true,
    });
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

    return new Promise((resolve, reject) => {
      const proc = spawn("docker", dockerArgs, { stdio: ["pipe", "pipe", "pipe"] });
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
          reject(new Error(`Agent container ${config.agent} exited with code ${code}`));
          return;
        }
        resolve({
          tokens_used: parseTokenUsage(stdout),
          runtime_id: containerName,
        });
      });

      proc.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }
}

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import type { PlatformConfig, ProjectConfig, RuntimeMetadataEnvelope } from "../../shared/types.js";
import type { AgentRunConfig, AgentRunResult } from "../agent-runner.js";
import { runProcess, parseTokenUsage } from "../runtime/process-utils.js";
import type { ExecutionBackend, RunEnvironmentHandle, SandboxTeardownReason } from "./backend.js";

export class DockerExecutionBackend implements ExecutionBackend {
  private projectRoot: string;

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig
  ) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.projectRoot = path.resolve(__dirname, "../../..");
  }

  async prepareRunEnvironment(
    run: import("../../shared/types.js").TaskRun,
    plan: import("../../shared/types.js").ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    const image = this.resolveSandboxImage(plan);
    const sandboxId = this.buildSandboxId(run.run_id);
    const result = await this.runDetachedContainer(sandboxId, image, workspacePath);
    const containerId = result.stdout.trim() || sandboxId;

    return {
      run_id: run.run_id,
      project_id: run.project_id,
      tenant_id: run.tenant_id,
      sandbox_id: sandboxId,
      execution_backend: "docker",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {
        image,
        container_id: containerId,
      },
    };
  }

  async executeStep(
    handle: RunEnvironmentHandle,
    _step: import("../../shared/types.js").PlanStep,
    config: AgentRunConfig
  ): Promise<AgentRunResult> {
    if (!config.runtime) {
      throw new Error("DockerExecutionBackend requires config.runtime");
    }
    if (config.runtime.provider !== "claude-code") {
      throw new Error(
        `DockerExecutionBackend does not support runtime provider '${config.runtime.provider}'`
      );
    }

    const envVars = this.buildStepEnv(config);
    const args = [
      "exec",
      "-w",
      "/workspace",
      ...envVars.flatMap(([key, value]) => ["-e", `${key}=${value}`]),
      handle.sandbox_id,
      "sh",
      "-lc",
      `timeout ${Math.max(1, Math.ceil(config.timeoutMinutes * 60))}s /usr/local/bin/entrypoint.sh`,
    ];

    const result = await runProcess("docker", args, {
      cwd: config.workspacePath,
      env: process.env,
      timeoutMs: Math.max(5_000, Math.ceil(config.timeoutMinutes * 60 * 1000) + 5_000),
      parseTokensFromStdout: true,
    });

    return {
      agentResult: {
        status: "complete",
        summary: "",
        artifacts_created: [],
        artifacts_modified: [],
        issues: [],
        metadata: {},
      },
      tokens_used: parseTokenUsage(result.stdout),
      cost_usd: 0,
      duration_seconds: 0,
      container_id: handle.sandbox_id,
      runtime_metadata: this.buildRuntimeMetadata(config, handle),
    };
  }

  async pauseRun(handle: RunEnvironmentHandle): Promise<void> {
    await this.runDockerCommand(["pause", handle.sandbox_id], handle.workspace_path);
  }

  async resumeRun(handle: RunEnvironmentHandle): Promise<RunEnvironmentHandle> {
    const state = await this.inspectContainerState(handle);
    if (state === "running") {
      return {
        ...handle,
        checkpoint_generation: handle.checkpoint_generation + 1,
        metadata: {
          ...handle.metadata,
          recovery_action: "reattached",
        },
      };
    }

    const image = String(handle.metadata["image"] ?? "").trim();
    if (!image) {
      throw new Error(`Docker sandbox ${handle.sandbox_id} cannot be resumed because no image metadata was persisted`);
    }

    const result = await this.runDetachedContainer(handle.sandbox_id, image, handle.workspace_path);
    return {
      ...handle,
      checkpoint_generation: handle.checkpoint_generation + 1,
      metadata: {
        ...handle.metadata,
        container_id: result.stdout.trim() || handle.sandbox_id,
        recovery_action: "recreated",
      },
    };
  }

  async teardownRun(
    handle: RunEnvironmentHandle,
    _reason: SandboxTeardownReason
  ): Promise<void> {
    try {
      await this.runDockerCommand(["rm", "-f", handle.sandbox_id], handle.workspace_path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No such container/i.test(message)) return;
      throw error;
    }
  }

  private resolveSandboxImage(plan: import("../../shared/types.js").ExecutionPlan): string {
    const images = plan.steps
      .map((step) => this.platformConfig.agent_definitions.find((agent) => agent.type === step.agent)?.container_image)
      .filter((value): value is string => Boolean(value));

    const uniqueImages = [...new Set(images)];
    if (uniqueImages.length === 0) {
      throw new Error("DockerExecutionBackend requires at least one agent container image");
    }
    if (uniqueImages.length > 1) {
      console.warn(
        `[execution-backend] Docker sandbox uses image ${uniqueImages[0]} for all steps; plan referenced ${uniqueImages.length} images`
      );
    }
    return uniqueImages[0];
  }

  private async buildSharedMountArgs(): Promise<string[]> {
    const pluginsDir = path.join(this.projectRoot, "plugins");
    try {
      const stat = await fs.stat(pluginsDir);
      if (!stat.isDirectory()) return [];
      return ["-v", `${pluginsDir}:/opt/sprintfoundry/plugins:ro`];
    } catch {
      return [];
    }
  }

  private buildStepEnv(config: AgentRunConfig): Array<[string, string]> {
    const envVars: Array<[string, string]> = [
      ["ANTHROPIC_API_KEY", config.apiKey],
      ["ANTHROPIC_MODEL", config.modelConfig.model],
      ["AGENT_TYPE", config.agent],
      ["AGENT_OUTPUT_FORMAT", config.cliFlags?.output_format ?? "json"],
      ["AGENT_SKIP_PERMISSIONS", config.cliFlags?.skip_permissions !== false ? "true" : "false"],
    ];

    if (config.cliFlags?.max_budget_usd !== undefined) {
      envVars.push(["AGENT_MAX_BUDGET", String(config.cliFlags.max_budget_usd)]);
    }

    const pluginDirs = (config.resolvedPluginPaths ?? [])
      .map((pluginPath) => path.basename(pluginPath))
      .map((pluginName) => `/opt/sprintfoundry/plugins/${pluginName}`);
    if (pluginDirs.length > 0) {
      envVars.push(["AGENT_PLUGIN_DIRS", pluginDirs.join(":")]);
    }

    return envVars;
  }

  private buildRuntimeMetadata(
    config: AgentRunConfig,
    handle: RunEnvironmentHandle
  ): RuntimeMetadataEnvelope {
    return {
      schema_version: 1,
      runtime: {
        provider: config.runtime!.provider,
        mode: "container",
        runtime_id: handle.sandbox_id,
        step_attempt: config.stepAttempt,
      },
      provider_metadata: {
        execution_backend: "docker",
        sandbox_id: handle.sandbox_id,
        container_id: handle.metadata["container_id"],
        image: handle.metadata["image"],
      },
    };
  }

  private buildSandboxId(runId: string): string {
    const normalized = runId.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");
    return `sf-run-${normalized}`.slice(0, 63);
  }

  private async runDetachedContainer(
    sandboxId: string,
    image: string,
    workspacePath: string
  ): Promise<{ stdout: string }> {
    const args = [
      "run",
      "-d",
      "--name",
      sandboxId,
      "--rm",
      "-w",
      "/workspace",
      "-v",
      `${workspacePath}:/workspace`,
      ...await this.buildSharedMountArgs(),
      "--entrypoint",
      "sh",
      image,
      "-lc",
      "trap 'exit 0' TERM INT; while true; do sleep 3600; done",
    ];
    return runProcess("docker", args, {
      cwd: workspacePath,
      env: process.env,
      timeoutMs: 30_000,
    });
  }

  private async inspectContainerState(handle: RunEnvironmentHandle): Promise<"running" | "paused" | "missing" | "other"> {
    try {
      const result = await runProcess(
        "docker",
        ["inspect", "-f", "{{.State.Status}}", handle.sandbox_id],
        {
          cwd: handle.workspace_path,
          env: process.env,
          timeoutMs: 30_000,
        }
      );
      const state = result.stdout.trim().toLowerCase();
      if (state === "running") return "running";
      if (state === "paused") {
        await this.runDockerCommand(["unpause", handle.sandbox_id], handle.workspace_path);
        return "running";
      }
      return "other";
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/No such object|No such container|Error: No such/i.test(message)) {
        return "missing";
      }
      throw error;
    }
  }

  private async runDockerCommand(args: string[], cwd: string): Promise<void> {
    await runProcess("docker", args, {
      cwd,
      env: process.env,
      timeoutMs: 30_000,
    });
  }
}

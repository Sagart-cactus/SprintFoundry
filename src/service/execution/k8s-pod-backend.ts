import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import type {
  ExecutionPlan,
  PlanStep,
  PlatformConfig,
  ProjectConfig,
  RuntimeMetadataEnvelope,
  TaskRun,
} from "../../shared/types.js";
import type { AgentRunConfig, AgentRunResult } from "../agent-runner.js";
import { parseTokenUsage } from "../runtime/process-utils.js";
import type { ExecutionBackend, RunEnvironmentHandle, SandboxTeardownReason } from "./backend.js";

const require = createRequire(import.meta.url);

interface K8sPodClient {
  createPod(namespace: string, manifest: Record<string, unknown>): Promise<void>;
  waitForPodReady(namespace: string, podName: string): Promise<void>;
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: string[]
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  deletePod(namespace: string, podName: string): Promise<void>;
}

export class KubernetesPodExecutionBackend implements ExecutionBackend {
  private projectRoot: string;
  private client: K8sPodClient;
  private readonly namespace: string;

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig,
    client?: K8sPodClient
  ) {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    this.projectRoot = path.resolve(__dirname, "../../..");
    this.namespace = this.platformConfig.k8s?.namespace?.trim() || "default";
    this.client = client ?? this.createClient();
  }

  async prepareRunEnvironment(
    run: TaskRun,
    plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    const sandboxId = this.buildSandboxId(run.run_id);
    const image = this.resolveSandboxImage(plan);
    const manifest = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: sandboxId,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/name": "sprintfoundry-run-sandbox",
          "sprintfoundry.io/project-id": run.project_id,
          "sprintfoundry.io/run-id": run.run_id,
          ...(run.tenant_id ? { "sprintfoundry.io/tenant-id": run.tenant_id } : {}),
        },
      },
      spec: {
        restartPolicy: "Never",
        containers: [
          {
            name: "sandbox",
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-lc", "trap 'exit 0' TERM INT; while true; do sleep 3600; done"],
            volumeMounts: [
              { name: "workspace", mountPath: "/workspace" },
              ...(await this.buildPluginVolumeMounts()),
            ],
          },
        ],
        volumes: [
          { name: "workspace", emptyDir: {} },
          ...(await this.buildPluginVolumes()),
        ],
      },
    };

    await this.client.createPod(this.namespace, manifest);
    await this.client.waitForPodReady(this.namespace, sandboxId);

    return {
      run_id: run.run_id,
      project_id: run.project_id,
      tenant_id: run.tenant_id,
      sandbox_id: sandboxId,
      execution_backend: "k8s-pod",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {
        namespace: this.namespace,
        image,
        pod_name: sandboxId,
      },
    };
  }

  async executeStep(
    handle: RunEnvironmentHandle,
    _step: PlanStep,
    config: AgentRunConfig
  ): Promise<AgentRunResult> {
    if (!config.runtime) {
      throw new Error("KubernetesPodExecutionBackend requires config.runtime");
    }
    if (config.runtime.provider !== "claude-code") {
      throw new Error(
        `KubernetesPodExecutionBackend does not support runtime provider '${config.runtime.provider}'`
      );
    }

    const command = this.buildExecCommand(config);
    const result = await this.client.exec(this.namespace, handle.sandbox_id, "sandbox", command);
    if (result.code !== 0) {
      throw new Error(
        `Sandbox pod ${handle.sandbox_id} step execution failed with code ${result.code}. ${result.stderr.trim()}`
      );
    }

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

  async pauseRun(_handle: RunEnvironmentHandle): Promise<void> {
    console.warn("[execution-backend] KubernetesPodExecutionBackend does not support pause yet");
  }

  async resumeRun(handle: RunEnvironmentHandle): Promise<RunEnvironmentHandle> {
    console.warn("[execution-backend] KubernetesPodExecutionBackend does not support resume yet");
    return handle;
  }

  async teardownRun(
    handle: RunEnvironmentHandle,
    _reason: SandboxTeardownReason
  ): Promise<void> {
    await this.client.deletePod(this.namespace, handle.sandbox_id);
  }

  private createClient(): K8sPodClient {
    let k8sModule: any;
    try {
      k8sModule = require("@kubernetes/client-node");
    } catch (error) {
      throw new Error(
        `KubernetesPodExecutionBackend requires @kubernetes/client-node: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const kc = new k8sModule.KubeConfig();
    kc.loadFromDefault();
    const coreApi = kc.makeApiClient(k8sModule.CoreV1Api);
    const execClient = new k8sModule.Exec(kc);

    return {
      createPod: async (namespace, manifest) => {
        await coreApi.createNamespacedPod({ namespace, body: manifest });
      },
      waitForPodReady: async (namespace, podName) => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
          const phase = pod?.status?.phase ?? pod?.body?.status?.phase;
          const conditions = pod?.status?.conditions ?? pod?.body?.status?.conditions ?? [];
          const ready = Array.isArray(conditions) && conditions.some((condition: any) =>
            condition?.type === "Ready" && condition?.status === "True"
          );
          if (phase === "Running" && ready) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        throw new Error(`Timed out waiting for pod ${podName} to become ready`);
      },
      exec: async (namespace, podName, containerName, command) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let exitCode = 0;
        await execClient.exec(
          namespace,
          podName,
          containerName,
          command,
          {
            write: (chunk: Buffer | string) => {
              stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            },
          },
          {
            write: (chunk: Buffer | string) => {
              stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            },
          },
          null,
          false,
          (status: { status?: string; code?: number }) => {
            if (typeof status?.code === "number") {
              exitCode = status.code;
            } else if (status?.status === "Success") {
              exitCode = 0;
            }
          }
        );
        return {
          stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
          stderr: Buffer.concat(stderrChunks).toString("utf-8"),
          code: exitCode,
        };
      },
      deletePod: async (namespace, podName) => {
        try {
          await coreApi.deleteNamespacedPod({ name: podName, namespace });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return;
          throw error;
        }
      },
    };
  }

  private resolveSandboxImage(plan: ExecutionPlan): string {
    const images = plan.steps
      .map((step) => this.platformConfig.agent_definitions.find((agent) => agent.type === step.agent)?.container_image)
      .filter((value): value is string => Boolean(value));
    const uniqueImages = [...new Set(images)];
    if (uniqueImages.length === 0) {
      throw new Error("KubernetesPodExecutionBackend requires at least one agent container image");
    }
    if (uniqueImages.length > 1) {
      console.warn(
        `[execution-backend] Kubernetes pod sandbox uses image ${uniqueImages[0]} for all steps; plan referenced ${uniqueImages.length} images`
      );
    }
    return uniqueImages[0];
  }

  private async buildPluginVolumes(): Promise<Array<Record<string, unknown>>> {
    const pluginsDir = path.join(this.projectRoot, "plugins");
    try {
      const stat = await fs.stat(pluginsDir);
      if (!stat.isDirectory()) return [];
      return [
        {
          name: "plugins",
          hostPath: {
            path: pluginsDir,
            type: "Directory",
          },
        },
      ];
    } catch {
      return [];
    }
  }

  private async buildPluginVolumeMounts(): Promise<Array<Record<string, unknown>>> {
    const pluginsDir = path.join(this.projectRoot, "plugins");
    try {
      const stat = await fs.stat(pluginsDir);
      if (!stat.isDirectory()) return [];
      return [{ name: "plugins", mountPath: "/opt/sprintfoundry/plugins", readOnly: true }];
    } catch {
      return [];
    }
  }

  private buildExecCommand(config: AgentRunConfig): string[] {
    const exports = [
      `export ANTHROPIC_API_KEY=${this.shellEscape(config.apiKey)}`,
      `export ANTHROPIC_MODEL=${this.shellEscape(config.modelConfig.model)}`,
      `export AGENT_TYPE=${this.shellEscape(config.agent)}`,
      `export AGENT_OUTPUT_FORMAT=${this.shellEscape(config.cliFlags?.output_format ?? "json")}`,
      `export AGENT_SKIP_PERMISSIONS=${this.shellEscape(config.cliFlags?.skip_permissions !== false ? "true" : "false")}`,
    ];
    if (config.cliFlags?.max_budget_usd !== undefined) {
      exports.push(`export AGENT_MAX_BUDGET=${this.shellEscape(String(config.cliFlags.max_budget_usd))}`);
    }

    const pluginDirs = (config.resolvedPluginPaths ?? [])
      .map((pluginPath) => path.basename(pluginPath))
      .map((pluginName) => `/opt/sprintfoundry/plugins/${pluginName}`);
    if (pluginDirs.length > 0) {
      exports.push(`export AGENT_PLUGIN_DIRS=${this.shellEscape(pluginDirs.join(":"))}`);
    }

    const timeoutSeconds = Math.max(1, Math.ceil(config.timeoutMinutes * 60));
    return [
      "sh",
      "-lc",
      `${exports.join(" && ")} && timeout ${timeoutSeconds}s /usr/local/bin/entrypoint.sh`,
    ];
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
        execution_backend: "k8s-pod",
        namespace: this.namespace,
        pod_name: handle.sandbox_id,
        image: handle.metadata["image"],
      },
    };
  }

  private buildSandboxId(runId: string): string {
    const normalized = runId.toLowerCase().replace(/[^a-z0-9-.]+/g, "-");
    return `sf-pod-${normalized}`.slice(0, 63);
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }
}


import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { PassThrough } from "stream";
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
import { resolveHostingMode } from "../hosting-mode.js";

const require = createRequire(import.meta.url);

interface K8sPodClient {
  createServiceAccount(namespace: string, manifest: Record<string, unknown>): Promise<void>;
  createPvc(namespace: string, manifest: Record<string, unknown>): Promise<void>;
  createEgressPolicy(namespace: string, manifest: Record<string, unknown>): Promise<void>;
  createPod(namespace: string, manifest: Record<string, unknown>): Promise<void>;
  waitForPodReady(namespace: string, podName: string): Promise<void>;
  getPod(namespace: string, podName: string): Promise<Record<string, unknown> | null>;
  getPvc(namespace: string, pvcName: string): Promise<Record<string, unknown> | null>;
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: string[]
  ): Promise<{ stdout: string; stderr: string; code: number }>;
  deletePod(namespace: string, podName: string): Promise<void>;
  deletePvc(namespace: string, pvcName: string): Promise<void>;
  deleteServiceAccount(namespace: string, serviceAccountName: string): Promise<void>;
  deleteEgressPolicy(namespace: string, policyName: string): Promise<void>;
}

export class KubernetesPodExecutionBackend implements ExecutionBackend {
  private projectRoot: string;
  private client: K8sPodClient | null;
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
    this.client = client ?? null;
  }

  async prepareRunEnvironment(
    run: TaskRun,
    plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    const client = this.getClient();
    const provisioningTimingMs: Record<string, number> = {};
    const provisionStartedAt = Date.now();
    const sandboxId = this.buildSandboxId(run.run_id);
    const pvcName = `${sandboxId}-workspace`.slice(0, 63);
    const image = this.resolveSandboxImage(plan);
    const serviceAccountName = this.buildServiceAccountName(run.run_id);
    const secretProfile = run.secret_profile ?? this.platformConfig.k8s?.default_secret_profile ?? "default";
    const networkProfile = run.network_profile ?? this.platformConfig.k8s?.default_network_profile ?? "full-internet";
    const isolationLevel = run.isolation_level
      ?? this.platformConfig.k8s?.default_isolation_level
      ?? "hardened_isolated";
    const serviceAccountManifest = this.buildServiceAccountManifest(serviceAccountName);
    const pvcManifest = this.buildWorkspacePvcManifest(run, pvcName);
    const egressPolicy = this.buildEgressPolicyManifest(run, sandboxId, networkProfile);
    const manifest = await this.buildPodManifest(
      run,
      sandboxId,
      image,
      pvcName,
      serviceAccountName,
      secretProfile,
      isolationLevel
    );

    const serviceAccountStartedAt = Date.now();
    await client.createServiceAccount(this.namespace, serviceAccountManifest);
    provisioningTimingMs.service_account_create = Date.now() - serviceAccountStartedAt;

    const pvcStartedAt = Date.now();
    await client.createPvc(this.namespace, pvcManifest);
    provisioningTimingMs.workspace_volume_create = Date.now() - pvcStartedAt;
    try {
      if (egressPolicy) {
        const egressPolicyStartedAt = Date.now();
        await client.createEgressPolicy(this.namespace, egressPolicy);
        provisioningTimingMs.egress_policy_create = Date.now() - egressPolicyStartedAt;
      }
      const podCreateStartedAt = Date.now();
      await client.createPod(this.namespace, manifest);
      provisioningTimingMs.pod_create = Date.now() - podCreateStartedAt;
      const podReadyStartedAt = Date.now();
      await client.waitForPodReady(this.namespace, sandboxId);
      provisioningTimingMs.pod_ready_wait = Date.now() - podReadyStartedAt;
    } catch (error) {
      await this.safeDeleteEgressPolicy(this.buildEgressPolicyName(sandboxId));
      await this.safeDeleteServiceAccount(serviceAccountName);
      await this.safeDeletePvc(pvcName);
      throw error;
    }
    provisioningTimingMs.total = Date.now() - provisionStartedAt;

    return {
      run_id: run.run_id,
      project_id: run.project_id,
      tenant_id: run.tenant_id,
      sandbox_id: sandboxId,
      execution_backend: "k8s-pod",
      hosting_mode: resolveHostingMode({ explicitHostingMode: run.hosting_mode, executionBackend: "k8s-pod" }),
      workspace_path: workspacePath,
      workspace_volume_ref: pvcName,
      network_profile: networkProfile,
      secret_profile: secretProfile,
      isolation_level: isolationLevel,
      checkpoint_generation: 0,
      metadata: {
        namespace: this.namespace,
        image,
        pod_name: sandboxId,
        pvc_name: pvcName,
        service_account_name: serviceAccountName,
        egress_policy_name: egressPolicy ? this.buildEgressPolicyName(sandboxId) : undefined,
        resource_policy: this.resolvePodResources(),
        quota_scope: this.platformConfig.k8s?.quota_scope,
        provisioning_timing_ms: provisioningTimingMs,
      },
    };
  }

  async executeStep(
    handle: RunEnvironmentHandle,
    _step: PlanStep,
    config: AgentRunConfig
  ): Promise<AgentRunResult> {
    const client = this.getClient();
    if (!config.runtime) {
      throw new Error("KubernetesPodExecutionBackend requires config.runtime");
    }
    if (config.runtime.provider !== "claude-code") {
      throw new Error(
        `KubernetesPodExecutionBackend does not support runtime provider '${config.runtime.provider}'`
      );
    }

    const command = this.buildExecCommand(config);
    const result = await client.exec(this.namespace, handle.sandbox_id, "sandbox", command);
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
    const client = this.getClient();
    const pod = await client.getPod(this.namespace, handle.sandbox_id);
    if (pod) {
      const phase = this.readPodPhase(pod);
      if (phase === "Running" && this.isPodReady(pod)) {
        return {
          ...handle,
          checkpoint_generation: handle.checkpoint_generation + 1,
          metadata: {
            ...handle.metadata,
            recovery_action: "reattached",
          },
        };
      }
      throw new Error(
        `Sandbox pod ${handle.sandbox_id} is not resumable from phase '${phase || "unknown"}'`
      );
    }

    if (!handle.workspace_volume_ref) {
      throw new Error(
        `Sandbox pod ${handle.sandbox_id} is missing and no workspace PVC is available for recovery`
      );
    }

    const pvc = await client.getPvc(this.namespace, handle.workspace_volume_ref);
    if (!pvc) {
      throw new Error(
        `Sandbox pod ${handle.sandbox_id} is missing and PVC ${handle.workspace_volume_ref} was not found`
      );
    }

    const image = String(handle.metadata["image"] ?? "").trim();
    if (!image) {
      throw new Error(`Sandbox pod ${handle.sandbox_id} cannot be recreated because no image metadata was persisted`);
    }

    const manifest = await this.buildPodManifest(
      {
        run_id: handle.run_id,
        project_id: handle.project_id,
        tenant_id: handle.tenant_id,
        network_profile: handle.network_profile,
        secret_profile: handle.secret_profile,
        isolation_level: handle.isolation_level,
      } as TaskRun,
      handle.sandbox_id,
      image,
      handle.workspace_volume_ref,
      String(handle.metadata["service_account_name"] ?? this.buildServiceAccountName(handle.run_id)),
      handle.secret_profile ?? this.platformConfig.k8s?.default_secret_profile ?? "default",
      handle.isolation_level
        ?? this.platformConfig.k8s?.default_isolation_level
        ?? "hardened_isolated"
    );
    const egressPolicy = this.buildEgressPolicyManifest(
      {
        run_id: handle.run_id,
        project_id: handle.project_id,
        tenant_id: handle.tenant_id,
        network_profile: handle.network_profile,
      } as TaskRun,
      handle.sandbox_id,
      handle.network_profile ?? this.platformConfig.k8s?.default_network_profile ?? "full-internet"
    );
    if (egressPolicy) {
      await client.createEgressPolicy(this.namespace, egressPolicy);
    }
    await client.createPod(this.namespace, manifest);
    await client.waitForPodReady(this.namespace, handle.sandbox_id);
    return {
      ...handle,
      checkpoint_generation: handle.checkpoint_generation + 1,
      metadata: {
        ...handle.metadata,
        recovery_action: "recreated",
      },
    };
  }

  async teardownRun(
    handle: RunEnvironmentHandle,
    reason: SandboxTeardownReason
  ): Promise<void> {
    const client = this.getClient();
    await client.deletePod(this.namespace, handle.sandbox_id);
    // Preserve the workspace PVC for failed/cancelled runs so resume can recreate the pod.
    if (reason === "completed" && handle.workspace_volume_ref) {
      await this.safeDeletePvc(handle.workspace_volume_ref);
    }
    const egressPolicyName = String(handle.metadata["egress_policy_name"] ?? "");
    if (egressPolicyName) {
      await this.safeDeleteEgressPolicy(egressPolicyName);
    }
    const serviceAccountName = String(handle.metadata["service_account_name"] ?? "");
    if (reason === "completed" && serviceAccountName) {
      await this.safeDeleteServiceAccount(serviceAccountName);
    }
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
      createServiceAccount: async (namespace, manifest) => {
        await coreApi.createNamespacedServiceAccount({ namespace, body: manifest });
      },
      createPvc: async (namespace, manifest) => {
        await coreApi.createNamespacedPersistentVolumeClaim({ namespace, body: manifest });
      },
      createEgressPolicy: async (namespace, manifest) => {
        const customObjectsApi = kc.makeApiClient(k8sModule.CustomObjectsApi);
        await customObjectsApi.createNamespacedCustomObject({
          group: "cilium.io",
          version: "v2",
          namespace,
          plural: "ciliumnetworkpolicies",
          body: manifest,
        });
      },
      createPod: async (namespace, manifest) => {
        await coreApi.createNamespacedPod({ namespace, body: manifest });
      },
      waitForPodReady: async (namespace, podName) => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
          const resolvedPod = (pod?.body ?? pod) as Record<string, unknown>;
          if (this.readPodPhase(resolvedPod) === "Running" && this.isPodReady(resolvedPod)) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        throw new Error(`Timed out waiting for pod ${podName} to become ready`);
      },
      getPod: async (namespace, podName) => {
        try {
          const pod = await coreApi.readNamespacedPod({ name: podName, namespace });
          return (pod?.body ?? pod) as Record<string, unknown>;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return null;
          throw error;
        }
      },
      getPvc: async (namespace, pvcName) => {
        try {
          const pvc = await coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
          return (pvc?.body ?? pvc) as Record<string, unknown>;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return null;
          throw error;
        }
      },
      exec: async (namespace, podName, containerName, command) => {
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let exitCode = 0;
        const stdoutStream = new PassThrough();
        const stderrStream = new PassThrough();
        stdoutStream.on("data", (chunk: Buffer | string) => {
          stdoutChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        stderrStream.on("data", (chunk: Buffer | string) => {
          stderrChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        await execClient.exec(
          namespace,
          podName,
          containerName,
          command,
          stdoutStream,
          stderrStream,
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
      deletePvc: async (namespace, pvcName) => {
        try {
          await coreApi.deleteNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return;
          throw error;
        }
      },
      deleteServiceAccount: async (namespace, serviceAccountName) => {
        try {
          await coreApi.deleteNamespacedServiceAccount({ name: serviceAccountName, namespace });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return;
          throw error;
        }
      },
      deleteEgressPolicy: async (namespace, policyName) => {
        try {
          const customObjectsApi = kc.makeApiClient(k8sModule.CustomObjectsApi);
          await customObjectsApi.deleteNamespacedCustomObject({
            group: "cilium.io",
            version: "v2",
            namespace,
            plural: "ciliumnetworkpolicies",
            name: policyName,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return;
          throw error;
        }
      },
    };
  }

  private getClient(): K8sPodClient {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  private buildWorkspacePvcManifest(run: TaskRun, pvcName: string): Record<string, unknown> {
    const storageClassName = this.platformConfig.k8s?.workspace_storage_class?.trim();
    const storageSize = this.platformConfig.k8s?.workspace_size?.trim() || "10Gi";
    return {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name: pvcName,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/name": "sprintfoundry-run-workspace",
          "sprintfoundry.io/project-id": run.project_id,
          "sprintfoundry.io/run-id": run.run_id,
          ...(run.tenant_id ? { "sprintfoundry.io/tenant-id": run.tenant_id } : {}),
        },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: {
          requests: {
            storage: storageSize,
          },
        },
        ...(storageClassName ? { storageClassName } : {}),
      },
    };
  }

  private async buildPodManifest(
    run: TaskRun,
    sandboxId: string,
    image: string,
    pvcName: string,
    serviceAccountName: string,
    secretProfile: string,
    isolationLevel: NonNullable<RunEnvironmentHandle["isolation_level"]>
  ): Promise<Record<string, unknown>> {
    const projectedSecrets = this.resolveProjectedSecrets(secretProfile);
    const runtimeClassName = this.resolveRuntimeClassName(isolationLevel);
    return {
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
        serviceAccountName,
        automountServiceAccountToken: this.platformConfig.k8s?.automount_service_account_token ?? false,
        runtimeClassName,
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 1001,
          runAsGroup: 1001,
          fsGroup: 1001,
          seccompProfile: {
            type: "RuntimeDefault",
          },
        },
        containers: [
          {
            name: "sandbox",
            image,
            imagePullPolicy: "IfNotPresent",
            command: ["sh", "-lc", "trap 'exit 0' TERM INT; while true; do sleep 3600; done"],
            env: [
              { name: "SPRINTFOUNDRY_SECRET_PROFILE", value: secretProfile },
              { name: "SPRINTFOUNDRY_ISOLATION_LEVEL", value: isolationLevel },
            ],
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: false,
              capabilities: {
                drop: ["ALL"],
              },
            },
            resources: this.resolvePodResources(),
            volumeMounts: [
              { name: "workspace", mountPath: "/workspace" },
              ...(projectedSecrets.length > 0
                ? [{ name: "projected-secrets", mountPath: "/var/run/sprintfoundry/secrets", readOnly: true }]
                : []),
              ...(await this.buildPluginVolumeMounts()),
            ],
          },
        ],
        volumes: [
          {
            name: "workspace",
            persistentVolumeClaim: {
              claimName: pvcName,
            },
          },
          ...(projectedSecrets.length > 0
            ? [
                {
                  name: "projected-secrets",
                  projected: {
                    sources: projectedSecrets.map((secretName) => ({
                      secret: {
                        name: secretName,
                      },
                    })),
                  },
                },
              ]
            : []),
          ...(await this.buildPluginVolumes()),
        ],
      },
    };
  }

  private buildServiceAccountManifest(serviceAccountName: string): Record<string, unknown> {
    return {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: {
        name: serviceAccountName,
        namespace: this.namespace,
      },
      automountServiceAccountToken: this.platformConfig.k8s?.automount_service_account_token ?? false,
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
        mode: "local_process",
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

  private buildServiceAccountName(runId: string): string {
    const normalized = runId.toLowerCase().replace(/[^a-z0-9-.]+/g, "-");
    return `sf-sa-${normalized}`.slice(0, 63);
  }

  private buildEgressPolicyName(sandboxId: string): string {
    return `${sandboxId}-egress`.slice(0, 63);
  }

  private shellEscape(value: string): string {
    return `'${value.replace(/'/g, `'\"'\"'`)}'`;
  }

  private async safeDeletePvc(pvcName: string): Promise<void> {
    try {
      await this.getClient().deletePvc(this.namespace, pvcName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[execution-backend] Failed to delete PVC ${pvcName}: ${message}`);
    }
  }

  private async safeDeleteServiceAccount(serviceAccountName: string): Promise<void> {
    try {
      await this.getClient().deleteServiceAccount(this.namespace, serviceAccountName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[execution-backend] Failed to delete service account ${serviceAccountName}: ${message}`
      );
    }
  }

  private async safeDeleteEgressPolicy(policyName: string): Promise<void> {
    try {
      await this.getClient().deleteEgressPolicy(this.namespace, policyName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[execution-backend] Failed to delete egress policy ${policyName}: ${message}`);
    }
  }

  private readPodPhase(pod: Record<string, unknown>): string {
    const status = pod["status"];
    if (!status || typeof status !== "object") return "";
    return String((status as Record<string, unknown>)["phase"] ?? "");
  }

  private isPodReady(pod: Record<string, unknown>): boolean {
    const status = pod["status"];
    if (!status || typeof status !== "object") return false;
    const conditions = (status as Record<string, unknown>)["conditions"];
    if (!Array.isArray(conditions)) return false;
    return conditions.some((condition) => {
      if (!condition || typeof condition !== "object") return false;
      const record = condition as Record<string, unknown>;
      return record["type"] === "Ready" && record["status"] === "True";
    });
  }

  private resolveProjectedSecrets(secretProfile: string): string[] {
    const profiles = this.platformConfig.k8s?.secret_profiles ?? {};
    return profiles[secretProfile] ?? [];
  }

  private buildEgressPolicyManifest(
    run: TaskRun,
    sandboxId: string,
    networkProfile: string
  ): Record<string, unknown> | null {
    const provider = this.platformConfig.k8s?.network_policy_provider ?? "none";
    if (provider === "none") return null;
    if (provider !== "cilium-fqdn") {
      throw new Error(`Unsupported k8s network policy provider '${provider}'`);
    }

    const profile = this.platformConfig.k8s?.network_profiles?.[networkProfile];
    if (!profile) {
      throw new Error(`Unknown k8s network profile '${networkProfile}'`);
    }

    const egressRules: Record<string, unknown>[] = [];
    if (profile.allow_internet) {
      egressRules.push({
        toEntities: ["world"],
      });
    }
    if ((profile.fqdn_allowlist?.length ?? 0) > 0) {
      egressRules.push({
        toFQDNs: profile.fqdn_allowlist!.map((matchName) => ({ matchName })),
      });
    }
    if ((profile.cidr_allowlist?.length ?? 0) > 0) {
      egressRules.push({
        toCIDRSet: profile.cidr_allowlist!.map((cidr) => ({ cidr })),
      });
    }

    return {
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: {
        name: this.buildEgressPolicyName(sandboxId),
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/name": "sprintfoundry-run-egress",
          "sprintfoundry.io/project-id": run.project_id,
          "sprintfoundry.io/run-id": run.run_id,
          ...(run.tenant_id ? { "sprintfoundry.io/tenant-id": run.tenant_id } : {}),
        },
      },
      spec: {
        endpointSelector: {
          matchLabels: {
            "sprintfoundry.io/run-id": run.run_id,
          },
        },
        egress: egressRules,
      },
    };
  }

  private resolveRuntimeClassName(
    isolationLevel: NonNullable<RunEnvironmentHandle["isolation_level"]>
  ): string | undefined {
    const configured = this.platformConfig.k8s?.runtime_class_per_isolation?.[isolationLevel];
    if (configured) return configured;

    switch (isolationLevel) {
      case "standard_isolated":
        return undefined;
      case "hardened_isolated":
        return "gvisor";
      case "strong_isolated":
        return "kata";
      default:
        return undefined;
    }
  }

  private resolvePodResources(): {
    requests: { cpu: string; memory: string };
    limits: { cpu: string; memory: string };
  } {
    const requests = this.platformConfig.k8s?.pod_resources?.requests ?? {};
    const limits = this.platformConfig.k8s?.pod_resources?.limits ?? {};
    return {
      requests: {
        cpu: requests.cpu?.trim() || "500m",
        memory: requests.memory?.trim() || "1Gi",
      },
      limits: {
        cpu: limits.cpu?.trim() || "2",
        memory: limits.memory?.trim() || "4Gi",
      },
    };
  }
}

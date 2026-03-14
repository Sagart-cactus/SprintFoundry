import { createRequire } from "module";
import path from "path";
import type { ExecutionPlan, PlanStep, PlatformConfig, ProjectConfig, TaskRun } from "../../shared/types.js";
import type { AgentRunConfig, AgentRunResult } from "../agent-runner.js";
import type { ExecutionBackend, RunEnvironmentHandle, SandboxTeardownReason } from "./backend.js";
import {
  DEFAULT_AGENT_SANDBOX_API_GROUP,
  DEFAULT_AGENT_SANDBOX_API_VERSION,
  DEFAULT_AGENT_SANDBOX_CLAIM_PLURAL,
} from "../agent-sandbox-platform.js";
import { resolveHostingMode } from "../hosting-mode.js";
import { LocalExecutionBackend } from "./local-backend.js";

const require = createRequire(import.meta.url);

interface AgentSandboxClient {
  createSandboxClaim(namespace: string, manifest: Record<string, unknown>): Promise<void>;
  waitForSandboxBinding(namespace: string, claimName: string): Promise<{ sandboxName?: string }>;
  deleteSandboxClaim(namespace: string, claimName: string): Promise<void>;
}

type LocalExecutionDelegate = Pick<ExecutionBackend, "executeStep">;

export class AgentSandboxExecutionBackend implements ExecutionBackend {
  private readonly namespace: string;
  private client: AgentSandboxClient | null;
  private readonly localBackend: LocalExecutionDelegate;

  constructor(
    private readonly platformConfig: PlatformConfig,
    private readonly projectConfig: ProjectConfig,
    client?: AgentSandboxClient,
    localBackend: LocalExecutionDelegate = new LocalExecutionBackend()
  ) {
    this.namespace = this.platformConfig.k8s?.namespace?.trim() || "default";
    this.client = client ?? null;
    this.localBackend = localBackend;
  }

  async prepareRunEnvironment(
    run: TaskRun,
    _plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    const client = this.getClient();
    const provisioningTimingMs: Record<string, number> = {};
    const provisionStartedAt = Date.now();
    const claimName = this.buildClaimName(run.run_id);
    const templateName = this.platformConfig.k8s?.agent_sandbox?.template_name?.trim() || "default";
    const manifest = this.buildSandboxClaimManifest(run, claimName, templateName);
    const hostEnv = this.buildWholeRunHostEnv();
    const claimCreateStartedAt = Date.now();
    await client.createSandboxClaim(this.namespace, manifest);
    provisioningTimingMs.claim_create = Date.now() - claimCreateStartedAt;
    const bindWaitStartedAt = Date.now();
    const binding = await client.waitForSandboxBinding(this.namespace, claimName);
    provisioningTimingMs.claim_bind_wait = Date.now() - bindWaitStartedAt;
    provisioningTimingMs.total = Date.now() - provisionStartedAt;

    return {
      run_id: run.run_id,
      project_id: run.project_id,
      tenant_id: run.tenant_id,
      sandbox_id: binding.sandboxName || claimName,
      execution_backend: "agent-sandbox",
      hosting_mode: resolveHostingMode({ explicitHostingMode: run.hosting_mode, executionBackend: "agent-sandbox" }),
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {
        namespace: this.namespace,
        claim_name: claimName,
        template_name: templateName,
        bound_sandbox_name: binding.sandboxName,
        warm_pool_name: this.platformConfig.k8s?.agent_sandbox?.warm_pool_name,
        host_env: hostEnv,
        host_paths: {
          runs_root: hostEnv.SPRINTFOUNDRY_RUNS_ROOT,
          sessions_dir: hostEnv.SPRINTFOUNDRY_SESSIONS_DIR,
          home: hostEnv.HOME,
          codex_home: hostEnv.CODEX_HOME,
        },
        provisioning_timing_ms: provisioningTimingMs,
      },
    };
  }

  async executeStep(
    handle: RunEnvironmentHandle,
    step: PlanStep,
    config: AgentRunConfig
  ): Promise<AgentRunResult> {
    return this.withWholeRunHostEnv(handle, async () => {
      const localHandle: RunEnvironmentHandle = {
        ...handle,
        execution_backend: "local",
      };
      return this.localBackend.executeStep(localHandle, step, config);
    });
  }

  async pauseRun(handle: RunEnvironmentHandle): Promise<void> {
    console.warn(
      `[execution-backend] AgentSandboxExecutionBackend pause is not implemented for ${handle.sandbox_id}`
    );
  }

  async resumeRun(handle: RunEnvironmentHandle): Promise<RunEnvironmentHandle> {
    const claimName = String(handle.metadata["claim_name"] ?? "").trim();
    if (!claimName) {
      return {
        ...handle,
        checkpoint_generation: handle.checkpoint_generation + 1,
      };
    }

    const binding = await this.getClient().waitForSandboxBinding(this.namespace, claimName);
    return {
      ...handle,
      sandbox_id: binding.sandboxName || handle.sandbox_id,
      checkpoint_generation: handle.checkpoint_generation + 1,
      metadata: {
        ...handle.metadata,
        bound_sandbox_name: binding.sandboxName || handle.metadata["bound_sandbox_name"],
        recovery_action: binding.sandboxName ? "rebound" : "reattached",
      },
    };
  }

  async teardownRun(
    handle: RunEnvironmentHandle,
    _reason: SandboxTeardownReason
  ): Promise<void> {
    const claimName = String(handle.metadata["claim_name"] ?? "");
    if (!claimName) return;
    await this.getClient().deleteSandboxClaim(this.namespace, claimName);
  }

  private buildSandboxClaimManifest(
    run: TaskRun,
    claimName: string,
    templateName: string
  ): Record<string, unknown> {
    const apiGroup = this.platformConfig.k8s?.agent_sandbox?.api_group?.trim() || DEFAULT_AGENT_SANDBOX_API_GROUP;
    const apiVersion = this.platformConfig.k8s?.agent_sandbox?.api_version?.trim() || DEFAULT_AGENT_SANDBOX_API_VERSION;
    return {
      apiVersion: `${apiGroup}/${apiVersion}`,
      kind: "SandboxClaim",
      metadata: {
        name: claimName,
        namespace: this.namespace,
        labels: {
          "app.kubernetes.io/name": "sprintfoundry-agent-sandbox",
          "sprintfoundry.io/project-id": run.project_id,
          "sprintfoundry.io/run-id": run.run_id,
          ...(run.tenant_id ? { "sprintfoundry.io/tenant-id": run.tenant_id } : {}),
        },
      },
      spec: {
        sandboxTemplateRef: {
          name: templateName,
        },
      },
    };
  }

  private createClient(): AgentSandboxClient {
    let k8sModule: any;
    try {
      k8sModule = require("@kubernetes/client-node");
    } catch (error) {
      throw new Error(
        `AgentSandboxExecutionBackend requires @kubernetes/client-node: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const kc = new k8sModule.KubeConfig();
    kc.loadFromDefault();
    const customObjectsApi = kc.makeApiClient(k8sModule.CustomObjectsApi);
    const apiGroup = this.platformConfig.k8s?.agent_sandbox?.api_group?.trim() || DEFAULT_AGENT_SANDBOX_API_GROUP;
    const apiVersion = this.platformConfig.k8s?.agent_sandbox?.api_version?.trim() || DEFAULT_AGENT_SANDBOX_API_VERSION;
    const claimPlural = this.platformConfig.k8s?.agent_sandbox?.claim_plural?.trim() || DEFAULT_AGENT_SANDBOX_CLAIM_PLURAL;

    return {
      createSandboxClaim: async (namespace, manifest) => {
        await customObjectsApi.createNamespacedCustomObject({
          group: apiGroup,
          version: apiVersion,
          namespace,
          plural: claimPlural,
          body: manifest,
        });
      },
      waitForSandboxBinding: async (namespace, claimName) => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
          const result = await customObjectsApi.getNamespacedCustomObject({
            group: apiGroup,
            version: apiVersion,
            namespace,
            plural: claimPlural,
            name: claimName,
          }) as Record<string, unknown>;
          const body = (result["body"] ?? result) as Record<string, unknown>;
          const status = body["status"];
          if (status && typeof status === "object") {
            const sandboxRef = (status as Record<string, unknown>)["sandboxRef"];
            if (sandboxRef && typeof sandboxRef === "object") {
              const sandboxName = String((sandboxRef as Record<string, unknown>)["name"] ?? "").trim();
              if (sandboxName) {
                return { sandboxName };
              }
            }
          }
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }
        return {};
      },
      deleteSandboxClaim: async (namespace, claimName) => {
        try {
          await customObjectsApi.deleteNamespacedCustomObject({
            group: apiGroup,
            version: apiVersion,
            namespace,
            plural: claimPlural,
            name: claimName,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return;
          throw error;
        }
      },
    };
  }

  private getClient(): AgentSandboxClient {
    if (!this.client) {
      this.client = this.createClient();
    }
    return this.client;
  }

  private buildWholeRunHostEnv(): Record<string, string> {
    const runsRoot = String(process.env.SPRINTFOUNDRY_RUNS_ROOT ?? "/workspace").trim() || "/workspace";
    const sessionsDir = String(
      process.env.SPRINTFOUNDRY_SESSIONS_DIR ?? path.join(runsRoot, ".sprintfoundry", "sessions")
    ).trim() || path.join(runsRoot, ".sprintfoundry", "sessions");
    const homeDir = String(process.env.HOME ?? "/workspace/home").trim() || "/workspace/home";
    const codexHome = String(process.env.CODEX_HOME ?? path.join(homeDir, ".codex")).trim() || path.join(homeDir, ".codex");

    return {
      SPRINTFOUNDRY_EXECUTION_BACKEND: "local",
      SPRINTFOUNDRY_RUN_SANDBOX_MODE: "k8s-whole-run",
      SPRINTFOUNDRY_RUNS_ROOT: runsRoot,
      SPRINTFOUNDRY_SESSIONS_DIR: sessionsDir,
      HOME: homeDir,
      CODEX_HOME: codexHome,
    };
  }

  private async withWholeRunHostEnv<T>(
    handle: RunEnvironmentHandle,
    action: () => Promise<T>
  ): Promise<T> {
    const hostEnv = (
      handle.metadata["host_env"] && typeof handle.metadata["host_env"] === "object"
        ? handle.metadata["host_env"]
        : this.buildWholeRunHostEnv()
    ) as Record<string, unknown>;
    const previous = new Map<string, string | undefined>();

    for (const [key, value] of Object.entries(hostEnv)) {
      if (typeof value !== "string" || value.length === 0) continue;
      previous.set(key, process.env[key]);
      process.env[key] = value;
    }

    try {
      return await action();
    } finally {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  private buildClaimName(runId: string): string {
    const normalized = runId.toLowerCase().replace(/[^a-z0-9-.]+/g, "-");
    return `sf-claim-${normalized}`.slice(0, 63);
  }
}

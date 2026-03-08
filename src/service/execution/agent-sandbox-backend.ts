import { createRequire } from "module";
import type { ExecutionPlan, PlanStep, PlatformConfig, ProjectConfig, TaskRun } from "../../shared/types.js";
import type { AgentRunConfig, AgentRunResult } from "../agent-runner.js";
import type { ExecutionBackend, RunEnvironmentHandle, SandboxTeardownReason } from "./backend.js";

const require = createRequire(import.meta.url);

interface AgentSandboxClient {
  createSandboxClaim(namespace: string, manifest: Record<string, unknown>): Promise<void>;
  waitForSandboxBinding(namespace: string, claimName: string): Promise<{ sandboxName?: string }>;
  deleteSandboxClaim(namespace: string, claimName: string): Promise<void>;
}

export class AgentSandboxExecutionBackend implements ExecutionBackend {
  private readonly namespace: string;
  private readonly client: AgentSandboxClient;

  constructor(
    private readonly platformConfig: PlatformConfig,
    private readonly projectConfig: ProjectConfig,
    client?: AgentSandboxClient
  ) {
    this.namespace = this.platformConfig.k8s?.namespace?.trim() || "default";
    this.client = client ?? this.createClient();
  }

  async prepareRunEnvironment(
    run: TaskRun,
    _plan: ExecutionPlan,
    workspacePath: string
  ): Promise<RunEnvironmentHandle> {
    const claimName = this.buildClaimName(run.run_id);
    const templateName = this.platformConfig.k8s?.agent_sandbox?.template_name?.trim() || "default";
    const manifest = this.buildSandboxClaimManifest(run, claimName, templateName);
    await this.client.createSandboxClaim(this.namespace, manifest);
    const binding = await this.client.waitForSandboxBinding(this.namespace, claimName);

    return {
      run_id: run.run_id,
      project_id: run.project_id,
      tenant_id: run.tenant_id,
      sandbox_id: binding.sandboxName || claimName,
      execution_backend: "agent-sandbox",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {
        namespace: this.namespace,
        claim_name: claimName,
        template_name: templateName,
        bound_sandbox_name: binding.sandboxName,
        warm_pool_name: this.platformConfig.k8s?.agent_sandbox?.warm_pool_name,
      },
    };
  }

  async executeStep(
    _handle: RunEnvironmentHandle,
    _step: PlanStep,
    _config: AgentRunConfig
  ): Promise<AgentRunResult> {
    throw new Error(
      "AgentSandboxExecutionBackend is scaffolded only. Step execution is not implemented yet."
    );
  }

  async pauseRun(handle: RunEnvironmentHandle): Promise<void> {
    console.warn(
      `[execution-backend] AgentSandboxExecutionBackend pause is not implemented for ${handle.sandbox_id}`
    );
  }

  async resumeRun(handle: RunEnvironmentHandle): Promise<RunEnvironmentHandle> {
    return {
      ...handle,
      checkpoint_generation: handle.checkpoint_generation + 1,
    };
  }

  async teardownRun(
    handle: RunEnvironmentHandle,
    _reason: SandboxTeardownReason
  ): Promise<void> {
    const claimName = String(handle.metadata["claim_name"] ?? "");
    if (!claimName) return;
    await this.client.deleteSandboxClaim(this.namespace, claimName);
  }

  private buildSandboxClaimManifest(
    run: TaskRun,
    claimName: string,
    templateName: string
  ): Record<string, unknown> {
    const apiGroup = this.platformConfig.k8s?.agent_sandbox?.api_group?.trim() || "agent-sandbox.dev";
    const apiVersion = this.platformConfig.k8s?.agent_sandbox?.api_version?.trim() || "v1alpha1";
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
    const apiGroup = this.platformConfig.k8s?.agent_sandbox?.api_group?.trim() || "agent-sandbox.dev";
    const apiVersion = this.platformConfig.k8s?.agent_sandbox?.api_version?.trim() || "v1alpha1";
    const claimPlural = this.platformConfig.k8s?.agent_sandbox?.claim_plural?.trim() || "sandboxclaims";

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

  private buildClaimName(runId: string): string {
    const normalized = runId.toLowerCase().replace(/[^a-z0-9-.]+/g, "-");
    return `sf-claim-${normalized}`.slice(0, 63);
  }
}

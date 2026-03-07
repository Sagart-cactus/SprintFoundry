import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePlatformConfig, makeProjectConfig, makeModelConfig } from "./fixtures/configs.js";
import { makePlan, makeStep } from "./fixtures/plans.js";
import { KubernetesPodExecutionBackend } from "../src/service/execution/k8s-pod-backend.js";

describe("KubernetesPodExecutionBackend", () => {
  const client = {
    createServiceAccount: vi.fn(),
    createPvc: vi.fn(),
    createEgressPolicy: vi.fn(),
    createPod: vi.fn(),
    waitForPodReady: vi.fn(),
    getPod: vi.fn(),
    getPvc: vi.fn(),
    exec: vi.fn(),
    deletePod: vi.fn(),
    deletePvc: vi.fn(),
    deleteServiceAccount: vi.fn(),
    deleteEgressPolicy: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one pod sandbox per run and waits for readiness", async () => {
    client.createPod.mockResolvedValue(undefined);
    client.waitForPodReady.mockResolvedValue(undefined);
    client.createServiceAccount.mockResolvedValue(undefined);
    client.createPvc.mockResolvedValue(undefined);

    const backend = new KubernetesPodExecutionBackend(
      makePlatformConfig({
        k8s: {
          namespace: "tenant-a",
          workspace_storage_class: "fast-ssd",
          workspace_size: "25Gi",
          default_secret_profile: "github-only",
          secret_profiles: {
            "github-only": ["tenant-a-github-token"],
          },
          default_isolation_level: "hardened_isolated",
          runtime_class_per_isolation: {
            hardened_isolated: "gvisor",
            strong_isolated: "kata",
          },
          network_policy_provider: "cilium-fqdn",
          default_network_profile: "github-plus-registries",
          network_profiles: {
            "github-only": {
              allow_internet: false,
              fqdn_allowlist: ["github.com", "api.github.com"],
              cidr_allowlist: [],
            },
            "github-plus-registries": {
              allow_internet: false,
              fqdn_allowlist: ["github.com", "api.github.com", "ghcr.io"],
              cidr_allowlist: [],
            },
          },
        },
      }),
      makeProjectConfig(),
      client
    );

    const handle = await backend.prepareRunEnvironment(
      {
        run_id: "Run 1",
        project_id: "project-1",
        tenant_id: "tenant-1",
        network_profile: "github-only",
      } as any,
      makePlan({
        steps: [makeStep({ step_number: 1, agent: "developer", task: "Implement feature" })],
      }),
      "/tmp/workspace-run-1"
    );

    expect(handle).toMatchObject({
      sandbox_id: "sf-pod-run-1",
      execution_backend: "k8s-pod",
      workspace_path: "/tmp/workspace-run-1",
      workspace_volume_ref: "sf-pod-run-1-workspace",
      network_profile: "github-only",
      secret_profile: "github-only",
      isolation_level: "hardened_isolated",
    });

    expect(client.createServiceAccount).toHaveBeenCalledTimes(1);
    expect(client.createPvc).toHaveBeenCalledTimes(1);
    expect(client.createEgressPolicy).toHaveBeenCalledTimes(1);
    expect(client.createPod).toHaveBeenCalledTimes(1);
    expect(client.waitForPodReady).toHaveBeenCalledWith("tenant-a", "sf-pod-run-1");
    const serviceAccountManifest = client.createServiceAccount.mock.calls[0][1];
    const pvcManifest = client.createPvc.mock.calls[0][1];
    const egressPolicy = client.createEgressPolicy.mock.calls[0][1];
    const manifest = client.createPod.mock.calls[0][1];
    expect(serviceAccountManifest).toMatchObject({
      metadata: {
        name: "sf-sa-run-1",
        namespace: "tenant-a",
      },
      automountServiceAccountToken: false,
    });
    expect(pvcManifest).toMatchObject({
      metadata: {
        name: "sf-pod-run-1-workspace",
        namespace: "tenant-a",
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage: "25Gi" } },
        storageClassName: "fast-ssd",
      },
    });
    expect(manifest.metadata).toMatchObject({
      name: "sf-pod-run-1",
      namespace: "tenant-a",
      labels: {
        "sprintfoundry.io/project-id": "project-1",
        "sprintfoundry.io/run-id": "Run 1",
        "sprintfoundry.io/tenant-id": "tenant-1",
      },
    });
    expect(manifest.spec).toMatchObject({
      serviceAccountName: "sf-sa-run-1",
      automountServiceAccountToken: false,
      runtimeClassName: "gvisor",
      securityContext: {
        runAsNonRoot: true,
        seccompProfile: {
          type: "RuntimeDefault",
        },
      },
    });
    expect(manifest.spec.containers[0].env).toEqual([
      { name: "SPRINTFOUNDRY_SECRET_PROFILE", value: "github-only" },
      { name: "SPRINTFOUNDRY_ISOLATION_LEVEL", value: "hardened_isolated" },
    ]);
    expect(manifest.spec.containers[0].securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: false,
      capabilities: {
        drop: ["ALL"],
      },
    });
    expect(egressPolicy).toMatchObject({
      apiVersion: "cilium.io/v2",
      kind: "CiliumNetworkPolicy",
      metadata: {
        name: "sf-pod-run-1-egress",
        namespace: "tenant-a",
      },
      spec: {
        endpointSelector: {
          matchLabels: {
            "sprintfoundry.io/run-id": "Run 1",
          },
        },
      },
    });
    expect(egressPolicy.spec.egress).toEqual([
      {
        toFQDNs: [{ matchName: "github.com" }, { matchName: "api.github.com" }],
      },
    ]);
    expect(manifest.spec.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "workspace",
          persistentVolumeClaim: { claimName: "sf-pod-run-1-workspace" },
        }),
        expect.objectContaining({
          name: "projected-secrets",
          projected: {
            sources: [{ secret: { name: "tenant-a-github-token" } }],
          },
        }),
      ])
    );
  });

  it("executes steps through the pod exec API", async () => {
    client.exec.mockResolvedValue({
      stdout: '{"usage":{"total_tokens":222}}\n',
      stderr: "",
      code: 0,
    });

    const backend = new KubernetesPodExecutionBackend(
      makePlatformConfig({
        k8s: {
          namespace: "tenant-a",
          network_policy_provider: "cilium-fqdn",
          default_network_profile: "full-internet",
          network_profiles: {
            "full-internet": {
              allow_internet: true,
              fqdn_allowlist: [],
              cidr_allowlist: [],
            },
          },
        },
      }),
      makeProjectConfig(),
      client
    );

    const result = await backend.executeStep(
      {
        run_id: "run-1",
        project_id: "project-1",
        sandbox_id: "sf-pod-run-1",
        execution_backend: "k8s-pod",
        workspace_path: "/tmp/workspace-run-1",
        checkpoint_generation: 0,
        metadata: {
          image: "sprintfoundry/agent-developer:latest",
        },
      },
      makeStep({ step_number: 1, agent: "developer", task: "Implement feature" }),
      {
        runId: "run-1",
        stepNumber: 1,
        stepAttempt: 1,
        agent: "developer",
        task: "Implement feature",
        context_inputs: [],
        workspacePath: "/tmp/workspace-run-1",
        modelConfig: makeModelConfig(),
        apiKey: "sk-ant-test",
        tokenBudget: 1000,
        timeoutMinutes: 3,
        previousStepResults: [],
        runtime: { provider: "claude-code", mode: "local_process" },
        resolvedPluginPaths: ["/repo/plugins/js-nextjs"],
        cliFlags: { output_format: "json", skip_permissions: true },
      }
    );

    expect(result.tokens_used).toBe(222);
    expect(result.container_id).toBe("sf-pod-run-1");
    expect(client.exec).toHaveBeenCalledWith(
      "tenant-a",
      "sf-pod-run-1",
      "sandbox",
      [
        "sh",
        "-lc",
        expect.stringContaining("export ANTHROPIC_API_KEY='sk-ant-test'"),
      ]
    );
    expect(client.exec.mock.calls[0][3][2]).toContain(
      "export AGENT_PLUGIN_DIRS='/opt/sprintfoundry/plugins/js-nextjs'"
    );
  });

  it("re-attaches to a running pod and recreates from PVC when the pod is gone", async () => {
    client.getPod
      .mockResolvedValueOnce({
        status: {
          phase: "Running",
          conditions: [{ type: "Ready", status: "True" }],
        },
      })
      .mockResolvedValueOnce(null);
    client.getPvc.mockResolvedValue({
      metadata: { name: "sf-pod-run-1-workspace" },
    });
    client.createEgressPolicy.mockResolvedValue(undefined);
    client.createPod.mockResolvedValue(undefined);
    client.waitForPodReady.mockResolvedValue(undefined);

    const backend = new KubernetesPodExecutionBackend(
      makePlatformConfig({
        k8s: {
          namespace: "tenant-a",
          network_policy_provider: "cilium-fqdn",
          default_network_profile: "full-internet",
          network_profiles: {
            "full-internet": {
              allow_internet: true,
              fqdn_allowlist: [],
              cidr_allowlist: [],
            },
          },
        },
      }),
      makeProjectConfig(),
      client
    );

    const attached = await backend.resumeRun({
      run_id: "run-1",
      project_id: "project-1",
      sandbox_id: "sf-pod-run-1",
      execution_backend: "k8s-pod",
      workspace_path: "/tmp/workspace-run-1",
      workspace_volume_ref: "sf-pod-run-1-workspace",
      checkpoint_generation: 0,
      network_profile: "full-internet",
      secret_profile: "default",
      isolation_level: "strong_isolated",
      metadata: {
        image: "sprintfoundry/agent-developer:latest",
        service_account_name: "sf-sa-run-1",
      },
    });
    const recreated = await backend.resumeRun({
      run_id: "run-1",
      project_id: "project-1",
      sandbox_id: "sf-pod-run-1",
      execution_backend: "k8s-pod",
      workspace_path: "/tmp/workspace-run-1",
      workspace_volume_ref: "sf-pod-run-1-workspace",
      checkpoint_generation: 1,
      network_profile: "full-internet",
      secret_profile: "default",
      isolation_level: "strong_isolated",
      metadata: {
        image: "sprintfoundry/agent-developer:latest",
        service_account_name: "sf-sa-run-1",
      },
    });

    expect(attached.checkpoint_generation).toBe(1);
    expect(attached.metadata).toMatchObject({ recovery_action: "reattached" });
    expect(client.createPod).toHaveBeenCalledTimes(1);
    expect(client.createEgressPolicy).toHaveBeenCalledTimes(1);
    expect(recreated.checkpoint_generation).toBe(2);
    expect(recreated.metadata).toMatchObject({ recovery_action: "recreated" });
  });

  it("deletes the pod on teardown", async () => {
    client.deletePod.mockResolvedValue(undefined);
    client.deletePvc.mockRejectedValue(new Error("storage api unavailable"));
    client.deleteServiceAccount.mockResolvedValue(undefined);
    client.deleteEgressPolicy.mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const backend = new KubernetesPodExecutionBackend(
      makePlatformConfig({ k8s: { namespace: "tenant-a" } }),
      makeProjectConfig(),
      client
    );

    await backend.teardownRun(
      {
        run_id: "run-1",
        project_id: "project-1",
        sandbox_id: "sf-pod-run-1",
        execution_backend: "k8s-pod",
        workspace_path: "/tmp/workspace-run-1",
        workspace_volume_ref: "sf-pod-run-1-workspace",
        network_profile: "github-only",
        checkpoint_generation: 0,
        metadata: {
          service_account_name: "sf-sa-run-1",
          egress_policy_name: "sf-pod-run-1-egress",
        },
      },
      "completed"
    );

    expect(client.deletePod).toHaveBeenCalledWith("tenant-a", "sf-pod-run-1");
    expect(client.deletePvc).toHaveBeenCalledWith("tenant-a", "sf-pod-run-1-workspace");
    expect(client.deleteEgressPolicy).toHaveBeenCalledWith("tenant-a", "sf-pod-run-1-egress");
    expect(client.deleteServiceAccount).toHaveBeenCalledWith("tenant-a", "sf-sa-run-1");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete PVC sf-pod-run-1-workspace")
    );
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePlatformConfig, makeProjectConfig, makeModelConfig } from "./fixtures/configs.js";
import { makePlan, makeStep } from "./fixtures/plans.js";
import { KubernetesPodExecutionBackend } from "../src/service/execution/k8s-pod-backend.js";

describe("KubernetesPodExecutionBackend", () => {
  const client = {
    createPvc: vi.fn(),
    createPod: vi.fn(),
    waitForPodReady: vi.fn(),
    exec: vi.fn(),
    deletePod: vi.fn(),
    deletePvc: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one pod sandbox per run and waits for readiness", async () => {
    client.createPod.mockResolvedValue(undefined);
    client.waitForPodReady.mockResolvedValue(undefined);
    client.createPvc.mockResolvedValue(undefined);

    const backend = new KubernetesPodExecutionBackend(
      makePlatformConfig({
        k8s: {
          namespace: "tenant-a",
          workspace_storage_class: "fast-ssd",
          workspace_size: "25Gi",
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
    });

    expect(client.createPvc).toHaveBeenCalledTimes(1);
    expect(client.createPod).toHaveBeenCalledTimes(1);
    expect(client.waitForPodReady).toHaveBeenCalledWith("tenant-a", "sf-pod-run-1");
    const pvcManifest = client.createPvc.mock.calls[0][1];
    const manifest = client.createPod.mock.calls[0][1];
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
    expect(manifest.spec.volumes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "workspace",
          persistentVolumeClaim: { claimName: "sf-pod-run-1-workspace" },
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
      makePlatformConfig({ k8s: { namespace: "tenant-a" } }),
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

  it("deletes the pod on teardown", async () => {
    client.deletePod.mockResolvedValue(undefined);
    client.deletePvc.mockRejectedValue(new Error("storage api unavailable"));
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
        checkpoint_generation: 0,
        metadata: {},
      },
      "completed"
    );

    expect(client.deletePod).toHaveBeenCalledWith("tenant-a", "sf-pod-run-1");
    expect(client.deletePvc).toHaveBeenCalledWith("tenant-a", "sf-pod-run-1-workspace");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to delete PVC sf-pod-run-1-workspace")
    );
  });
});

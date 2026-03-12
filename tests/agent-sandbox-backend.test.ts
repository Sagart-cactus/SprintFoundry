import { beforeEach, describe, expect, it, vi } from "vitest";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";
import { AgentSandboxExecutionBackend } from "../src/service/execution/agent-sandbox-backend.js";

describe("AgentSandboxExecutionBackend", () => {
  const client = {
    createSandboxClaim: vi.fn(),
    waitForSandboxBinding: vi.fn(),
    deleteSandboxClaim: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a SandboxClaim and tracks the bound sandbox identity", async () => {
    client.createSandboxClaim.mockResolvedValue(undefined);
    client.waitForSandboxBinding.mockResolvedValue({ sandboxName: "sandbox-abc" });

    const backend = new AgentSandboxExecutionBackend(
      makePlatformConfig({
        k8s: {
          namespace: "tenant-a",
          agent_sandbox: {
            enabled: true,
            template_name: "typescript-dev",
            warm_pool_name: "ts-pool",
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
      } as any,
      { plan_id: "p1", ticket_id: "t1", classification: "new_feature", reasoning: "", steps: [], parallel_groups: [], human_gates: [] },
      "/tmp/workspace-run-1"
    );

    expect(client.createSandboxClaim).toHaveBeenCalledTimes(1);
    const manifest = client.createSandboxClaim.mock.calls[0][1];
    expect(manifest).toMatchObject({
      kind: "SandboxClaim",
      metadata: {
        name: "sf-claim-run-1",
        namespace: "tenant-a",
      },
      spec: {
        sandboxTemplateRef: {
          name: "typescript-dev",
        },
      },
    });
    expect(handle).toMatchObject({
      sandbox_id: "sandbox-abc",
      execution_backend: "agent-sandbox",
      workspace_path: "/tmp/workspace-run-1",
    });
    expect(handle.metadata).toMatchObject({
      claim_name: "sf-claim-run-1",
      template_name: "typescript-dev",
      warm_pool_name: "ts-pool",
      provisioning_timing_ms: {
        claim_create: expect.any(Number),
        claim_bind_wait: expect.any(Number),
        total: expect.any(Number),
      },
    });
  });

  it("fails fast for executeStep because the scaffold does not implement execution yet", async () => {
    const backend = new AgentSandboxExecutionBackend(
      makePlatformConfig({
        k8s: {
          agent_sandbox: { enabled: true },
        },
      }),
      makeProjectConfig(),
      client
    );

    await expect(
      backend.executeStep(
        {
          run_id: "run-1",
          project_id: "project-1",
          sandbox_id: "sandbox-abc",
          execution_backend: "agent-sandbox",
          workspace_path: "/tmp/workspace-run-1",
          checkpoint_generation: 0,
          metadata: {},
        },
        { step_number: 1, agent: "developer", task: "Work", context_inputs: [], depends_on: [], estimated_complexity: "medium" },
        {} as any
      )
    ).rejects.toThrow(/not implemented/);
  });
});

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
      apiVersion: "agents.x-k8s.io/v1alpha1",
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
      hosting_mode: "k8s-agent-sandbox",
      workspace_path: "/tmp/workspace-run-1",
    });
    expect(handle.metadata).toMatchObject({
      claim_name: "sf-claim-run-1",
      template_name: "typescript-dev",
      warm_pool_name: "ts-pool",
      host_env: {
        SPRINTFOUNDRY_EXECUTION_BACKEND: "local",
        SPRINTFOUNDRY_RUN_SANDBOX_MODE: "k8s-whole-run",
      },
      provisioning_timing_ms: {
        claim_create: expect.any(Number),
        claim_bind_wait: expect.any(Number),
        total: expect.any(Number),
      },
    });
  });

  it("executes steps locally under whole-run host env", async () => {
    const localBackend = {
      executeStep: vi.fn(async () => ({
        agentResult: {
          status: "complete",
          summary: "ok",
          artifacts_created: [],
          artifacts_modified: [],
          issues: [],
          metadata: {
            observed_env: {
              execution_backend: process.env.SPRINTFOUNDRY_EXECUTION_BACKEND,
              run_sandbox_mode: process.env.SPRINTFOUNDRY_RUN_SANDBOX_MODE,
              runs_root: process.env.SPRINTFOUNDRY_RUNS_ROOT,
              sessions_dir: process.env.SPRINTFOUNDRY_SESSIONS_DIR,
              home: process.env.HOME,
              codex_home: process.env.CODEX_HOME,
            },
          },
        },
        tokens_used: 0,
        cost_usd: 0,
        duration_seconds: 0,
        container_id: "runtime-1",
      })),
    };
    const backend = new AgentSandboxExecutionBackend(
      makePlatformConfig({
        k8s: {
          agent_sandbox: { enabled: true },
        },
      }),
      makeProjectConfig(),
      client,
      localBackend
    );

    const result = await backend.executeStep(
      {
        run_id: "run-1",
        project_id: "project-1",
        sandbox_id: "sandbox-abc",
        execution_backend: "agent-sandbox",
        hosting_mode: "k8s-agent-sandbox",
        workspace_path: "/tmp/workspace-run-1",
        checkpoint_generation: 0,
        metadata: {
          host_env: {
            SPRINTFOUNDRY_EXECUTION_BACKEND: "local",
            SPRINTFOUNDRY_RUN_SANDBOX_MODE: "k8s-whole-run",
            SPRINTFOUNDRY_RUNS_ROOT: "/workspace",
            SPRINTFOUNDRY_SESSIONS_DIR: "/workspace/.sprintfoundry/sessions",
            HOME: "/workspace/home",
            CODEX_HOME: "/workspace/home/.codex",
          },
        },
      },
      { step_number: 1, agent: "developer", task: "Work", context_inputs: [], depends_on: [], estimated_complexity: "medium" },
      {} as any
    );

    expect(localBackend.executeStep).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      container_id: "runtime-1",
      agentResult: {
        metadata: {
          observed_env: {
            execution_backend: "local",
            run_sandbox_mode: "k8s-whole-run",
            runs_root: "/workspace",
            sessions_dir: "/workspace/.sprintfoundry/sessions",
            home: "/workspace/home",
            codex_home: "/workspace/home/.codex",
          },
        },
      },
    });
    expect(process.env.SPRINTFOUNDRY_RUN_SANDBOX_MODE).not.toBe("k8s-whole-run");
  });
});

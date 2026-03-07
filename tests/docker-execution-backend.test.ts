import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { makePlatformConfig, makeProjectConfig, makeModelConfig } from "./fixtures/configs.js";
import { makePlan, makeStep } from "./fixtures/plans.js";

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn: mockSpawn } = await import("child_process");
const { DockerExecutionBackend } = await import("../src/service/execution/docker-backend.js");

function makeFakeProcess(stdout = "", exitCode = 0, stderr = "") {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: vi.fn() };
  proc.pid = 45678;
  proc.kill = vi.fn();

  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    if (stderr) proc.stderr.emit("data", Buffer.from(stderr));
    proc.emit("close", exitCode);
  }, 5);

  return proc;
}

describe("DockerExecutionBackend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates one long-lived container for the run sandbox", async () => {
    (mockSpawn as any).mockImplementationOnce(() => makeFakeProcess("container-123\n"));

    const backend = new DockerExecutionBackend(makePlatformConfig(), makeProjectConfig());
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
      run_id: "Run 1",
      project_id: "project-1",
      tenant_id: "tenant-1",
      sandbox_id: "sf-run-run-1",
      execution_backend: "docker",
      workspace_path: "/tmp/workspace-run-1",
    });
    expect(handle.metadata).toMatchObject({
      image: "sprintfoundry/agent-developer:latest",
      container_id: "container-123",
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [command, args] = (mockSpawn as any).mock.calls[0];
    expect(command).toBe("docker");
    expect(args).toEqual(
      expect.arrayContaining([
        "run",
        "-d",
        "--name",
        "sf-run-run-1",
        "--rm",
        "-w",
        "/workspace",
        "-v",
        "/tmp/workspace-run-1:/workspace",
        "--entrypoint",
        "sh",
        "sprintfoundry/agent-developer:latest",
      ])
    );
  });

  it("dispatches steps into the existing sandbox with docker exec", async () => {
    (mockSpawn as any).mockImplementationOnce(() => makeFakeProcess('{"usage":{"total_tokens":321}}\n'));

    const backend = new DockerExecutionBackend(makePlatformConfig(), makeProjectConfig());
    const result = await backend.executeStep(
      {
        run_id: "run-1",
        project_id: "project-1",
        sandbox_id: "sf-run-run-1",
        execution_backend: "docker",
        workspace_path: "/tmp/workspace-run-1",
        checkpoint_generation: 0,
        metadata: {
          image: "sprintfoundry/agent-developer:latest",
          container_id: "container-123",
        },
      },
      makeStep({ step_number: 1, agent: "developer", task: "Implement feature" }),
      {
        runId: "run-1",
        stepNumber: 1,
        stepAttempt: 2,
        agent: "developer",
        task: "Implement feature",
        context_inputs: [],
        workspacePath: "/tmp/workspace-run-1",
        modelConfig: makeModelConfig(),
        apiKey: "sk-ant-test",
        tokenBudget: 1000,
        timeoutMinutes: 5,
        previousStepResults: [],
        runtime: { provider: "claude-code", mode: "local_process" },
        resolvedPluginPaths: ["/repo/plugins/js-nextjs", "/repo/plugins/code-review"],
        cliFlags: {
          output_format: "json",
          skip_permissions: true,
          max_budget_usd: 1.25,
        },
      }
    );

    expect(result.tokens_used).toBe(321);
    expect(result.container_id).toBe("sf-run-run-1");
    expect(result.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_process",
        runtime_id: "sf-run-run-1",
        step_attempt: 2,
      },
      provider_metadata: {
        execution_backend: "docker",
        sandbox_id: "sf-run-run-1",
        image: "sprintfoundry/agent-developer:latest",
      },
    });

    const [command, args] = (mockSpawn as any).mock.calls[0];
    expect(command).toBe("docker");
    expect(args).toEqual(
      expect.arrayContaining([
        "exec",
        "-w",
        "/workspace",
        "-e",
        "ANTHROPIC_API_KEY=sk-ant-test",
        "-e",
        "AGENT_TYPE=developer",
        "-e",
        "AGENT_MAX_BUDGET=1.25",
        "-e",
        "AGENT_PLUGIN_DIRS=/opt/sprintfoundry/plugins/js-nextjs:/opt/sprintfoundry/plugins/code-review",
        "sf-run-run-1",
        "sh",
        "-lc",
        "timeout 300s /usr/local/bin/entrypoint.sh",
      ])
    );
  });

  it("pauses, resumes, and tears down the sandbox container", async () => {
    (mockSpawn as any)
      .mockImplementationOnce(() => makeFakeProcess(""))
      .mockImplementationOnce(() => makeFakeProcess("running\n"))
      .mockImplementationOnce(() => makeFakeProcess(""));

    const backend = new DockerExecutionBackend(makePlatformConfig(), makeProjectConfig());
    const handle = {
      run_id: "run-1",
      project_id: "project-1",
      sandbox_id: "sf-run-run-1",
      execution_backend: "docker",
      workspace_path: "/tmp/workspace-run-1",
      checkpoint_generation: 0,
      metadata: { image: "sprintfoundry/agent-developer:latest" },
    };

    await backend.pauseRun(handle);
    const resumed = await backend.resumeRun(handle);
    await backend.teardownRun(handle, "completed");

    expect((mockSpawn as any).mock.calls[0][1]).toEqual(["pause", "sf-run-run-1"]);
    expect((mockSpawn as any).mock.calls[1][1]).toEqual([
      "inspect",
      "-f",
      "{{.State.Status}}",
      "sf-run-run-1",
    ]);
    expect((mockSpawn as any).mock.calls[2][1]).toEqual(["rm", "-f", "sf-run-run-1"]);
    expect(resumed.checkpoint_generation).toBe(1);
    expect(resumed.metadata).toMatchObject({ recovery_action: "reattached" });
  });

  it("recreates the sandbox container when the prior one is missing", async () => {
    (mockSpawn as any)
      .mockImplementationOnce(() => makeFakeProcess("", 1, "Error: No such container"))
      .mockImplementationOnce(() => makeFakeProcess("container-456\n"));

    const backend = new DockerExecutionBackend(makePlatformConfig(), makeProjectConfig());
    const resumed = await backend.resumeRun({
      run_id: "run-1",
      project_id: "project-1",
      sandbox_id: "sf-run-run-1",
      execution_backend: "docker",
      workspace_path: "/tmp/workspace-run-1",
      checkpoint_generation: 2,
      metadata: {
        image: "sprintfoundry/agent-developer:latest",
      },
    });

    expect((mockSpawn as any).mock.calls[0][1]).toEqual([
      "inspect",
      "-f",
      "{{.State.Status}}",
      "sf-run-run-1",
    ]);
    expect((mockSpawn as any).mock.calls[1][1]).toEqual(
      expect.arrayContaining([
        "run",
        "-d",
        "--name",
        "sf-run-run-1",
        "sprintfoundry/agent-developer:latest",
      ])
    );
    expect(resumed.checkpoint_generation).toBe(3);
    expect(resumed.metadata).toMatchObject({
      recovery_action: "recreated",
      container_id: "container-456",
    });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

const { execFileMock, validateAgentSandboxWholeRunHostingMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  validateAgentSandboxWholeRunHostingMock: vi.fn(),
}));

vi.mock("child_process", () => ({
  execFile: execFileMock,
}));

vi.mock("../src/service/agent-sandbox-platform.js", async () => {
  const actual = await vi.importActual<typeof import("../src/service/agent-sandbox-platform.js")>(
    "../src/service/agent-sandbox-platform.js",
  );
  return {
    ...actual,
    validateAgentSandboxWholeRunHosting: validateAgentSandboxWholeRunHostingMock,
  };
});

import { runPreflight } from "../src/service/preflight.js";

describe("runPreflight", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      OPENAI_API_KEY: "test-openai-key",
      SPRINTFOUNDRY_HOSTING_MODE: "k8s-agent-sandbox",
      SPRINTFOUNDRY_RUN_SANDBOX_MODE: "k8s-whole-run",
    };
    validateAgentSandboxWholeRunHostingMock.mockResolvedValue(undefined);
    execFileMock.mockImplementation(
      (
        command: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
      ) => {
        if (command === "git" && args[0] === "--version") {
          callback(null, "git version 2.53.0\n", "");
          return;
        }
        if (command === "git" && args[0] === "ls-remote") {
          callback(null, "abc123\trefs/heads/main\n", "");
          return;
        }
        callback(new Error(`unexpected command: ${command} ${args.join(" ")}`));
      },
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("skips host-only kubernetes checks inside a hosted whole-run sandbox", async () => {
    const platform = makePlatformConfig({
      defaults: {
        runtime_per_agent: {
          developer: { provider: "codex", mode: "local_sdk" },
        },
        planner_runtime: { provider: "codex", mode: "local_sdk" },
      },
      agent_definitions: [makePlatformConfig().agent_definitions.find((agent) => agent.type === "developer")!],
      k8s: {
        agent_sandbox: {
          enabled: true,
          whole_run_hosting_enabled: true,
        },
      },
    });
    const project = makeProjectConfig({
      agents: ["developer"],
      api_keys: {
        anthropic: "",
        openai: "test-openai-key",
      },
      runtime_overrides: {
        developer: { provider: "codex", mode: "local_sdk" },
      },
      planner_runtime_override: { provider: "codex", mode: "local_sdk" },
    });

    const result = await runPreflight(platform, project, {
      profile: "k8s",
      includePlanner: false,
      agentIds: ["developer"],
    });

    expect(result.profile).toBe("k8s");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          label: "Kubernetes host checks",
          severity: "pass",
        }),
      ]),
    );
    expect(result.checks.map((check) => check.label)).not.toEqual(
      expect.arrayContaining([
        "kubectl",
        "Kube context",
        "Agent Sandbox CRDs",
        "Project namespace",
        "Project secret",
        "Project configmap",
        "RBAC: sandboxclaims",
      ]),
    );
    expect(validateAgentSandboxWholeRunHostingMock).not.toHaveBeenCalled();
    expect(execFileMock.mock.calls.every(([command]) => command !== "kubectl")).toBe(true);
  });
});

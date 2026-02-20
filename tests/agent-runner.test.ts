import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import { makePlatformConfig, makeProjectConfig, makeModelConfig } from "./fixtures/configs.js";
import { makeResult } from "./fixtures/results.js";
import type { AgentRunConfig } from "../src/service/agent-runner.js";

// Mock child_process.spawn
vi.mock("child_process", () => {
  const actual = vi.importActual("child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

const { spawn: mockSpawn } = await import("child_process");
const { query: mockClaudeSdkQuery } = await import("@anthropic-ai/claude-agent-sdk");

const { AgentRunner } = await import("../src/service/agent-runner.js");

function makeFakeProcess(
  stdout = "",
  exitCode = 0,
  options?: { delay?: number }
) {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.pid = 12345;
  proc.kill = vi.fn();

  setTimeout(() => {
    if (stdout) proc.stdout.emit("data", Buffer.from(stdout));
    proc.emit("close", exitCode);
  }, options?.delay ?? 5);

  return proc;
}

function makeRunConfig(overrides?: Partial<AgentRunConfig>): AgentRunConfig {
  return {
    stepNumber: overrides?.stepNumber ?? 1,
    stepAttempt: overrides?.stepAttempt ?? 1,
    agent: overrides?.agent ?? "developer",
    task: overrides?.task ?? "Implement the feature",
    context_inputs: overrides?.context_inputs ?? [{ type: "ticket" }],
    workspacePath: overrides?.workspacePath ?? "/tmp/test-workspace",
    modelConfig: overrides?.modelConfig ?? makeModelConfig(),
    apiKey: overrides?.apiKey ?? "sk-ant-test-key",
    tokenBudget: overrides?.tokenBudget ?? 500_000,
    timeoutMinutes: overrides?.timeoutMinutes ?? 30,
    previousStepResults: overrides?.previousStepResults ?? [],
    plugins: overrides?.plugins,
    cliFlags: overrides?.cliFlags,
    containerResources: overrides?.containerResources,
  };
}

async function* makeSdkSuccessStream(tokens = 500) {
  yield {
    type: "system",
    subtype: "init",
    session_id: "sdk-session-1",
  };
  yield {
    type: "result",
    subtype: "success",
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    stop_reason: null,
    total_cost_usd: 0.123,
    usage: {
      input_tokens: Math.floor(tokens / 2),
      output_tokens: tokens - Math.floor(tokens / 2),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    modelUsage: {},
    permission_denials: [],
    result: "ok",
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: "sdk-session-1",
  };
}

describe("AgentRunner", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-runner-test-"));

    // Create the workspace structure tests expect
    const agentDir = path.join(tmpDir, "src", "agents", "developer");
    await fs.mkdir(agentDir, { recursive: true });
    await fs.writeFile(
      path.join(agentDir, "CLAUDE.md"),
      "# Developer Agent",
      "utf-8"
    );
  });

  it("buildClaudeCliArgs includes -p, --output-format, --dangerously-skip-permissions", async () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());

    // Access private method via prototype trick
    const args = (runner as any).buildClaudeCliArgs("Do the task", makeRunConfig());

    expect(args).toContain("-p");
    expect(args).toContain("Do the task");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("buildClaudeCliArgs includes --max-budget-usd when set", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());

    const args = (runner as any).buildClaudeCliArgs(
      "Do the task",
      makeRunConfig({ cliFlags: { max_budget_usd: 5.0 } })
    );

    expect(args).toContain("--max-budget-usd");
    expect(args).toContain("5");
  });

  it("buildClaudeCliArgs does NOT include --max-budget-usd when not set", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());

    const args = (runner as any).buildClaudeCliArgs(
      "Do the task",
      makeRunConfig({ cliFlags: {} })
    );

    expect(args).not.toContain("--max-budget-usd");
  });

  it("buildClaudeCliArgs includes --plugin-dir for each plugin", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());

    const args = (runner as any).buildClaudeCliArgs(
      "Do the task",
      makeRunConfig({ plugins: ["js-nextjs", "frontend-design"] })
    );

    const pluginDirIndices = args
      .map((a: string, i: number) => (a === "--plugin-dir" ? i : -1))
      .filter((i: number) => i >= 0);

    expect(pluginDirIndices).toHaveLength(2);
    // Each --plugin-dir should be followed by a path
    for (const idx of pluginDirIndices) {
      expect(args[idx + 1]).toContain("plugins");
    }
  });

  it("readAgentResult parses valid .agent-result.json", async () => {
    const workspacePath = path.join(tmpDir, "workspace-valid");
    await fs.mkdir(workspacePath, { recursive: true });
    const result = makeResult();
    await fs.writeFile(
      path.join(workspacePath, ".agent-result.json"),
      JSON.stringify(result),
      "utf-8"
    );

    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const parsed = await (runner as any).readAgentResult(workspacePath);

    expect(parsed.status).toBe("complete");
    expect(parsed.summary).toBe("Task completed successfully");
  });

  it("readAgentResult returns failure stub for missing file", async () => {
    const workspacePath = path.join(tmpDir, "workspace-missing");
    await fs.mkdir(workspacePath, { recursive: true });

    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const parsed = await (runner as any).readAgentResult(workspacePath);

    expect(parsed.status).toBe("failed");
    expect(parsed.summary).toContain("did not produce a result file");
  });

  it("readAgentResult returns failure stub for invalid JSON", async () => {
    const workspacePath = path.join(tmpDir, "workspace-invalid");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, ".agent-result.json"),
      "not json {{{",
      "utf-8"
    );

    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const parsed = await (runner as any).readAgentResult(workspacePath);

    expect(parsed.status).toBe("failed");
  });

  it("readAgentResult returns failure for missing required fields", async () => {
    const workspacePath = path.join(tmpDir, "workspace-partial");
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(
      path.join(workspacePath, ".agent-result.json"),
      JSON.stringify({ foo: "bar" }),
      "utf-8"
    );

    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const parsed = await (runner as any).readAgentResult(workspacePath);

    expect(parsed.status).toBe("failed");
    expect(parsed.issues).toContain("Missing required fields in .agent-result.json");
  });

  it("persistStepResultSnapshot writes per-step result file", async () => {
    const workspacePath = path.join(tmpDir, "workspace-step-snapshot");
    await fs.mkdir(workspacePath, { recursive: true });
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());

    await (runner as any).persistStepResultSnapshot(
      workspacePath,
      7,
      2,
      "code-review",
      makeResult({ summary: "Snapshot saved" })
    );

    const snapshotPath = path.join(
      workspacePath,
      ".sprintfoundry",
      "step-results",
      "step-7.attempt-2.code-review.json"
    );
    const raw = await fs.readFile(snapshotPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.summary).toBe("Snapshot saved");
  });

  it("parseTokenUsage extracts from JSON output", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const output = JSON.stringify({ usage: { total_tokens: 1234 } });

    const tokens = (runner as any).parseTokenUsage(output);

    expect(tokens).toBe(1234);
  });

  it("parseTokenUsage extracts from regex fallback", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const output = "Process completed. Tokens: 5678\nDone.";

    const tokens = (runner as any).parseTokenUsage(output);

    expect(tokens).toBe(5678);
  });

  it("parseTokenUsage returns 0 for unrecognized output", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const output = "no token info here";

    const tokens = (runner as any).parseTokenUsage(output);

    expect(tokens).toBe(0);
  });

  it("estimateCost calculates correctly for known models", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());

    const cost = (runner as any).estimateCost(
      1_000_000,
      { provider: "anthropic", model: "claude-sonnet-4-5-20250929" }
    );

    expect(cost).toBe(3.0); // $3 per 1M tokens
  });

  it("estimateCost uses default rate for unknown models", () => {
    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());

    const cost = (runner as any).estimateCost(
      1_000_000,
      { provider: "anthropic", model: "claude-unknown-model" }
    );

    expect(cost).toBe(3.0); // default $3 per 1M
  });

  it("uses Claude SDK query() for local claude-code runtime", async () => {
    delete process.env.SPRINTFOUNDRY_USE_CONTAINERS;
    (mockClaudeSdkQuery as any).mockReturnValueOnce(makeSdkSuccessStream(500));

    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const workspacePath = path.join(tmpDir, "workspace-local-sdk");
    await fs.mkdir(workspacePath, { recursive: true });
    (runner as any).readAgentResult = vi.fn().mockResolvedValue(makeResult());

    const result = await runner.run(makeRunConfig({ workspacePath }));
    expect(mockClaudeSdkQuery).toHaveBeenCalledTimes(1);
    expect(result.agentResult.status).toBe("complete");
    expect(result.cost_usd).toBe(0.123);
    expect(result.agentResult.metadata.runtime).toBeDefined();
    expect(result.agentResult.metadata.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_sdk",
        step_attempt: 1,
      },
    });
  });

  it("spawnContainer constructs correct docker args with volume mounts", async () => {
    const proc = makeFakeProcess(
      JSON.stringify({ usage: { total_tokens: 200 } })
    );
    (mockSpawn as any).mockReturnValueOnce(proc);

    const runner = new AgentRunner(
      makePlatformConfig(),
      makeProjectConfig({
        runtime_overrides: {
          developer: { provider: "claude-code", mode: "container" },
        },
      })
    );
    (runner as any).prepareWorkspace = vi.fn().mockResolvedValue(undefined);
    (runner as any).readAgentResult = vi.fn().mockResolvedValue(makeResult());

    const result = await runner.run(
      makeRunConfig({ agent: "developer", plugins: ["js-nextjs"] })
    );

    expect(mockSpawn).toHaveBeenCalledWith(
      "docker",
      expect.arrayContaining(["run", "--rm", "-v"]),
      expect.any(Object)
    );

    const dockerArgs = (mockSpawn as any).mock.calls[0][1];
    // Should have volume mount for workspace
    expect(dockerArgs.some((a: string) => a.includes("/workspace"))).toBe(true);

  });

  it("timeout kills the process", async () => {
    delete process.env.SPRINTFOUNDRY_USE_CONTAINERS;
    (mockClaudeSdkQuery as any).mockImplementationOnce((params: any) => (async function* () {
      await new Promise((_, reject) => {
        const signal = params.options.abortController.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    })());

    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const workspacePath = path.join(tmpDir, "workspace-timeout-sdk");
    await fs.mkdir(workspacePath, { recursive: true });
    const config = makeRunConfig({ timeoutMinutes: 0.001, workspacePath }); // ~60ms timeout

    await expect(runner.run(config)).rejects.toThrow(/timed out/);
    expect(mockClaudeSdkQuery).toHaveBeenCalledTimes(1);
  });

  it("run rejects when local claude exits with non-zero code", async () => {
    delete process.env.SPRINTFOUNDRY_USE_CONTAINERS;
    (mockClaudeSdkQuery as any).mockReturnValueOnce((async function* () {
      yield {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0 },
        },
        modelUsage: {},
        permission_denials: [],
        errors: ["simulated failure"],
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sdk-session-err",
      };
    })());

    const runner = new AgentRunner(makePlatformConfig(), makeProjectConfig());
    const workspacePath = path.join(tmpDir, "workspace-local-error-sdk");
    await fs.mkdir(workspacePath, { recursive: true });
    await expect(runner.run(makeRunConfig({ workspacePath }))).rejects.toThrow(/exited with code 1/);
  });

  it("run rejects when docker exits with non-zero code", async () => {
    const proc = makeFakeProcess("container error", 2);
    (mockSpawn as any).mockReturnValueOnce(proc);

    const runner = new AgentRunner(
      makePlatformConfig(),
      makeProjectConfig({
        runtime_overrides: {
          developer: { provider: "claude-code", mode: "container" },
        },
      })
    );
    (runner as any).prepareWorkspace = vi.fn().mockResolvedValue(undefined);

    await expect(runner.run(makeRunConfig())).rejects.toThrow(/exited with code 2/);
  });

  it("uses codex runtime when project runtime override is set", async () => {
    delete process.env.SPRINTFOUNDRY_USE_CONTAINERS;

    const proc = makeFakeProcess(JSON.stringify({ usage: { total_tokens: 321 } }));
    (mockSpawn as any).mockReturnValueOnce(proc);

    const runner = new AgentRunner(
      makePlatformConfig(),
      makeProjectConfig({
        runtime_overrides: {
          developer: { provider: "codex", mode: "local_process" },
        },
      })
    );
    (runner as any).prepareWorkspace = vi.fn().mockResolvedValue({
      codexHomeDir: "/tmp/codex-home-test",
      codexSkillNames: ["web-design-guidelines"],
    });
    (runner as any).readAgentResult = vi.fn().mockResolvedValue(makeResult());

    const result = await runner.run(makeRunConfig({ agent: "developer" }));

    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      expect.any(Array),
      expect.any(Object)
    );
    const spawnOpts = (mockSpawn as any).mock.calls[0][2];
    expect(spawnOpts.env.CODEX_HOME).toBe("/tmp/codex-home-test");
    expect(result.tokens_used).toBe(321);
    expect(result.cost_usd).toBeCloseTo(0.000963, 8);
  });

  it("prepareWorkspace stages codex skills and appends AGENTS.md skill section", async () => {
    const workspacePath = path.join(tmpDir, "workspace-codex-skill");
    await fs.mkdir(workspacePath, { recursive: true });

    const skillSource = path.join(tmpDir, "skills", "web-design-guidelines");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# Skill", "utf-8");
    await fs.writeFile(path.join(skillSource, "notes.md"), "helper", "utf-8");

    const runner = new AgentRunner(
      makePlatformConfig({
        defaults: {
          ...makePlatformConfig().defaults,
          codex_skills_enabled: true,
          codex_skill_catalog: {
            "web-design-guidelines": { path: skillSource },
          },
          codex_skills_per_agent: {
            developer: ["web-design-guidelines"],
          },
        },
      }),
      makeProjectConfig()
    );

    const prep = await (runner as any).prepareWorkspace(
      makeRunConfig({ agent: "developer", workspacePath }),
      { provider: "codex", mode: "local_process" }
    );

    expect(prep.codexHomeDir).toBe(path.join(workspacePath, ".codex-home"));
    expect(prep.codexSkillNames).toEqual(["web-design-guidelines"]);
    await expect(
      fs.access(
        path.join(
          workspacePath,
          ".codex-home",
          "skills",
          "web-design-guidelines",
          "SKILL.md"
        )
      )
    ).resolves.toBeUndefined();

    const agentsMd = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("## Runtime Skills");
    expect(agentsMd).toContain("web-design-guidelines");
  });

  it("project runtime override takes precedence over platform runtime defaults", async () => {
    const proc = makeFakeProcess(JSON.stringify({ usage: { total_tokens: 111 } }));
    (mockSpawn as any).mockReturnValueOnce(proc);

    const runner = new AgentRunner(
      makePlatformConfig({
        defaults: {
          model_per_agent: {
            orchestrator: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
            developer: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
            qa: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
          },
          budgets: {
            per_agent_tokens: 500_000,
            per_task_total_tokens: 3_000_000,
            per_task_max_cost_usd: 25,
          },
          timeouts: {
            agent_timeout_minutes: 30,
            task_timeout_minutes: 180,
            human_gate_timeout_hours: 48,
          },
          max_rework_cycles: 3,
          runtime_per_agent: {
            developer: { provider: "claude-code", mode: "local_process" },
          },
        },
      }),
      makeProjectConfig({
        runtime_overrides: {
          developer: { provider: "codex", mode: "local_process" },
        },
      })
    );
    (runner as any).prepareWorkspace = vi.fn().mockResolvedValue(undefined);
    (runner as any).readAgentResult = vi.fn().mockResolvedValue(makeResult());

    await runner.run(makeRunConfig({ agent: "developer" }));
    expect(mockSpawn).toHaveBeenCalledWith(
      "codex",
      expect.any(Array),
      expect.any(Object)
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

vi.mock("../src/service/runtime/process-utils.js", () => ({
  runProcess: vi.fn(),
}));

const { runProcess } = await import("../src/service/runtime/process-utils.js");
const { CodexPlannerRuntime } = await import("../src/service/runtime/codex-planner-runtime.js");

describe("CodexPlannerRuntime", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-planner-runtime-test-"));
    vi.mocked(runProcess).mockImplementation(async (_command, _args, options) => {
      await fs.writeFile(
        path.join(options.cwd, ".planner-plan.raw.txt"),
        JSON.stringify({
          classification: "new_feature",
          reasoning: "test",
          steps: [
            {
              step_number: 1,
              agent: "developer",
              task: "Implement",
              context_inputs: [{ type: "ticket" }],
              depends_on: [],
              estimated_complexity: "low",
            },
          ],
          parallel_groups: [],
          human_gates: [],
        }),
        "utf-8"
      );
      return {
        tokensUsed: 0,
        runtimeId: "planner-test",
        stdout: "",
        stderr: "",
      } as any;
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("passes model_reasoning_effort for codex orchestrator model", async () => {
    const platform = makePlatformConfig({
      defaults: {
        ...makePlatformConfig().defaults,
        model_per_agent: {
          ...makePlatformConfig().defaults.model_per_agent,
          orchestrator: { provider: "openai", model: "gpt-5.3-codex" },
        },
      },
    });
    const project = makeProjectConfig({
      planner_runtime_override: {
        provider: "codex",
        mode: "local_process",
        model_reasoning_effort: "high",
      },
      model_overrides: {
        orchestrator: { provider: "openai", model: "gpt-5.3-codex" },
      },
    });
    const planner = new CodexPlannerRuntime(platform, project);

    await planner.generatePlan(
      {
        id: "T-1",
        source: "prompt",
        title: "Title",
        description: "Desc",
        labels: [],
        priority: "p1",
        acceptance_criteria: [],
        linked_tickets: [],
        comments: [],
        author: "test",
        raw: {},
      },
      [],
      [],
      tmpDir
    );

    const args = vi.mocked(runProcess).mock.calls[0][1] as string[];
    expect(args).toContain("--config");
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it("ignores model_reasoning_effort for non-codex orchestrator model", async () => {
    const platform = makePlatformConfig();
    const project = makeProjectConfig({
      planner_runtime_override: {
        provider: "codex",
        mode: "local_process",
        model_reasoning_effort: "high",
      },
      model_overrides: {
        orchestrator: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
      },
    });
    const planner = new CodexPlannerRuntime(platform, project);

    await planner.generatePlan(
      {
        id: "T-2",
        source: "prompt",
        title: "Title",
        description: "Desc",
        labels: [],
        priority: "p1",
        acceptance_criteria: [],
        linked_tickets: [],
        comments: [],
        author: "test",
        raw: {},
      },
      [],
      [],
      tmpDir
    );

    const args = vi.mocked(runProcess).mock.calls[0][1] as string[];
    expect(args.some((arg) => arg.includes("model_reasoning_effort"))).toBe(false);
  });
});


import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";
import { makeStep } from "./fixtures/plans.js";
import { makeResult } from "./fixtures/results.js";

// Mock all sub-services (must match orchestration-service.test.ts pattern)
vi.mock("../src/service/runtime/planner-factory.js", () => ({
  PlannerFactory: class {
    create() {
      return {
        generatePlan: vi.fn(),
        planRework: vi.fn(),
      };
    }
    constructor() {}
  },
}));

vi.mock("../src/service/agent-runner.js", () => ({
  AgentRunner: class {
    run = vi.fn();
    constructor(..._args: any[]) {}
  },
}));

vi.mock("../src/service/workspace-manager.js", () => ({
  WorkspaceManager: class {
    create = vi.fn().mockResolvedValue("/tmp/workspace");
    cleanup = vi.fn();
    getPath = vi.fn().mockReturnValue("/tmp/workspace");
    constructor(..._args: any[]) {}
  },
}));

vi.mock("../src/service/ticket-fetcher.js", () => ({
  TicketFetcher: class {
    fetch = vi.fn();
    updateStatus = vi.fn();
    constructor(..._args: any[]) {}
  },
}));

vi.mock("../src/service/git-manager.js", () => ({
  GitManager: class {
    cloneAndBranch = vi.fn();
    commitAndPush = vi.fn();
    commitStepCheckpoint = vi.fn().mockResolvedValue(true);
    createPullRequest = vi.fn().mockResolvedValue("https://github.com/test/repo/pull/1");
    constructor(..._args: any[]) {}
  },
}));

vi.mock("../src/service/notification-service.js", () => ({
  NotificationService: class {
    send = vi.fn();
    constructor(..._args: any[]) {}
  },
}));

vi.mock("../src/service/event-store.js", () => ({
  EventStore: class {
    store = vi.fn();
    initialize = vi.fn();
    close = vi.fn();
    getAll = vi.fn().mockResolvedValue([]);
    getByRunId = vi.fn().mockResolvedValue([]);
    getByType = vi.fn().mockResolvedValue([]);
    constructor(..._args: any[]) {}
  },
}));

vi.mock("../src/service/runtime-session-store.js", () => ({
  RuntimeSessionStore: class {
    record = vi.fn();
    findLatestByAgent = vi.fn().mockResolvedValue(null);
    constructor(..._args: any[]) {}
  },
}));

const { OrchestrationService } = await import("../src/service/orchestration-service.js");
const { PluginRegistry } = await import("../src/service/plugin-registry.js");

// --- Helpers ---

function makeParallelPlan() {
  return {
    plan_id: "plan-parallel-1",
    ticket_id: "TEST-123",
    classification: "new_feature" as const,
    reasoning: "Parallel dev + security",
    steps: [
      makeStep({ step_number: 1, agent: "developer", task: "Implement feature", depends_on: [] }),
      makeStep({ step_number: 2, agent: "security", task: "Audit security", depends_on: [] }),
      makeStep({ step_number: 3, agent: "qa", task: "Test feature", depends_on: [1, 2] }),
    ],
    parallel_groups: [[1, 2]],
    human_gates: [],
  };
}

function makeWorktreePlugin() {
  return {
    name: "worktree",
    supportsSubWorktrees: true,
    create: vi.fn().mockResolvedValue({ path: "/tmp/workspace", branch: "feat/test" }),
    destroy: vi.fn(),
    commitStepChanges: vi.fn().mockResolvedValue(true),
    createPullRequest: vi.fn().mockResolvedValue("https://github.com/test/repo/pull/1"),
    getPath: vi.fn().mockReturnValue("/tmp/workspace"),
    list: vi.fn().mockResolvedValue([]),
    createSubWorktree: vi.fn().mockImplementation(
      async (parentPath: string, stepNumber: number) => `${parentPath}-step${stepNumber}`
    ),
    mergeSubWorktree: vi.fn().mockResolvedValue(undefined),
    removeSubWorktree: vi.fn().mockResolvedValue(undefined),
  };
}

function makeTmpdirPlugin() {
  return {
    name: "tmpdir",
    // no supportsSubWorktrees — defaults to undefined/false
    create: vi.fn().mockResolvedValue({ path: "/tmp/workspace", branch: "feat/test" }),
    destroy: vi.fn(),
    commitStepChanges: vi.fn().mockResolvedValue(true),
    createPullRequest: vi.fn().mockResolvedValue("https://github.com/test/repo/pull/1"),
    getPath: vi.fn().mockReturnValue("/tmp/workspace"),
    list: vi.fn().mockResolvedValue([]),
  };
}

describe("Parallel execution with sub-worktree isolation", () => {
  let service: InstanceType<typeof OrchestrationService>;
  let mockAgentRunner: any;
  let mockPlanner: any;
  let worktreePlugin: ReturnType<typeof makeWorktreePlugin>;

  beforeEach(() => {
    vi.clearAllMocks();

    worktreePlugin = makeWorktreePlugin();
    const registry = new PluginRegistry();
    // Register the mock worktree plugin directly
    registry.register(
      {
        manifest: { name: "worktree", slot: "workspace", version: "1.0.0" },
        create: () => worktreePlugin,
      },
      {}
    );

    service = new OrchestrationService(makePlatformConfig(), makeProjectConfig(), registry);
    mockAgentRunner = (service as any).agentRunner;
    mockPlanner = (service as any).plannerRuntime;
  });

  it("creates sub-worktrees for parallel steps when plugin supports it", async () => {
    const plan = makeParallelPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("p1", "prompt", "Build parallel feature");

    expect(run.status).toBe("completed");

    // The parallel group [1, 2] should trigger sub-worktree creation
    expect(worktreePlugin.createSubWorktree).toHaveBeenCalledTimes(2);
    expect(worktreePlugin.createSubWorktree).toHaveBeenCalledWith(
      expect.any(String), 1
    );
    expect(worktreePlugin.createSubWorktree).toHaveBeenCalledWith(
      expect.any(String), 2
    );
  });

  it("merges sub-worktrees back after successful parallel execution", async () => {
    const plan = makeParallelPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    await service.handleTask("p1", "prompt", "Build parallel feature");

    // Both parallel steps should merge back
    expect(worktreePlugin.mergeSubWorktree).toHaveBeenCalledTimes(2);
  });

  it("passes sub-worktree path (not parent) to agent runner", async () => {
    const plan = makeParallelPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    await service.handleTask("p1", "prompt", "Build parallel feature");

    // Find calls to agentRunner.run for steps 1 and 2 (the parallel ones)
    const runCalls = mockAgentRunner.run.mock.calls;
    const parallelCalls = runCalls.filter(
      (call: any[]) => call[0].stepNumber === 1 || call[0].stepNumber === 2
    );

    for (const call of parallelCalls) {
      const workspacePath = call[0].workspacePath;
      // Sub-worktree paths should contain "-step"
      expect(workspacePath).toMatch(/-step[12]$/);
    }
  });

  it("cleans up sub-worktree on step failure", async () => {
    const plan = makeParallelPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);

    // Step 1 succeeds, step 2 fails
    let callCount = 0;
    mockAgentRunner.run.mockImplementation(async (opts: any) => {
      callCount++;
      if (opts.stepNumber === 2) {
        return {
          agentResult: {
            status: "failed",
            summary: "Security audit failed",
            artifacts_created: [],
            artifacts_modified: [],
            issues: ["Critical vulnerability found"],
          },
          tokens_used: 50,
          cost_usd: 0.005,
          duration_seconds: 3,
          container_id: `local-${callCount}`,
        };
      }
      return {
        agentResult: makeResult(),
        tokens_used: 100,
        cost_usd: 0.01,
        duration_seconds: 5,
        container_id: `local-${callCount}`,
      };
    });

    const run = await service.handleTask("p1", "prompt", "Build parallel feature");

    expect(run.status).toBe("failed");

    // Sub-worktrees should have been created for both steps
    expect(worktreePlugin.createSubWorktree).toHaveBeenCalledTimes(2);

    // The failed step should have its sub-worktree cleaned up (removeSubWorktree)
    // The successful step should have merged
    const totalMerges = worktreePlugin.mergeSubWorktree.mock.calls.length;
    const totalRemoves = worktreePlugin.removeSubWorktree.mock.calls.length;
    // At least one cleanup action per step
    expect(totalMerges + totalRemoves).toBeGreaterThanOrEqual(2);
  });

  it("sequential steps do NOT create sub-worktrees", async () => {
    // Step 3 depends on [1, 2] so it runs sequentially after the parallel group
    const plan = makeParallelPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    await service.handleTask("p1", "prompt", "Build parallel feature");

    // Only 2 sub-worktrees for the parallel group, not 3
    expect(worktreePlugin.createSubWorktree).toHaveBeenCalledTimes(2);
  });
});

describe("Parallel execution WITHOUT sub-worktree support (tmpdir fallback)", () => {
  let service: InstanceType<typeof OrchestrationService>;
  let mockAgentRunner: any;
  let mockPlanner: any;
  let tmpdirPlugin: ReturnType<typeof makeTmpdirPlugin>;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpdirPlugin = makeTmpdirPlugin();
    const registry = new PluginRegistry();
    registry.register(
      {
        manifest: { name: "tmpdir", slot: "workspace", version: "1.0.0" },
        create: () => tmpdirPlugin,
      },
      {}
    );

    service = new OrchestrationService(makePlatformConfig(), makeProjectConfig(), registry);
    mockAgentRunner = (service as any).agentRunner;
    mockPlanner = (service as any).plannerRuntime;
  });

  it("uses shared workspace when plugin lacks sub-worktree support", async () => {
    const plan = makeParallelPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("p1", "prompt", "Build parallel feature");

    expect(run.status).toBe("completed");

    // All agent calls should use the same workspace path (no sub-worktrees)
    const workspacePaths = mockAgentRunner.run.mock.calls.map(
      (call: any[]) => call[0].workspacePath
    );
    const uniquePaths = new Set(workspacePaths);
    expect(uniquePaths.size).toBe(1);
    expect(workspacePaths[0]).toBe("/tmp/workspace");
  });
});

describe("Parallel execution without any registry (legacy mode)", () => {
  let service: InstanceType<typeof OrchestrationService>;
  let mockAgentRunner: any;
  let mockPlanner: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // No registry at all (legacy path)
    service = new OrchestrationService(makePlatformConfig(), makeProjectConfig());
    mockAgentRunner = (service as any).agentRunner;
    mockPlanner = (service as any).plannerRuntime;
  });

  it("runs parallel steps with shared workspace (no crash)", async () => {
    const plan = makeParallelPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("p1", "prompt", "Build parallel feature");

    expect(run.status).toBe("completed");

    // All agent calls should use the same workspace path
    const workspacePaths = mockAgentRunner.run.mock.calls.map(
      (call: any[]) => call[0].workspacePath
    );
    const uniquePaths = new Set(workspacePaths);
    expect(uniquePaths.size).toBe(1);
  });
});

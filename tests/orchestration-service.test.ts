import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";
import { makeTicket } from "./fixtures/tickets.js";
import { makePlan, makeStep, makeDevQaPlan } from "./fixtures/plans.js";
import { makeResult, makeFailedResult, makeReworkResult } from "./fixtures/results.js";

// Mock all sub-services using class syntax so they work with `new`
vi.mock("../src/service/orchestrator-agent.js", () => ({
  OrchestratorAgent: class {
    generatePlan = vi.fn();
    planRework = vi.fn();
    constructor(..._args: any[]) {}
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
    createPullRequest = vi
      .fn()
      .mockResolvedValue("https://github.com/test/repo/pull/1");
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

const { OrchestrationService } = await import(
  "../src/service/orchestration-service.js"
);

describe("OrchestrationService", () => {
  let service: InstanceType<typeof OrchestrationService>;
  let mockOrchestratorAgent: any;
  let mockAgentRunner: any;
  let mockTicketFetcher: any;
  let mockGitManager: any;

  beforeEach(() => {
    vi.clearAllMocks();

    service = new OrchestrationService(
      makePlatformConfig(),
      makeProjectConfig()
    );

    // Get references to the mock instances
    mockOrchestratorAgent = (service as any).orchestratorAgent;
    mockAgentRunner = (service as any).agentRunner;
    mockTicketFetcher = (service as any).tickets;
    mockGitManager = (service as any).git;
  });

  it("handleTask with source=prompt creates ticket from prompt text", async () => {
    const plan = makeDevQaPlan();
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("prompt-1", "prompt", "Add a button");

    // Should NOT have called ticket fetcher
    expect(mockTicketFetcher.fetch).not.toHaveBeenCalled();
    // Ticket should be created from prompt
    expect(run.ticket.title).toBe("Add a button");
    expect(run.ticket.source).toBe("prompt");
  });

  it("handleTask with source=github fetches ticket via TicketFetcher", async () => {
    const ticket = makeTicket();
    mockTicketFetcher.fetch.mockResolvedValue(ticket);

    const plan = makeDevQaPlan();
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("42", "github");

    expect(mockTicketFetcher.fetch).toHaveBeenCalledWith("42", "github");
    expect(run.ticket.id).toBe("TEST-123");
  });

  it("happy path: plan → validate → execute → PR", async () => {
    const plan = makeDevQaPlan();
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 1000,
      cost_usd: 0.03,
      duration_seconds: 10,
      container_id: "local-1",
    });
    mockGitManager.createPullRequest.mockResolvedValue(
      "https://github.com/test/repo/pull/1"
    );

    const run = await service.handleTask("p1", "prompt", "Build a thing");

    expect(run.status).toBe("completed");
    expect(run.pr_url).toBe("https://github.com/test/repo/pull/1");
    expect(run.total_tokens_used).toBeGreaterThan(0);
    expect(run.total_cost_usd).toBeGreaterThan(0);
    // Should have executed steps for dev and qa (plan may have extra injected steps)
    expect(mockAgentRunner.run).toHaveBeenCalled();
  });

  it("step failure sets run.status = 'failed'", async () => {
    const plan = makeDevQaPlan();
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeFailedResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("failed");
    // PR should NOT be created
    expect(mockGitManager.createPullRequest).not.toHaveBeenCalled();
  });

  it("rework loop: needs_rework → planRework → retry → complete", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({
          step_number: 2,
          agent: "qa",
          task: "Test code",
          depends_on: [1],
        }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    // Step 1 (developer): succeeds
    // Step 2 (qa): needs_rework on first call, then complete on retry
    let qaCallCount = 0;
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      if (config.agent === "developer") {
        return {
          agentResult: makeResult(),
          tokens_used: 500,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "local-1",
        };
      }
      // QA agent
      qaCallCount++;
      if (qaCallCount === 1) {
        return {
          agentResult: makeReworkResult(),
          tokens_used: 300,
          cost_usd: 0.01,
          duration_seconds: 3,
          container_id: "local-2",
        };
      }
      // Second run (after rework): complete
      return {
        agentResult: makeResult({ summary: "Tests now pass" }),
        tokens_used: 200,
        cost_usd: 0.01,
        duration_seconds: 2,
        container_id: "local-3",
      };
    });

    // planRework returns a fix step
    mockOrchestratorAgent.planRework.mockResolvedValue({
      steps: [
        makeStep({
          step_number: 901,
          agent: "developer",
          task: "Fix failing tests",
        }),
      ],
    });

    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("completed");
    expect(mockOrchestratorAgent.planRework).toHaveBeenCalledTimes(1);
    // Agent runner should be called multiple times: dev(1) + qa(1st attempt) + rework-dev(901) + qa(retry)
    expect(mockAgentRunner.run.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("rework exceeds max cycles → step fails", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({
          step_number: 2,
          agent: "qa",
          task: "Test code",
          depends_on: [1],
        }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    // Developer always succeeds, QA always needs rework
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      if (config.agent === "developer") {
        return {
          agentResult: makeResult(),
          tokens_used: 100,
          cost_usd: 0.01,
          duration_seconds: 2,
          container_id: "local-1",
        };
      }
      return {
        agentResult: makeReworkResult(),
        tokens_used: 100,
        cost_usd: 0.01,
        duration_seconds: 2,
        container_id: "local-2",
      };
    });

    mockOrchestratorAgent.planRework.mockResolvedValue({
      steps: [
        makeStep({ step_number: 901, agent: "developer", task: "Fix" }),
      ],
    });

    const run = await service.handleTask("p1", "prompt", "Build it");

    // Should fail after exhausting rework cycles
    expect(run.status).toBe("failed");
  });

  it("budget exceeded → step fails before spawning", async () => {
    const lowBudgetPlatform = makePlatformConfig({
      defaults: {
        model_per_agent: {
          orchestrator: {
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
          },
          developer: {
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
          },
          qa: {
            provider: "anthropic",
            model: "claude-sonnet-4-5-20250929",
          },
        },
        budgets: {
          per_agent_tokens: 500_000,
          per_task_total_tokens: 100, // very low budget
          per_task_max_cost_usd: 25,
        },
        timeouts: {
          agent_timeout_minutes: 30,
          task_timeout_minutes: 180,
          human_gate_timeout_hours: 48,
        },
        max_rework_cycles: 3,
      },
    });

    const lowBudgetService = new OrchestrationService(
      lowBudgetPlatform,
      makeProjectConfig()
    );

    const mockOrch = (lowBudgetService as any).orchestratorAgent;
    const mockRunner = (lowBudgetService as any).agentRunner;

    const plan = makeDevQaPlan();
    mockOrch.generatePlan.mockResolvedValue(plan);

    // First agent uses all the budget
    mockRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 200, // exceeds budget of 100
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await lowBudgetService.handleTask("p1", "prompt", "Build it");

    // Second step (qa) should fail due to budget
    expect(run.status).toBe("failed");
  });

  it("parallel group executes steps concurrently", async () => {
    const plan = makePlan({
      steps: [
        makeStep({
          step_number: 1,
          agent: "developer",
          task: "Build frontend",
        }),
        makeStep({
          step_number: 2,
          agent: "developer",
          task: "Build backend",
        }),
        makeStep({
          step_number: 3,
          agent: "qa",
          task: "Test all",
          depends_on: [1, 2],
        }),
      ],
    });
    plan.parallel_groups = [[1, 2]]; // steps 1 and 2 can run in parallel

    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("completed");
    // All steps should have been executed (plan may have additional injected steps)
    expect(mockAgentRunner.run).toHaveBeenCalled();
    expect(mockAgentRunner.run.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("deadlock detection when no steps are ready", async () => {
    // Create a circular dependency that causes deadlock
    const plan = makePlan({
      steps: [
        makeStep({
          step_number: 1,
          agent: "developer",
          task: "Step A",
          depends_on: [2],
        }),
        makeStep({
          step_number: 2,
          agent: "qa",
          task: "Step B",
          depends_on: [1],
        }),
      ],
    });

    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Deadlock");
  });

  it("resolveModel falls back through 3 levels", () => {
    // Test the 3-level fallback: project override → platform default → role-based
    const platformConfig = makePlatformConfig({
      defaults: {
        model_per_agent: {
          developer: {
            provider: "anthropic",
            model: "platform-default-model",
          },
          qa: { provider: "anthropic", model: "platform-qa-model" },
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
      },
    });

    const projectConfig = makeProjectConfig({
      model_overrides: {
        developer: {
          provider: "anthropic",
          model: "project-override-model",
        },
      },
    });

    const svc = new OrchestrationService(platformConfig, projectConfig);

    // Level 1: project override exists for developer
    const devModel = (svc as any).resolveModel("developer");
    expect(devModel.model).toBe("project-override-model");

    // Level 2: platform default for qa (no project override)
    const qaModel = (svc as any).resolveModel("qa");
    expect(qaModel.model).toBe("platform-qa-model");

    // Level 3: role-based fallback for unknown agent
    // "go-developer" is not in model_per_agent but has role "developer" in agent_definitions
    const goDevModel = (svc as any).resolveModel("go-developer");
    expect(goDevModel.model).toBe("platform-default-model");
  });

  it("waitForReviewDecision resolves approved decision from workspace file", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-approve-"));
    const review = {
      review_id: "review-123",
      run_id: "run-123",
      after_step: 2,
      status: "pending",
      summary: "Needs approval",
      artifacts_to_review: [],
    } as const;

    setTimeout(async () => {
      const dir = path.join(workspace, ".agentsdlc", "reviews");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "review-123.decision.json"),
        JSON.stringify({ status: "approved", reviewer_feedback: "Ship it" }),
        "utf-8"
      );
    }, 20);

    const decision = await (service as any).waitForReviewDecision(review, workspace);

    expect(decision.status).toBe("approved");
    expect(decision.reviewer_feedback).toBe("Ship it");
  });

  it("waitForReviewDecision times out and rejects", async () => {
    const fastTimeoutService = new OrchestrationService(
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
            human_gate_timeout_hours: 0.00001,
          },
          max_rework_cycles: 3,
        },
      }),
      makeProjectConfig()
    );
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-timeout-"));
    const review = {
      review_id: "review-timeout",
      run_id: "run-timeout",
      after_step: 2,
      status: "pending",
      summary: "Needs approval",
      artifacts_to_review: [],
    } as const;

    const decision = await (fastTimeoutService as any).waitForReviewDecision(review, workspace);
    expect(decision.status).toBe("rejected");
    expect(decision.reviewer_feedback).toContain("timed out");
  });
});

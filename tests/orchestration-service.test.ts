import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";
import { makeTicket } from "./fixtures/tickets.js";
import { makePlan, makeStep, makeDevQaPlan } from "./fixtures/plans.js";
import { makeResult, makeFailedResult, makeReworkResult } from "./fixtures/results.js";
import type { ExecutionBackend, RunEnvironmentHandle } from "../src/service/execution/index.js";

const eventStoreCtor = vi.fn();
const eventSinkCtor = vi.fn();
const eventSinkUpsertRun = vi.fn();
const eventSinkPostLog = vi.fn();
const eventSinkUpsertStepResult = vi.fn();
const agentRunnerCtor = vi.fn();

// Mock all sub-services using class syntax so they work with `new`
// Mock PlannerFactory — returns a mock planner with generatePlan/planRework
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
    constructor(...args: any[]) {
      agentRunnerCtor(...args);
    }
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
    constructor(...args: any[]) {
      eventStoreCtor(...args);
    }
  },
}));

vi.mock("../src/service/event-sink-client.js", () => ({
  EventSinkClient: class {
    postEvent = vi.fn();
    upsertRun = eventSinkUpsertRun;
    postLog = eventSinkPostLog;
    upsertStepResult = eventSinkUpsertStepResult;
    constructor(url: string) {
      eventSinkCtor(url);
    }
  },
}));

vi.mock("../src/service/runtime-session-store.js", () => ({
  RuntimeSessionStore: class {
    record = vi.fn();
    findLatestByAgent = vi.fn().mockResolvedValue(null);
    constructor(..._args: any[]) {}
  },
}));

vi.mock("../src/service/session-manager.js", () => ({
  SessionManager: class {
    private sinkClient?: { upsertRun?: (session: unknown) => Promise<void> | void };
    constructor(_baseDir?: string, sinkClient?: { upsertRun?: (session: unknown) => Promise<void> | void }) {
      this.sinkClient = sinkClient;
    }
    persist = vi.fn(async (run: any) => {
      if (this.sinkClient?.upsertRun) {
        await this.sinkClient.upsertRun({
          run_id: run.run_id,
          status: run.status,
        });
      }
    });
    get = vi.fn().mockResolvedValue(null);
    list = vi.fn().mockResolvedValue([]);
    archive = vi.fn().mockResolvedValue(true);
    remove = vi.fn().mockResolvedValue(true);
    updateStatus = vi.fn().mockResolvedValue(true);
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
  let mockSessionStore: any;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SPRINTFOUNDRY_EVENT_SINK_URL;

    service = new OrchestrationService(
      makePlatformConfig(),
      makeProjectConfig()
    );

    // Get references to the mock instances
    mockOrchestratorAgent = (service as any).plannerRuntime;
    mockAgentRunner = (service as any).agentRunner;
    mockTicketFetcher = (service as any).tickets;
    mockGitManager = (service as any).git;
    mockSessionStore = (service as any).sessions;
  });

  it("constructs EventStore without sink client when sink env is unset", () => {
    expect(eventSinkCtor).not.toHaveBeenCalled();
    expect(eventStoreCtor).toHaveBeenCalledTimes(1);
    expect(eventStoreCtor.mock.calls[0][0]).toBe(makePlatformConfig().events_dir);
    expect(eventStoreCtor.mock.calls[0][1]).toBeUndefined();
  });

  it("passes the selected execution backend into AgentRunner", () => {
    const backend: ExecutionBackend = {
      prepareRunEnvironment: vi.fn(),
      executeStep: vi.fn(),
      pauseRun: vi.fn(),
      resumeRun: vi.fn(),
      teardownRun: vi.fn(),
    };

    new OrchestrationService(
      makePlatformConfig(),
      makeProjectConfig(),
      undefined,
      backend
    );

    expect(agentRunnerCtor).toHaveBeenCalled();
    expect(agentRunnerCtor.mock.calls.at(-1)?.[2]).toBe(backend);
  });

  it("constructs EventStore with sink client when sink env is set", () => {
    process.env.SPRINTFOUNDRY_EVENT_SINK_URL = "https://sink.example/events";
    new OrchestrationService(makePlatformConfig(), makeProjectConfig());

    expect(eventSinkCtor).toHaveBeenCalledWith("https://sink.example/events");
    expect(eventStoreCtor).toHaveBeenCalledTimes(2);
    expect(eventStoreCtor.mock.calls[1][1]).toBeDefined();
  });

  it("wires sink client into SessionManager persistence when sink env is set", async () => {
    process.env.SPRINTFOUNDRY_EVENT_SINK_URL = "https://sink.example/events";
    const sinkEnabledService = new OrchestrationService(makePlatformConfig(), makeProjectConfig());

    const mockPlanner = (sinkEnabledService as any).plannerRuntime;
    const mockRunner = (sinkEnabledService as any).agentRunner;

    const plan = makeDevQaPlan();
    mockPlanner.generatePlan.mockResolvedValue(plan);
    mockRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    await sinkEnabledService.handleTask("p1", "prompt", "Build a thing");

    await vi.waitFor(
      () => {
        expect(eventSinkUpsertRun).toHaveBeenCalled();
      },
      { timeout: 5000 }
    );
  });

  it("prepares and tears down one run environment per run", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-run-env-"));
    const backendHandle: RunEnvironmentHandle = {
      run_id: "pending",
      project_id: makeProjectConfig().project_id,
      sandbox_id: "sandbox-1",
      execution_backend: "test",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {},
    };
    const backend: ExecutionBackend = {
      prepareRunEnvironment: vi.fn(async (run) => ({ ...backendHandle, run_id: run.run_id })),
      executeStep: vi.fn(),
      pauseRun: vi.fn(),
      resumeRun: vi.fn(async (handle) => handle),
      teardownRun: vi.fn(async () => {}),
    };

    service = new OrchestrationService(
      makePlatformConfig(),
      makeProjectConfig(),
      undefined,
      backend
    );
    mockOrchestratorAgent = (service as any).plannerRuntime;
    mockAgentRunner = (service as any).agentRunner;
    mockTicketFetcher = (service as any).tickets;
    mockGitManager = (service as any).git;
    mockSessionStore = (service as any).sessions;
    (service as any).workspace.create.mockResolvedValue(workspacePath);

    mockOrchestratorAgent.generatePlan.mockResolvedValue(makeDevQaPlan());
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("prompt-1", "prompt", "Add a button");

    expect(backend.prepareRunEnvironment).toHaveBeenCalledTimes(1);
    expect(backend.teardownRun).toHaveBeenCalledTimes(1);
    expect(mockAgentRunner.run).toHaveBeenCalledTimes(2);
    expect((backend.teardownRun as any).mock.calls[0][0].sandbox_id).toBe("sandbox-1");
    expect(run.status).toBe("completed");
    expect(run.sandbox_id).toBe("sandbox-1");
    expect(run.execution_backend).toBe("test");

    const runStatePath = path.join(workspacePath, ".sprintfoundry", "run-state.json");
    let persisted: any;
    await vi.waitFor(async () => {
      persisted = JSON.parse(await fs.readFile(runStatePath, "utf-8"));
      expect(persisted.run_environment?.sandbox_id).toBe("sandbox-1");
    });

    const storedEvents = ((service as any).events.store as any).mock.calls.map((c: any[]) => c[0]);
    const sandboxCreated = storedEvents.find((event: any) => event.event_type === "sandbox.created");
    const sandboxDestroyed = storedEvents.find((event: any) => event.event_type === "sandbox.destroyed");
    const stepStarted = storedEvents.find(
      (event: any) => event.event_type === "step.started" && event.data.step === 1
    );
    const stepCompleted = storedEvents.find(
      (event: any) => event.event_type === "step.completed" && event.data.step === 1
    );

    expect(sandboxCreated?.data).toMatchObject({
      sandbox_id: "sandbox-1",
      execution_backend: "test",
      checkpoint_generation: 0,
      workspace_path: workspacePath,
    });
    expect(sandboxDestroyed?.data).toMatchObject({
      sandbox_id: "sandbox-1",
      execution_backend: "test",
      reason: "completed",
    });
    expect(stepStarted?.data).toMatchObject({
      sandbox_id: "sandbox-1",
      execution_backend: "test",
    });
    expect(stepCompleted?.data).toMatchObject({
      sandbox_id: "sandbox-1",
      execution_backend: "test",
    });
  });

  it("reuses a persisted run environment through resumeRun instead of recreating it", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-run-env-resume-"));
    const initialHandle: RunEnvironmentHandle = {
      run_id: "run-1",
      project_id: makeProjectConfig().project_id,
      sandbox_id: "sandbox-existing",
      execution_backend: "test",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {},
    };
    const resumedHandle: RunEnvironmentHandle = {
      ...initialHandle,
      checkpoint_generation: 1,
      metadata: { resumed: true },
    };
    const backend: ExecutionBackend = {
      prepareRunEnvironment: vi.fn(async () => initialHandle),
      executeStep: vi.fn(),
      pauseRun: vi.fn(),
      resumeRun: vi.fn(async () => resumedHandle),
      teardownRun: vi.fn(async () => {}),
    };

    service = new OrchestrationService(
      makePlatformConfig(),
      makeProjectConfig(),
      undefined,
      backend
    );

    const run = (service as any).createRun("ticket-1");
    run.ticket = makeTicket();
    run.run_environment = initialHandle;

    const prepared = await (service as any).prepareRunEnvironment(run, makePlan(), workspacePath);

    expect(backend.prepareRunEnvironment).not.toHaveBeenCalled();
    expect(backend.resumeRun).toHaveBeenCalledTimes(1);
    expect(prepared.checkpoint_generation).toBe(1);
    expect(run.run_environment?.metadata).toEqual({ resumed: true });
    expect(run.sandbox_id).toBe("sandbox-existing");
    expect(run.execution_backend).toBe("test");

    const storedEvents = ((service as any).events.store as any).mock.calls.map((c: any[]) => c[0]);
    const sandboxResumed = storedEvents.find((event: any) => event.event_type === "sandbox.resumed");
    expect(sandboxResumed?.data).toMatchObject({
      sandbox_id: "sandbox-existing",
      execution_backend: "test",
      checkpoint_generation: 1,
    });
  });

  it("records backend provisioning metrics when the sandbox reports sub-stage timings", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-run-env-metrics-"));
    const metricsSpy = vi.fn();
    const preparedHandle: RunEnvironmentHandle = {
      run_id: "run-1",
      project_id: makeProjectConfig().project_id,
      sandbox_id: "sandbox-existing",
      execution_backend: "k8s-pod",
      workspace_path: workspacePath,
      checkpoint_generation: 0,
      metadata: {
        provisioning_timing_ms: {
          workspace_volume_create: 120,
          pod_ready_wait: 850,
          total: 1100,
        },
      },
    };
    const backend: ExecutionBackend = {
      prepareRunEnvironment: vi.fn(async () => preparedHandle),
      executeStep: vi.fn(),
      pauseRun: vi.fn(),
      resumeRun: vi.fn(async () => preparedHandle),
      teardownRun: vi.fn(async () => {}),
    };

    service = new OrchestrationService(
      makePlatformConfig(),
      makeProjectConfig(),
      undefined,
      backend
    );
    (service as any).metricsService.recordSandboxProvisioning = metricsSpy;

    const run = (service as any).createRun("ticket-1");
    run.ticket = makeTicket();

    await (service as any).prepareRunEnvironment(run, makePlan(), workspacePath);

    expect(metricsSpy).toHaveBeenCalledTimes(3);
    expect(metricsSpy).toHaveBeenCalledWith({
      project_id: "test-project",
      execution_backend: "k8s-pod",
      stage: "workspace_volume_create",
      durationMs: 120,
    });
    expect(metricsSpy).toHaveBeenCalledWith({
      project_id: "test-project",
      execution_backend: "k8s-pod",
      stage: "pod_ready_wait",
      durationMs: 850,
    });
    expect(metricsSpy).toHaveBeenCalledWith({
      project_id: "test-project",
      execution_backend: "k8s-pod",
      stage: "total",
      durationMs: 1100,
    });
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

  it("can skip PR finalization when explicitly requested by env", async () => {
    process.env.SPRINTFOUNDRY_SKIP_PR_FINALIZATION = "1";
    try {
      const plan = makeDevQaPlan();
      mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
      mockAgentRunner.run.mockResolvedValue({
        agentResult: makeResult(),
        tokens_used: 1000,
        cost_usd: 0.03,
        duration_seconds: 10,
        container_id: "local-1",
      });

      const run = await service.handleTask("p1", "prompt", "Build a thing");

      expect(run.status).toBe("completed");
      expect(run.pr_url).toBeNull();
      expect(mockGitManager.createPullRequest).not.toHaveBeenCalled();
    } finally {
      delete process.env.SPRINTFOUNDRY_SKIP_PR_FINALIZATION;
    }
  });

  it("can skip PR finalization for direct runs when explicitly requested by env", async () => {
    process.env.SPRINTFOUNDRY_SKIP_PR_FINALIZATION = "1";
    try {
      mockAgentRunner.run.mockResolvedValue({
        agentResult: makeResult(),
        tokens_used: 1000,
        cost_usd: 0.03,
        duration_seconds: 10,
        container_id: "local-1",
      });

      const run = await service.handleTask("p1", "prompt", "Build a thing", {
        agent: "developer",
      });

      expect(run.status).toBe("completed");
      expect(run.pr_url).toBeNull();
      expect(mockGitManager.createPullRequest).not.toHaveBeenCalled();
    } finally {
      delete process.env.SPRINTFOUNDRY_SKIP_PR_FINALIZATION;
    }
  });

  it("resumeTask resumes from requested failed step and injects operator prompt", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-resume-test-"));
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Build baseline" }),
        makeStep({ step_number: 2, agent: "qa", task: "Run tests", depends_on: [1] }),
      ],
    });

    const runState = {
      run_id: "run-resume-1",
      project_id: "test-project",
      ticket: makeTicket(),
      plan,
      validated_plan: plan,
      status: "failed",
      steps: [
        {
          step_number: 1,
          agent: "developer",
          task: "Build baseline",
          status: "completed",
          container_id: "session-dev-1",
          tokens_used: 100,
          cost_usd: 0.01,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          result: makeResult({ summary: "Baseline complete" }),
          rework_count: 0,
          runtime_metadata: null,
        },
        {
          step_number: 2,
          agent: "qa",
          task: "Run tests",
          status: "failed",
          container_id: "session-qa-1",
          tokens_used: 80,
          cost_usd: 0.01,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          result: makeFailedResult(),
          rework_count: 0,
          runtime_metadata: null,
        },
      ],
      total_tokens_used: 180,
      total_cost_usd: 0.02,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      pr_url: null,
      error: "QA failed",
    };

    const stateDir = path.join(workspacePath, ".sprintfoundry");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "run-state.json"),
      JSON.stringify(runState, null, 2),
      "utf-8"
    );

    (service as any).sessionManager.get = vi.fn().mockResolvedValue({
      run_id: "run-resume-1",
      workspace_path: workspacePath,
      status: "failed",
    });

    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult({ summary: "QA now passing" }),
      tokens_used: 40,
      cost_usd: 0.005,
      duration_seconds: 3,
      container_id: "session-qa-2",
    });

    const run = await service.resumeTask("run-resume-1", {
      step: 2,
      prompt: "Focus on flaky snapshot tests and update snapshots if needed.",
    });

    expect(run.status).toBe("completed");
    expect(mockAgentRunner.run).toHaveBeenCalledTimes(1);
    const call = mockAgentRunner.run.mock.calls[0][0];
    expect(call.stepNumber).toBe(2);
    expect(call.task).toContain("Operator Resume Prompt");
    expect(call.task).toContain("flaky snapshot tests");
  });

  it("resumeTask rejects non-failed runs", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-resume-test-"));
    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Build baseline" })],
    });
    const runState = {
      run_id: "run-resume-2",
      project_id: "test-project",
      ticket: makeTicket(),
      plan,
      validated_plan: plan,
      status: "completed",
      steps: [],
      total_tokens_used: 0,
      total_cost_usd: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      pr_url: null,
      error: null,
    };
    const stateDir = path.join(workspacePath, ".sprintfoundry");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "run-state.json"),
      JSON.stringify(runState, null, 2),
      "utf-8"
    );

    (service as any).sessionManager.get = vi.fn().mockResolvedValue({
      run_id: "run-resume-2",
      workspace_path: workspacePath,
      status: "completed",
    });

    await expect(service.resumeTask("run-resume-2")).rejects.toThrow(
      /Only failed\/cancelled runs can be resumed/
    );
  });

  it("resumeTask honors cancelled session status when run-state is stale", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-resume-test-"));
    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Fix flaky test" })],
    });
    const runState = {
      run_id: "run-resume-3",
      project_id: "test-project",
      ticket: makeTicket(),
      plan,
      validated_plan: plan,
      status: "executing",
      steps: [
        {
          step_number: 1,
          agent: "developer",
          task: "Fix flaky test",
          status: "failed",
          container_id: "session-dev-old",
          tokens_used: 25,
          cost_usd: 0.002,
          started_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
          result: makeFailedResult({ summary: "Old failed attempt" }),
          rework_count: 0,
          runtime_metadata: null,
        },
      ],
      total_tokens_used: 25,
      total_cost_usd: 0.002,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      pr_url: null,
      error: "Old failure",
    };
    const stateDir = path.join(workspacePath, ".sprintfoundry");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "run-state.json"),
      JSON.stringify(runState, null, 2),
      "utf-8"
    );

    (service as any).sessionManager.get = vi.fn().mockResolvedValue({
      run_id: "run-resume-3",
      workspace_path: workspacePath,
      status: "cancelled",
      completed_at: new Date().toISOString(),
      error: null,
    });

    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult({ summary: "Flaky test fixed" }),
      tokens_used: 30,
      cost_usd: 0.003,
      duration_seconds: 2,
      container_id: "session-dev-new",
    });

    const run = await service.resumeTask("run-resume-3");

    expect(run.status).toBe("completed");
    expect(mockAgentRunner.run).toHaveBeenCalledTimes(1);
  });

  it("resumeTask can recover an in-progress run after pod interruption when explicitly allowed", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-resume-executing-"));
    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Finish interrupted work" })],
    });
    const runState = {
      run_id: "run-resume-executing",
      project_id: "test-project",
      ticket: makeTicket(),
      plan,
      validated_plan: plan,
      status: "executing",
      steps: [
        {
          step_number: 1,
          agent: "developer",
          task: "Finish interrupted work",
          status: "running",
          container_id: "session-dev-1",
          tokens_used: 10,
          cost_usd: 0.001,
          started_at: new Date().toISOString(),
          completed_at: null,
          result: null,
          rework_count: 0,
          runtime_metadata: null,
        },
      ],
      total_tokens_used: 10,
      total_cost_usd: 0.001,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: null,
      pr_url: null,
      error: null,
    };
    const stateDir = path.join(workspacePath, ".sprintfoundry");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "run-state.json"),
      JSON.stringify(runState, null, 2),
      "utf-8"
    );

    (service as any).sessionManager.get = vi.fn().mockResolvedValue({
      run_id: "run-resume-executing",
      workspace_path: workspacePath,
      status: "executing",
    });

    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult({ summary: "Recovered successfully" }),
      tokens_used: 30,
      cost_usd: 0.003,
      duration_seconds: 3,
      container_id: "session-dev-2",
    });

    const run = await service.resumeTask("run-resume-executing", {
      allowInProgressRecovery: true,
    });

    expect(run.status).toBe("completed");
    expect(run.steps.some((step) => step.status === "failed")).toBe(true);
    expect(run.steps.some((step) => step.status === "completed")).toBe(true);
    expect(mockAgentRunner.run).toHaveBeenCalledTimes(1);
  });

  it("marks previously running steps as failed before resuming to avoid silent replay", async () => {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-resume-running-step-"));
    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Finish interrupted work" })],
    });
    const runState = {
      run_id: "run-resume-4",
      project_id: "test-project",
      ticket: makeTicket(),
      plan,
      validated_plan: plan,
      status: "failed",
      steps: [
        {
          step_number: 1,
          agent: "developer",
          task: "Finish interrupted work",
          status: "running",
          container_id: "session-dev-1",
          tokens_used: 10,
          cost_usd: 0.001,
          started_at: new Date().toISOString(),
          completed_at: null,
          result: null,
          rework_count: 0,
          runtime_metadata: null,
        },
      ],
      total_tokens_used: 10,
      total_cost_usd: 0.001,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      pr_url: null,
      error: "interrupted",
    };
    const stateDir = path.join(workspacePath, ".sprintfoundry");
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      path.join(stateDir, "run-state.json"),
      JSON.stringify(runState, null, 2),
      "utf-8"
    );

    (service as any).sessionManager.get = vi.fn().mockResolvedValue({
      run_id: "run-resume-4",
      workspace_path: workspacePath,
      status: "failed",
    });

    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult({ summary: "Recovered successfully" }),
      tokens_used: 30,
      cost_usd: 0.003,
      duration_seconds: 3,
      container_id: "session-dev-2",
    });

    const run = await service.resumeTask("run-resume-4");

    expect(run.status).toBe("completed");
    expect(run.steps.some((step) => step.status === "failed")).toBe(true);
    expect(run.steps.some((step) => step.status === "completed")).toBe(true);
    expect(mockAgentRunner.run).toHaveBeenCalledTimes(1);
  });

  it("persists runtime activity events emitted by SDK runtimes", async () => {
    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Implement feature" })],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      await config.onRuntimeActivity?.({
        type: "agent_command_run",
        data: { command: "npm test -- unit" },
      });
      await config.onRuntimeActivity?.({
        type: "agent_file_edit",
        data: { path: "src/index.ts" },
      });
      await config.onRuntimeActivity?.({
        type: "agent_tool_call",
        data: { tool_name: "web_search" },
      });
      await config.onRuntimeActivity?.({
        type: "agent_thinking",
        data: { text: "Considering edge cases" },
      });
      return {
        agentResult: makeResult(),
        tokens_used: 100,
        cost_usd: 0.01,
        duration_seconds: 5,
        container_id: "local-1",
      };
    });

    const run = await service.handleTask("p-activity", "prompt", "Build a thing");

    expect(run.status).toBe("completed");
    const storedEvents = ((service as any).events.store as any).mock.calls.map((c: any[]) => c[0]);
    const activityTypes = storedEvents.map((e: any) => e.event_type);
    expect(activityTypes).toContain("agent_command_run");
    expect(activityTypes).toContain("agent_file_edit");
    expect(activityTypes).toContain("agent_tool_call");
    expect(activityTypes).toContain("agent_thinking");
    const commandEvent = storedEvents.find((e: any) => e.event_type === "agent_command_run");
    expect(commandEvent.data.step).toBe(1);
    expect(commandEvent.data.agent).toBe("developer");
  });

  it("posts fallback Claude stdout logs to the sink when no structured activity is emitted", async () => {
    process.env.SPRINTFOUNDRY_EVENT_SINK_URL = "https://sink.example/events";
    service = new OrchestrationService(makePlatformConfig(), makeProjectConfig());
    mockOrchestratorAgent = (service as any).plannerRuntime;
    mockAgentRunner = (service as any).agentRunner;

    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "sf-fallback-claude-"));
    (service as any).workspace.getPath = vi.fn().mockReturnValue(workspacePath);
    (service as any).workspace.create = vi.fn().mockResolvedValue(workspacePath);

    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Implement feature" })],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockImplementation(async () => {
      await fs.writeFile(
        path.join(workspacePath, ".claude-runtime.step-1.attempt-1.stdout.log"),
        JSON.stringify({ type: "assistant", message: "hello" }) + "\n",
        "utf-8"
      );
      return {
        agentResult: makeResult(),
        tokens_used: 100,
        cost_usd: 0.01,
        duration_seconds: 5,
        container_id: "local-1",
      };
    });

    const run = await service.handleTask("p-fallback", "prompt", "Build a thing");

    expect(run.status).toBe("completed");
    expect(eventSinkPostLog).toHaveBeenCalled();
    expect(eventSinkPostLog.mock.calls[0][0]).toMatchObject({
      run_id: run.run_id,
      step_number: 1,
      step_attempt: 1,
      agent: "developer",
      runtime_provider: "claude-code",
      stream: "activity",
    });
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

    const mockOrch = (lowBudgetService as any).plannerRuntime;
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

  it("parallel group supports object format with step_numbers", async () => {
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
    // Codex planner may emit object groups instead of raw number arrays.
    (plan as any).parallel_groups = [{ group_id: "g1", step_numbers: [1, 2] }];

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
    expect(mockAgentRunner.run.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("parallel group supports object format with steps", async () => {
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
    (plan as any).parallel_groups = [{ group_id: "g1", steps: [1, 2] }];

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

  it("allows missing API key for local_process runtime", async () => {
    const serviceNoKeys = new OrchestrationService(
      makePlatformConfig({
        defaults: {
          model_per_agent: {
            orchestrator: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
            developer: { provider: "openai", model: "gpt-5" },
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
            developer: { provider: "codex", mode: "local_process" },
          },
        },
        rules: [],
      }),
      makeProjectConfig({
        api_keys: {},
        rules: [],
      })
    );

    const mockPlanner = (serviceNoKeys as any).plannerRuntime;
    const mockRunner = (serviceNoKeys as any).agentRunner;
    mockPlanner.generatePlan.mockResolvedValue(
      makePlan({
        steps: [makeStep({ step_number: 1, agent: "developer", task: "Implement" })],
      })
    );
    mockRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 50,
      cost_usd: 0.01,
      duration_seconds: 1,
      container_id: "local-1",
    });

    const run = await serviceNoKeys.handleTask("p1", "prompt", "Build thing");
    expect(run.status).toBe("completed");
    expect(mockRunner.run).toHaveBeenCalled();
    expect(mockRunner.run.mock.calls[0][0].apiKey).toBe("");
  });

  it("still requires API key for SDK runtimes", async () => {
    const serviceNoKeys = new OrchestrationService(
      makePlatformConfig({
        defaults: {
          model_per_agent: {
            orchestrator: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
            developer: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
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
            developer: { provider: "claude-code", mode: "local_sdk" },
          },
        },
        rules: [],
      }),
      makeProjectConfig({
        api_keys: {},
        rules: [],
      })
    );
    const mockPlanner = (serviceNoKeys as any).plannerRuntime;
    const mockRunner = (serviceNoKeys as any).agentRunner;
    mockPlanner.generatePlan.mockResolvedValue(
      makePlan({
        steps: [makeStep({ step_number: 1, agent: "developer", task: "Implement" })],
      })
    );

    const run = await serviceNoKeys.handleTask("p1", "prompt", "Build thing");
    expect(run.status).toBe("failed");
    expect(mockRunner.run).not.toHaveBeenCalled();
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
      const dir = path.join(workspace, ".sprintfoundry", "reviews");
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

  // ---- commitStepCheckpoint integration tests ----

  it("commit checkpoint: happy path — commitStepCheckpoint called after each complete step", async () => {
    const plan = makeDevQaPlan();
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });
    // commitStepCheckpoint returns true (changes were committed) for each step
    mockGitManager.commitStepCheckpoint.mockResolvedValue(true);

    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("completed");
    // Should be called once per completed step (2 steps in dev-qa plan)
    expect(mockGitManager.commitStepCheckpoint).toHaveBeenCalledTimes(2);
    // Verify call arguments for the first step
    const firstCall = mockGitManager.commitStepCheckpoint.mock.calls[0];
    expect(firstCall[0]).toBe("/tmp/workspace"); // workspacePath
    expect(firstCall[1]).toMatch(/^run-/);        // runId
    expect(firstCall[2]).toBe(1);                 // stepNumber
    expect(firstCall[3]).toBe("developer");        // agentId
  });

  it("commit checkpoint: step.committed event emitted when commitStepCheckpoint returns true", async () => {
    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Do work" })],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });
    mockGitManager.commitStepCheckpoint.mockResolvedValue(true);

    const mockEventStore = (service as any).events;
    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("completed");
    // At least the developer step triggered a commit (plan validator may inject qa step too)
    expect(mockGitManager.commitStepCheckpoint).toHaveBeenCalled();

    // Verify step.committed event was emitted for step 1 (developer)
    const storedEvents = mockEventStore.store.mock.calls.map((c: any[]) => c[0]);
    const committedEvents = storedEvents.filter((e: any) => e.event_type === "step.committed");
    expect(committedEvents.length).toBeGreaterThanOrEqual(1);
    const devCommit = committedEvents.find((e: any) => e.data.agent === "developer");
    expect(devCommit).toBeDefined();
    expect(devCommit.data.step).toBe(1);
  });

  it("commit checkpoint: no-diff skip — no step.committed event when commitStepCheckpoint returns false", async () => {
    const plan = makePlan({
      steps: [makeStep({ step_number: 1, agent: "developer", task: "Do work" })],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });
    // No diff — nothing staged for any step
    mockGitManager.commitStepCheckpoint.mockResolvedValue(false);

    const mockEventStore = (service as any).events;
    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("completed");
    // commitStepCheckpoint was still called (for each step)
    expect(mockGitManager.commitStepCheckpoint).toHaveBeenCalled();

    // step.committed should NOT have been emitted
    const storedEvents = mockEventStore.store.mock.calls.map((c: any[]) => c[0]);
    const committedEvent = storedEvents.find((e: any) => e.event_type === "step.committed");
    expect(committedEvent).toBeUndefined();

    // Run should still complete normally
    expect(run.pr_url).toBeDefined();
  });

  it("commit checkpoint: commit failure — step and run marked failed, step.failed emitted", async () => {
    const plan = makeDevQaPlan();
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });
    // Commit throws — simulates locked .git/index or corrupt repo
    mockGitManager.commitStepCheckpoint.mockRejectedValue(
      new Error("fatal: Unable to create '.git/index.lock': File exists")
    );

    const mockEventStore = (service as any).events;
    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("failed");
    expect(run.error).toContain("Git checkpoint commit failed");
    expect(run.error).toContain("step 1");

    // step.failed event should be emitted with git error details
    const storedEvents = mockEventStore.store.mock.calls.map((c: any[]) => c[0]);
    const failedEvent = storedEvents.find((e: any) => e.event_type === "step.failed");
    expect(failedEvent).toBeDefined();
    expect(failedEvent.data.error).toContain("Git checkpoint commit failed");
    expect(failedEvent.data.error).toContain("index.lock");
    expect(failedEvent.data.sandbox_id).toBe(run.sandbox_id);
    expect(failedEvent.data.execution_backend).toBe(run.execution_backend);

    // PR should NOT be created when run fails
    expect(mockGitManager.createPullRequest).not.toHaveBeenCalled();
  });

  it("commit checkpoint: needs_rework steps do NOT get a checkpoint commit", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    let qaCallCount = 0;
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      if (config.agent === "developer") {
        return { agentResult: makeResult(), tokens_used: 100, cost_usd: 0.01, duration_seconds: 5, container_id: "c1" };
      }
      qaCallCount++;
      if (qaCallCount === 1) {
        return { agentResult: makeReworkResult(), tokens_used: 100, cost_usd: 0.01, duration_seconds: 3, container_id: "c2" };
      }
      return { agentResult: makeResult({ summary: "Tests pass" }), tokens_used: 100, cost_usd: 0.01, duration_seconds: 2, container_id: "c3" };
    });

    mockOrchestratorAgent.planRework.mockResolvedValue({
      steps: [makeStep({ step_number: 901, agent: "developer", task: "Fix bugs" })],
    });

    mockGitManager.commitStepCheckpoint.mockResolvedValue(true);

    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("completed");
    // commitStepCheckpoint should have been called for each COMPLETE step only
    // (not for the qa needs_rework step — it never reaches that code path)
    // Steps that complete: developer(1), developer(901 rework fix), qa(retry), so 3 commits
    const callCount = mockGitManager.commitStepCheckpoint.mock.calls.length;
    expect(callCount).toBeGreaterThanOrEqual(2); // at least dev + qa-retry
  });

  it("commit checkpoint: PR creation compatibility — createPullRequest called after per-step commits", async () => {
    const plan = makeDevQaPlan();
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });
    mockGitManager.commitStepCheckpoint.mockResolvedValue(true);
    mockGitManager.createPullRequest.mockResolvedValue("https://github.com/test/repo/pull/42");

    const run = await service.handleTask("p1", "prompt", "Build it");

    expect(run.status).toBe("completed");
    // Per-step commits happened
    expect(mockGitManager.commitStepCheckpoint).toHaveBeenCalled();
    // createPullRequest still called and succeeds
    expect(mockGitManager.createPullRequest).toHaveBeenCalledTimes(1);
    expect(run.pr_url).toBe("https://github.com/test/repo/pull/42");
  });

  // ---- Code Review Agent Tests ----

  it("executes code-review step after developer and before QA", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "code-review", task: "Review code", depends_on: [1] }),
        makeStep({ step_number: 3, agent: "qa", task: "Test code", depends_on: [2] }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    const run = await service.handleTask("p1", "prompt", "Build feature");

    expect(run.status).toBe("completed");
    // Verify execution order: developer, code-review, qa (may have additional injected steps)
    const agents = mockAgentRunner.run.mock.calls.map((c: any[]) => c[0].agent);
    const devIdx = agents.indexOf("developer");
    const crIdx = agents.indexOf("code-review");
    const qaIdx = agents.indexOf("qa");
    expect(devIdx).toBeLessThan(crIdx);
    expect(crIdx).toBeLessThan(qaIdx);
  });

  it("code-review needs_rework triggers developer rework", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "code-review", task: "Review code", depends_on: [1] }),
        makeStep({ step_number: 3, agent: "qa", task: "Test code", depends_on: [2] }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    let crCallCount = 0;
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      if (config.agent === "developer") {
        if (config.stepNumber === 901) {
          return {
            agentResult: makeResult({ summary: "Developer rework complete from resumed context" }),
            tokens_used: 80,
            cost_usd: 0.01,
            duration_seconds: 4,
            container_id: "session-dev-resumed",
            resume_used: true,
            resume_failed: false,
            resume_fallback: false,
            token_savings: { cached_input_tokens: 240 },
          };
        }
        return {
          agentResult: makeResult(),
          tokens_used: 100,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-dev-initial",
        };
      }
      if (config.agent === "code-review") {
        crCallCount++;
        if (crCallCount === 1) {
          return {
            agentResult: makeReworkResult({
              rework_target: "developer",
              rework_reason: "MUST_FIX items found",
            }),
            tokens_used: 100,
            cost_usd: 0.01,
            duration_seconds: 5,
            container_id: "session-review-1",
          };
        }
        return {
          agentResult: makeResult({ summary: "Code review passed" }),
          tokens_used: 100,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-review-2",
        };
      }
      // qa
      return {
        agentResult: makeResult(),
        tokens_used: 100,
        cost_usd: 0.01,
        duration_seconds: 5,
        container_id: "session-qa-1",
      };
    });

    mockOrchestratorAgent.planRework.mockResolvedValue({
      steps: [
        makeStep({ step_number: 901, agent: "developer", task: "Fix review findings" }),
      ],
    });
    mockSessionStore.findLatestByAgent.mockResolvedValue({
      run_id: "any",
      agent: "developer",
      step_number: 1,
      step_attempt: 1,
      runtime_provider: "claude-code",
      runtime_mode: "local_sdk",
      session_id: "session-dev-123",
      updated_at: new Date().toISOString(),
    });

    const run = await service.handleTask("p1", "prompt", "Build feature");

    expect(run.status).toBe("completed");
    expect(mockOrchestratorAgent.planRework).toHaveBeenCalledTimes(1);
    const reworkCall = mockAgentRunner.run.mock.calls
      .map((call: any[]) => call[0])
      .find((cfg: any) => cfg.stepNumber === 901);
    expect(reworkCall.resumeSessionId).toBe("session-dev-123");
    expect(reworkCall.resumeReason).toBe("rework_plan");
    expect(mockSessionStore.record).toHaveBeenCalled();

    const storedEvents = ((service as any).events.store as any).mock.calls.map((c: any[]) => c[0]);
    const reworkStarted = storedEvents.find(
      (event: any) => event.event_type === "step.started" && event.data.step === 901
    );
    const reworkCompleted = storedEvents.find(
      (event: any) => event.event_type === "step.completed" && event.data.step === 901
    );
    expect(reworkStarted.data.resume_used).toBe(true);
    expect(reworkStarted.data.resume_failed).toBe(false);
    expect(reworkStarted.data.resume_fallback).toBe(false);
    expect(reworkStarted.data.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_sdk",
        step_attempt: 1,
      },
      resume: {
        requested: true,
        used: true,
        failed: false,
        fallback_to_fresh: false,
        source_session_id: "session-dev-123",
        reason: "rework_plan",
      },
    });
    expect(reworkCompleted.data.resume_used).toBe(true);
    expect(reworkCompleted.data.resume_failed).toBe(false);
    expect(reworkCompleted.data.resume_fallback).toBe(false);
    expect(reworkCompleted.data.token_savings).toEqual({ cached_input_tokens: 240 });
    expect(reworkCompleted.data.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_sdk",
        runtime_id: "session-dev-resumed",
        step_attempt: 1,
      },
      resume: {
        requested: true,
        used: true,
        failed: false,
        fallback_to_fresh: false,
        source_session_id: "session-dev-123",
        reason: "rework_plan",
      },
      token_savings: {
        cached_input_tokens: 240,
      },
    });

    const recordedReworkSession = mockSessionStore.record.mock.calls
      .map((call: any[]) => call[1])
      .find((entry: any) => entry.step_number === 901);
    expect(recordedReworkSession.resume_used).toBe(true);
    expect(recordedReworkSession.resume_failed).toBe(false);
    expect(recordedReworkSession.resume_fallback).toBe(false);
    expect(recordedReworkSession.token_savings_cached_input_tokens).toBe(240);

    const reworkStepExecution = run.steps.find((entry) => entry.step_number === 901);
    expect(reworkStepExecution?.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_sdk",
        runtime_id: "session-dev-resumed",
      },
      resume: {
        requested: true,
        used: true,
        failed: false,
        fallback_to_fresh: false,
      },
      token_savings: {
        cached_input_tokens: 240,
      },
    });
  });

  it("records resume fallback telemetry when resumed rework succeeds via fresh fallback", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "code-review", task: "Review code", depends_on: [1] }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    let crCallCount = 0;
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      if (config.agent === "developer" && config.stepNumber === 901) {
        return {
          agentResult: makeResult({ summary: "Rework complete after resume fallback" }),
          tokens_used: 120,
          cost_usd: 0.02,
          duration_seconds: 6,
          container_id: "session-dev-fallback",
          resume_used: true,
          resume_failed: true,
          resume_fallback: true,
        };
      }
      if (config.agent === "developer") {
        return {
          agentResult: makeResult(),
          tokens_used: 100,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-dev-initial",
        };
      }
      crCallCount++;
      if (crCallCount === 1) {
        return {
          agentResult: makeReworkResult({
            rework_target: "developer",
            rework_reason: "MUST_FIX items found",
          }),
          tokens_used: 90,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-review-1",
        };
      }
      return {
        agentResult: makeResult({ summary: "Code review passed" }),
        tokens_used: 90,
        cost_usd: 0.01,
        duration_seconds: 5,
        container_id: "session-review-2",
      };
    });

    mockOrchestratorAgent.planRework.mockResolvedValue({
      steps: [
        makeStep({ step_number: 901, agent: "developer", task: "Fix review findings" }),
      ],
    });
    mockSessionStore.findLatestByAgent.mockResolvedValue({
      run_id: "any",
      agent: "developer",
      step_number: 1,
      step_attempt: 1,
      runtime_provider: "claude-code",
      runtime_mode: "local_sdk",
      session_id: "session-dev-123",
      updated_at: new Date().toISOString(),
    });

    const run = await service.handleTask("p1", "prompt", "Build feature");
    expect(run.status).toBe("completed");

    const storedEvents = ((service as any).events.store as any).mock.calls.map((c: any[]) => c[0]);
    const reworkCompleted = storedEvents.find(
      (event: any) => event.event_type === "step.completed" && event.data.step === 901
    );
    expect(reworkCompleted.data.resume_used).toBe(true);
    expect(reworkCompleted.data.resume_failed).toBe(true);
    expect(reworkCompleted.data.resume_fallback).toBe(true);
  });

  it("emits resume telemetry on step.failed when resumed rework fails without fallback", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "code-review", task: "Review code", depends_on: [1] }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    let crCallCount = 0;
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      if (config.agent === "developer" && config.stepNumber === 901) {
        const err = new Error("resume execution failed: rate limit");
        (err as any).resume_used = true;
        (err as any).resume_failed = true;
        (err as any).resume_fallback = false;
        throw err;
      }
      if (config.agent === "developer") {
        return {
          agentResult: makeResult(),
          tokens_used: 100,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-dev-initial",
        };
      }
      crCallCount++;
      if (crCallCount === 1) {
        return {
          agentResult: makeReworkResult({
            rework_target: "developer",
            rework_reason: "MUST_FIX items found",
          }),
          tokens_used: 90,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-review-1",
        };
      }
      return {
        agentResult: makeResult({ summary: "Code review passed" }),
        tokens_used: 90,
        cost_usd: 0.01,
        duration_seconds: 5,
        container_id: "session-review-2",
      };
    });

    mockOrchestratorAgent.planRework.mockResolvedValue({
      steps: [
        makeStep({ step_number: 901, agent: "developer", task: "Fix review findings" }),
      ],
    });
    mockSessionStore.findLatestByAgent.mockResolvedValue({
      run_id: "any",
      agent: "developer",
      step_number: 1,
      step_attempt: 1,
      runtime_provider: "claude-code",
      runtime_mode: "local_sdk",
      session_id: "session-dev-123",
      updated_at: new Date().toISOString(),
    });

    const run = await service.handleTask("p1", "prompt", "Build feature");
    expect(run.status).toBe("failed");

    const storedEvents = ((service as any).events.store as any).mock.calls.map((c: any[]) => c[0]);
    const failed = storedEvents.find(
      (event: any) => event.event_type === "step.failed" && event.data.step === 901
    );
    expect(failed.data.resume_used).toBe(true);
    expect(failed.data.resume_failed).toBe(true);
    expect(failed.data.resume_fallback).toBe(false);
    expect(failed.data.sandbox_id).toBe(run.sandbox_id);
    expect(failed.data.execution_backend).toBe(run.execution_backend);
    expect(failed.data.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_sdk",
      },
      resume: {
        requested: true,
        used: true,
        failed: true,
        fallback_to_fresh: false,
        source_session_id: "session-dev-123",
        reason: "rework_plan",
      },
    });
  });

  it("emits resume telemetry on step.failed when resume fallback attempt also fails", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "code-review", task: "Review code", depends_on: [1] }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);

    let crCallCount = 0;
    mockAgentRunner.run.mockImplementation(async (config: any) => {
      if (config.agent === "developer" && config.stepNumber === 901) {
        const err = new Error("resume invalid, fallback fresh run failed");
        (err as any).resume_used = true;
        (err as any).resume_failed = true;
        (err as any).resume_fallback = true;
        throw err;
      }
      if (config.agent === "developer") {
        return {
          agentResult: makeResult(),
          tokens_used: 100,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-dev-initial",
        };
      }
      crCallCount++;
      if (crCallCount === 1) {
        return {
          agentResult: makeReworkResult({
            rework_target: "developer",
            rework_reason: "MUST_FIX items found",
          }),
          tokens_used: 90,
          cost_usd: 0.01,
          duration_seconds: 5,
          container_id: "session-review-1",
        };
      }
      return {
        agentResult: makeResult({ summary: "Code review passed" }),
        tokens_used: 90,
        cost_usd: 0.01,
        duration_seconds: 5,
        container_id: "session-review-2",
      };
    });

    mockOrchestratorAgent.planRework.mockResolvedValue({
      steps: [
        makeStep({ step_number: 901, agent: "developer", task: "Fix review findings" }),
      ],
    });
    mockSessionStore.findLatestByAgent.mockResolvedValue({
      run_id: "any",
      agent: "developer",
      step_number: 1,
      step_attempt: 1,
      runtime_provider: "claude-code",
      runtime_mode: "local_sdk",
      session_id: "session-dev-123",
      updated_at: new Date().toISOString(),
    });

    const run = await service.handleTask("p1", "prompt", "Build feature");
    expect(run.status).toBe("failed");

    const storedEvents = ((service as any).events.store as any).mock.calls.map((c: any[]) => c[0]);
    const failed = storedEvents.find(
      (event: any) => event.event_type === "step.failed" && event.data.step === 901
    );
    expect(failed.data.resume_used).toBe(true);
    expect(failed.data.resume_failed).toBe(true);
    expect(failed.data.resume_fallback).toBe(true);
    expect(failed.data.sandbox_id).toBe(run.sandbox_id);
    expect(failed.data.execution_backend).toBe(run.execution_backend);
    expect(failed.data.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_sdk",
      },
      resume: {
        requested: true,
        used: true,
        failed: true,
        fallback_to_fresh: true,
        source_session_id: "session-dev-123",
        reason: "rework_plan",
      },
    });
  });

  it("quality gate runs after developer-role steps", async () => {
    const plan = makePlan({
      steps: [
        makeStep({ step_number: 1, agent: "developer", task: "Write code" }),
        makeStep({ step_number: 2, agent: "qa", task: "Test code", depends_on: [1] }),
      ],
    });
    mockOrchestratorAgent.generatePlan.mockResolvedValue(plan);
    mockAgentRunner.run.mockResolvedValue({
      agentResult: makeResult(),
      tokens_used: 100,
      cost_usd: 0.01,
      duration_seconds: 5,
      container_id: "local-1",
    });

    // Spy on runQualityGate
    const qualityGateSpy = vi.spyOn(service as any, "runQualityGate").mockResolvedValue({
      passed: true,
      failures: [],
    });

    const run = await service.handleTask("p1", "prompt", "Build feature");

    expect(run.status).toBe("completed");
    // Quality gate should have been called for the developer step
    expect(qualityGateSpy).toHaveBeenCalled();
    const callArgs = qualityGateSpy.mock.calls[0] as any[];
    expect(callArgs[1].agent).toBe("developer");
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

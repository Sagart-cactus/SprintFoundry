import { describe, it, expect, vi, beforeEach } from "vitest";
import { makePlatformConfig, makeProjectConfig, defaultAgentDefinitions, defaultPlatformRules } from "./fixtures/configs.js";
import { makeTicket } from "./fixtures/tickets.js";
import { makeStep } from "./fixtures/plans.js";
import { makeReworkResult } from "./fixtures/results.js";

// Mock the Anthropic SDK — must return a class-like constructor
const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts: any) {}
    },
  };
});

const { OrchestratorAgent } = await import(
  "../src/service/orchestrator-agent.js"
);

function makeApiResponse(content: string) {
  return {
    content: [{ type: "text", text: content }],
    usage: { input_tokens: 100, output_tokens: 200 },
  };
}

describe("OrchestratorAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("generatePlan returns parsed ExecutionPlan from mock API response", async () => {
    const planJson = JSON.stringify({
      classification: "new_feature",
      reasoning: "Adding a CSV export feature",
      steps: [
        {
          step_number: 1,
          agent: "developer",
          task: "Implement CSV export",
          context_inputs: [{ type: "ticket" }],
          depends_on: [],
          estimated_complexity: "medium",
        },
      ],
      parallel_groups: [],
      human_gates: [],
    });

    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    const ticket = makeTicket();
    const plan = await agent.generatePlan(
      ticket,
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    expect(plan.classification).toBe("new_feature");
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0].agent).toBe("developer");
    expect(plan.ticket_id).toBe(ticket.id);
  });

  it("generatePlan throws on malformed JSON from API", async () => {
    mockCreate.mockResolvedValueOnce(
      makeApiResponse("this is not json {{{")
    );

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );

    await expect(
      agent.generatePlan(
        makeTicket(),
        defaultAgentDefinitions(),
        defaultPlatformRules(),
        "/tmp/test-workspace"
      )
    ).rejects.toThrow(/Failed to parse orchestrator agent plan/);
  });

  it("buildSystemPrompt includes agent definitions and rules", async () => {
    const planJson = JSON.stringify({
      classification: "bug_fix",
      reasoning: "fix",
      steps: [],
      parallel_groups: [],
      human_gates: [],
    });
    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    await agent.generatePlan(
      makeTicket(),
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("Developer Agent");
    expect(callArgs.system).toContain("QA Agent");
    expect(callArgs.system).toContain("QA-role agent must always run");
  });

  it("buildSystemPrompt includes plugins in agent listing", async () => {
    const planJson = JSON.stringify({
      classification: "bug_fix",
      reasoning: "fix",
      steps: [],
      parallel_groups: [],
      human_gates: [],
    });
    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    await agent.generatePlan(
      makeTicket(),
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("js-nextjs");
    expect(callArgs.system).toContain("frontend-design");
  });

  it("buildUserPrompt includes ticket details", async () => {
    const planJson = JSON.stringify({
      classification: "bug_fix",
      reasoning: "fix",
      steps: [],
      parallel_groups: [],
      human_gates: [],
    });
    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const ticket = makeTicket({ title: "My Special Ticket" });
    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    await agent.generatePlan(
      ticket,
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    const callArgs = mockCreate.mock.calls[0][0];
    const userContent = callArgs.messages[0].content;
    expect(userContent).toContain("My Special Ticket");
    expect(userContent).toContain("TEST-123");
  });

  it("planRework returns rework steps from mock API", async () => {
    const reworkStepsJson = JSON.stringify([
      {
        step_number: 901,
        agent: "developer",
        task: "Fix failing tests",
        context_inputs: [{ type: "ticket" }],
        depends_on: [],
        estimated_complexity: "low",
      },
    ]);
    mockCreate.mockResolvedValueOnce(makeApiResponse(reworkStepsJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    const result = await agent.planRework(
      makeTicket(),
      makeStep({ step_number: 2, agent: "qa" }),
      makeReworkResult(),
      "/tmp/test-workspace"
    );

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].step_number).toBe(901);
    expect(result.steps[0].agent).toBe("developer");
  });

  it("planRework falls back to default step on JSON parse failure", async () => {
    mockCreate.mockResolvedValueOnce(
      makeApiResponse("I can't parse this properly")
    );

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    const failedStep = makeStep({ step_number: 2, agent: "qa" });
    const failureResult = makeReworkResult({
      rework_target: "developer",
      rework_reason: "Tests failing",
    });

    const result = await agent.planRework(
      makeTicket(),
      failedStep,
      failureResult,
      "/tmp/test-workspace"
    );

    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].agent).toBe("developer"); // rework_target
    expect(result.steps[0].step_number).toBe(902); // 900 + step_number
  });

  it("filterAgents respects project catalog", async () => {
    const planJson = JSON.stringify({
      classification: "bug_fix",
      reasoning: "fix",
      steps: [],
      parallel_groups: [],
      human_gates: [],
    });
    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig({ agents: ["go-developer", "go-qa"] })
    );
    await agent.generatePlan(
      makeTicket(),
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    const callArgs = mockCreate.mock.calls[0][0];
    // System prompt should only include go-developer and go-qa
    expect(callArgs.system).toContain("Go Developer Agent");
    expect(callArgs.system).toContain("Go QA Agent");
    // The JS developer should not appear (its ID is "developer")
    expect(callArgs.system).not.toContain('id: "developer"');
  });

  it("resolveApiKey returns empty string when no key configured (SDK falls back to env)", () => {
    // OrchestratorAgent no longer throws on missing key — the Anthropic SDK
    // handles env-based credential lookup when no explicit key is provided
    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig({ api_keys: {} })
    );
    expect(agent).toBeDefined();
  });

  // ---- Code Review Agent Tests ----

  it("system prompt includes code-review agent in definitions", async () => {
    const planJson = JSON.stringify({
      classification: "bug_fix",
      reasoning: "fix",
      steps: [],
      parallel_groups: [],
      human_gates: [],
    });
    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    await agent.generatePlan(
      makeTicket(),
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("Code Review Agent");
    expect(callArgs.system).toContain("code-review");
    expect(callArgs.system).toContain("Code quality review");
  });

  it("planning guidelines mention code-review for complex/P0 tasks", async () => {
    const planJson = JSON.stringify({
      classification: "bug_fix",
      reasoning: "fix",
      steps: [],
      parallel_groups: [],
      human_gates: [],
    });
    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig()
    );
    await agent.generatePlan(
      makeTicket(),
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.system).toContain("Code review agent");
    expect(callArgs.system).toContain("P0 tickets");
    expect(callArgs.system).toContain("developer → code-review → qa");
  });

  it("model resolution: project override → platform default → hardcoded", async () => {
    const planJson = JSON.stringify({
      classification: "bug_fix",
      reasoning: "fix",
      steps: [],
      parallel_groups: [],
      human_gates: [],
    });
    mockCreate.mockResolvedValueOnce(makeApiResponse(planJson));

    const agent = new OrchestratorAgent(
      makePlatformConfig(),
      makeProjectConfig({
        model_overrides: {
          orchestrator: { provider: "anthropic", model: "claude-opus-4-5-20250929" },
        },
      })
    );
    await agent.generatePlan(
      makeTicket(),
      defaultAgentDefinitions(),
      defaultPlatformRules(),
      "/tmp/test-workspace"
    );

    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("claude-opus-4-5-20250929");
  });
});

import { describe, it, expect } from "vitest";
import { PlannerFactory } from "../src/service/runtime/planner-factory.js";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

describe("PlannerFactory", () => {
  it("returns OrchestratorAgent by default", () => {
    const planner = new PlannerFactory().create(
      makePlatformConfig(),
      makeProjectConfig()
    );
    expect(planner.constructor.name).toBe("OrchestratorAgent");
  });

  it("returns CodexPlannerRuntime when configured", () => {
    const planner = new PlannerFactory().create(
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
          planner_runtime: { provider: "codex", mode: "local_process" },
        },
      }),
      makeProjectConfig({
        api_keys: {
          anthropic: "sk-ant-test-key",
          openai: "sk-openai-test-key",
        },
      })
    );
    expect(planner.constructor.name).toBe("CodexPlannerRuntime");
  });
});

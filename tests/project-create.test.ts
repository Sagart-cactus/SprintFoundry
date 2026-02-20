import { describe, expect, it } from "vitest";
import { buildProjectConfig } from "../src/commands/project-create.js";

type ProjectAnswers = Parameters<typeof buildProjectConfig>[0];

function baseAnswers(overrides: Partial<ProjectAnswers> = {}): ProjectAnswers {
  return {
    projectId: "demo-project",
    name: "Demo Project",
    stack: "js",
    agents: ["product", "developer", "qa"],
    repoUrl: "git@github.com:acme/demo-project.git",
    defaultBranch: "main",
    ticketSource: "prompt",
    ticketConfig: {},
    apiProviders: [],
    branchPrefix: "feat/",
    includeTicketId: true,
    namingStyle: "kebab-case",
    modelProfile: "default",
    ...overrides,
  };
}

describe("project create config generation", () => {
  it("does not add runtime/model overrides for default model profile", () => {
    const config = buildProjectConfig(baseAnswers());
    expect(config.model_overrides).toBeUndefined();
    expect(config.runtime_overrides).toBeUndefined();
    expect(config.planner_runtime_override).toBeUndefined();
  });

  it("adds codex 5.3 reasoning settings when selected", () => {
    const config = buildProjectConfig(baseAnswers({ modelProfile: "codex-53-reasoning" })) as {
      model_overrides: Record<string, { provider: string; model: string }>;
      runtime_overrides: Record<string, { provider: string; mode: string; model_reasoning_effort: string }>;
      planner_runtime_override: {
        provider: string;
        mode: string;
        model_reasoning_effort: string;
        args: string[];
      };
    };

    expect(config.model_overrides.orchestrator).toEqual({
      provider: "openai",
      model: "gpt-5.3-codex",
    });
    expect(config.model_overrides.product.model).toBe("gpt-5.3-codex");
    expect(config.model_overrides.developer.model).toBe("gpt-5.3-codex");
    expect(config.model_overrides.qa.model).toBe("gpt-5.3-codex");

    expect(config.runtime_overrides.product.model_reasoning_effort).toBe("medium");
    expect(config.runtime_overrides.developer.model_reasoning_effort).toBe("medium");
    expect(config.runtime_overrides.qa.model_reasoning_effort).toBe("medium");

    expect(config.planner_runtime_override).toEqual({
      provider: "codex",
      mode: "local_process",
      model_reasoning_effort: "high",
      args: ["--model", "gpt-5.3-codex"],
    });
  });
});

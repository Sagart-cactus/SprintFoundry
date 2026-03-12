import { describe, expect, it } from "vitest";
import { resolveDefaultDirectAgent } from "../src/service/direct-agent-default.js";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

describe("resolveDefaultDirectAgent", () => {
  it("prefers the generic agent by default", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig(),
      makeProjectConfig({ agents: ["developer", "qa", "security"] })
    );

    expect(agent).toBe("generic");
  });

  it("still prefers the generic agent even when the project only lists go agents", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig(),
      makeProjectConfig({ agents: ["go-developer", "go-qa"] })
    );

    expect(agent).toBe("generic");
  });

  it("falls back to the first allowed project agent when no developer-role agent is available", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig({
        agent_definitions: makePlatformConfig().agent_definitions.filter((definition) => definition.role !== "developer"),
      }),
      makeProjectConfig({ agents: ["qa", "security"] })
    );

    expect(agent).toBe("qa");
  });

  it("falls back to the platform developer agent when generic is not defined", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig({
        agent_definitions: makePlatformConfig().agent_definitions.filter((definition) => definition.type !== "generic"),
      }),
      makeProjectConfig({ agents: undefined })
    );

    expect(agent).toBe("developer");
  });
});

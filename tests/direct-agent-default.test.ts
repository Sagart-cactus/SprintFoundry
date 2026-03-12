import { describe, expect, it } from "vitest";
import { resolveDefaultDirectAgent } from "../src/service/direct-agent-default.js";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

describe("resolveDefaultDirectAgent", () => {
  it("prefers the standard developer agent when it is allowed", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig(),
      makeProjectConfig({ agents: ["developer", "qa", "security"] })
    );

    expect(agent).toBe("developer");
  });

  it("falls back to go-developer when the project only allows go agents", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig(),
      makeProjectConfig({ agents: ["go-developer", "go-qa"] })
    );

    expect(agent).toBe("go-developer");
  });

  it("falls back to the first allowed project agent when no developer-role agent is available", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig(),
      makeProjectConfig({ agents: ["qa", "security"] })
    );

    expect(agent).toBe("qa");
  });

  it("falls back to the platform developer agent when the project does not restrict agents", () => {
    const agent = resolveDefaultDirectAgent(
      makePlatformConfig(),
      makeProjectConfig({ agents: undefined })
    );

    expect(agent).toBe("developer");
  });
});

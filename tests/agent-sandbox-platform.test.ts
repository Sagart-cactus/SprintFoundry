import { describe, expect, it } from "vitest";
import { makePlatformConfig } from "./fixtures/configs.js";
import {
  AGENT_SANDBOX_WHOLE_RUN_HOSTING_ENV,
  DEFAULT_AGENT_SANDBOX_API_GROUP,
  DEFAULT_AGENT_SANDBOX_API_VERSION,
  isAgentSandboxWholeRunHostingEnabled,
  normalizeAgentSandboxPlatformConfig,
  validateAgentSandboxWholeRunHosting,
} from "../src/service/agent-sandbox-platform.js";

describe("agent-sandbox platform helpers", () => {
  it("normalizes upstream Agent Sandbox defaults", () => {
    const platform = makePlatformConfig({
      k8s: {
        agent_sandbox: {},
      },
    });

    normalizeAgentSandboxPlatformConfig(platform);

    expect(platform.k8s?.agent_sandbox).toMatchObject({
      enabled: false,
      whole_run_hosting_enabled: false,
      template_name: "default",
      warm_pool_name: "",
      api_group: DEFAULT_AGENT_SANDBOX_API_GROUP,
      api_version: DEFAULT_AGENT_SANDBOX_API_VERSION,
      claim_plural: "sandboxclaims",
    });
  });

  it("uses the dedicated whole-run hosting feature flag env override", () => {
    const platform = makePlatformConfig({
      k8s: {
        agent_sandbox: {
          enabled: true,
          whole_run_hosting_enabled: false,
        },
      },
    });

    expect(
      isAgentSandboxWholeRunHostingEnabled(platform, {
        [AGENT_SANDBOX_WHOLE_RUN_HOSTING_ENV]: "true",
      } as NodeJS.ProcessEnv)
    ).toBe(true);
  });

  it("fails fast when whole-run hosting is enabled but agent sandbox itself is disabled", async () => {
    const platform = makePlatformConfig({
      k8s: {
        agent_sandbox: {
          enabled: false,
          whole_run_hosting_enabled: true,
        },
      },
    });

    await expect(
      validateAgentSandboxWholeRunHosting(platform, {})
    ).rejects.toThrow(/k8s\.agent_sandbox\.enabled is false/);
  });

  it("fails fast when required CRDs are missing", async () => {
    const platform = makePlatformConfig({
      k8s: {
        agent_sandbox: {
          enabled: true,
          whole_run_hosting_enabled: true,
        },
      },
    });

    await expect(
      validateAgentSandboxWholeRunHosting(platform, {}, {
        readCustomResourceDefinition: async (name: string) => {
          if (name.startsWith("sandboxclaims.")) return {};
          throw new Error("NotFound");
        },
      })
    ).rejects.toThrow(/sandboxtemplates\.extensions\.agents\.x-k8s\.io/);
  });

  it("skips CRD validation inside an already-hosted sandbox whole-run", async () => {
    const platform = makePlatformConfig({
      k8s: {
        agent_sandbox: {
          enabled: false,
          whole_run_hosting_enabled: true,
        },
      },
    });

    await expect(
      validateAgentSandboxWholeRunHosting(platform, {
        SPRINTFOUNDRY_HOSTING_MODE: "k8s-agent-sandbox",
        SPRINTFOUNDRY_RUN_SANDBOX_MODE: "k8s-whole-run",
      } as NodeJS.ProcessEnv, {
        readCustomResourceDefinition: async () => {
          throw new Error("should not be called");
        },
      })
    ).resolves.toBeUndefined();
  });

  it("passes when required CRDs are present", async () => {
    const platform = makePlatformConfig({
      k8s: {
        agent_sandbox: {
          enabled: true,
          whole_run_hosting_enabled: true,
        },
      },
    });

    await expect(
      validateAgentSandboxWholeRunHosting(platform, {}, {
        readCustomResourceDefinition: async () => ({}),
      })
    ).resolves.toBeUndefined();
  });
});

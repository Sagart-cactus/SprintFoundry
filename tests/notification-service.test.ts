import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotificationService } from "../src/service/notification-service.js";
import type { IntegrationConfig } from "../src/shared/types.js";

function makeIntegration(
  overrides?: Partial<IntegrationConfig["notifications"]>
): IntegrationConfig {
  return {
    ticket_source: { type: "github", config: {} },
    notifications: overrides === undefined ? undefined : {
      type: overrides?.type ?? "slack",
      config: overrides?.config ?? { webhook_url: "https://hooks.slack.com/test" },
    },
  };
}

describe("NotificationService", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true });
    // Restore console.log spy for notification tests (setup.ts mocks it)
    vi.spyOn(console, "log");
    vi.spyOn(console, "warn");
    vi.spyOn(console, "error");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("send() logs to console always", async () => {
    const service = new NotificationService(makeIntegration());

    await service.send("Test message");

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Test message")
    );
  });

  it("send() does nothing when no type configured", async () => {
    const service = new NotificationService(makeIntegration(undefined));

    await service.send("Test message");

    // Should only log to console, not call fetch
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("sendSlack posts to webhook URL", async () => {
    const service = new NotificationService(
      makeIntegration({
        type: "slack",
        config: { webhook_url: "https://hooks.slack.com/test", channel: "#alerts" },
      })
    );

    await service.send("Deploy completed");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://hooks.slack.com/test",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Deploy completed"),
      })
    );

    // Verify body includes channel
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.channel).toBe("#alerts");
  });

  it("sendSlack skips when no webhook_url", async () => {
    const service = new NotificationService(
      makeIntegration({
        type: "slack",
        config: {},
      })
    );

    await service.send("Test");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("No webhook_url")
    );
  });

  it("sendWebhook posts to URL", async () => {
    const service = new NotificationService(
      makeIntegration({
        type: "webhook",
        config: { url: "https://my-webhook.com/notify" },
      })
    );

    await service.send("Task finished");

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://my-webhook.com/notify",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("Task finished"),
      })
    );

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.source).toBe("agentsdlc");
    expect(body.timestamp).toBeDefined();
  });

  it("sendWebhook skips when no url", async () => {
    const service = new NotificationService(
      makeIntegration({
        type: "webhook",
        config: {},
      })
    );

    await service.send("Test");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("No url configured")
    );
  });
});

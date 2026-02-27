import { describe, it, expect, vi } from "vitest";
import { NotificationRouter, defaultRoutingConfig } from "../src/service/notification-router.js";
import type { NotifierPlugin } from "../src/shared/plugin-types.js";

// ---------- Helpers ----------

function makeNotifier(name: string): NotifierPlugin & { calls: Array<{ message: string; priority: string | undefined }> } {
  const calls: Array<{ message: string; priority: string | undefined }> = [];
  return {
    name,
    calls,
    notify: vi.fn(async (message: string, priority?: string) => {
      calls.push({ message, priority });
    }),
  };
}

function makeFailingNotifier(name: string): NotifierPlugin {
  return {
    name,
    notify: vi.fn(async () => {
      throw new Error("delivery failed");
    }),
  };
}

// ---------- Tests ----------

describe("NotificationRouter", () => {
  it("routes to the correct notifier based on priority", async () => {
    const slack = makeNotifier("slack");
    const webhook = makeNotifier("webhook");

    const router = new NotificationRouter(
      new Map([["slack", slack], ["webhook", webhook]]),
      { urgent: ["slack"], action: ["slack"], warning: ["webhook"], info: ["webhook"] }
    );

    await router.notify("urgent msg", "urgent");
    expect(slack.calls).toHaveLength(1);
    expect(webhook.calls).toHaveLength(0);

    await router.notify("info msg", "info");
    expect(slack.calls).toHaveLength(1);
    expect(webhook.calls).toHaveLength(1);
  });

  it("sends to multiple notifiers for the same priority", async () => {
    const slack = makeNotifier("slack");
    const webhook = makeNotifier("webhook");

    const router = new NotificationRouter(
      new Map([["slack", slack], ["webhook", webhook]]),
      { urgent: ["slack", "webhook"], action: [], warning: [], info: [] }
    );

    const result = await router.notify("critical alert", "urgent");
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(slack.calls).toHaveLength(1);
    expect(webhook.calls).toHaveLength(1);
  });

  it("returns 0 sent when no notifiers configured for priority", async () => {
    const router = new NotificationRouter(
      new Map(),
      { urgent: [], action: [], warning: [], info: [] }
    );

    const result = await router.notify("orphan message", "info");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("counts failures when a notifier throws", async () => {
    const good = makeNotifier("good");
    const bad = makeFailingNotifier("bad");

    const router = new NotificationRouter(
      new Map([["good", good], ["bad", bad]]),
      { urgent: ["good", "bad"], action: [], warning: [], info: [] }
    );

    const result = await router.notify("test", "urgent");
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("counts failure when notifier name not found", async () => {
    const router = new NotificationRouter(
      new Map(),
      { urgent: ["nonexistent"], action: [], warning: [], info: [] }
    );

    const result = await router.notify("test", "urgent");
    expect(result.failed).toBe(1);
  });

  it("defaults priority to info", async () => {
    const console_ = makeNotifier("console");
    const router = new NotificationRouter(
      new Map([["console", console_]]),
      { urgent: [], action: [], warning: [], info: ["console"] }
    );

    await router.notify("hello");
    expect(console_.calls).toHaveLength(1);
  });

  describe("inferPriority", () => {
    it("maps failed events to urgent", () => {
      const router = new NotificationRouter(new Map(), defaultRoutingConfig());
      expect(router.inferPriority("ci.failed")).toBe("urgent");
      expect(router.inferPriority("task.failed")).toBe("urgent");
    });

    it("maps merge/approved events to action", () => {
      const router = new NotificationRouter(new Map(), defaultRoutingConfig());
      expect(router.inferPriority("merge.ready")).toBe("action");
      expect(router.inferPriority("pr.approved")).toBe("action");
    });

    it("maps rework events to warning", () => {
      const router = new NotificationRouter(new Map(), defaultRoutingConfig());
      expect(router.inferPriority("step.rework_triggered")).toBe("warning");
    });

    it("defaults to info", () => {
      const router = new NotificationRouter(new Map(), defaultRoutingConfig());
      expect(router.inferPriority("task.completed")).toBe("info");
    });
  });

  describe("notifyEvent", () => {
    it("sends with inferred priority", async () => {
      const slack = makeNotifier("slack");
      const router = new NotificationRouter(
        new Map([["slack", slack]]),
        { urgent: ["slack"], action: [], warning: [], info: [] }
      );

      await router.notifyEvent("ci.failed", "CI failed on PR #42");
      expect(slack.calls).toHaveLength(1);
      expect(slack.calls[0].priority).toBe("urgent");
    });
  });
});

describe("defaultRoutingConfig", () => {
  it("routes all priorities to console", () => {
    const config = defaultRoutingConfig();
    expect(config.urgent).toEqual(["console"]);
    expect(config.action).toEqual(["console"]);
    expect(config.warning).toEqual(["console"]);
    expect(config.info).toEqual(["console"]);
  });
});

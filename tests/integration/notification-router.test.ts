/**
 * Integration tests: Notification Router
 * Priority routing, multi-channel delivery, failure handling.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotificationRouter, defaultRoutingConfig } from "../../src/service/notification-router.js";
import { createMockNotifierPlugin, createRecordingNotifier } from "../helpers/plugin-mocks.js";
import type { NotifierPlugin, EventPriority } from "../../src/shared/plugin-types.js";

describe("Notification Router — priority routing", () => {
  it("routes urgent messages to urgent-configured channels", async () => {
    const slackNotifier = createRecordingNotifier("slack");
    const emailNotifier = createRecordingNotifier("email");
    const consoleNotifier = createRecordingNotifier("console");

    const plugins = new Map<string, NotifierPlugin>([
      ["slack", slackNotifier],
      ["email", emailNotifier],
      ["console", consoleNotifier],
    ]);

    const router = new NotificationRouter(plugins, {
      urgent: ["slack", "email"],
      action: ["slack"],
      warning: ["console"],
      info: ["console"],
    });

    await router.notify("Server is down!", "urgent");

    expect(slackNotifier.messages).toHaveLength(1);
    expect(emailNotifier.messages).toHaveLength(1);
    expect(consoleNotifier.messages).toHaveLength(0);
    expect(slackNotifier.messages[0].priority).toBe("urgent");
  });

  it("routes info messages only to info channels", async () => {
    const slack = createRecordingNotifier("slack");
    const console_ = createRecordingNotifier("console");

    const plugins = new Map<string, NotifierPlugin>([
      ["slack", slack],
      ["console", console_],
    ]);

    const router = new NotificationRouter(plugins, {
      urgent: ["slack", "console"],
      action: ["slack"],
      warning: ["slack"],
      info: ["console"],
    });

    await router.notify("Build completed", "info");

    expect(slack.messages).toHaveLength(0);
    expect(console_.messages).toHaveLength(1);
  });

  it("defaults to info priority when not specified", async () => {
    const recorder = createRecordingNotifier("default");
    const plugins = new Map<string, NotifierPlugin>([["default", recorder]]);
    const router = new NotificationRouter(plugins, {
      urgent: [],
      action: [],
      warning: [],
      info: ["default"],
    });

    await router.notify("Some message");
    expect(recorder.messages).toHaveLength(1);
  });
});

describe("Notification Router — multi-channel delivery", () => {
  it("sends to all configured channels for a priority", async () => {
    const ch1 = createRecordingNotifier("ch1");
    const ch2 = createRecordingNotifier("ch2");
    const ch3 = createRecordingNotifier("ch3");

    const plugins = new Map<string, NotifierPlugin>([
      ["ch1", ch1],
      ["ch2", ch2],
      ["ch3", ch3],
    ]);

    const router = new NotificationRouter(plugins, {
      urgent: ["ch1", "ch2", "ch3"],
      action: [],
      warning: [],
      info: [],
    });

    const result = await router.notify("All hands!", "urgent");
    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
    expect(ch1.messages).toHaveLength(1);
    expect(ch2.messages).toHaveLength(1);
    expect(ch3.messages).toHaveLength(1);
  });

  it("returns zero sent when no channels configured", async () => {
    const plugins = new Map<string, NotifierPlugin>();
    const router = new NotificationRouter(plugins, {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    });

    const result = await router.notify("Nobody listening", "action");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });
});

describe("Notification Router — failure handling", () => {
  it("one failing notifier does not block others (allSettled)", async () => {
    const good = createRecordingNotifier("good");
    const bad = createMockNotifierPlugin({ name: "bad", shouldFail: true });

    const plugins = new Map<string, NotifierPlugin>([
      ["good", good],
      ["bad", bad],
    ]);

    const router = new NotificationRouter(plugins, {
      urgent: ["good", "bad"],
      action: [],
      warning: [],
      info: [],
    });

    const result = await router.notify("Mixed delivery", "urgent");
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
    expect(good.messages).toHaveLength(1);
  });

  it("handles missing notifier plugin gracefully", async () => {
    const existing = createRecordingNotifier("existing");
    const plugins = new Map<string, NotifierPlugin>([["existing", existing]]);

    const router = new NotificationRouter(plugins, {
      urgent: ["existing", "nonexistent"],
      action: [],
      warning: [],
      info: [],
    });

    const result = await router.notify("Partial delivery", "urgent");
    expect(result.sent).toBe(1);
    expect(result.failed).toBe(1);
  });

  it("all failing returns all failed count", async () => {
    const bad1 = createMockNotifierPlugin({ name: "bad1", shouldFail: true });
    const bad2 = createMockNotifierPlugin({ name: "bad2", shouldFail: true });

    const plugins = new Map<string, NotifierPlugin>([
      ["bad1", bad1],
      ["bad2", bad2],
    ]);

    const router = new NotificationRouter(plugins, {
      urgent: ["bad1", "bad2"],
      action: [],
      warning: [],
      info: [],
    });

    const result = await router.notify("Total failure", "urgent");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
  });
});

describe("Notification Router — priority inference", () => {
  it("infers 'urgent' for failure events", () => {
    const router = new NotificationRouter(new Map(), defaultRoutingConfig());
    expect(router.inferPriority("ci.failed")).toBe("urgent");
    expect(router.inferPriority("task.failed")).toBe("urgent");
    expect(router.inferPriority("agent-stuck")).toBe("urgent");
  });

  it("infers 'action' for approval/merge events", () => {
    const router = new NotificationRouter(new Map(), defaultRoutingConfig());
    expect(router.inferPriority("pr.approved")).toBe("action");
    expect(router.inferPriority("auto-merge")).toBe("action");
  });

  it("infers 'warning' for rework events", () => {
    const router = new NotificationRouter(new Map(), defaultRoutingConfig());
    expect(router.inferPriority("step.rework_triggered")).toBe("warning");
    expect(router.inferPriority("token_limit_warning")).toBe("warning");
  });

  it("defaults to 'info' for unknown events", () => {
    const router = new NotificationRouter(new Map(), defaultRoutingConfig());
    expect(router.inferPriority("task.created")).toBe("info");
    expect(router.inferPriority("something.random")).toBe("info");
  });
});

describe("Notification Router — notifyEvent convenience method", () => {
  it("auto-infers priority and routes correctly", async () => {
    const urgent = createRecordingNotifier("urgent-ch");
    const info = createRecordingNotifier("info-ch");

    const plugins = new Map<string, NotifierPlugin>([
      ["urgent-ch", urgent],
      ["info-ch", info],
    ]);

    const router = new NotificationRouter(plugins, {
      urgent: ["urgent-ch"],
      action: [],
      warning: [],
      info: ["info-ch"],
    });

    await router.notifyEvent("ci.failed", "CI broke");
    await router.notifyEvent("task.created", "New task started");

    expect(urgent.messages).toHaveLength(1);
    expect(urgent.messages[0].message).toBe("CI broke");
    expect(info.messages).toHaveLength(1);
    expect(info.messages[0].message).toBe("New task started");
  });
});

/**
 * Unit tests: Notification Router
 * Priority inference, routing config validation, edge cases.
 */

import { describe, it, expect } from "vitest";
import { NotificationRouter, defaultRoutingConfig } from "../../src/service/notification-router.js";
import type { NotifierPlugin, EventPriority } from "../../src/shared/plugin-types.js";

describe("NotificationRouter — inferPriority", () => {
  const router = new NotificationRouter(new Map(), defaultRoutingConfig());

  it("maps failure-related strings to urgent", () => {
    expect(router.inferPriority("build.failed")).toBe("urgent");
    expect(router.inferPriority("task.failed")).toBe("urgent");
    expect(router.inferPriority("ci.failed")).toBe("urgent");
    expect(router.inferPriority("step.failed")).toBe("urgent");
    expect(router.inferPriority("agent-stuck")).toBe("urgent");
    expect(router.inferPriority("deployment.stuck")).toBe("urgent");
  });

  it("maps approval/merge strings to action", () => {
    expect(router.inferPriority("pr.approved")).toBe("action");
    expect(router.inferPriority("review.approved")).toBe("action");
    expect(router.inferPriority("auto-merge")).toBe("action");
    expect(router.inferPriority("ready.to.merge")).toBe("action");
  });

  it("maps rework/warning strings to warning", () => {
    expect(router.inferPriority("step.rework_triggered")).toBe("warning");
    expect(router.inferPriority("rework.needed")).toBe("warning");
    expect(router.inferPriority("token_limit_warning")).toBe("warning");
    expect(router.inferPriority("budget.warning")).toBe("warning");
  });

  it("defaults unrecognized strings to info", () => {
    expect(router.inferPriority("task.created")).toBe("info");
    expect(router.inferPriority("step.started")).toBe("info");
    expect(router.inferPriority("pr.created")).toBe("info");
    expect(router.inferPriority("")).toBe("info");
    expect(router.inferPriority("random-event")).toBe("info");
  });

  it("priority inference is case-sensitive", () => {
    // "Failed" (uppercase F) won't match "failed"
    expect(router.inferPriority("Failed")).toBe("info");
  });
});

describe("NotificationRouter — routing config", () => {
  it("defaultRoutingConfig sends everything to console", () => {
    const config = defaultRoutingConfig();
    expect(config.urgent).toEqual(["console"]);
    expect(config.action).toEqual(["console"]);
    expect(config.warning).toEqual(["console"]);
    expect(config.info).toEqual(["console"]);
  });

  it("supports empty routing for a priority level", async () => {
    const router = new NotificationRouter(new Map(), {
      urgent: [],
      action: [],
      warning: [],
      info: [],
    });

    // Should not throw, just return 0/0
    const result = await router.notify("test", "urgent");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
  });

  it("handles routing config with unknown plugin names", async () => {
    const router = new NotificationRouter(new Map(), {
      urgent: ["nonexistent-plugin"],
      action: [],
      warning: [],
      info: [],
    });

    const result = await router.notify("test", "urgent");
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(1);
  });
});

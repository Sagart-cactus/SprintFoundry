/**
 * Integration tests: Lifecycle Manager
 * State transitions, reaction triggers, escalation, notification routing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { LifecycleManager, defaultLifecycleConfig } from "../../src/service/lifecycle-manager.js";
import { SessionManager } from "../../src/service/session-manager.js";
import { NotificationRouter } from "../../src/service/notification-router.js";
import { createMockSCMPlugin, createRecordingNotifier } from "../helpers/plugin-mocks.js";
import type { LifecycleConfig, LifecycleCallbacks } from "../../src/service/lifecycle-manager.js";
import type { SCMPlugin, PRInfo } from "../../src/shared/plugin-types.js";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

let tmpDir: string;
let sessionManager: SessionManager;
let notifier: ReturnType<typeof createRecordingNotifier>;
let router: NotificationRouter;
let scm: SCMPlugin;
let config: LifecycleConfig;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sf-lifecycle-integ-"));
  sessionManager = new SessionManager(tmpDir);
  notifier = createRecordingNotifier("console");
  router = new NotificationRouter(
    new Map([["console", notifier]]),
    { urgent: ["console"], action: ["console"], warning: ["console"], info: ["console"] }
  );
  scm = createMockSCMPlugin();
  config = {
    ...defaultLifecycleConfig(),
    enabled: true,
    poll_interval_ms: 100,
  };
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("Lifecycle Manager — watch and unwatch", () => {
  it("registers a run for watching", () => {
    const lm = new LifecycleManager(config, scm, sessionManager, router);
    lm.watch("run-1", "feat/test", "https://github.com/test/repo/pull/42", "https://github.com/test/repo");
    expect(lm.watchCount).toBe(1);
  });

  it("unwatches a run", () => {
    const lm = new LifecycleManager(config, scm, sessionManager, router);
    lm.watch("run-1", "feat/test", "https://github.com/test/repo/pull/42", "https://github.com/test/repo");
    lm.unwatch("run-1");
    expect(lm.watchCount).toBe(0);
  });

  it("does nothing when config disabled", () => {
    config.enabled = false;
    const lm = new LifecycleManager(config, scm, sessionManager, router);
    lm.watch("run-1", "feat/test", "https://github.com/test/repo/pull/42", "https://github.com/test/repo");
    expect(lm.watchCount).toBe(0);
  });
});

describe("Lifecycle Manager — CI failure reactions", () => {
  it("triggers rework callback on CI failure", async () => {
    const onCIFailure = vi.fn(async () => {});
    const lm = new LifecycleManager(config, scm, sessionManager, router, { onCIFailure });

    // Configure SCM mock to return failing CI
    vi.mocked(scm.getCISummary).mockResolvedValue("failing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("pending");

    lm.watch("run-ci-1", "feat/ci", "https://github.com/test/repo/pull/1", "https://github.com/test/repo");
    await lm.check("run-ci-1");

    expect(onCIFailure).toHaveBeenCalledTimes(1);
    expect(onCIFailure).toHaveBeenCalledWith("run-ci-1", expect.any(Object), "failing");
  });

  it("escalates after exceeding retry limit", async () => {
    const onCIFailure = vi.fn(async () => {});
    config.reactions["ci-failed"].retries = 1;
    const lm = new LifecycleManager(config, scm, sessionManager, router, { onCIFailure });

    vi.mocked(scm.getCISummary).mockResolvedValue("failing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("pending");

    lm.watch("run-esc-1", "feat/esc", "https://github.com/test/repo/pull/2", "https://github.com/test/repo");

    // First failure: within retries
    await lm.check("run-esc-1");
    expect(onCIFailure).toHaveBeenCalledTimes(1);

    // Second failure: exceeds retries, should escalate to urgent
    await lm.check("run-esc-1");
    expect(onCIFailure).toHaveBeenCalledTimes(1); // not called again
    const urgentMessages = notifier.messages.filter((m) => m.priority === "urgent");
    expect(urgentMessages.length).toBeGreaterThanOrEqual(1);
    expect(urgentMessages[0].message).toContain("Manual intervention");
  });

  it("sends notification on CI failure when auto is disabled", async () => {
    config.reactions["ci-failed"].auto = false;
    const lm = new LifecycleManager(config, scm, sessionManager, router);

    vi.mocked(scm.getCISummary).mockResolvedValue("failing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("pending");

    lm.watch("run-manual-1", "feat/manual", "https://github.com/test/repo/pull/3", "https://github.com/test/repo");
    await lm.check("run-manual-1");

    expect(notifier.messages.length).toBeGreaterThanOrEqual(1);
    expect(notifier.messages.some((m) => m.message.includes("Requires attention"))).toBe(true);
  });
});

describe("Lifecycle Manager — review changes requested", () => {
  it("triggers rework callback on changes requested", async () => {
    const onChangesRequested = vi.fn(async () => {});
    const lm = new LifecycleManager(config, scm, sessionManager, router, { onChangesRequested });

    vi.mocked(scm.getCISummary).mockResolvedValue("passing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("changes_requested");
    vi.mocked(scm.getPendingComments).mockResolvedValue([
      { id: 1, author: "reviewer", body: "Fix the error handling", created_at: new Date().toISOString() },
    ]);

    lm.watch("run-review-1", "feat/review", "https://github.com/test/repo/pull/5", "https://github.com/test/repo");
    await lm.check("run-review-1");

    expect(onChangesRequested).toHaveBeenCalledTimes(1);
    expect(onChangesRequested).toHaveBeenCalledWith(
      "run-review-1",
      expect.any(Object),
      ["Fix the error handling"]
    );
  });

  it("escalates after exceeding review rework limit", async () => {
    config.reactions["changes-requested"].retries = 0;
    const lm = new LifecycleManager(config, scm, sessionManager, router);

    vi.mocked(scm.getCISummary).mockResolvedValue("passing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("changes_requested");

    lm.watch("run-rev-esc", "feat/rev-esc", "https://github.com/test/repo/pull/6", "https://github.com/test/repo");
    await lm.check("run-rev-esc");

    const urgentMessages = notifier.messages.filter((m) => m.priority === "urgent");
    expect(urgentMessages.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Lifecycle Manager — approved and green (auto-merge)", () => {
  it("calls onReadyToMerge when approved and CI passing with auto-merge enabled", async () => {
    const onReadyToMerge = vi.fn(async () => {});
    config.reactions["approved-and-green"].auto = true;
    config.reactions["approved-and-green"].action = "auto-merge";
    const lm = new LifecycleManager(config, scm, sessionManager, router, { onReadyToMerge });

    vi.mocked(scm.getCISummary).mockResolvedValue("passing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("approved");

    lm.watch("run-merge-1", "feat/merge", "https://github.com/test/repo/pull/7", "https://github.com/test/repo");
    await lm.check("run-merge-1");

    expect(onReadyToMerge).toHaveBeenCalledTimes(1);
    // Auto-merge unwatches the run
    expect(lm.watchCount).toBe(0);
  });

  it("notifies when mergeable but auto is disabled", async () => {
    config.reactions["approved-and-green"].auto = false;
    const lm = new LifecycleManager(config, scm, sessionManager, router);

    vi.mocked(scm.getCISummary).mockResolvedValue("passing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("approved");

    lm.watch("run-notify-merge", "feat/nm", "https://github.com/test/repo/pull/8", "https://github.com/test/repo");
    await lm.check("run-notify-merge");

    expect(notifier.messages.some((m) => m.message.includes("Ready to merge"))).toBe(true);
  });

  it("notifies of blockers when not mergeable", async () => {
    config.reactions["approved-and-green"].auto = true;
    config.reactions["approved-and-green"].action = "auto-merge";
    const lm = new LifecycleManager(config, scm, sessionManager, router);

    vi.mocked(scm.getCISummary).mockResolvedValue("passing");
    vi.mocked(scm.getReviewDecision).mockResolvedValue("approved");
    vi.mocked(scm.getMergeability).mockResolvedValue({
      mergeable: false,
      ci: "passing",
      review: "approved",
      blockers: ["Branch protection requires 2 approvals"],
    });

    lm.watch("run-blocked", "feat/blocked", "https://github.com/test/repo/pull/9", "https://github.com/test/repo");
    await lm.check("run-blocked");

    expect(notifier.messages.some((m) => m.message.includes("not mergeable"))).toBe(true);
  });
});

describe("Lifecycle Manager — merged/closed PR cleanup", () => {
  it("unwatches when PR is merged", async () => {
    const lm = new LifecycleManager(config, scm, sessionManager, router);

    vi.mocked(scm.getPRState).mockResolvedValue("merged");

    lm.watch("run-merged", "feat/merged", "https://github.com/test/repo/pull/10", "https://github.com/test/repo");
    await lm.check("run-merged");

    expect(lm.watchCount).toBe(0);
    expect(notifier.messages.some((m) => m.message.includes("merged"))).toBe(true);
  });

  it("unwatches when PR is closed", async () => {
    const lm = new LifecycleManager(config, scm, sessionManager, router);

    vi.mocked(scm.getPRState).mockResolvedValue("closed");

    lm.watch("run-closed", "feat/closed", "https://github.com/test/repo/pull/11", "https://github.com/test/repo");
    await lm.check("run-closed");

    expect(lm.watchCount).toBe(0);
  });
});

describe("Lifecycle Manager — polling", () => {
  it("start/stop controls the polling timer", () => {
    const lm = new LifecycleManager(config, scm, sessionManager, router);
    expect(lm.isRunning).toBe(false);

    lm.start();
    expect(lm.isRunning).toBe(true);

    lm.stop();
    expect(lm.isRunning).toBe(false);
  });

  it("does not start when config is disabled", () => {
    config.enabled = false;
    const lm = new LifecycleManager(config, scm, sessionManager, router);
    lm.start();
    expect(lm.isRunning).toBe(false);
  });

  it("skip check when no SCM plugin configured", async () => {
    const lm = new LifecycleManager(config, null, sessionManager, router);
    lm.watch("run-no-scm", "feat/test", "https://github.com/test/repo/pull/1", "https://github.com/test/repo");
    // Should not throw
    await lm.pollAll();
    // No notifications sent (no SCM to check)
    expect(notifier.messages).toHaveLength(0);
  });
});

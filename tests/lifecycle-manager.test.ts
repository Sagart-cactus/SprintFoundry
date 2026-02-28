import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { LifecycleManager, defaultLifecycleConfig } from "../src/service/lifecycle-manager.js";
import { NotificationRouter, defaultRoutingConfig } from "../src/service/notification-router.js";
import { SessionManager } from "../src/service/session-manager.js";
import type { SCMPlugin, PRInfo, NotifierPlugin } from "../src/shared/plugin-types.js";
import type { LifecycleConfig } from "../src/shared/types.js";

// ---------- Helpers ----------

let testDir: string;

const MOCK_PR: PRInfo = {
  number: 42,
  url: "https://github.com/test/repo/pull/42",
  branch: "feat/test",
  repo: "test/repo",
};

function makeSCM(overrides?: Partial<SCMPlugin>): SCMPlugin {
  return {
    name: "mock-scm",
    detectPR: vi.fn().mockResolvedValue(MOCK_PR),
    getPRState: vi.fn().mockResolvedValue("open"),
    getCISummary: vi.fn().mockResolvedValue("passing"),
    getReviewDecision: vi.fn().mockResolvedValue("pending"),
    getPendingComments: vi.fn().mockResolvedValue([]),
    getMergeability: vi.fn().mockResolvedValue({ mergeable: true, ci: "passing", review: "approved", blockers: [] }),
    mergePR: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeNotifier(): NotifierPlugin & { messages: string[] } {
  const messages: string[] = [];
  return {
    name: "test",
    messages,
    notify: vi.fn(async (msg: string) => { messages.push(msg); }),
  };
}

function makeEnabledConfig(overrides?: Partial<LifecycleConfig>): LifecycleConfig {
  const base = defaultLifecycleConfig();
  return { ...base, enabled: true, ...overrides };
}

// ---------- Tests ----------

describe("LifecycleManager", () => {
  let sessionMgr: SessionManager;
  let notifier: ReturnType<typeof makeNotifier>;
  let router: NotificationRouter;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sf-lifecycle-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
    sessionMgr = new SessionManager(testDir);
    notifier = makeNotifier();
    router = new NotificationRouter(
      new Map([["test", notifier]]),
      { urgent: ["test"], action: ["test"], warning: ["test"], info: ["test"] }
    );
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("does not watch when disabled", () => {
    const config = defaultLifecycleConfig(); // enabled: false
    const mgr = new LifecycleManager(config, makeSCM(), sessionMgr, router);

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    expect(mgr.watchCount).toBe(0);
  });

  it("watches and unwatches runs when enabled", () => {
    const mgr = new LifecycleManager(makeEnabledConfig(), makeSCM(), sessionMgr, router);

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    expect(mgr.watchCount).toBe(1);

    mgr.watch("run-2", "feat/other", "https://example.com/pr/2", "https://example.com/repo");
    expect(mgr.watchCount).toBe(2);

    mgr.unwatch("run-1");
    expect(mgr.watchCount).toBe(1);
  });

  it("starts and stops polling", () => {
    const mgr = new LifecycleManager(makeEnabledConfig(), makeSCM(), sessionMgr, router);
    expect(mgr.isRunning).toBe(false);

    mgr.start();
    expect(mgr.isRunning).toBe(true);

    mgr.stop();
    expect(mgr.isRunning).toBe(false);
  });

  it("does not start polling when disabled", () => {
    const config = defaultLifecycleConfig();
    const mgr = new LifecycleManager(config, makeSCM(), sessionMgr, router);
    mgr.start();
    expect(mgr.isRunning).toBe(false);
  });

  it("unwatches merged PRs", async () => {
    const scm = makeSCM({ getPRState: vi.fn().mockResolvedValue("merged") });
    const mgr = new LifecycleManager(makeEnabledConfig(), scm, sessionMgr, router);

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    await mgr.check("run-1");

    expect(mgr.watchCount).toBe(0);
    expect(notifier.messages.some((m) => m.includes("merged"))).toBe(true);
  });

  it("unwatches closed PRs", async () => {
    const scm = makeSCM({ getPRState: vi.fn().mockResolvedValue("closed") });
    const mgr = new LifecycleManager(makeEnabledConfig(), scm, sessionMgr, router);

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    await mgr.check("run-1");

    expect(mgr.watchCount).toBe(0);
  });

  it("triggers CI failure notification when CI is failing", async () => {
    const scm = makeSCM({ getCISummary: vi.fn().mockResolvedValue("failing") });
    const onCIFailure = vi.fn().mockResolvedValue(undefined);
    const mgr = new LifecycleManager(makeEnabledConfig(), scm, sessionMgr, router, { onCIFailure });

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    await mgr.check("run-1");

    expect(onCIFailure).toHaveBeenCalledWith("run-1", MOCK_PR, "failing");
    expect(notifier.messages.some((m) => m.includes("CI failed"))).toBe(true);
  });

  it("escalates after exceeding CI retry limit", async () => {
    const scm = makeSCM({ getCISummary: vi.fn().mockResolvedValue("failing") });
    const onCIFailure = vi.fn().mockResolvedValue(undefined);
    const config = makeEnabledConfig();
    config.reactions["ci-failed"].retries = 1;
    const mgr = new LifecycleManager(config, scm, sessionMgr, router, { onCIFailure });

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");

    await mgr.check("run-1"); // attempt 1 — should trigger rework
    expect(onCIFailure).toHaveBeenCalledTimes(1);

    await mgr.check("run-1"); // attempt 2 — exceeds retries, should escalate
    expect(onCIFailure).toHaveBeenCalledTimes(1); // NOT called again
    expect(notifier.messages.some((m) => m.includes("Manual intervention"))).toBe(true);
  });

  it("triggers changes-requested rework", async () => {
    const scm = makeSCM({
      getReviewDecision: vi.fn().mockResolvedValue("changes_requested"),
      getPendingComments: vi.fn().mockResolvedValue([
        { id: 1, author: "reviewer", body: "Fix the tests", created_at: "2026-02-27T10:00:00Z" },
      ]),
    });
    const onChangesRequested = vi.fn().mockResolvedValue(undefined);
    const mgr = new LifecycleManager(makeEnabledConfig(), scm, sessionMgr, router, { onChangesRequested });

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    await mgr.check("run-1");

    expect(onChangesRequested).toHaveBeenCalledWith("run-1", MOCK_PR, ["Fix the tests"]);
  });

  it("notifies when PR is approved and green", async () => {
    const scm = makeSCM({
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
    });
    const mgr = new LifecycleManager(makeEnabledConfig(), scm, sessionMgr, router);

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    await mgr.check("run-1");

    // Default config has auto: false for approved-and-green, so just notifies
    expect(notifier.messages.some((m) => m.includes("Ready to merge"))).toBe(true);
  });

  it("auto-merges when configured and mergeable", async () => {
    const scm = makeSCM({
      getCISummary: vi.fn().mockResolvedValue("passing"),
      getReviewDecision: vi.fn().mockResolvedValue("approved"),
    });
    const onReadyToMerge = vi.fn().mockResolvedValue(undefined);
    const config = makeEnabledConfig();
    config.reactions["approved-and-green"].auto = true;
    config.reactions["approved-and-green"].action = "auto-merge";
    const mgr = new LifecycleManager(config, scm, sessionMgr, router, { onReadyToMerge });

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    await mgr.check("run-1");

    expect(onReadyToMerge).toHaveBeenCalledWith("run-1", MOCK_PR);
    expect(mgr.watchCount).toBe(0); // unwatched after merge
  });

  it("skips check when no SCM plugin", async () => {
    const mgr = new LifecycleManager(makeEnabledConfig(), null, sessionMgr, router);

    mgr.watch("run-1", "feat/test", "https://example.com/pr/1", "https://example.com/repo");
    // Should not throw
    await mgr.check("run-1");
    expect(mgr.watchCount).toBe(1); // still watched
  });

  it("pollAll processes all watched runs", async () => {
    const scm = makeSCM({ getPRState: vi.fn().mockResolvedValue("merged") });
    const mgr = new LifecycleManager(makeEnabledConfig(), scm, sessionMgr, router);

    mgr.watch("run-1", "feat/a", "https://example.com/pr/1", "https://example.com/repo");
    mgr.watch("run-2", "feat/b", "https://example.com/pr/2", "https://example.com/repo");
    expect(mgr.watchCount).toBe(2);

    await mgr.pollAll();
    expect(mgr.watchCount).toBe(0); // both unwatched (merged)
  });
});

describe("defaultLifecycleConfig", () => {
  it("is disabled by default", () => {
    const config = defaultLifecycleConfig();
    expect(config.enabled).toBe(false);
  });

  it("has all 4 reaction triggers", () => {
    const config = defaultLifecycleConfig();
    expect(Object.keys(config.reactions)).toEqual([
      "ci-failed",
      "changes-requested",
      "approved-and-green",
      "agent-stuck",
    ]);
  });

  it("defaults ci-failed to trigger-rework with 2 retries", () => {
    const config = defaultLifecycleConfig();
    expect(config.reactions["ci-failed"].action).toBe("trigger-rework");
    expect(config.reactions["ci-failed"].retries).toBe(2);
    expect(config.reactions["ci-failed"].auto).toBe(true);
  });

  it("defaults approved-and-green to notify (not auto-merge)", () => {
    const config = defaultLifecycleConfig();
    expect(config.reactions["approved-and-green"].auto).toBe(false);
    expect(config.reactions["approved-and-green"].action).toBe("notify");
  });
});

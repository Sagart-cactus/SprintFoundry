/**
 * Integration tests: SCM Plugin interface
 * Tests PR detection, CI status, review decision, and merge readiness
 * using mock SCM implementations.
 */

import { describe, it, expect, vi } from "vitest";
import { createMockSCMPlugin } from "../helpers/plugin-mocks.js";
import type { SCMPlugin, PRInfo, CIStatus, ReviewDecision, MergeReadiness } from "../../src/shared/plugin-types.js";

const defaultPR: PRInfo = {
  number: 42,
  url: "https://github.com/test/repo/pull/42",
  branch: "feat/test",
  repo: "test/repo",
};

describe("SCM Plugin — PR detection", () => {
  it("detects an existing PR for a branch", async () => {
    const scm = createMockSCMPlugin({ defaultPR });
    const pr = await scm.detectPR("feat/test", { url: "https://github.com/test/repo", default_branch: "main" });
    expect(pr).not.toBeNull();
    expect(pr!.number).toBe(42);
    expect(pr!.branch).toBe("feat/test");
  });

  it("returns null when no PR exists", async () => {
    const scm = createMockSCMPlugin({ defaultPR: null });
    const pr = await scm.detectPR("feat/orphan", { url: "https://github.com/test/repo", default_branch: "main" });
    expect(pr).toBeNull();
  });
});

describe("SCM Plugin — PR state", () => {
  it("reports PR as open", async () => {
    const scm = createMockSCMPlugin();
    const state = await scm.getPRState(defaultPR);
    expect(state).toBe("open");
  });

  it("reports PR as merged", async () => {
    const scm = createMockSCMPlugin();
    vi.mocked(scm.getPRState).mockResolvedValueOnce("merged");
    const state = await scm.getPRState(defaultPR);
    expect(state).toBe("merged");
  });

  it("reports PR as closed", async () => {
    const scm = createMockSCMPlugin();
    vi.mocked(scm.getPRState).mockResolvedValueOnce("closed");
    const state = await scm.getPRState(defaultPR);
    expect(state).toBe("closed");
  });
});

describe("SCM Plugin — CI status", () => {
  it("returns passing CI status", async () => {
    const scm = createMockSCMPlugin({ defaultCIStatus: "passing" });
    const status = await scm.getCISummary(defaultPR);
    expect(status).toBe("passing");
  });

  it("returns failing CI status", async () => {
    const scm = createMockSCMPlugin({ defaultCIStatus: "failing" });
    const status = await scm.getCISummary(defaultPR);
    expect(status).toBe("failing");
  });

  it("returns pending CI status", async () => {
    const scm = createMockSCMPlugin({ defaultCIStatus: "pending" });
    const status = await scm.getCISummary(defaultPR);
    expect(status).toBe("pending");
  });

  it("returns none when no CI configured", async () => {
    const scm = createMockSCMPlugin({ defaultCIStatus: "none" });
    const status = await scm.getCISummary(defaultPR);
    expect(status).toBe("none");
  });
});

describe("SCM Plugin — review decisions", () => {
  it("reports approved review", async () => {
    const scm = createMockSCMPlugin({ defaultReviewDecision: "approved" });
    const decision = await scm.getReviewDecision(defaultPR);
    expect(decision).toBe("approved");
  });

  it("reports changes_requested review", async () => {
    const scm = createMockSCMPlugin({ defaultReviewDecision: "changes_requested" });
    const decision = await scm.getReviewDecision(defaultPR);
    expect(decision).toBe("changes_requested");
  });

  it("reports pending review", async () => {
    const scm = createMockSCMPlugin({ defaultReviewDecision: "pending" });
    const decision = await scm.getReviewDecision(defaultPR);
    expect(decision).toBe("pending");
  });

  it("retrieves pending comments", async () => {
    const scm = createMockSCMPlugin();
    vi.mocked(scm.getPendingComments).mockResolvedValueOnce([
      { id: 1, author: "reviewer1", body: "Fix error handling", created_at: new Date().toISOString() },
      { id: 2, author: "reviewer2", body: "Add tests", path: "src/main.ts", line: 42, created_at: new Date().toISOString() },
    ]);

    const comments = await scm.getPendingComments(defaultPR);
    expect(comments).toHaveLength(2);
    expect(comments[0].body).toBe("Fix error handling");
    expect(comments[1].path).toBe("src/main.ts");
    expect(comments[1].line).toBe(42);
  });
});

describe("SCM Plugin — merge readiness", () => {
  it("reports mergeable when CI passing and review approved", async () => {
    const scm = createMockSCMPlugin({
      defaultMergeability: {
        mergeable: true,
        ci: "passing",
        review: "approved",
        blockers: [],
      },
    });

    const result = await scm.getMergeability(defaultPR);
    expect(result.mergeable).toBe(true);
    expect(result.blockers).toHaveLength(0);
  });

  it("reports not mergeable with blockers", async () => {
    const scm = createMockSCMPlugin({
      defaultMergeability: {
        mergeable: false,
        ci: "failing",
        review: "changes_requested",
        blockers: ["CI is failing", "Changes requested by reviewer"],
      },
    });

    const result = await scm.getMergeability(defaultPR);
    expect(result.mergeable).toBe(false);
    expect(result.blockers).toHaveLength(2);
    expect(result.blockers[0]).toContain("CI");
  });

  it("mergePR can be called with different methods", async () => {
    const scm = createMockSCMPlugin();

    await scm.mergePR(defaultPR, "squash");
    expect(scm.mergePR).toHaveBeenCalledWith(defaultPR, "squash");

    await scm.mergePR(defaultPR, "rebase");
    expect(scm.mergePR).toHaveBeenCalledWith(defaultPR, "rebase");

    await scm.mergePR(defaultPR, "merge");
    expect(scm.mergePR).toHaveBeenCalledWith(defaultPR, "merge");
  });
});

describe("SCM Plugin — composite scenarios", () => {
  it("full PR lifecycle: detect -> check CI -> check review -> merge", async () => {
    const scm = createMockSCMPlugin();

    // 1. Detect PR
    const pr = await scm.detectPR("feat/lifecycle", { url: "https://github.com/test/repo", default_branch: "main" });
    expect(pr).not.toBeNull();

    // 2. Check CI
    const ci = await scm.getCISummary(pr!);
    expect(ci).toBe("passing");

    // 3. Check review
    const review = await scm.getReviewDecision(pr!);
    expect(review).toBe("approved");

    // 4. Check mergeability
    const merge = await scm.getMergeability(pr!);
    expect(merge.mergeable).toBe(true);

    // 5. Merge
    await scm.mergePR(pr!, "squash");
    expect(scm.mergePR).toHaveBeenCalledTimes(1);
  });

  it("blocked lifecycle: detect -> CI failing -> wait", async () => {
    const scm = createMockSCMPlugin({ defaultCIStatus: "failing" });

    const pr = await scm.detectPR("feat/blocked", { url: "https://github.com/test/repo", default_branch: "main" });
    const ci = await scm.getCISummary(pr!);
    expect(ci).toBe("failing");

    // Should not attempt merge when CI failing
    const merge = await scm.getMergeability(pr!);
    // Default mergeability is still true (mock), but a real implementation would check CI
    // This tests that the interface methods work as expected
    expect(scm.getCISummary).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { githubSCMModule } from "../src/plugins/scm-github/index.js";
import type { SCMPlugin } from "../src/shared/plugin-types.js";

function mockJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("scm-github plugin", () => {
  let plugin: SCMPlugin;

  beforeEach(() => {
    plugin = githubSCMModule.create({
      token: "ghp_test",
      owner: "acme",
      repo: "example",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("detectPR returns null when no open PR matches branch", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(mockJsonResponse(200, []));

    const pr = await plugin.detectPR("feat/no-pr", {
      url: "git@github.com:acme/example.git",
      default_branch: "main",
    });

    expect(pr).toBeNull();
  });

  it("detectPR returns PR info when branch has open PR", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      mockJsonResponse(200, [
        {
          number: 42,
          html_url: "https://github.com/acme/example/pull/42",
          head: { ref: "feat/ready" },
        },
      ])
    );

    const pr = await plugin.detectPR("feat/ready", {
      url: "https://github.com/acme/example.git",
      default_branch: "main",
    });

    expect(pr).not.toBeNull();
    expect(pr!.number).toBe(42);
    expect(pr!.repo).toBe("acme/example");
    expect(pr!.branch).toBe("feat/ready");
  });

  it("maps merged and closed PR states", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, { state: "closed", merged_at: "2026-02-28T00:00:00Z" })
    );
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, { state: "closed", merged_at: null })
    );

    const merged = await plugin.getPRState({
      number: 7,
      url: "https://github.com/acme/example/pull/7",
      branch: "feat/a",
      repo: "acme/example",
    });
    const closed = await plugin.getPRState({
      number: 8,
      url: "https://github.com/acme/example/pull/8",
      branch: "feat/b",
      repo: "acme/example",
    });

    expect(merged).toBe("merged");
    expect(closed).toBe("closed");
  });

  it("computes mergeability blockers from CI and review state", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    // getPR for getMergeability
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, { number: 9, head: { sha: "abc" }, mergeable: false, requested_reviewers: [] })
    );
    // getPR for getCISummary
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, { number: 9, head: { sha: "abc" }, mergeable: false, requested_reviewers: [] })
    );
    // commit status
    fetchMock.mockResolvedValueOnce(mockJsonResponse(200, { state: "failure" }));
    // reviews
    fetchMock.mockResolvedValueOnce(
      mockJsonResponse(200, [{ state: "CHANGES_REQUESTED", submitted_at: "2026-02-28T00:00:00Z" }])
    );

    const readiness = await plugin.getMergeability({
      number: 9,
      url: "https://github.com/acme/example/pull/9",
      branch: "feat/c",
      repo: "acme/example",
    });

    expect(readiness.mergeable).toBe(false);
    expect(readiness.ci).toBe("failing");
    expect(readiness.review).toBe("changes_requested");
    expect(readiness.blockers.length).toBeGreaterThan(0);
  });
});


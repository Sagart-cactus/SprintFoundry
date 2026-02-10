import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RepoConfig, BranchStrategy, TaskRun } from "../src/shared/types.js";
import { makeTicket } from "./fixtures/tickets.js";

// Mock child_process.spawnSync
vi.mock("child_process", () => ({
  spawnSync: vi.fn().mockReturnValue({
    status: 0,
    stdout: "",
    stderr: "",
  }),
}));

const { spawnSync: mockSpawnSync } = await import("child_process");
const { GitManager } = await import("../src/service/git-manager.js");

function makeRepoConfig(overrides?: Partial<RepoConfig>): RepoConfig {
  return {
    url: overrides?.url ?? "https://github.com/test/repo.git",
    default_branch: overrides?.default_branch ?? "main",
    token: overrides?.token ?? "ghp_testtoken",
    ssh_key_path: overrides?.ssh_key_path,
  };
}

function makeBranchStrategy(
  overrides?: Partial<BranchStrategy>
): BranchStrategy {
  return {
    prefix: overrides?.prefix ?? "feat/",
    include_ticket_id: overrides?.include_ticket_id ?? true,
    naming: overrides?.naming ?? "kebab-case",
  };
}

describe("GitManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("cloneAndBranch calls git clone + checkout", async () => {
    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());

    await git.cloneAndBranch("/workspace", makeTicket({ id: "TEST-1", title: "My Feature" }));

    expect(mockSpawnSync).toHaveBeenCalledTimes(2);

    const cloneCall = (mockSpawnSync as any).mock.calls[0] as any[];
    expect(cloneCall[0]).toBe("git");
    expect(cloneCall[1]).toContain("clone");

    const checkoutCall = (mockSpawnSync as any).mock.calls[1] as any[];
    expect(checkoutCall[0]).toBe("git");
    expect(checkoutCall[1]).toContain("checkout");
    expect(checkoutCall[1]).toContain("origin/main");
  });

  it("cloneAndBranch injects token into HTTPS URL", async () => {
    const git = new GitManager(
      makeRepoConfig({ token: "mytoken123" }),
      makeBranchStrategy()
    );

    await git.cloneAndBranch("/workspace", makeTicket());

    const cloneArgs = (mockSpawnSync as any).mock.calls[0][1] as string[];
    expect(cloneArgs).toContain("https://mytoken123@github.com/test/repo.git");
  });

  it("cloneAndBranch converts SSH URL to HTTPS with token", async () => {
    const git = new GitManager(
      makeRepoConfig({
        url: "git@github.com:test/repo.git",
        token: "mytoken",
      }),
      makeBranchStrategy()
    );

    await git.cloneAndBranch("/workspace", makeTicket());

    const cloneArgs = (mockSpawnSync as any).mock.calls[0][1] as string[];
    expect(cloneArgs).toContain("https://mytoken@github.com/test/repo.git");
  });

  it("buildBranchName uses kebab-case by default", () => {
    const git = new GitManager(
      makeRepoConfig(),
      makeBranchStrategy({ naming: "kebab-case", include_ticket_id: false })
    );

    const name = (git as any).buildBranchName(
      makeTicket({ title: "Add CSV Export Feature" })
    );

    expect(name).toBe("feat/add-csv-export-feature");
    expect(name).not.toContain("_");
  });

  it("buildBranchName uses snake_case when configured", () => {
    const git = new GitManager(
      makeRepoConfig(),
      makeBranchStrategy({ naming: "snake_case", include_ticket_id: false })
    );

    const name = (git as any).buildBranchName(
      makeTicket({ title: "Add CSV Export" })
    );

    expect(name).toBe("feat/add_csv_export");
  });

  it("buildBranchName includes ticket ID when configured", () => {
    const git = new GitManager(
      makeRepoConfig(),
      makeBranchStrategy({ include_ticket_id: true })
    );

    const name = (git as any).buildBranchName(
      makeTicket({ id: "PROJ-42", title: "Some Feature" })
    );

    expect(name).toContain("proj-42");
  });

  it("buildBranchName truncates to 50 chars in slug", () => {
    const git = new GitManager(
      makeRepoConfig(),
      makeBranchStrategy({ include_ticket_id: false })
    );

    const longTitle = "This is a very long title that should be truncated at exactly fifty characters";
    const name = (git as any).buildBranchName(makeTicket({ title: longTitle }));

    // The slug part (after prefix) should be ≤ 50 chars
    const slug = name.replace("feat/", "");
    expect(slug.length).toBeLessThanOrEqual(50);
  });

  it("commitAndPush calls git add, commit, push", async () => {
    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());

    await git.commitAndPush("/workspace", "feat: add CSV export");

    expect(mockSpawnSync).toHaveBeenCalledTimes(3);

    const calls = (mockSpawnSync as any).mock.calls.map((c: any[]) => c[1]);
    expect(calls[0]).toEqual(["add", "-A"]);
    expect(calls[1]).toEqual(["commit", "-m", "feat: add CSV export"]);
    expect(calls[2]).toEqual(["push", "-u", "origin", "HEAD"]);
  });

  it("createPullRequest calls gh pr create", async () => {
    (mockSpawnSync as any).mockReturnValueOnce({
      status: 0,
      stdout: "https://github.com/test/repo/pull/1\n",
      stderr: "",
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());

    const run = {
      run_id: "run-1",
      ticket: makeTicket(),
      steps: [
        { agent: "developer", result: { summary: "Implemented CSV export" } },
        { agent: "qa", result: { summary: "Tests passing" } },
      ],
      total_tokens_used: 10000,
      total_cost_usd: 1.5,
    } as unknown as TaskRun;

    const prUrl = await git.createPullRequest("/workspace", run);

    expect(prUrl).toBe("https://github.com/test/repo/pull/1");
    const call = (mockSpawnSync as any).mock.calls[0] as any[];
    expect(call[0]).toBe("gh");
    expect(call[1]).toContain("pr");
    expect(call[1]).toContain("create");
  });

  it("createPullRequest falls back to commitAndPush on gh failure", async () => {
    (mockSpawnSync as any)
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "gh not found",
      })
      .mockReturnValue({
        status: 0,
        stdout: "",
        stderr: "",
      });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());

    const run = {
      run_id: "run-2",
      ticket: makeTicket(),
      steps: [],
      total_tokens_used: 0,
      total_cost_usd: 0,
    } as unknown as TaskRun;

    const result = await git.createPullRequest("/workspace", run);

    expect(result).toContain("Branch pushed");
    // Should have called git add/commit/push after gh failure
    expect(mockSpawnSync).toHaveBeenCalledTimes(4); // 1 failed gh + 3 git commands
  });

  it("buildPRBody includes step summaries and stats", () => {
    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());

    const run = {
      ticket: makeTicket({ id: "TEST-5", title: "CSV Export" }),
      steps: [
        { agent: "developer", result: { summary: "Implemented feature" } },
        { agent: "qa", result: { summary: "All tests pass" } },
      ],
      total_tokens_used: 50000,
      total_cost_usd: 2.5,
    } as unknown as TaskRun;

    const body = (git as any).buildPRBody(run);

    expect(body).toContain("TEST-5");
    expect(body).toContain("CSV Export");
    expect(body).toContain("developer");
    expect(body).toContain("Implemented feature");
    expect(body).toContain("2.50");
  });

  it("exec passes SSH key env when configured", async () => {
    const git = new GitManager(
      makeRepoConfig({ ssh_key_path: "/home/user/.ssh/deploy_key", token: undefined }),
      makeBranchStrategy()
    );

    await git.cloneAndBranch("/workspace", makeTicket());

    const callOpts = (mockSpawnSync as any).mock.calls[0][2];
    expect(callOpts.env.GIT_SSH_COMMAND).toContain("ssh -i /home/user/.ssh/deploy_key");
  });
});

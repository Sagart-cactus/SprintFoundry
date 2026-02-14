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

    // 3 calls: git clone, git checkout, entire enable (tryEnableEntire — best-effort, may succeed or fail)
    expect(mockSpawnSync).toHaveBeenCalledTimes(3);

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

  // ---- commitStepCheckpoint ----

  it("commitStepCheckpoint: happy path — stages changes, detects diff, commits and returns true", async () => {
    // First call: git add -A (status 0)
    // Second call: git diff --staged --quiet (status 1 = changes present)
    // Third call: git commit -m ... (status 0)
    (mockSpawnSync as any)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // git add -A
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }) // git diff --staged --quiet (exit 1 = has changes)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git commit

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    const result = await git.commitStepCheckpoint("/workspace", "run-abc123", 1, "developer");

    expect(result).toBe(true);

    const calls = (mockSpawnSync as any).mock.calls;
    expect(calls[0][1]).toEqual(["add", "-A"]);
    expect(calls[1][1]).toEqual(["diff", "--staged", "--quiet"]);
    expect(calls[2][1]).toEqual(["commit", "-m", "chore(agentsdlc): run run-abc123 step 1 developer"]);
  });

  it("commitStepCheckpoint: commit message includes runId, stepNumber, and agentId", async () => {
    (mockSpawnSync as any)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // git add -A
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }) // diff = has changes
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git commit

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await git.commitStepCheckpoint("/workspace", "run-xyz-99", 42, "qa");

    const commitCall = (mockSpawnSync as any).mock.calls[2];
    expect(commitCall[1]).toContain("commit");
    expect(commitCall[1]).toContain("-m");
    const commitMsg = commitCall[1][commitCall[1].indexOf("-m") + 1];
    expect(commitMsg).toBe("chore(agentsdlc): run run-xyz-99 step 42 qa");
  });

  it("commitStepCheckpoint: no-diff skip — returns false without creating a commit", async () => {
    // git add succeeds, git diff --staged --quiet exits 0 = no changes
    (mockSpawnSync as any)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // git add -A
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }); // git diff --staged --quiet (exit 0 = no changes)

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    const result = await git.commitStepCheckpoint("/workspace", "run-noop", 3, "developer");

    expect(result).toBe(false);

    // git commit should NOT have been called
    const calls = (mockSpawnSync as any).mock.calls;
    expect(calls.length).toBe(2); // only add + diff, no commit
    const commandNames = calls.map((c: any[]) => c[1][0]);
    expect(commandNames).not.toContain("commit");
  });

  it("commitStepCheckpoint: throws when git commit fails (non-zero exit)", async () => {
    (mockSpawnSync as any)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // git add -A
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }) // diff = has changes
      .mockReturnValueOnce({ status: 128, stdout: "", stderr: "fatal: not a git repository" }); // commit fails

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await expect(
      git.commitStepCheckpoint("/workspace", "run-err", 1, "developer")
    ).rejects.toThrow(/not a git repository/);
  });

  it("commitStepCheckpoint: throws when git add fails", async () => {
    (mockSpawnSync as any).mockReturnValueOnce({
      status: 128,
      stdout: "",
      stderr: "fatal: not a git repository",
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await expect(
      git.commitStepCheckpoint("/workspace", "run-err", 1, "developer")
    ).rejects.toThrow();
  });

  it("commitStepCheckpoint: throws when spawnSync returns error object", async () => {
    (mockSpawnSync as any)
      .mockReturnValueOnce({ status: 0, stdout: "", stderr: "" }) // git add -A
      .mockReturnValueOnce({ status: 1, stdout: "", stderr: "" }) // diff = has changes
      .mockReturnValueOnce({ error: new Error("ENOENT: git not found"), status: null, stdout: "" }); // git commit: system error

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await expect(
      git.commitStepCheckpoint("/workspace", "run-err", 1, "developer")
    ).rejects.toThrow("ENOENT: git not found");
  });

  it("commitStepCheckpoint: PR creation still works after per-step commits (gh pr create path)", async () => {
    // Simulate: per-step commits already present; createPullRequest via gh CLI
    (mockSpawnSync as any).mockReturnValueOnce({
      status: 0,
      stdout: "https://github.com/test/repo/pull/99\n",
      stderr: "",
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    const run = {
      run_id: "run-pr-compat",
      ticket: makeTicket({ id: "TEST-99", title: "Per-step commits test" }),
      steps: [
        { agent: "developer", result: { summary: "Implemented feature" } },
        { agent: "qa", result: { summary: "Tests pass" } },
      ],
      total_tokens_used: 5000,
      total_cost_usd: 0.5,
    } as unknown as TaskRun;

    const prUrl = await git.createPullRequest("/workspace", run);

    // Should succeed via gh pr create — no extra commits needed
    expect(prUrl).toBe("https://github.com/test/repo/pull/99");
    const call = (mockSpawnSync as any).mock.calls[0];
    expect(call[0]).toBe("gh");
    expect(call[1]).toContain("pr");
    expect(call[1]).toContain("create");
  });
});

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

  it("commitAndPush calls git add, unstages excluded, commits, and pushes", async () => {
    // Default mock returns status 0 for all calls except where overridden
    // Calls: git add -A, N × git reset HEAD (excluded files), git diff --staged --name-only,
    //        git diff --staged --quiet (status 1 = has changes), git commit, git push
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 1, stdout: "", stderr: "" }; // has changes
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" }; // no runtime files staged
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await git.commitAndPush("/workspace", "feat: add CSV export");

    const calls = (mockSpawnSync as any).mock.calls;
    const commands = calls.map((c: any[]) => c[1]);

    // First call should be git add -A
    expect(commands[0]).toEqual(["add", "-A"]);
    // Should contain git reset HEAD -- calls for excluded files
    const resetCalls = commands.filter((c: string[]) => c[0] === "reset" && c[1] === "HEAD");
    expect(resetCalls.length).toBeGreaterThan(0);
    // Should end with commit and push
    const commitCall = commands.find((c: string[]) => c[0] === "commit");
    expect(commitCall).toEqual(["commit", "-m", "feat: add CSV export"]);
    const pushCall = commands.find((c: string[]) => c[0] === "push");
    expect(pushCall).toEqual(["push", "-u", "origin", "HEAD"]);
  });

  it("createPullRequest pushes branch then calls gh pr create", async () => {
    (mockSpawnSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh") {
        return { status: 0, stdout: "https://github.com/test/repo/pull/1\n", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 0, stdout: "", stderr: "" }; // no remaining changes
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
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

    const calls = (mockSpawnSync as any).mock.calls;
    const commands = calls.map((c: any[]) => ({ cmd: c[0], args: c[1] }));
    // Should push before gh pr create
    const pushIdx = commands.findIndex((c: any) => c.cmd === "git" && c.args[0] === "push");
    const ghIdx = commands.findIndex((c: any) => c.cmd === "gh");
    expect(pushIdx).toBeGreaterThan(-1);
    expect(ghIdx).toBeGreaterThan(pushIdx);
    expect(commands[ghIdx].args).toContain("pr");
    expect(commands[ghIdx].args).toContain("create");
  });

  it("createPullRequest returns manual message when gh pr create fails", async () => {
    (mockSpawnSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh") {
        return { status: 1, stdout: "", stderr: "gh not found" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 0, stdout: "", stderr: "" }; // no remaining changes
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
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
    expect(result).toContain("Create PR manually");

    // Branch should have been pushed before gh attempt
    const calls = (mockSpawnSync as any).mock.calls;
    const pushIdx = calls.findIndex((c: any[]) => c[0] === "git" && c[1][0] === "push");
    const ghIdx = calls.findIndex((c: any[]) => c[0] === "gh");
    expect(pushIdx).toBeGreaterThan(-1);
    expect(ghIdx).toBeGreaterThan(pushIdx);
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

  it("commitStepCheckpoint: happy path — stages changes, unstages excluded, commits, pushes and returns true", async () => {
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 1, stdout: "", stderr: "" }; // has changes
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" }; // no runtime files
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    const result = await git.commitStepCheckpoint("/workspace", "run-abc123", 1, "developer");

    expect(result).toBe(true);

    const calls = (mockSpawnSync as any).mock.calls;
    const commands = calls.map((c: any[]) => c[1]);
    expect(commands[0]).toEqual(["add", "-A"]);
    // Should have reset calls for excluded files
    const resetCalls = commands.filter((c: string[]) => c[0] === "reset" && c[1] === "HEAD");
    expect(resetCalls.length).toBeGreaterThan(0);
    // Should commit then push
    const commitCall = commands.find((c: string[]) => c[0] === "commit");
    expect(commitCall).toEqual(["commit", "-m", "chore(agentsdlc): run run-abc123 step 1 developer"]);
    const pushCall = commands.find((c: string[]) => c[0] === "push");
    expect(pushCall).toEqual(["push", "-u", "origin", "HEAD"]);
  });

  it("commitStepCheckpoint: commit message includes runId, stepNumber, and agentId", async () => {
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await git.commitStepCheckpoint("/workspace", "run-xyz-99", 42, "qa");

    const calls = (mockSpawnSync as any).mock.calls;
    const commitCall = calls.find((c: any[]) => c[1][0] === "commit");
    expect(commitCall).toBeDefined();
    const commitMsg = commitCall[1][commitCall[1].indexOf("-m") + 1];
    expect(commitMsg).toBe("chore(agentsdlc): run run-xyz-99 step 42 qa");
  });

  it("commitStepCheckpoint: no-diff skip — returns false without creating a commit", async () => {
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 0, stdout: "", stderr: "" }; // no changes
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    const result = await git.commitStepCheckpoint("/workspace", "run-noop", 3, "developer");

    expect(result).toBe(false);

    const calls = (mockSpawnSync as any).mock.calls;
    const commandNames = calls.map((c: any[]) => c[1][0]);
    expect(commandNames).not.toContain("commit");
  });

  it("commitStepCheckpoint: unstages orchestration scaffold files (CLAUDE.md, AGENTS.md, etc.)", async () => {
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await git.commitStepCheckpoint("/workspace", "run-excl", 1, "developer");

    const calls = (mockSpawnSync as any).mock.calls;
    const resetPaths = calls
      .filter((c: any[]) => c[1][0] === "reset" && c[1][1] === "HEAD")
      .map((c: any[]) => c[1][3]); // ["reset", "HEAD", "--", <path>]

    expect(resetPaths).toContain("CLAUDE.md");
    expect(resetPaths).toContain("AGENTS.md");
    expect(resetPaths).toContain(".agent-task.md");
    expect(resetPaths).toContain(".agent-result.json");
    expect(resetPaths).toContain(".agent-profile.md");
    expect(resetPaths).toContain(".agentsdlc");
    expect(resetPaths).toContain("artifacts");
    expect(resetPaths).toContain(".entire");
  });

  it("commitStepCheckpoint: unstages step-specific runtime debug/log files", async () => {
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return {
          status: 0,
          stdout: ".claude-runtime.step-1.attempt-1.debug.json\n.codex-runtime.step-2.attempt-1.stderr.log\nsrc/index.ts\n",
          stderr: "",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await git.commitStepCheckpoint("/workspace", "run-rt", 1, "developer");

    const calls = (mockSpawnSync as any).mock.calls;
    const resetPaths = calls
      .filter((c: any[]) => c[1][0] === "reset" && c[1][1] === "HEAD")
      .map((c: any[]) => c[1][3]);

    // Runtime files should be unstaged
    expect(resetPaths).toContain(".claude-runtime.step-1.attempt-1.debug.json");
    expect(resetPaths).toContain(".codex-runtime.step-2.attempt-1.stderr.log");
    // Real source files should NOT be unstaged
    expect(resetPaths).not.toContain("src/index.ts");
  });

  it("commitStepCheckpoint: throws when git commit fails (non-zero exit)", async () => {
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "commit") {
        return { status: 128, stdout: "", stderr: "fatal: not a git repository" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

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
    let callCount = 0;
    (mockSpawnSync as any).mockImplementation((_cmd: string, args: string[]) => {
      callCount++;
      if (callCount === 1) return { status: 0, stdout: "", stderr: "" }; // git add
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "commit") {
        return { error: new Error("ENOENT: git not found"), status: null, stdout: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    });

    const git = new GitManager(makeRepoConfig(), makeBranchStrategy());
    await expect(
      git.commitStepCheckpoint("/workspace", "run-err", 1, "developer")
    ).rejects.toThrow("ENOENT: git not found");
  });

  it("commitStepCheckpoint: PR creation still works after per-step commits (gh pr create path)", async () => {
    (mockSpawnSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "gh") {
        return { status: 0, stdout: "https://github.com/test/repo/pull/99\n", stderr: "" };
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--quiet") {
        return { status: 0, stdout: "", stderr: "" }; // no remaining changes (already committed by checkpoints)
      }
      if (args[0] === "diff" && args[1] === "--staged" && args[2] === "--name-only") {
        return { status: 0, stdout: "", stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
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

    expect(prUrl).toBe("https://github.com/test/repo/pull/99");
    // gh pr create should have been called after push
    const calls = (mockSpawnSync as any).mock.calls;
    const ghCall = calls.find((c: any[]) => c[0] === "gh");
    expect(ghCall).toBeDefined();
    expect(ghCall[1]).toContain("pr");
    expect(ghCall[1]).toContain("create");
  });
});

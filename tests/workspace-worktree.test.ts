import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PluginRegistry } from "../src/service/plugin-registry.js";
import { worktreeWorkspaceModule } from "../src/plugins/workspace-worktree/index.js";
import type { WorkspacePlugin } from "../src/shared/plugin-types.js";
import * as child_process from "child_process";
import * as fs from "fs/promises";

// We mock child_process.spawnSync and fs/promises so no real git commands or filesystem I/O run.
vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawnSync: vi.fn(),
  };
});

vi.mock("fs/promises", async () => {
  const actual = await vi.importActual<typeof import("fs/promises")>("fs/promises");
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
    access: vi.fn(),
    readdir: vi.fn().mockResolvedValue([]),
  };
});

const mockedSpawn = vi.mocked(child_process.spawnSync);
const mockedAccess = vi.mocked(fs.access);
const mockedReaddir = vi.mocked(fs.readdir);

// Default: commands succeed with empty output
function spawnOk(stdout = ""): any {
  return { status: 0, stdout, stderr: "", error: null };
}

// Simulate command output per first arg
function setupSpawnDefaults() {
  mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
    const joined = args?.join(" ") ?? "";

    // rev-parse --abbrev-ref HEAD
    if (joined.includes("--abbrev-ref")) return spawnOk("feat/test-branch\n");
    // rev-parse --git-common-dir
    if (joined.includes("--git-common-dir")) return spawnOk("../../_base\n");
    // rev-list --count
    if (joined.includes("rev-list")) return spawnOk("3\n");
    // diff --staged --quiet (0 = no changes)
    if (joined.includes("diff") && joined.includes("--quiet")) return spawnOk("");
    // diff --staged --name-only
    if (joined.includes("diff") && joined.includes("--name-only")) return spawnOk("");
    // config --global user.email
    if (joined.includes("config") && joined.includes("user.email") && !joined.includes("sprintfoundry")) {
      return spawnOk("user@example.com\n");
    }

    return spawnOk("");
  }) as any);
}

const makeTicket = () => ({
  id: "TEST-1",
  source: "github" as const,
  title: "Test ticket",
  description: "A test ticket",
  labels: [],
  priority: "p2" as const,
  acceptance_criteria: [],
  linked_tickets: [],
  comments: [],
  author: "tester",
  raw: {},
});

const makeRepoConfig = () => ({
  url: "https://github.com/test/repo.git",
  default_branch: "main",
});

const makeBranchStrategy = () => ({
  prefix: "feat/" as const,
  include_ticket_id: true,
  naming: "kebab-case" as const,
});

describe("workspace-worktree plugin", () => {
  beforeEach(() => {
    setupSpawnDefaults();
    // Base clone does not exist by default
    mockedAccess.mockRejectedValue(new Error("ENOENT"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --- Module & Registry ---

  it("registers in plugin registry", () => {
    const registry = new PluginRegistry();
    registry.register(worktreeWorkspaceModule, {
      project_id: "test-project",
      base_repo_dir: "/tmp/test-repos",
    });
    const plugin = registry.get<WorkspacePlugin>("workspace", "worktree");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("worktree");
  });

  it("uses default base_repo_dir if not provided", () => {
    const registry = new PluginRegistry();
    registry.register(worktreeWorkspaceModule, { project_id: "p1" });
    const plugin = registry.get<WorkspacePlugin>("workspace", "worktree");
    expect(plugin).not.toBeNull();
    expect(plugin!.name).toBe("worktree");
  });

  it("reports supportsSubWorktrees as true", () => {
    const registry = new PluginRegistry();
    registry.register(worktreeWorkspaceModule, { project_id: "p1" });
    const plugin = registry.get<WorkspacePlugin>("workspace", "worktree")!;
    expect(plugin.supportsSubWorktrees).toBe(true);
  });

  it("exposes createSubWorktree and mergeSubWorktree methods", () => {
    const registry = new PluginRegistry();
    registry.register(worktreeWorkspaceModule, { project_id: "p1" });
    const plugin = registry.get<WorkspacePlugin>("workspace", "worktree")!;
    expect(typeof plugin.createSubWorktree).toBe("function");
    expect(typeof plugin.mergeSubWorktree).toBe("function");
    expect(typeof plugin.removeSubWorktree).toBe("function");
  });

  // --- create() ---

  it("creates bare clone when no base exists", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());

    // Should have called git clone --bare
    const cloneCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.includes("clone") && args?.includes("--bare")
    );
    expect(cloneCalls.length).toBe(1);
    expect(cloneCalls[0][1]).toContain("https://github.com/test/repo.git");
  });

  it("fetches existing base clone when base exists", async () => {
    // Base clone exists
    mockedAccess.mockResolvedValueOnce(undefined);

    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());

    // Should have called git fetch --all --prune (not clone)
    const fetchCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.includes("fetch") && args?.includes("--all")
    );
    expect(fetchCalls.length).toBe(1);

    // Should NOT have called clone --bare
    const cloneCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.includes("clone") && args?.includes("--bare")
    );
    expect(cloneCalls.length).toBe(0);
  });

  it("creates worktree from base clone", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    const result = await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());

    // Should have called git worktree add
    const worktreeCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "worktree" && args?.[1] === "add"
    );
    expect(worktreeCalls.length).toBe(1);

    expect(result.path).toBe("/tmp/repos/test-project/run-run-abc");
    expect(result.branch).toContain("feat/");
  });

  it("injects token into clone URL when provided", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create(
      "run-abc",
      { url: "https://github.com/test/repo.git", default_branch: "main", token: "ghp_secret" },
      makeBranchStrategy(),
      makeTicket()
    );

    // Clone URL should contain the token
    const cloneCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.includes("clone") && args?.includes("--bare")
    );
    expect(cloneCalls.length).toBe(1);
    expect(cloneCalls[0][1]).toContain("https://ghp_secret@github.com/test/repo.git");
  });

  // --- destroy() ---

  it("removes worktree on destroy", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());
    await plugin.destroy("run-abc");

    const removeCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "worktree" && args?.[1] === "remove"
    );
    expect(removeCalls.length).toBe(1);
  });

  it("destroy is a no-op for unknown runId", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    // Should not throw
    await expect(plugin.destroy("nonexistent")).resolves.not.toThrow();
  });

  // --- commitStepChanges() ---

  it("commitStepChanges returns false when no changes staged", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());
    const result = await plugin.commitStepChanges("/tmp/repos/test-project/run-run-abc", "run-abc", 1, "developer");
    expect(result).toBe(false);
  });

  it("commitStepChanges commits and pushes when changes exist", async () => {
    // Override diff --staged --quiet to return non-zero (has changes)
    mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
      const joined = args?.join(" ") ?? "";
      if (joined.includes("diff") && joined.includes("--staged") && joined.includes("--quiet")) {
        return { status: 1, stdout: "", stderr: "", error: null };
      }
      if (joined.includes("diff") && joined.includes("--name-only")) return spawnOk("");
      if (joined.includes("config") && joined.includes("user.email") && !joined.includes("sprintfoundry")) {
        return spawnOk("user@example.com\n");
      }
      if (joined.includes("--abbrev-ref")) return spawnOk("feat/test-branch\n");
      return spawnOk("");
    }) as any);

    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());
    const result = await plugin.commitStepChanges("/tmp/repos/test-project/run-run-abc", "run-abc", 1, "developer");
    expect(result).toBe(true);

    // Should have committed
    const commitCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "commit"
    );
    expect(commitCalls.length).toBe(1);
    expect(commitCalls[0][1]).toContain("chore(sprintfoundry): run run-abc step 1 developer");
  });

  // --- Sub-worktree operations ---

  it("createSubWorktree creates isolated worktree from parent branch", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());

    const subPath = await plugin.createSubWorktree!("/tmp/repos/test-project/run-run-abc", 2);
    expect(subPath).toBe("/tmp/repos/test-project/run-run-abc-step2");

    const worktreeCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "worktree" && args?.[1] === "add" && args?.some(a => a.includes("-step2"))
    );
    expect(worktreeCalls.length).toBe(1);
  });

  it("mergeSubWorktree merges and cleans up", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());

    await plugin.mergeSubWorktree!(
      "/tmp/repos/test-project/run-run-abc",
      "/tmp/repos/test-project/run-run-abc-step2",
      2
    );

    // Should have called git merge
    const mergeCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "merge"
    );
    expect(mergeCalls.length).toBe(1);
    expect(mergeCalls[0][1]).toContain("--no-ff");
  });

  it("mergeSubWorktree skips merge when no new commits", async () => {
    // Override rev-list --count to return 0
    mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
      const joined = args?.join(" ") ?? "";
      if (joined.includes("rev-list") && joined.includes("--count")) return spawnOk("0\n");
      if (joined.includes("--abbrev-ref")) return spawnOk("feat/test-branch\n");
      if (joined.includes("--git-common-dir")) return spawnOk("../../_base\n");
      if (joined.includes("config") && joined.includes("user.email") && !joined.includes("sprintfoundry")) {
        return spawnOk("user@example.com\n");
      }
      return spawnOk("");
    }) as any);

    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());

    await plugin.mergeSubWorktree!(
      "/tmp/repos/test-project/run-run-abc",
      "/tmp/repos/test-project/run-run-abc-step2",
      2
    );

    // Should NOT have called git merge
    const mergeCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "merge"
    );
    expect(mergeCalls.length).toBe(0);
  });

  it("removeSubWorktree cleans up worktree and branch", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());

    // Mock rev-parse to return a step branch name
    mockedSpawn.mockImplementation(((cmd: string, args: string[]) => {
      const joined = args?.join(" ") ?? "";
      if (joined.includes("--abbrev-ref")) return spawnOk("feat/test-branch-step2\n");
      if (joined.includes("--git-common-dir")) return spawnOk("../../_base\n");
      if (joined.includes("config") && joined.includes("user.email") && !joined.includes("sprintfoundry")) {
        return spawnOk("user@example.com\n");
      }
      return spawnOk("");
    }) as any);

    await plugin.removeSubWorktree!("/tmp/repos/test-project/run-run-abc-step2");

    // Should have attempted to remove the worktree
    const removeCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "worktree" && args?.[1] === "remove"
    );
    expect(removeCalls.length).toBe(1);

    // Should have attempted to delete the step branch
    const branchDeleteCalls = mockedSpawn.mock.calls.filter(
      ([cmd, args]) => cmd === "git" && args?.[0] === "branch" && args?.[1] === "-D"
    );
    expect(branchDeleteCalls.length).toBe(1);
  });

  // --- list() ---

  it("lists run IDs from directory entries", async () => {
    mockedReaddir.mockResolvedValueOnce(["_base", "run-abc", "run-def"] as any);

    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    const runs = await plugin.list();
    expect(runs).toEqual(["abc", "def"]);
  });

  it("list returns empty array when dir does not exist", async () => {
    mockedReaddir.mockRejectedValueOnce(new Error("ENOENT"));

    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    const runs = await plugin.list();
    expect(runs).toEqual([]);
  });

  // --- getPath() ---

  it("getPath returns expected path for known runId", async () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    await plugin.create("run-abc", makeRepoConfig(), makeBranchStrategy(), makeTicket());
    expect(plugin.getPath("run-abc")).toBe("/tmp/repos/test-project/run-run-abc");
  });

  it("getPath returns computed path for unknown runId", () => {
    const plugin = worktreeWorkspaceModule.create({
      project_id: "test-project",
      base_repo_dir: "/tmp/repos",
    });

    expect(plugin.getPath("run-xyz")).toBe("/tmp/repos/test-project/run-run-xyz");
  });
});

describe("tmpdir plugin does NOT support sub-worktrees", () => {
  it("does not declare supportsSubWorktrees", async () => {
    const { tmpdirWorkspaceModule } = await import("../src/plugins/workspace-tmpdir/index.js");
    const registry = new PluginRegistry();
    registry.register(tmpdirWorkspaceModule, { project_id: "test-project" });
    const plugin = registry.get<WorkspacePlugin>("workspace", "tmpdir")!;
    expect(plugin.supportsSubWorktrees).toBeUndefined();
    expect(plugin.createSubWorktree).toBeUndefined();
  });
});

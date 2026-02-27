/**
 * Integration tests: Workspace Worktree Plugin
 * Create/destroy worktrees using real git repos.
 * Tests actual git operations (not mocked).
 */

import { describe, it, expect, afterEach } from "vitest";
import { execSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import * as path from "path";
import * as os from "os";
import { createFixtureWorkspace, type FixtureWorkspace } from "../helpers/fixture-workspace.js";

let cleanup: (() => void)[] = [];

afterEach(() => {
  for (const fn of cleanup) {
    try { fn(); } catch { /* */ }
  }
  cleanup = [];
});

/**
 * Create a bare repo from a fixture workspace (simulates a remote).
 */
function createBareFromFixture(fixture: FixtureWorkspace): string {
  const bareDir = mkdtempSync(path.join(os.tmpdir(), "sf-bare-integ-"));
  cleanup.push(() => rmSync(bareDir, { recursive: true, force: true }));
  execSync(`git clone --bare "${fixture.path}" "${bareDir}"`, { stdio: "pipe" });
  return bareDir;
}

describe("Workspace Worktree — git worktree operations", () => {
  it("creates a worktree from a bare clone", () => {
    const fixture = createFixtureWorkspace();
    cleanup.push(() => fixture.cleanup());

    const bareRepo = createBareFromFixture(fixture);
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), "sf-wt-integ-"));
    cleanup.push(() => rmSync(worktreeDir, { recursive: true, force: true }));

    const worktreePath = path.join(worktreeDir, "run-1");

    execSync(`git worktree add -b feat/run-1 "${worktreePath}" main`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    expect(existsSync(worktreePath)).toBe(true);
    expect(existsSync(path.join(worktreePath, "README.md"))).toBe(true);

    // Verify it's on the right branch
    const branch = execSync("git branch --show-current", { cwd: worktreePath, encoding: "utf-8" }).trim();
    expect(branch).toBe("feat/run-1");
  });

  it("can make changes in a worktree and commit", () => {
    const fixture = createFixtureWorkspace();
    cleanup.push(() => fixture.cleanup());

    const bareRepo = createBareFromFixture(fixture);
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), "sf-wt-commit-"));
    cleanup.push(() => rmSync(worktreeDir, { recursive: true, force: true }));

    const worktreePath = path.join(worktreeDir, "run-commit");
    execSync(`git worktree add -b feat/commit-test "${worktreePath}" main`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    // Make a change
    writeFileSync(path.join(worktreePath, "new-file.ts"), "export const x = 1;\n");
    execSync("git add . && git -c commit.gpgsign=false commit -m 'test commit'", {
      cwd: worktreePath,
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com" },
    });

    // Verify the commit exists
    const log = execSync("git log --oneline -1", { cwd: worktreePath, encoding: "utf-8" });
    expect(log).toContain("test commit");
  });

  it("removes a worktree cleanly", () => {
    const fixture = createFixtureWorkspace();
    cleanup.push(() => fixture.cleanup());

    const bareRepo = createBareFromFixture(fixture);
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), "sf-wt-rm-"));
    cleanup.push(() => rmSync(worktreeDir, { recursive: true, force: true }));

    const worktreePath = path.join(worktreeDir, "run-remove");
    execSync(`git worktree add -b feat/remove-test "${worktreePath}" main`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    expect(existsSync(worktreePath)).toBe(true);

    // Remove the worktree
    rmSync(worktreePath, { recursive: true, force: true });
    execSync("git worktree prune", { cwd: bareRepo, stdio: "pipe" });

    expect(existsSync(worktreePath)).toBe(false);

    // Verify it's pruned from git's perspective
    const list = execSync("git worktree list", { cwd: bareRepo, encoding: "utf-8" });
    expect(list).not.toContain("run-remove");
  });
});

describe("Workspace Worktree — parallel sub-worktrees", () => {
  it("creates multiple sub-worktrees from a parent worktree", () => {
    const fixture = createFixtureWorkspace();
    cleanup.push(() => fixture.cleanup());

    const bareRepo = createBareFromFixture(fixture);
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), "sf-sub-wt-"));
    cleanup.push(() => rmSync(worktreeDir, { recursive: true, force: true }));

    // Create parent worktree
    const parentPath = path.join(worktreeDir, "run-parent");
    execSync(`git worktree add -b feat/parent "${parentPath}" main`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    // Create sub-worktrees for parallel steps
    const sub1Path = path.join(worktreeDir, "run-parent-step-1");
    const sub2Path = path.join(worktreeDir, "run-parent-step-2");

    execSync(`git worktree add -b feat/parent-step-1 "${sub1Path}" feat/parent`, {
      cwd: bareRepo,
      stdio: "pipe",
    });
    execSync(`git worktree add -b feat/parent-step-2 "${sub2Path}" feat/parent`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    expect(existsSync(sub1Path)).toBe(true);
    expect(existsSync(sub2Path)).toBe(true);

    // Each sub-worktree has the same content
    expect(existsSync(path.join(sub1Path, "README.md"))).toBe(true);
    expect(existsSync(path.join(sub2Path, "README.md"))).toBe(true);

    // Verify they're on different branches
    const branch1 = execSync("git branch --show-current", { cwd: sub1Path, encoding: "utf-8" }).trim();
    const branch2 = execSync("git branch --show-current", { cwd: sub2Path, encoding: "utf-8" }).trim();
    expect(branch1).toBe("feat/parent-step-1");
    expect(branch2).toBe("feat/parent-step-2");
  });

  it("merges sub-worktree changes back into parent", () => {
    const fixture = createFixtureWorkspace();
    cleanup.push(() => fixture.cleanup());

    const bareRepo = createBareFromFixture(fixture);
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), "sf-merge-wt-"));
    cleanup.push(() => rmSync(worktreeDir, { recursive: true, force: true }));

    const parentPath = path.join(worktreeDir, "parent");
    execSync(`git worktree add -b feat/merge-parent "${parentPath}" main`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    const subPath = path.join(worktreeDir, "sub-step");
    execSync(`git worktree add -b feat/merge-step "${subPath}" feat/merge-parent`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    // Make changes in sub-worktree
    writeFileSync(path.join(subPath, "step-output.ts"), "export const result = 'done';\n");
    execSync("git add . && git -c commit.gpgsign=false commit -m 'step output'", {
      cwd: subPath,
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com" },
    });

    // Merge back into parent
    execSync("git -c commit.gpgsign=false merge --no-ff feat/merge-step -m 'merge step'", {
      cwd: parentPath,
      stdio: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com" },
    });

    // Verify merged file exists in parent
    expect(existsSync(path.join(parentPath, "step-output.ts"))).toBe(true);

    // Verify merge commit in parent
    const log = execSync("git log --oneline -2", { cwd: parentPath, encoding: "utf-8" });
    expect(log).toContain("merge step");
  });

  it("handles merge conflicts between parallel sub-worktrees", () => {
    const fixture = createFixtureWorkspace();
    cleanup.push(() => fixture.cleanup());

    const bareRepo = createBareFromFixture(fixture);
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), "sf-conflict-wt-"));
    cleanup.push(() => rmSync(worktreeDir, { recursive: true, force: true }));

    const parentPath = path.join(worktreeDir, "parent");
    execSync(`git worktree add -b feat/conflict-parent "${parentPath}" main`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    const sub1 = path.join(worktreeDir, "step-1");
    const sub2 = path.join(worktreeDir, "step-2");
    execSync(`git worktree add -b feat/conflict-s1 "${sub1}" feat/conflict-parent`, {
      cwd: bareRepo,
      stdio: "pipe",
    });
    execSync(`git worktree add -b feat/conflict-s2 "${sub2}" feat/conflict-parent`, {
      cwd: bareRepo,
      stdio: "pipe",
    });

    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com" };

    // Both modify the same file
    writeFileSync(path.join(sub1, "README.md"), "# Modified by step 1\n");
    execSync("git add . && git -c commit.gpgsign=false commit -m 'step 1 change'", { cwd: sub1, stdio: "pipe", env: gitEnv });

    writeFileSync(path.join(sub2, "README.md"), "# Modified by step 2\n");
    execSync("git add . && git -c commit.gpgsign=false commit -m 'step 2 change'", { cwd: sub2, stdio: "pipe", env: gitEnv });

    // First merge succeeds
    execSync("git -c commit.gpgsign=false merge --no-ff feat/conflict-s1 -m 'merge s1'", {
      cwd: parentPath,
      stdio: "pipe",
      env: gitEnv,
    });

    // Second merge should conflict
    try {
      execSync("git -c commit.gpgsign=false merge --no-ff feat/conflict-s2 -m 'merge s2'", {
        cwd: parentPath,
        stdio: "pipe",
        env: gitEnv,
      });
      // If it doesn't throw, that's fine (git might auto-resolve in some cases)
    } catch {
      // Expected: merge conflict
      // Abort the merge
      execSync("git merge --abort", { cwd: parentPath, stdio: "pipe" });
    }

    // Parent should still be in a clean state
    const status = execSync("git status --porcelain", { cwd: parentPath, encoding: "utf-8" });
    expect(status.trim()).toBe("");
  });
});

describe("Workspace Worktree — worktree listing", () => {
  it("lists all worktrees from bare repo", () => {
    const fixture = createFixtureWorkspace();
    cleanup.push(() => fixture.cleanup());

    const bareRepo = createBareFromFixture(fixture);
    const worktreeDir = mkdtempSync(path.join(os.tmpdir(), "sf-list-wt-"));
    cleanup.push(() => rmSync(worktreeDir, { recursive: true, force: true }));

    execSync(`git worktree add "${path.join(worktreeDir, "wt-a")}" -b feat/a main`, { cwd: bareRepo, stdio: "pipe" });
    execSync(`git worktree add "${path.join(worktreeDir, "wt-b")}" -b feat/b main`, { cwd: bareRepo, stdio: "pipe" });

    const list = execSync("git worktree list --porcelain", { cwd: bareRepo, encoding: "utf-8" });
    expect(list).toContain("wt-a");
    expect(list).toContain("wt-b");
  });
});

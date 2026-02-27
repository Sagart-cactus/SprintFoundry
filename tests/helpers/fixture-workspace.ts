/**
 * Test helper: create temporary git repos for workspace testing.
 * Sets up real git repos with initial commits for integration tests.
 */

import { execSync } from "child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

export interface FixtureWorkspace {
  /** Root path of the temporary git repo. */
  path: string;
  /** Clean up the workspace directory. */
  cleanup(): void;
  /** Write a file relative to the workspace root. */
  writeFile(relativePath: string, content: string): void;
  /** Stage and commit all changes. */
  commit(message: string): void;
  /** Create a new branch from the current HEAD. */
  createBranch(name: string): void;
  /** Checkout an existing branch. */
  checkout(name: string): void;
  /** Get the current branch name. */
  currentBranch(): string;
  /** Write a JSONL events file at .events.jsonl */
  writeEvents(events: object[]): void;
  /** Write a Claude Code JSONL session file. */
  writeClaudeSession(lines: object[]): void;
}

/**
 * Create a temporary git repo with an initial commit.
 * Returns a FixtureWorkspace with helper methods.
 */
export function createFixtureWorkspace(prefix = "sf-fixture-"): FixtureWorkspace {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), prefix));

  // Initialize git repo (disable commit signing for test repos)
  const git = (args: string) => {
    execSync(`git -c commit.gpgsign=false ${args}`, {
      cwd: tmpDir,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
  };

  git("init -b main");
  git("config user.email test@test.com");
  git("config user.name Test");

  // Create initial commit
  writeFileSync(path.join(tmpDir, "README.md"), "# Test Repo\n");
  git("add .");
  git('commit -m "Initial commit"');

  const workspace: FixtureWorkspace = {
    path: tmpDir,

    cleanup() {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* best effort */ }
    },

    writeFile(relativePath: string, content: string) {
      const fullPath = path.join(tmpDir, relativePath);
      const dir = path.dirname(fullPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(fullPath, content, "utf-8");
    },

    commit(message: string) {
      git("add .");
      git(`commit -m "${message}" --allow-empty`);
    },

    createBranch(name: string) {
      git(`checkout -b ${name}`);
    },

    checkout(name: string) {
      git(`checkout ${name}`);
    },

    currentBranch(): string {
      return execSync("git branch --show-current", { cwd: tmpDir, encoding: "utf-8" }).trim();
    },

    writeEvents(events: object[]) {
      const content = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
      writeFileSync(path.join(tmpDir, ".events.jsonl"), content, "utf-8");
    },

    writeClaudeSession(lines: object[]) {
      const claudeDir = path.join(tmpDir, ".claude");
      mkdirSync(claudeDir, { recursive: true });
      const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
      writeFileSync(path.join(claudeDir, "session.jsonl"), content, "utf-8");
    },
  };

  return workspace;
}

/**
 * Create a bare git repo (for testing worktree plugin's base clone behavior).
 */
export function createBareRepo(prefix = "sf-bare-"): { path: string; cleanup(): void } {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), prefix));
  execSync("git init --bare", {
    cwd: tmpDir,
    stdio: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  return {
    path: tmpDir,
    cleanup() {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    },
  };
}

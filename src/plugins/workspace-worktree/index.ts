// ============================================================
// SprintFoundry — Workspace Worktree Plugin
// Uses git worktrees for lightweight, isolated workspaces.
// A single base clone is kept per project; each run gets a
// worktree from it, and parallel steps get sub-worktrees.
// ============================================================

import { spawnSync } from "child_process";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  WorkspacePlugin,
  WorkspaceInfo,
  PluginModule,
} from "../../shared/plugin-types.js";
import type {
  AgentType,
  BranchStrategy,
  RepoConfig,
  TaskRun,
  TicketDetails,
} from "../../shared/types.js";

/**
 * Executes a git command synchronously in a given directory.
 * Returns stdout on success, throws on failure.
 */
function git(args: string[], cwd: string, repoConfig?: RepoConfig): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_SSH_COMMAND: repoConfig?.ssh_key_path
        ? `ssh -i ${repoConfig.ssh_key_path} -o StrictHostKeyChecking=no`
        : undefined,
    },
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args[0]} failed: ${result.stderr?.trim() || "unknown error"}`
    );
  }
  return result.stdout ?? "";
}

/** Like git() but returns {status, stdout} without throwing on non-zero exit. */
function gitRaw(args: string[], cwd: string, repoConfig?: RepoConfig): { status: number | null; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    env: {
      ...process.env,
      GIT_SSH_COMMAND: repoConfig?.ssh_key_path
        ? `ssh -i ${repoConfig.ssh_key_path} -o StrictHostKeyChecking=no`
        : undefined,
    },
  });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "" };
}

// Files the orchestration service writes for agent context — never commit these
const CHECKPOINT_EXCLUDE = [
  "CLAUDE.md", "AGENTS.md", ".agent-task.md", ".agent-result.json",
  ".agent-profile.md", ".sprintfoundry", ".planner-task.md",
  ".planner-plan.raw.txt", ".planner-rework-task.md", ".planner-rework.raw.txt",
  ".planner-runtime.stdout.log", ".planner-runtime.stderr.log",
  ".planner-rework.stderr.log", ".claude-runtime.stdout.log",
  ".claude-runtime.stderr.log", ".claude-runtime.debug.json",
  ".codex-runtime.stdout.log", ".codex-runtime.stderr.log",
  ".codex-runtime.debug.json", ".codex-home", ".agent-context",
  ".events.jsonl", ".entire", "artifacts",
];

class WorktreeWorkspacePlugin implements WorkspacePlugin {
  readonly name = "worktree";
  readonly supportsSubWorktrees = true;

  private baseDir: string;
  private repoConfig: RepoConfig | null = null;
  private branchStrategy: BranchStrategy | null = null;
  private runWorktrees = new Map<string, string>(); // runId → worktree path

  constructor(config: { base_repo_dir: string; project_id: string }) {
    this.baseDir = path.join(config.base_repo_dir, config.project_id);
  }

  // ---- Base clone management ----

  private get baseClonePath(): string {
    return path.join(this.baseDir, "_base");
  }

  /**
   * Ensure a base bare clone exists and is up-to-date.
   * Uses a bare clone so worktrees share the object database.
   */
  private async ensureBaseClone(repoConfig: RepoConfig): Promise<void> {
    const basePath = this.baseClonePath;

    try {
      await fs.access(path.join(basePath, "HEAD"));
      // Base clone exists — fetch latest
      console.log(`[worktree] Fetching latest into base clone: ${basePath}`);
      git(["fetch", "--all", "--prune"], basePath, repoConfig);
    } catch {
      // No base clone — create bare clone
      console.log(`[worktree] Creating base bare clone: ${basePath}`);
      await fs.mkdir(basePath, { recursive: true });
      const cloneUrl = repoConfig.token
        ? this.injectToken(repoConfig.url, repoConfig.token)
        : repoConfig.url;
      git(["clone", "--bare", cloneUrl, basePath], path.dirname(basePath), repoConfig);
    }
  }

  // ---- WorkspacePlugin interface ----

  async create(
    runId: string,
    repoConfig: RepoConfig,
    branchStrategy: BranchStrategy,
    ticket: TicketDetails
  ): Promise<WorkspaceInfo> {
    this.repoConfig = repoConfig;
    this.branchStrategy = branchStrategy;

    // 1. Ensure base clone is current
    await this.ensureBaseClone(repoConfig);

    // 2. Create worktree for this run
    const worktreePath = path.join(this.baseDir, `run-${runId}`);
    const branchName = this.resolveAvailableBranchName(
      this.buildBranchName(ticket, branchStrategy),
      runId
    );

    console.log(`[worktree] Creating worktree for run ${runId}: ${worktreePath}`);
    git(
      ["worktree", "add", "-b", branchName, worktreePath, repoConfig.default_branch],
      this.baseClonePath,
      repoConfig
    );

    // 3. Set up push tracking
    this.ensureGitIdentity(worktreePath);
    const cloneUrl = repoConfig.token
      ? this.injectToken(repoConfig.url, repoConfig.token)
      : repoConfig.url;
    git(["remote", "set-url", "origin", cloneUrl], worktreePath, repoConfig);

    this.runWorktrees.set(runId, worktreePath);

    return { path: worktreePath, branch: branchName };
  }

  async destroy(runId: string): Promise<void> {
    const worktreePath = this.runWorktrees.get(runId);
    if (!worktreePath) return;

    console.log(`[worktree] Removing worktree for run ${runId}: ${worktreePath}`);
    try {
      git(["worktree", "remove", "--force", worktreePath], this.baseClonePath);
    } catch {
      // Fallback: remove directory manually if worktree remove fails
      await fs.rm(worktreePath, { recursive: true, force: true });
      try { git(["worktree", "prune"], this.baseClonePath); } catch { /* best effort */ }
    }
    this.runWorktrees.delete(runId);
  }

  async commitStepChanges(
    workspacePath: string,
    runId: string,
    stepNumber: number,
    agent: AgentType
  ): Promise<boolean> {
    git(["add", "-A"], workspacePath, this.repoConfig ?? undefined);
    this.unstageExcluded(workspacePath);

    const diff = gitRaw(["diff", "--staged", "--quiet"], workspacePath);
    if (diff.status === 0) {
      console.log(`[worktree] Step ${stepNumber} checkpoint: no changes to commit.`);
      return false;
    }

    const message = `chore(sprintfoundry): run ${runId} step ${stepNumber} ${agent}`;
    git(["commit", "-m", message], workspacePath, this.repoConfig ?? undefined);
    try {
      git(["push", "-u", "origin", "HEAD"], workspacePath, this.repoConfig ?? undefined);
      console.log(`[worktree] Step ${stepNumber} checkpoint committed and pushed.`);
    } catch (err) {
      console.warn(`[worktree] Step ${stepNumber} checkpoint committed locally (push skipped: ${(err as Error).message.split("\n")[0]})`);
    }
    return true;
  }

  async createPullRequest(workspacePath: string, run: TaskRun): Promise<string> {
    // Commit any remaining changes
    git(["add", "-A"], workspacePath, this.repoConfig ?? undefined);
    this.unstageExcluded(workspacePath);
    const diff = gitRaw(["diff", "--staged", "--quiet"], workspacePath);
    if (diff.status !== 0) {
      git(
        ["commit", "-m", `feat: ${run.ticket.title} [SprintFoundry run ${run.run_id}]`],
        workspacePath,
        this.repoConfig ?? undefined
      );
    }
    git(["push", "-u", "origin", "HEAD"], workspacePath, this.repoConfig ?? undefined);

    // Use gh CLI
    try {
      const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath).trim();
      const title = `[SprintFoundry] ${run.ticket.title}`;
      const result = spawnSync("gh", [
        "pr", "create", "--title", title, "--body", `SprintFoundry run ${run.run_id}`,
        "--base", this.repoConfig?.default_branch ?? "main", "--head", branch,
      ], { cwd: workspacePath, encoding: "utf-8", timeout: 30_000 });
      if (result.status === 0) return result.stdout.trim();
    } catch { /* fall through */ }
    return `Branch pushed. Create PR manually for ${run.ticket.id}.`;
  }

  getPath(runId: string): string {
    return this.runWorktrees.get(runId) ?? path.join(this.baseDir, `run-${runId}`);
  }

  async list(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.baseDir);
      return entries
        .filter((e) => e.startsWith("run-"))
        .map((e) => e.replace(/^run-/, ""));
    } catch {
      return [];
    }
  }

  // ---- Sub-worktree support for parallel step isolation ----

  async createSubWorktree(parentPath: string, stepNumber: number): Promise<string> {
    const subPath = `${parentPath}-step${stepNumber}`;
    const parentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], parentPath).trim();
    const subBranch = `${parentBranch}-step${stepNumber}`;

    console.log(`[worktree] Creating sub-worktree for step ${stepNumber}: ${subPath}`);
    git(
      ["worktree", "add", "-b", subBranch, subPath, parentBranch],
      parentPath,
      this.repoConfig ?? undefined
    );

    return subPath;
  }

  async mergeSubWorktree(parentPath: string, subWorktreePath: string, stepNumber: number): Promise<void> {
    const subBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], subWorktreePath).trim();

    // Check if sub-worktree has any commits beyond the parent
    const parentBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], parentPath).trim();
    const revCount = git(["rev-list", "--count", `${parentBranch}..${subBranch}`], parentPath).trim();

    if (revCount === "0") {
      console.log(`[worktree] Step ${stepNumber}: no new commits to merge.`);
      await this.removeSubWorktree(subWorktreePath);
      return;
    }

    console.log(`[worktree] Merging step ${stepNumber} sub-worktree (${revCount} commits).`);
    git(["merge", "--no-ff", "-m", `merge: step ${stepNumber} parallel work`, subBranch], parentPath, this.repoConfig ?? undefined);

    // Clean up
    await this.removeSubWorktree(subWorktreePath);
  }

  async removeSubWorktree(subWorktreePath: string): Promise<void> {
    // Get the branch name before removing
    let subBranch: string | null = null;
    try {
      subBranch = git(["rev-parse", "--abbrev-ref", "HEAD"], subWorktreePath).trim();
    } catch { /* worktree might already be gone */ }

    // Find the parent bare repo or closest .git directory to run worktree remove
    try {
      const gitDir = git(["rev-parse", "--git-common-dir"], subWorktreePath).trim();
      const bareDir = path.resolve(subWorktreePath, gitDir);
      git(["worktree", "remove", "--force", subWorktreePath], bareDir);
    } catch {
      await fs.rm(subWorktreePath, { recursive: true, force: true });
    }

    // Delete the temporary branch
    if (subBranch && subBranch.includes("-step")) {
      try {
        // Find a worktree that still exists to run branch -D from
        const parentPath = subWorktreePath.replace(/-step\d+$/, "");
        git(["branch", "-D", subBranch], parentPath);
      } catch { /* best effort */ }
    }
  }

  // ---- Helpers ----

  private buildBranchName(ticket: TicketDetails, strategy: BranchStrategy): string {
    const { prefix, include_ticket_id, naming } = strategy;
    const parts: string[] = [];
    const sep = naming === "snake_case" ? "_" : "-";

    if (include_ticket_id) {
      parts.push(this.sanitize(ticket.id, sep));
    }
    parts.push(this.sanitize(ticket.title, sep).slice(0, 50));

    return prefix + parts.join(sep);
  }

  private resolveAvailableBranchName(baseName: string, runId: string): string {
    if (!this.branchExists(baseName)) return baseName;
    const suffix = runId.slice(-6).toLowerCase();
    let candidate = `${baseName}-${suffix}`;
    let index = 2;
    while (this.branchExists(candidate)) {
      candidate = `${baseName}-${suffix}-${index}`;
      index += 1;
    }
    return candidate;
  }

  private branchExists(branch: string): boolean {
    const result = gitRaw(
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      this.baseClonePath,
      this.repoConfig ?? undefined
    );
    return result.status === 0;
  }

  private sanitize(value: string, sep: "-" | "_"): string {
    const s = value.toLowerCase().replace(/[^a-z0-9]+/g, sep).replace(/^[-_]+|[-_]+$/g, "");
    return s || "work";
  }

  private injectToken(url: string, token: string): string {
    if (url.startsWith("git@")) {
      const match = url.match(/git@(.+):(.+)/);
      if (match) return `https://${token}@${match[1]}/${match[2]}`;
    }
    return url.replace("https://", `https://${token}@`);
  }

  private ensureGitIdentity(cwd: string): void {
    const result = gitRaw(["config", "--global", "user.email"], cwd);
    if (!result.stdout.trim()) {
      gitRaw(["config", "--global", "user.email", "sprintfoundry@localhost"], cwd);
      gitRaw(["config", "--global", "user.name", "SprintFoundry"], cwd);
    }
  }

  private unstageExcluded(workspacePath: string): void {
    for (const pattern of CHECKPOINT_EXCLUDE) {
      gitRaw(["reset", "HEAD", "--", pattern], workspacePath);
    }
    const staged = gitRaw(["diff", "--staged", "--name-only"], workspacePath);
    const runtimePattern = /^\.(claude|codex)-runtime\.step-.*\.(debug\.json|stdout\.log|stderr\.log|retry\.stdout\.log|retry\.stderr\.log)$/;
    for (const file of (staged.stdout || "").split("\n").filter(Boolean)) {
      if (runtimePattern.test(file)) {
        gitRaw(["reset", "HEAD", "--", file], workspacePath);
      }
    }
  }
}

export const worktreeWorkspaceModule: PluginModule<WorkspacePlugin> = {
  manifest: {
    name: "worktree",
    slot: "workspace",
    version: "1.0.0",
    description: "Git worktree workspace with shared object database and sub-worktree isolation for parallel steps",
  },
  create: (config) => {
    const baseRepoDir = (config.base_repo_dir as string) ?? "/var/cache/sprintfoundry/repos";
    const projectId = (config.project_id as string) ?? "default";
    return new WorktreeWorkspacePlugin({ base_repo_dir: baseRepoDir, project_id: projectId });
  },
};

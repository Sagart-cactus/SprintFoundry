// ============================================================
// SprintFoundry — Git Manager
// Clone repos, create branches, commit, push, create PRs
// ============================================================

import { spawnSync } from "child_process";
import type {
  RepoConfig,
  BranchStrategy,
  TicketDetails,
  TaskRun,
} from "../shared/types.js";

export class GitManager {
  constructor(
    private repoConfig: RepoConfig,
    private branchStrategy: BranchStrategy
  ) {}

  async cloneAndBranch(
    workspacePath: string,
    ticket: TicketDetails
  ): Promise<string> {
    const branchName = this.buildBranchName(ticket);

    // Clone the repository
    const cloneUrl = this.repoConfig.token
      ? this.injectToken(this.repoConfig.url, this.repoConfig.token)
      : this.repoConfig.url;

    this.exec(["git", "clone", "--depth", "50", cloneUrl, "."], workspacePath);
    this.exec(
      ["git", "checkout", "-b", branchName, `origin/${this.repoConfig.default_branch}`],
      workspacePath
    );

    // Enable Entire session tracking on the cloned repo (best-effort)
    this.tryEnableEntire(workspacePath);

    return branchName;
  }

  // Files written by the orchestration service for agent context — never commit these
  private static CHECKPOINT_EXCLUDE = [
    "CLAUDE.md",
    "AGENTS.md",
    ".agent-task.md",
    ".agent-result.json",
    ".agent-profile.md",
    ".sprintfoundry",
    ".planner-task.md",
    ".planner-plan.raw.txt",
    ".planner-rework-task.md",
    ".planner-rework.raw.txt",
    ".planner-runtime.stdout.log",
    ".planner-runtime.stderr.log",
    ".planner-rework.stderr.log",
    ".claude-runtime.stdout.log",
    ".claude-runtime.stderr.log",
    ".claude-runtime.debug.json",
    ".codex-runtime.stdout.log",
    ".codex-runtime.stderr.log",
    ".codex-runtime.debug.json",
    ".codex-home",
    ".agent-context",
    ".events.jsonl",
    ".entire",
    "artifacts",
  ];

  async commitStepCheckpoint(
    workspacePath: string,
    runId: string,
    stepNumber: number,
    agentId: string
  ): Promise<boolean> {
    this.exec(["git", "add", "-A"], workspacePath);
    this.unstageExcluded(workspacePath);

    // Check whether there is anything staged to commit
    const diffResult = this.execRaw(["git", "diff", "--staged", "--quiet"], workspacePath);
    if (diffResult.status === 0) {
      // Exit code 0 means no diff — nothing to commit
      console.log(`[git] Step ${stepNumber} checkpoint: no changes to commit, skipping.`);
      return false;
    }

    const message = `chore(sprintfoundry): run ${runId} step ${stepNumber} ${agentId}`;
    this.exec(["git", "commit", "-m", message], workspacePath);
    this.exec(["git", "push", "-u", "origin", "HEAD"], workspacePath);
    console.log(`[git] Step ${stepNumber} checkpoint committed and pushed: "${message}"`);
    return true;
  }

  async commitAndPush(
    workspacePath: string,
    message: string
  ): Promise<void> {
    this.exec(["git", "add", "-A"], workspacePath);
    this.unstageExcluded(workspacePath);
    // Only commit if there are staged changes (step checkpoints may have already committed everything)
    const diffResult = this.execRaw(["git", "diff", "--staged", "--quiet"], workspacePath);
    if (diffResult.status !== 0) {
      this.exec(["git", "commit", "-m", message], workspacePath);
    }
    this.exec(["git", "push", "-u", "origin", "HEAD"], workspacePath);
  }

  async createPullRequest(
    workspacePath: string,
    run: TaskRun
  ): Promise<string> {
    const title = `[SprintFoundry] ${run.ticket.title}`;
    const body = this.buildPRBody(run);

    // Commit any remaining unstaged changes before pushing
    this.exec(["git", "add", "-A"], workspacePath);
    this.unstageExcluded(workspacePath);
    const diffResult = this.execRaw(["git", "diff", "--staged", "--quiet"], workspacePath);
    if (diffResult.status !== 0) {
      this.exec(["git", "commit", "-m", `feat: ${run.ticket.title} [SprintFoundry run ${run.run_id}]`], workspacePath);
    }

    // Push branch to remote before creating PR
    this.exec(["git", "push", "-u", "origin", "HEAD"], workspacePath);

    // Use GitHub CLI if available, otherwise return placeholder
    try {
      const result = this.exec(
        ["gh", "pr", "create", "--title", title, "--body", body, "--base", this.repoConfig.default_branch],
        workspacePath
      );
      return result.trim();
    } catch {
      return `Branch pushed. Create PR manually for ${run.ticket.id}.`;
    }
  }

  private buildBranchName(ticket: TicketDetails): string {
    const { prefix, include_ticket_id, naming } = this.branchStrategy;
    const parts: string[] = [];

    if (include_ticket_id) {
      parts.push(ticket.id.toLowerCase());
    }

    // Slugify the title
    const slug = ticket.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, naming === "snake_case" ? "_" : "-")
      .replace(/^[-_]+|[-_]+$/g, "")
      .slice(0, 50);

    parts.push(slug);

    return prefix + parts.join(naming === "snake_case" ? "_" : "-");
  }

  private buildPRBody(run: TaskRun): string {
    const lines: string[] = [];

    // --- Summary ---
    lines.push(`## Summary`);
    lines.push(``);
    const classification = run.plan?.classification;
    if (classification) {
      lines.push(`**Type**: ${classification.replace(/_/g, " ")}`);
    }
    lines.push(`**Ticket**: ${run.ticket.id} — ${run.ticket.title}`);
    lines.push(`**Priority**: ${run.ticket.priority.toUpperCase()}`);
    if (run.ticket.labels.length > 0) {
      lines.push(`**Labels**: ${run.ticket.labels.join(", ")}`);
    }
    lines.push(``);

    // --- Description ---
    if (run.ticket.description) {
      lines.push(`## Description`);
      lines.push(``);
      lines.push(run.ticket.description);
      lines.push(``);
    }

    // --- Acceptance Criteria ---
    if (run.ticket.acceptance_criteria.length > 0) {
      lines.push(`## Acceptance Criteria`);
      lines.push(``);
      for (const ac of run.ticket.acceptance_criteria) {
        lines.push(`- [ ] ${ac}`);
      }
      lines.push(``);
    }

    // --- Agent Results ---
    const completedSteps = run.steps.filter((s) => s.result);
    if (completedSteps.length > 0) {
      lines.push(`## Agent Results`);
      lines.push(``);
      for (const step of completedSteps) {
        const r = step.result!;
        lines.push(`### Step ${step.step_number}: ${step.agent}`);
        lines.push(``);
        lines.push(r.summary);
        lines.push(``);
        const allFiles = [...r.artifacts_created, ...r.artifacts_modified];
        if (allFiles.length > 0) {
          lines.push(`<details><summary>Files touched (${allFiles.length})</summary>`);
          lines.push(``);
          for (const f of r.artifacts_created) {
            lines.push(`- \`${f}\` (new)`);
          }
          for (const f of r.artifacts_modified) {
            lines.push(`- \`${f}\` (modified)`);
          }
          lines.push(``);
          lines.push(`</details>`);
          lines.push(``);
        }
        if (r.issues.length > 0) {
          lines.push(`**Issues**: ${r.issues.join("; ")}`);
          lines.push(``);
        }
      }
    }

    // --- Stats ---
    lines.push(`## Stats`);
    lines.push(``);
    lines.push(`| Metric | Value |`);
    lines.push(`| --- | --- |`);
    lines.push(`| Tokens used | ${run.total_tokens_used.toLocaleString()} |`);
    lines.push(`| Cost | $${run.total_cost_usd.toFixed(2)} |`);
    lines.push(`| Steps | ${run.steps.length} |`);
    lines.push(`| Run ID | \`${run.run_id}\` |`);
    lines.push(``);

    // --- Footer ---
    lines.push(`---`);
    lines.push(`Generated by [SprintFoundry](https://github.com/Sagart-cactus/sprintfoundry)`);

    return lines.join("\n");
  }

  private unstageExcluded(workspacePath: string): void {
    for (const pattern of GitManager.CHECKPOINT_EXCLUDE) {
      this.execRaw(["git", "reset", "HEAD", "--", pattern], workspacePath);
    }
    // Also unstage any step-specific debug/log files (glob patterns)
    const stagedFiles = this.execRaw(["git", "diff", "--staged", "--name-only"], workspacePath);
    const runtimePattern = /^\.(claude|codex)-runtime\.step-.*\.(debug\.json|stdout\.log|stderr\.log|retry\.stdout\.log|retry\.stderr\.log)$/;
    for (const file of (stagedFiles.stdout || "").split("\n").filter(Boolean)) {
      if (runtimePattern.test(file)) {
        this.execRaw(["git", "reset", "HEAD", "--", file], workspacePath);
      }
    }
  }

  private tryEnableEntire(cwd: string): void {
    try {
      const [command, ...args] = ["entire", "enable", "--strategy", "manual-commit"];
      const result = spawnSync(command, args, {
        cwd,
        encoding: "utf-8",
        timeout: 10_000,
      });
      if (result.status === 0) {
        console.log(`[git] Entire enabled with manual strategy`);
      } else {
        console.log(`[git] Entire not available, skipping`);
      }
    } catch {
      // entire CLI not installed — silently skip
    }
  }

  private injectToken(url: string, token: string): string {
    // Convert git@github.com:org/repo.git to https://token@github.com/org/repo.git
    if (url.startsWith("git@")) {
      const match = url.match(/git@(.+):(.+)/);
      if (match) {
        return `https://${token}@${match[1]}/${match[2]}`;
      }
    }
    // For HTTPS URLs, inject token
    return url.replace("https://", `https://${token}@`);
  }

  private redactArgs(args: string[]): string[] {
    const token = this.repoConfig.token;
    if (!token) return args;
    return args.map((arg) => arg.includes(token) ? arg.replace(token, "***") : arg);
  }

  private exec(args: string[], cwd: string): string {
    console.log(`[git] Running: ${this.redactArgs(args).join(" ")}`);
    const [command, ...commandArgs] = args;
    const result = spawnSync(command, commandArgs, {
      cwd,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_SSH_COMMAND: this.repoConfig.ssh_key_path
          ? `ssh -i ${this.repoConfig.ssh_key_path} -o StrictHostKeyChecking=no`
          : undefined,
      },
    });

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `Command failed (${command}): ${result.stderr || "unknown error"}`
      );
    }
    return result.stdout ?? "";
  }

  // Like exec, but returns the raw result without throwing on non-zero exit codes.
  private execRaw(args: string[], cwd: string): { status: number | null; stdout: string } {
    const [command, ...commandArgs] = args;
    const result = spawnSync(command, commandArgs, {
      cwd,
      encoding: "utf-8",
      timeout: 60_000,
      env: {
        ...process.env,
        GIT_SSH_COMMAND: this.repoConfig.ssh_key_path
          ? `ssh -i ${this.repoConfig.ssh_key_path} -o StrictHostKeyChecking=no`
          : undefined,
      },
    });

    if (result.error) {
      throw result.error;
    }
    return { status: result.status, stdout: result.stdout ?? "" };
  }
}

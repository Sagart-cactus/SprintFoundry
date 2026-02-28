// ============================================================
// SprintFoundry — Plugin Type Definitions
// Interfaces for swappable workspace, tracker, SCM, and notifier plugins
// ============================================================

import type {
  AgentType,
  BranchStrategy,
  EventPriority,
  RepoConfig,
  TaskEvent,
  TaskRun,
  TaskSource,
  TicketDetails,
} from "./types.js";

// ----- Plugin Metadata -----

export type PluginSlot = "workspace" | "tracker" | "scm" | "notifier";

export interface PluginManifest {
  name: string;
  slot: PluginSlot;
  version: string;
  description?: string;
}

export interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config: Record<string, unknown>): T;
}

// ----- Workspace Plugin -----

export interface WorkspaceInfo {
  path: string;
  branch: string;
}

export interface WorkspacePlugin {
  readonly name: string;

  /** Create a workspace for a run: clone repo, create branch, return path + branch name. */
  create(
    runId: string,
    repoConfig: RepoConfig,
    branchStrategy: BranchStrategy,
    ticket: TicketDetails
  ): Promise<WorkspaceInfo>;

  /** Remove a workspace directory. */
  destroy(runId: string): Promise<void>;

  /** Checkpoint-commit step changes (add, commit, push). Returns true if there were changes. */
  commitStepChanges(
    workspacePath: string,
    runId: string,
    stepNumber: number,
    agent: AgentType,
  ): Promise<boolean>;

  /** Commit remaining changes, push, and create a pull request. Returns the PR URL. */
  createPullRequest(
    workspacePath: string,
    run: TaskRun,
  ): Promise<string>;

  /** Get the workspace path for a run (without creating it). */
  getPath(runId: string): string;

  /** List existing workspace run IDs. */
  list(): Promise<string[]>;

  // ---- Optional sub-worktree support for parallel step isolation ----

  /** Whether this plugin supports sub-worktree isolation for parallel steps. */
  readonly supportsSubWorktrees?: boolean;

  /** Create an isolated sub-worktree from the run workspace for a parallel step. */
  createSubWorktree?(parentPath: string, stepNumber: number): Promise<string>;

  /** Merge changes from a sub-worktree back into the parent workspace. */
  mergeSubWorktree?(parentPath: string, subWorktreePath: string, stepNumber: number): Promise<void>;

  /** Remove a sub-worktree (cleanup after merge or failure). */
  removeSubWorktree?(subWorktreePath: string): Promise<void>;
}

// ----- Tracker Plugin -----

export interface TrackerPlugin {
  readonly name: string;

  /** Fetch ticket details from the tracking system. */
  fetch(ticketId: string, source: TaskSource): Promise<TicketDetails>;

  /** Update the ticket status (e.g., "in_review") and optionally attach a PR URL. */
  updateStatus(
    ticket: TicketDetails,
    status: string,
    prUrl?: string
  ): Promise<void>;
}

// ----- SCM Plugin (post-PR lifecycle) -----

export interface PRInfo {
  number: number;
  url: string;
  branch: string;
  repo: string;
}

export type CIStatus = "pending" | "passing" | "failing" | "none";
export type ReviewDecision = "approved" | "changes_requested" | "pending" | "none";

export interface ReviewComment {
  id: number;
  author: string;
  body: string;
  path?: string;
  line?: number;
  created_at: string;
}

export interface MergeReadiness {
  mergeable: boolean;
  ci: CIStatus;
  review: ReviewDecision;
  blockers: string[];
}

export interface SCMPlugin {
  readonly name: string;

  /** Detect whether a PR exists for a branch. */
  detectPR(branch: string, repo: RepoConfig): Promise<PRInfo | null>;

  /** Get the current state of a PR (open, merged, closed). */
  getPRState(pr: PRInfo): Promise<"open" | "merged" | "closed">;

  /** Get aggregated CI status for a PR. */
  getCISummary(pr: PRInfo): Promise<CIStatus>;

  /** Get the review decision for a PR. */
  getReviewDecision(pr: PRInfo): Promise<ReviewDecision>;

  /** Get unresolved review comments. */
  getPendingComments(pr: PRInfo): Promise<ReviewComment[]>;

  /** Check if a PR is ready to merge. */
  getMergeability(pr: PRInfo): Promise<MergeReadiness>;

  /** Merge a PR. */
  mergePR(pr: PRInfo, method?: "merge" | "squash" | "rebase"): Promise<void>;
}

// ----- Notifier Plugin -----

export type { EventPriority } from "./types.js";

export interface NotifierPlugin {
  readonly name: string;

  /** Send a notification message. */
  notify(message: string, priority?: EventPriority): Promise<void>;
}

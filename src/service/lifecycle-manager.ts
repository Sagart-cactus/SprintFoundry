// ============================================================
// SprintFoundry — Lifecycle Manager
// Post-PR state machine: polls for CI failures, review comments,
// and merge readiness. Triggers rework loops or notifications.
// ============================================================

import type {
  LifecycleConfig,
  ReactionTrigger,
  RunSessionMetadata,
} from "../shared/types.js";
import type {
  SCMPlugin,
  PRInfo,
  CIStatus,
  ReviewDecision,
} from "../shared/plugin-types.js";
import { SessionManager } from "./session-manager.js";
import { NotificationRouter } from "./notification-router.js";

export interface LifecycleCallbacks {
  /** Called when CI fails and reaction is trigger-rework. */
  onCIFailure?(runId: string, prInfo: PRInfo, ciStatus: CIStatus): Promise<void>;
  /** Called when review changes requested and reaction is trigger-rework. */
  onChangesRequested?(runId: string, prInfo: PRInfo, comments: string[]): Promise<void>;
  /** Called when PR is approved + green and reaction is auto-merge. */
  onReadyToMerge?(runId: string, prInfo: PRInfo): Promise<void>;
}

interface WatchedRun {
  runId: string;
  branch: string;
  prUrl: string;
  repoUrl: string;
  ciFailureCount: number;
  reviewReworkCount: number;
}

export class LifecycleManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private watchedRuns = new Map<string, WatchedRun>();
  private running = false;

  constructor(
    private config: LifecycleConfig,
    private scm: SCMPlugin | null,
    private sessionManager: SessionManager,
    private notificationRouter: NotificationRouter,
    private callbacks: LifecycleCallbacks = {}
  ) {}

  /**
   * Start watching a completed run for post-PR lifecycle events.
   */
  watch(runId: string, branch: string, prUrl: string, repoUrl: string): void {
    if (!this.config.enabled) return;

    this.watchedRuns.set(runId, {
      runId,
      branch,
      prUrl,
      repoUrl,
      ciFailureCount: 0,
      reviewReworkCount: 0,
    });

    console.log(`[lifecycle] Watching run ${runId} (PR: ${prUrl})`);
  }

  /**
   * Stop watching a run.
   */
  unwatch(runId: string): void {
    this.watchedRuns.delete(runId);
  }

  /**
   * Start the polling loop.
   */
  start(): void {
    if (!this.config.enabled || this.timer) return;

    const intervalMs = this.config.poll_interval_ms || 30_000;
    console.log(`[lifecycle] Starting polling (interval: ${intervalMs}ms)`);

    this.timer = setInterval(() => {
      this.pollAll().catch((err) => {
        console.error(`[lifecycle] Poll error: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, intervalMs);
  }

  /**
   * Stop the polling loop.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      console.log("[lifecycle] Polling stopped");
    }
  }

  /**
   * Force-check a single run immediately.
   */
  async check(runId: string): Promise<void> {
    const watched = this.watchedRuns.get(runId);
    if (!watched) return;
    await this.checkRun(watched);
  }

  /**
   * Poll all watched runs.
   */
  async pollAll(): Promise<void> {
    if (this.running) return; // prevent overlapping polls
    this.running = true;

    try {
      for (const [, watched] of this.watchedRuns) {
        try {
          await this.checkRun(watched);
        } catch (err) {
          console.warn(`[lifecycle] Error checking run ${watched.runId}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async checkRun(watched: WatchedRun): Promise<void> {
    if (!this.scm) {
      console.warn("[lifecycle] No SCM plugin configured, skipping check");
      return;
    }

    // Detect PR
    const prInfo = await this.scm.detectPR(watched.branch, { url: watched.repoUrl, default_branch: "main" });
    if (!prInfo) return;

    // Check PR state
    const prState = await this.scm.getPRState(prInfo);
    if (prState === "merged") {
      console.log(`[lifecycle] PR ${prInfo.url} merged, unwatching run ${watched.runId}`);
      await this.sessionManager.updateStatus(watched.runId, "completed");
      await this.notificationRouter.notify(
        `PR ${prInfo.url} merged for run ${watched.runId}`,
        "info"
      );
      this.unwatch(watched.runId);
      return;
    }

    if (prState === "closed") {
      console.log(`[lifecycle] PR ${prInfo.url} closed, unwatching run ${watched.runId}`);
      this.unwatch(watched.runId);
      return;
    }

    // Check CI
    const ciStatus = await this.scm.getCISummary(prInfo);
    if (ciStatus === "failing") {
      await this.handleCIFailure(watched, prInfo);
    }

    // Check reviews
    const reviewDecision = await this.scm.getReviewDecision(prInfo);
    if (reviewDecision === "changes_requested") {
      await this.handleChangesRequested(watched, prInfo);
    }

    // Check merge readiness
    if (reviewDecision === "approved" && ciStatus === "passing") {
      await this.handleReadyToMerge(watched, prInfo);
    }
  }

  private async handleCIFailure(watched: WatchedRun, prInfo: PRInfo): Promise<void> {
    const reaction = this.config.reactions["ci-failed"];
    if (!reaction) return;

    watched.ciFailureCount++;

    if (watched.ciFailureCount > reaction.retries) {
      // Escalate
      await this.notificationRouter.notify(
        `CI has failed ${watched.ciFailureCount} times for run ${watched.runId} (PR: ${prInfo.url}). Manual intervention required.`,
        "urgent"
      );
      return;
    }

    if (reaction.auto && reaction.action === "trigger-rework") {
      console.log(`[lifecycle] CI failed for run ${watched.runId}, triggering rework (attempt ${watched.ciFailureCount}/${reaction.retries})`);
      await this.notificationRouter.notify(
        `CI failed for run ${watched.runId}. Triggering automated rework (attempt ${watched.ciFailureCount}).`,
        reaction.priority
      );
      if (this.callbacks.onCIFailure) {
        await this.callbacks.onCIFailure(watched.runId, prInfo, "failing");
      }
    } else {
      await this.notificationRouter.notify(
        `CI failed for run ${watched.runId} (PR: ${prInfo.url}). Requires attention.`,
        reaction.priority
      );
    }
  }

  private async handleChangesRequested(watched: WatchedRun, prInfo: PRInfo): Promise<void> {
    const reaction = this.config.reactions["changes-requested"];
    if (!reaction) return;

    watched.reviewReworkCount++;

    if (watched.reviewReworkCount > reaction.retries) {
      await this.notificationRouter.notify(
        `Review changes requested ${watched.reviewReworkCount} times for run ${watched.runId}. Manual intervention required.`,
        "urgent"
      );
      return;
    }

    if (reaction.auto && reaction.action === "trigger-rework") {
      const comments = await this.scm!.getPendingComments(prInfo);
      const commentBodies = comments.map((c) => c.body);

      console.log(`[lifecycle] Changes requested for run ${watched.runId}, triggering rework (attempt ${watched.reviewReworkCount}/${reaction.retries})`);
      await this.notificationRouter.notify(
        `Review changes requested for run ${watched.runId}. Triggering automated rework.`,
        reaction.priority
      );
      if (this.callbacks.onChangesRequested) {
        await this.callbacks.onChangesRequested(watched.runId, prInfo, commentBodies);
      }
    } else {
      await this.notificationRouter.notify(
        `Review changes requested for run ${watched.runId} (PR: ${prInfo.url}).`,
        reaction.priority
      );
    }
  }

  private async handleReadyToMerge(watched: WatchedRun, prInfo: PRInfo): Promise<void> {
    const reaction = this.config.reactions["approved-and-green"];
    if (!reaction) return;

    if (reaction.auto && reaction.action === "auto-merge") {
      const mergeability = await this.scm!.getMergeability(prInfo);
      if (mergeability.mergeable) {
        console.log(`[lifecycle] PR ${prInfo.url} approved and green, auto-merging`);
        if (this.callbacks.onReadyToMerge) {
          await this.callbacks.onReadyToMerge(watched.runId, prInfo);
        }
        await this.notificationRouter.notify(
          `PR ${prInfo.url} auto-merged for run ${watched.runId}.`,
          "info"
        );
        this.unwatch(watched.runId);
      } else {
        await this.notificationRouter.notify(
          `PR ${prInfo.url} approved and green but not mergeable: ${mergeability.blockers.join(", ")}`,
          "warning"
        );
      }
    } else {
      await this.notificationRouter.notify(
        `PR ${prInfo.url} is approved and CI is passing. Ready to merge.`,
        reaction.priority
      );
    }
  }

  /** Number of runs currently being watched. */
  get watchCount(): number {
    return this.watchedRuns.size;
  }

  /** Whether the polling loop is active. */
  get isRunning(): boolean {
    return this.timer !== null;
  }
}

/**
 * Create a default LifecycleConfig (disabled by default).
 */
export function defaultLifecycleConfig(): LifecycleConfig {
  return {
    enabled: false,
    poll_interval_ms: 30_000,
    reactions: {
      "ci-failed": {
        trigger: "ci-failed",
        auto: true,
        action: "trigger-rework",
        retries: 2,
        escalate_after: 3,
        priority: "warning",
      },
      "changes-requested": {
        trigger: "changes-requested",
        auto: true,
        action: "trigger-rework",
        retries: 1,
        escalate_after: "30m",
        priority: "action",
      },
      "approved-and-green": {
        trigger: "approved-and-green",
        auto: false,
        action: "notify",
        retries: 0,
        escalate_after: 0,
        priority: "action",
      },
      "agent-stuck": {
        trigger: "agent-stuck",
        auto: true,
        action: "notify",
        retries: 0,
        escalate_after: "10m",
        priority: "urgent",
      },
    },
    notification_routing: {
      urgent: ["console"],
      action: ["console"],
      warning: ["console"],
      info: ["console"],
    },
  };
}

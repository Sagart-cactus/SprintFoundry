// ============================================================
// SprintFoundry — Session Manager
// Flat-file persistence for run sessions.
// Stores metadata at ~/.sprintfoundry/sessions/{run_id}.json
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type {
  DurableSnapshotMetadata,
  TaskRun,
  RunSessionMetadata,
  RunStatus,
  TerminalWorkflowState,
} from "../shared/types.js";
import type { EventSinkClient } from "./event-sink-client.js";

const SESSIONS_DIR = path.join(os.homedir(), ".sprintfoundry", "sessions");
const ARCHIVE_DIR = path.join(SESSIONS_DIR, "archive");
const SESSIONS_DIR_ENV = "SPRINTFOUNDRY_SESSIONS_DIR";

export class SessionManager {
  private sessionsDir: string;
  private archiveDir: string;
  private sinkClient?: Pick<EventSinkClient, "upsertRun">;

  constructor(baseDir?: string, sinkClient?: Pick<EventSinkClient, "upsertRun">) {
    this.sessionsDir = baseDir ?? process.env[SESSIONS_DIR_ENV] ?? SESSIONS_DIR;
    this.archiveDir = path.join(this.sessionsDir, "archive");
    this.sinkClient = sinkClient;
  }

  /**
   * Persist (create or update) session metadata from a TaskRun.
   * Extracts a lightweight RunSessionMetadata snapshot.
   */
  async persist(run: TaskRun, extra?: { workspace_path?: string; branch?: string }): Promise<void> {
    await fs.mkdir(this.sessionsDir, { recursive: true });
    const existing = await this.readRaw(run.run_id);

    const currentStep = run.steps.length > 0
      ? Math.max(...run.steps.filter((s) => s.status === "running").map((s) => s.step_number), 0)
      : 0;

    const totalSteps = run.validated_plan?.steps.length
      ?? run.plan?.steps.length
      ?? 0;

    const metadata: RunSessionMetadata = {
      run_id: run.run_id,
      project_id: run.project_id,
      ticket_id: run.ticket?.id ?? "unknown",
      ticket_source: run.ticket?.source ?? "prompt",
      ticket_title: run.ticket?.title ?? "Unknown",
      status: run.status,
      current_step: currentStep,
      total_steps: totalSteps,
      plan_classification: run.plan?.classification ?? null,
      workspace_path: extra?.workspace_path ?? null,
      branch: extra?.branch ?? null,
      pr_url: run.pr_url,
      total_tokens: run.total_tokens_used,
      total_cost_usd: run.total_cost_usd,
      created_at: run.created_at instanceof Date ? run.created_at.toISOString() : String(run.created_at),
      updated_at: new Date().toISOString(),
      completed_at: run.completed_at instanceof Date ? run.completed_at.toISOString() : null,
      error: run.error,
      terminal_workflow_state: this.resolveTerminalWorkflowState(run.status, existing),
      durable_snapshot: existing?.durable_snapshot ?? null,
    };

    await this.save(metadata);
  }

  async updateSnapshotState(
    runId: string,
    update: {
      terminal_workflow_state?: TerminalWorkflowState;
      durable_snapshot?: DurableSnapshotMetadata | null;
    }
  ): Promise<RunSessionMetadata | null> {
    return this.patch(runId, (current) => ({
      ...current,
      ...(update.terminal_workflow_state
        ? { terminal_workflow_state: update.terminal_workflow_state }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(update, "durable_snapshot")
        ? { durable_snapshot: update.durable_snapshot ?? null }
        : {}),
      updated_at: new Date().toISOString(),
    }));
  }

  /**
   * Read session metadata for a specific run.
   */
  async get(runId: string): Promise<RunSessionMetadata | null> {
    const session = await this.readRaw(runId);
    if (!session) return null;
    return this.reconcileFromWorkspaceEvents(session);
  }

  /**
   * List all active (non-archived) sessions, sorted by updated_at descending.
   */
  async list(): Promise<RunSessionMetadata[]> {
    try {
      await fs.mkdir(this.sessionsDir, { recursive: true });
      const entries = await fs.readdir(this.sessionsDir);
      const jsonFiles = entries.filter((e) => e.endsWith(".json"));

      const sessions: RunSessionMetadata[] = [];
      for (const file of jsonFiles) {
        try {
          const raw = await fs.readFile(path.join(this.sessionsDir, file), "utf-8");
          const parsed = JSON.parse(raw) as RunSessionMetadata;
          sessions.push(await this.reconcileFromWorkspaceEvents(parsed));
        } catch {
          // Skip corrupt files
        }
      }

      sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      return sessions;
    } catch {
      return [];
    }
  }

  /**
   * Move a session to the archive directory.
   */
  async archive(runId: string): Promise<boolean> {
    const src = this.getSessionPath(runId);
    try {
      await fs.access(src);
    } catch {
      return false;
    }

    await fs.mkdir(this.archiveDir, { recursive: true });
    const dest = path.join(this.archiveDir, `${runId}.json`);
    await fs.rename(src, dest);
    return true;
  }

  /**
   * Delete a session file entirely.
   */
  async remove(runId: string): Promise<boolean> {
    const filePath = this.getSessionPath(runId);
    try {
      await fs.unlink(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update only the status field of a session (for cancel operations).
   */
  async updateStatus(runId: string, status: RunStatus): Promise<boolean> {
    const session = await this.get(runId);
    if (!session) return false;
    session.status = status;
    session.updated_at = new Date().toISOString();
    await this.update(session);
    return true;
  }

  async upsertMetadata(session: RunSessionMetadata): Promise<void> {
    await this.save(session);
  }

  private async save(session: RunSessionMetadata): Promise<void> {
    const filePath = this.getSessionPath(session.run_id);
    let writeError: unknown = null;
    try {
      await fs.writeFile(filePath, JSON.stringify(session, null, 2), "utf-8");
    } catch (error) {
      writeError = error;
    }
    await this.upsertToSink(session);
    if (writeError) {
      throw writeError;
    }
  }

  private async update(session: RunSessionMetadata): Promise<void> {
    await this.save(session);
  }

  private async patch(
    runId: string,
    updater: (current: RunSessionMetadata) => RunSessionMetadata
  ): Promise<RunSessionMetadata | null> {
    const current = await this.readRaw(runId);
    if (!current) return null;
    const next = updater(current);
    await this.update(next);
    return next;
  }

  private async upsertToSink(session: RunSessionMetadata): Promise<void> {
    if (!this.sinkClient) return;

    try {
      await this.sinkClient.upsertRun(session);
    } catch (error) {
      console.warn(
        `[session-sink] Failed to upsert run ${session.run_id}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private getSessionPath(runId: string): string {
    return path.join(this.sessionsDir, `${runId}.json`);
  }

  private async readRaw(runId: string): Promise<RunSessionMetadata | null> {
    const filePath = this.getSessionPath(runId);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      return JSON.parse(raw) as RunSessionMetadata;
    } catch {
      return null;
    }
  }

  private resolveTerminalWorkflowState(
    status: RunStatus,
    existing: RunSessionMetadata | null
  ): TerminalWorkflowState {
    if (status === "completed" || status === "failed" || status === "cancelled") {
      return existing?.terminal_workflow_state ?? "terminal_pending_snapshot";
    }
    return "running";
  }

  private async reconcileFromWorkspaceEvents(
    session: RunSessionMetadata
  ): Promise<RunSessionMetadata> {
    // Terminal/cancelled states are authoritative.
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "cancelled"
    ) {
      return session;
    }
    if (!session.workspace_path) return session;

    const eventsPath = path.join(session.workspace_path, ".events.jsonl");
    const raw = await fs.readFile(eventsPath, "utf-8").catch(() => "");
    if (!raw.trim()) return session;

    const events = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line) as { event_type?: string; timestamp?: string };
        } catch {
          return null;
        }
      })
      .filter((evt): evt is { event_type?: string; timestamp?: string } => Boolean(evt));

    if (events.length === 0) return session;

    let derived: RunStatus | null = null;
    let sawStepFailure = false;
    let hasTerminalTaskEvent = false;

    for (const event of events) {
      const type = event.event_type;
      if (type === "task.completed") {
        derived = "completed";
        hasTerminalTaskEvent = true;
      } else if (type === "task.failed") {
        derived = "failed";
        hasTerminalTaskEvent = true;
      } else if (type === "human_gate.requested") {
        if (!hasTerminalTaskEvent) derived = "waiting_human_review";
      } else if (type === "human_gate.approved") {
        if (!hasTerminalTaskEvent) derived = "executing";
      } else if (type === "human_gate.rejected") {
        derived = "failed";
        hasTerminalTaskEvent = true;
      } else if (type === "step.failed") {
        sawStepFailure = true;
        if (!hasTerminalTaskEvent) derived = "executing";
      } else if (type === "step.started") {
        if (!hasTerminalTaskEvent) derived = "executing";
      } else if (type === "task.plan_generated") {
        if (!hasTerminalTaskEvent && !derived) derived = "planning";
      } else if (type === "task.created") {
        if (!hasTerminalTaskEvent && !derived) derived = "pending";
      }
    }

    // If a step failed but no terminal task event was written, treat run as failed.
    if (!hasTerminalTaskEvent && sawStepFailure) {
      derived = "failed";
    }

    if (!derived || derived === session.status) return session;

    const lastTimestamp = events.at(-1)?.timestamp;
    return {
      ...session,
      status: derived,
      updated_at: lastTimestamp ?? session.updated_at,
      completed_at:
        (derived === "completed" || derived === "failed")
          ? (session.completed_at ?? lastTimestamp ?? null)
          : session.completed_at,
    };
  }
}

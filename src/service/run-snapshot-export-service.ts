import { EventStore } from "./event-store.js";
import { EventSinkClient } from "./event-sink-client.js";
import { RunSnapshotStore, type RunSnapshotUploadResult } from "./run-snapshot-store.js";
import { SessionManager } from "./session-manager.js";
import type {
  DurableSnapshotMetadata,
  RunSessionMetadata,
} from "../shared/types.js";

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function resolveTerminalStatus(
  status: RunSessionMetadata["status"]
): "completed" | "failed" | "cancelled" {
  if (status === "completed" || status === "failed" || status === "cancelled") {
    return status;
  }
  throw new Error(`Run status '${status}' is not terminal; snapshot export is not allowed.`);
}

export interface RunSnapshotExportServiceOptions {
  sessionManager?: SessionManager;
  snapshotStore?: RunSnapshotStore;
  eventStoreFactory?: (workspacePath: string) => EventStore;
}

const EVENT_SINK_URL_ENV = "SPRINTFOUNDRY_EVENT_SINK_URL";
const INTERNAL_API_TOKEN_ENV = "SPRINTFOUNDRY_INTERNAL_API_TOKEN";

export class RunSnapshotExportService {
  private readonly sessionManager: SessionManager;
  private readonly snapshotStore: RunSnapshotStore;
  private readonly eventStoreFactory: (workspacePath: string) => EventStore;

  constructor(options: RunSnapshotExportServiceOptions = {}) {
    this.sessionManager = options.sessionManager ?? new SessionManager();
    this.snapshotStore = options.snapshotStore ?? new RunSnapshotStore();
    this.eventStoreFactory =
      options.eventStoreFactory ??
      ((workspacePath) => {
        const sinkUrl = asString(process.env[EVENT_SINK_URL_ENV]);
        const internalApiToken = asString(process.env[INTERNAL_API_TOKEN_ENV]) || undefined;
        const sinkClient = sinkUrl ? new EventSinkClient(sinkUrl, globalThis.fetch, internalApiToken) : undefined;
        const store = new EventStore(undefined, sinkClient);
        void store.initialize(workspacePath);
        return store;
      });
  }

  async exportRun(runId: string): Promise<RunSnapshotUploadResult> {
    const session = await this.sessionManager.get(runId);
    if (!session) {
      throw new Error(`Run session not found for ${runId}`);
    }
    if (!session.workspace_path) {
      throw new Error(`Run ${runId} does not have a workspace path; snapshot export is not available.`);
    }

    const terminalStatus = resolveTerminalStatus(session.status);
    const uploadMarker = this.buildUploadingSnapshot(terminalStatus);
    await this.sessionManager.updateSnapshotState(runId, {
      terminal_workflow_state: "snapshot_uploading",
      durable_snapshot: uploadMarker,
    });

    const events = this.eventStoreFactory(session.workspace_path);
    await events.store({
      event_id: `workspace-snapshot-started-${runId}-${Date.now()}`,
      run_id: runId,
      event_type: "workspace.snapshot.started",
      timestamp: new Date(),
      data: {
        terminal_status: terminalStatus,
      },
    });

    try {
      const result = await this.snapshotStore.uploadRunSnapshot(
        {
          run_id: runId,
          project_id: session.project_id,
          terminal_status: terminalStatus,
        },
        session,
        session.workspace_path
      );

      await this.sessionManager.upsertMetadata(result.session);
      await events.store({
        event_id: `workspace-snapshot-completed-${runId}-${Date.now()}`,
        run_id: runId,
        event_type: "workspace.snapshot.completed",
        timestamp: new Date(),
        data: {
          terminal_status: terminalStatus,
          bucket: result.durableSnapshot.bucket,
          manifest_key: result.durableSnapshot.manifest_key,
          archive_key: result.durableSnapshot.archive_key,
        },
      });
      await events.close();
      return result;
    } catch (error) {
      const failureSnapshot: DurableSnapshotMetadata = {
        ...uploadMarker,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      await this.sessionManager.updateSnapshotState(runId, {
        terminal_workflow_state: "snapshot_failed",
        durable_snapshot: failureSnapshot,
      });
      await events.store({
        event_id: `workspace-snapshot-failed-${runId}-${Date.now()}`,
        run_id: runId,
        event_type: "workspace.snapshot.failed",
        timestamp: new Date(),
        data: {
          terminal_status: terminalStatus,
          error: failureSnapshot.error,
        },
      });
      await events.close();
      throw error;
    }
  }

  async markCleanupCompleted(runId: string, details: Record<string, unknown>): Promise<void> {
    const session = await this.sessionManager.get(runId);
    if (!session || !session.workspace_path) return;

    await this.sessionManager.updateSnapshotState(runId, {
      terminal_workflow_state: "cleanup_completed",
      durable_snapshot: session.durable_snapshot ?? null,
    });
    const events = this.eventStoreFactory(session.workspace_path);
    await events.store({
      event_id: `workspace-cleanup-completed-${runId}-${Date.now()}`,
      run_id: runId,
      event_type: "workspace.cleanup.completed",
      timestamp: new Date(),
      data: details,
    });
    await events.close();
  }

  async markCleanupFailed(
    runId: string,
    details: Record<string, unknown>
  ): Promise<void> {
    const session = await this.sessionManager.get(runId);
    if (!session || !session.workspace_path) return;

    const events = this.eventStoreFactory(session.workspace_path);
    await events.store({
      event_id: `workspace-cleanup-failed-${runId}-${Date.now()}`,
      run_id: runId,
      event_type: "workspace.cleanup.failed",
      timestamp: new Date(),
      data: details,
    });
    await events.close();
  }

  private buildUploadingSnapshot(
    terminalStatus: "completed" | "failed" | "cancelled"
  ): DurableSnapshotMetadata {
    return {
      status: "uploading",
      backend: "s3",
      bucket: asString(process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET),
      endpoint: asString(process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT) || null,
      region: asString(process.env.SPRINTFOUNDRY_SNAPSHOT_S3_REGION) || "us-east-1",
      terminal_status: terminalStatus,
      exported_at: null,
      error: null,
    };
  }
}

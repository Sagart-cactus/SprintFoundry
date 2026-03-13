import { describe, expect, it, vi } from "vitest";
import {
  K8sRunSnapshotController,
  buildSnapshotExporterJobManifest,
  extractK8sListItems,
  makeSnapshotExporterJobName,
  type K8sSnapshotClient,
} from "../src/service/k8s-run-snapshot-controller.js";
import { type RunSnapshotStore } from "../src/service/run-snapshot-store.js";
import type { RunSessionMetadata } from "../src/shared/types.js";

function makeJob(overrides: {
  name: string;
  appName: string;
  runId: string;
  projectId: string;
  succeeded?: number;
  failed?: number;
}): Record<string, unknown> {
  return {
    metadata: {
      name: overrides.name,
      labels: {
        "app.kubernetes.io/name": overrides.appName,
        "sprintfoundry.io/run-id": overrides.runId,
        "sprintfoundry.io/project-id": overrides.projectId,
      },
    },
    status: {
      succeeded: overrides.succeeded ?? 0,
      failed: overrides.failed ?? 0,
    },
  };
}

describe("buildSnapshotExporterJobManifest", () => {
  it("builds an exporter job that mounts the run workspace PVC", () => {
    process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET = "snapshot-bucket";

    const manifest = buildSnapshotExporterJobManifest({
      namespace: "sf",
      runId: "run-123",
      projectId: "project-a",
      image: "sprintfoundry-runner:test",
      ttlSecondsAfterFinished: 120,
    });

    expect(manifest.kind).toBe("Job");
    expect(manifest.metadata.name).toBe(makeSnapshotExporterJobName("run-123"));
    expect(manifest.spec.template.spec.containers[0]?.args).toEqual(["snapshot-export", "run-123"]);
    expect(manifest.spec.template.spec.volumes[0]?.persistentVolumeClaim.claimName).toBe(
      "sf-run-ws-run-123"
    );
  });
});

describe("K8sRunSnapshotController", () => {
  it("extracts list items from both client response shapes", () => {
    const items = [makeJob({
      name: "sf-run-123",
      appName: "sprintfoundry-runner",
      runId: "run-123",
      projectId: "project-a",
      succeeded: 1,
    })];

    expect(extractK8sListItems({ items })).toEqual(items);
    expect(extractK8sListItems({ body: { items } })).toEqual(items);
    expect(extractK8sListItems({})).toEqual([]);
  });

  it("creates an exporter job for a terminal runner job", async () => {
    const client: K8sSnapshotClient = {
      listJobs: vi.fn(async () => [
        makeJob({
          name: "sf-run-123",
          appName: "sprintfoundry-runner",
          runId: "run-123",
          projectId: "project-a",
          succeeded: 1,
        }),
      ]),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      pvcExists: vi.fn(async () => true),
      deletePvc: vi.fn(async () => undefined),
    };

    const controller = new K8sRunSnapshotController({
      namespace: "sf",
      runnerImage: "sprintfoundry-runner:test",
      k8sClient: client,
    });

    const summary = await controller.reconcileOnce();

    expect(summary.inspectedRuns).toBe(1);
    expect(summary.exportersCreated).toBe(1);
    expect(client.createJob).toHaveBeenCalledTimes(1);
  });

  it("deletes the PVC and marks cleanup complete after exporter success", async () => {
    const client: K8sSnapshotClient = {
      listJobs: vi.fn(async () => [
        makeJob({
          name: "sf-run-123",
          appName: "sprintfoundry-runner",
          runId: "run-123",
          projectId: "project-a",
          succeeded: 1,
        }),
        makeJob({
          name: makeSnapshotExporterJobName("run-123"),
          appName: "sprintfoundry-snapshot-exporter",
          runId: "run-123",
          projectId: "project-a",
          succeeded: 1,
        }),
      ]),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      pvcExists: vi.fn(async () => true),
      deletePvc: vi.fn(async () => undefined),
    };

    const existingSession: RunSessionMetadata = {
      run_id: "run-123",
      project_id: "project-a",
      ticket_id: "PROMPT-1",
      ticket_source: "prompt",
      ticket_title: "snapshot controller",
      status: "completed",
      current_step: 1,
      total_steps: 1,
      plan_classification: "direct",
      workspace_path: "/tmp/workspace",
      branch: null,
      pr_url: null,
      total_tokens: 0,
      total_cost_usd: 0,
      created_at: "2026-03-13T00:00:00.000Z",
      updated_at: "2026-03-13T00:00:00.000Z",
      completed_at: "2026-03-13T00:05:00.000Z",
      error: null,
      terminal_workflow_state: "snapshot_completed",
      durable_snapshot: {
        status: "completed",
        backend: "s3",
        bucket: "snapshot-bucket",
        terminal_status: "completed",
        archive_key: "archive",
        manifest_key: "manifest",
        session_key: "session",
        exported_at: "2026-03-13T00:05:30.000Z",
      },
    };
    const readSessionRecord = vi.fn(async () => existingSession);
    const writeSessionRecord = vi.fn(async () => undefined);
    const snapshotStore = {
      readSessionRecord,
      writeSessionRecord,
    } as unknown as RunSnapshotStore;

    const controller = new K8sRunSnapshotController({
      namespace: "sf",
      k8sClient: client,
      snapshotStore,
    });

    const summary = await controller.reconcileOnce();

    expect(summary.pvcCleanupCompleted).toBe(1);
    expect(client.deletePvc).toHaveBeenCalledWith("sf", "sf-run-ws-run-123");
    expect(writeSessionRecord).toHaveBeenCalledTimes(1);
  });

  it("deletes terminal pods before attempting PVC cleanup", async () => {
    const client: K8sSnapshotClient = {
      listJobs: vi.fn(async () => [
        makeJob({
          name: "sf-run-123",
          appName: "sprintfoundry-runner",
          runId: "run-123",
          projectId: "project-a",
          succeeded: 1,
        }),
        makeJob({
          name: makeSnapshotExporterJobName("run-123"),
          appName: "sprintfoundry-snapshot-exporter",
          runId: "run-123",
          projectId: "project-a",
          succeeded: 1,
        }),
      ]),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => [
        {
          metadata: { name: "runner-pod" },
          status: { phase: "Succeeded" },
        },
        {
          metadata: { name: "exporter-pod" },
          status: { phase: "Succeeded" },
        },
      ]),
      deletePod: vi.fn(async () => undefined),
      pvcExists: vi.fn(async () => true),
      deletePvc: vi.fn(async () => undefined),
    };

    const controller = new K8sRunSnapshotController({
      namespace: "sf",
      k8sClient: client,
    });

    const summary = await controller.reconcileOnce();

    expect(summary.pvcCleanupCompleted).toBe(0);
    expect(client.deletePod).toHaveBeenCalledTimes(2);
    expect(client.deletePvc).not.toHaveBeenCalled();
  });
});

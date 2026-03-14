import { afterEach, describe, expect, it, vi } from "vitest";
import {
  K8sRunSnapshotController,
  buildSnapshotExporterJobManifest,
  extractK8sListItems,
  makeSnapshotExporterJobName,
  type K8sSnapshotClient,
} from "../src/service/k8s-run-snapshot-controller.js";
import { type RunSnapshotStore } from "../src/service/run-snapshot-store.js";
import type { RunSessionMetadata } from "../src/shared/types.js";

afterEach(() => {
  delete process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET;
  delete process.env.SPRINTFOUNDRY_EVENT_SINK_URL;
  delete process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN;
});

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

function makeSandboxClaim(overrides: {
  name: string;
  runId: string;
  projectId: string;
  templateName?: string;
}): Record<string, unknown> {
  return {
    metadata: {
      name: overrides.name,
      labels: {
        "app.kubernetes.io/name": "sprintfoundry-runner",
        "sprintfoundry.io/run-id": overrides.runId,
        "sprintfoundry.io/project-id": overrides.projectId,
      },
      annotations: {
        "sprintfoundry.io/template-name": overrides.templateName ?? `sf-template-${overrides.runId}`,
      },
    },
    spec: {
      sandboxTemplateRef: {
        name: overrides.templateName ?? `sf-template-${overrides.runId}`,
      },
    },
  };
}

describe("buildSnapshotExporterJobManifest", () => {
  it("builds an exporter job that mounts the run workspace PVC", () => {
    process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET = "snapshot-bucket";
    process.env.SPRINTFOUNDRY_EVENT_SINK_URL = "http://event-api.internal/events";
    process.env.SPRINTFOUNDRY_INTERNAL_API_TOKEN = "internal-token";

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
    expect(manifest.spec.template.spec.containers[0]?.env).toEqual(
      expect.arrayContaining([
        { name: "SPRINTFOUNDRY_EVENT_SINK_URL", value: "http://event-api.internal/events" },
        { name: "SPRINTFOUNDRY_INTERNAL_API_TOKEN", value: "internal-token" },
      ])
    );
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
    process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET = "snapshot-bucket";
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
      listSandboxClaims: vi.fn(async () => []),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
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

  it("does not create exporter jobs when snapshot storage is unconfigured", async () => {
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
      listSandboxClaims: vi.fn(async () => []),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
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
    expect(summary.exportersCreated).toBe(0);
    expect(client.createJob).not.toHaveBeenCalled();
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
      listSandboxClaims: vi.fn(async () => []),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
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
      listSandboxClaims: vi.fn(async () => []),
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
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
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

  it("reconciles sandbox-hosted runs after exporter success", async () => {
    const client: K8sSnapshotClient = {
      listJobs: vi.fn(async () => [
        makeJob({
          name: makeSnapshotExporterJobName("run-sandbox"),
          appName: "sprintfoundry-snapshot-exporter",
          runId: "run-sandbox",
          projectId: "project-a",
          succeeded: 1,
        }),
      ]),
      listSandboxClaims: vi.fn(async () => [
        makeSandboxClaim({
          name: "sf-run-run-sandbox",
          runId: "run-sandbox",
          projectId: "project-a",
          templateName: "sf-template-run-sandbox",
        }),
      ]),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
      pvcExists: vi.fn(async () => true),
      deletePvc: vi.fn(async () => undefined),
    };

    const readSessionRecord = vi.fn(async () => ({
      run_id: "run-sandbox",
      project_id: "project-a",
      ticket_id: "PROMPT-1",
      ticket_source: "prompt",
      ticket_title: "sandbox snapshot controller",
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
      },
    } satisfies RunSessionMetadata));
    const writeSessionRecord = vi.fn(async () => undefined);
    const snapshotStore = {
      readSessionRecord,
      writeSessionRecord,
    } as unknown as RunSnapshotStore;
    const eventSinkClient = {
      postEvent: vi.fn(async () => undefined),
    };

    const controller = new K8sRunSnapshotController({
      namespace: "sf",
      k8sClient: client,
      snapshotStore,
      eventSinkClient,
    });

    const summary = await controller.reconcileOnce();

    expect(summary.inspectedRuns).toBe(1);
    expect(client.deleteSandboxClaim).toHaveBeenCalledWith("sf", "sf-run-run-sandbox");
    expect(client.deleteSandboxTemplate).toHaveBeenCalledWith("sf", "sf-template-run-sandbox");
    expect(client.deletePvc).toHaveBeenCalledWith("sf", "sf-run-ws-run-sandbox");
    expect(summary.pvcCleanupCompleted).toBe(1);
    expect(eventSinkClient.postEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: "run-sandbox",
        event_type: "workspace.cleanup.completed",
      })
    );
  });

  it("releases sandbox claims before waiting for sandbox-owned terminal pods to disappear", async () => {
    const client: K8sSnapshotClient = {
      listJobs: vi.fn(async () => [
        makeJob({
          name: makeSnapshotExporterJobName("run-sandbox-wait"),
          appName: "sprintfoundry-snapshot-exporter",
          runId: "run-sandbox-wait",
          projectId: "project-a",
          succeeded: 1,
        }),
      ]),
      listSandboxClaims: vi.fn(async () => [
        makeSandboxClaim({
          name: "sf-run-run-sandbox-wait",
          runId: "run-sandbox-wait",
          projectId: "project-a",
          templateName: "sf-template-run-sandbox-wait",
        }),
      ]),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => [
        { metadata: { name: "sf-run-run-sandbox-wait" }, status: { phase: "Failed" } },
      ]),
      deletePod: vi.fn(async () => undefined),
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
      pvcExists: vi.fn(async () => true),
      deletePvc: vi.fn(async () => undefined),
    };

    const controller = new K8sRunSnapshotController({
      namespace: "sf",
      k8sClient: client,
      snapshotStore: {} as RunSnapshotStore,
    });

    const summary = await controller.reconcileOnce();

    expect(summary.inspectedRuns).toBe(1);
    expect(client.deleteSandboxClaim).toHaveBeenCalledWith("sf", "sf-run-run-sandbox-wait");
    expect(client.deleteSandboxTemplate).toHaveBeenCalledWith("sf", "sf-template-run-sandbox-wait");
    expect(client.deletePod).not.toHaveBeenCalled();
    expect(client.deletePvc).not.toHaveBeenCalled();
    expect(summary.pvcCleanupCompleted).toBe(0);
  });

  it("keeps exporter-only runs eligible for pvc cleanup after sandbox resources are gone", async () => {
    const readSessionRecord = vi.fn(async () => ({
      run_id: "run-exporter-only",
      project_id: "project-a",
      ticket_id: "PROMPT-1",
      ticket_source: "prompt",
      ticket_title: "exporter only cleanup",
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
      },
    } satisfies RunSessionMetadata));
    const writeSessionRecord = vi.fn(async () => undefined);
    const client: K8sSnapshotClient = {
      listJobs: vi.fn(async () => [
        makeJob({
          name: makeSnapshotExporterJobName("run-exporter-only"),
          appName: "sprintfoundry-snapshot-exporter",
          runId: "run-exporter-only",
          projectId: "project-a",
          succeeded: 1,
        }),
      ]),
      listSandboxClaims: vi.fn(async () => []),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
      pvcExists: vi.fn(async () => true),
      deletePvc: vi.fn(async () => undefined),
    };

    const controller = new K8sRunSnapshotController({
      namespace: "sf",
      k8sClient: client,
      snapshotStore: {
        readSessionRecord,
        writeSessionRecord,
      } as unknown as RunSnapshotStore,
      eventSinkClient: {
        postEvent: vi.fn(async () => undefined),
      },
    });

    const summary = await controller.reconcileOnce();

    expect(summary.inspectedRuns).toBe(1);
    expect(client.deletePvc).toHaveBeenCalledWith("sf", "sf-run-ws-run-exporter-only");
    expect(summary.pvcCleanupCompleted).toBe(1);
  });

  it("backfills cleanup metadata when the pvc is already gone", async () => {
    const readSessionRecord = vi.fn(async () => ({
      run_id: "run-cleanup-backfill",
      project_id: "project-a",
      ticket_id: "PROMPT-1",
      ticket_source: "prompt",
      ticket_title: "cleanup backfill",
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
      },
    } satisfies RunSessionMetadata));
    const writeSessionRecord = vi.fn(async () => undefined);
    const eventSinkClient = {
      postEvent: vi.fn(async () => undefined),
    };
    const client: K8sSnapshotClient = {
      listJobs: vi.fn(async () => [
        makeJob({
          name: makeSnapshotExporterJobName("run-cleanup-backfill"),
          appName: "sprintfoundry-snapshot-exporter",
          runId: "run-cleanup-backfill",
          projectId: "project-a",
          succeeded: 1,
        }),
      ]),
      listSandboxClaims: vi.fn(async () => []),
      createJob: vi.fn(async () => undefined),
      listPods: vi.fn(async () => []),
      deletePod: vi.fn(async () => undefined),
      deleteSandboxClaim: vi.fn(async () => undefined),
      deleteSandboxTemplate: vi.fn(async () => undefined),
      pvcExists: vi.fn(async () => false),
      deletePvc: vi.fn(async () => undefined),
    };

    const controller = new K8sRunSnapshotController({
      namespace: "sf",
      k8sClient: client,
      snapshotStore: {
        readSessionRecord,
        writeSessionRecord,
      } as unknown as RunSnapshotStore,
      eventSinkClient,
    });

    const summary = await controller.reconcileOnce();

    expect(summary.inspectedRuns).toBe(1);
    expect(summary.pvcCleanupCompleted).toBe(1);
    expect(client.deletePvc).not.toHaveBeenCalled();
    expect(writeSessionRecord).toHaveBeenCalledTimes(1);
    expect(eventSinkClient.postEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: "run-cleanup-backfill",
        event_type: "workspace.cleanup.completed",
      })
    );
  });
});

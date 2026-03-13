import { createRequire } from "node:module";
import { makeRunWorkspacePvcName } from "./dispatch-controller.js";
import { RunSnapshotStore } from "./run-snapshot-store.js";
import type { RunSessionMetadata } from "../shared/types.js";

const require = createRequire(import.meta.url);
const SESSIONS_DIR_ENV = "SPRINTFOUNDRY_SESSIONS_DIR";

export interface SnapshotExporterJobManifest {
  apiVersion: "batch/v1";
  kind: "Job";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
  };
  spec: {
    ttlSecondsAfterFinished: number;
    backoffLimit: number;
    template: {
      metadata: {
        labels: Record<string, string>;
      };
      spec: {
        restartPolicy: "Never";
        containers: Array<{
          name: string;
          image: string;
          imagePullPolicy: string;
          command: string[];
          args: string[];
          env: Array<{ name: string; value: string }>;
          volumeMounts: Array<{ name: string; mountPath: string }>;
        }>;
        volumes: Array<{ name: string; persistentVolumeClaim: { claimName: string } }>;
      };
    };
  };
}

export interface K8sSnapshotClient {
  listJobs(namespace: string): Promise<Array<Record<string, unknown>>>;
  createJob(namespace: string, manifest: SnapshotExporterJobManifest): Promise<void>;
  listPods(namespace: string, labelSelector: string): Promise<Array<Record<string, unknown>>>;
  deletePod(namespace: string, name: string): Promise<void>;
  pvcExists(namespace: string, name: string): Promise<boolean>;
  deletePvc(namespace: string, name: string): Promise<void>;
}

export interface K8sRunSnapshotControllerOptions {
  namespace?: string;
  runnerImage?: string;
  exporterTtlSecondsAfterFinished?: number;
  logger?: Pick<Console, "log" | "warn" | "error">;
  snapshotStore?: RunSnapshotStore;
  k8sClient?: K8sSnapshotClient;
}

export interface K8sRunSnapshotReconcileSummary {
  inspectedRuns: number;
  exportersCreated: number;
  pvcCleanupCompleted: number;
  snapshotFailuresDetected: number;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function sanitizeK8sName(input: string): string {
  const cleaned = input
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .replace(/--+/g, "-");
  return cleaned.slice(0, 60) || "run";
}

export function extractK8sListItems(payload: unknown): Array<Record<string, unknown>> {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record.items)) {
      return record.items as Array<Record<string, unknown>>;
    }
    const body = record.body;
    if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).items)) {
      return (body as Record<string, unknown>).items as Array<Record<string, unknown>>;
    }
  }
  return [];
}

export function makeSnapshotExporterJobName(runId: string): string {
  return `sf-snapshot-${sanitizeK8sName(runId)}`;
}

function labelsOf(job: Record<string, unknown>): Record<string, string> {
  const metadata = job.metadata;
  if (metadata && typeof metadata === "object") {
    const labels = (metadata as Record<string, unknown>).labels;
    if (labels && typeof labels === "object") {
      return Object.fromEntries(
        Object.entries(labels as Record<string, unknown>).map(([key, value]) => [key, String(value)])
      );
    }
  }
  return {};
}

function nameOf(job: Record<string, unknown>): string {
  const metadata = job.metadata;
  if (metadata && typeof metadata === "object") {
    return asString((metadata as Record<string, unknown>).name);
  }
  return "";
}

function phaseOf(resource: Record<string, unknown>): string {
  const status = resource.status;
  if (status && typeof status === "object") {
    return asString((status as Record<string, unknown>).phase);
  }
  return "";
}

function isJobSucceeded(job: Record<string, unknown>): boolean {
  const status = job.status;
  if (!status || typeof status !== "object") return false;
  const succeeded = Number((status as Record<string, unknown>).succeeded ?? 0);
  if (succeeded > 0) return true;
  const conditions = Array.isArray((status as Record<string, unknown>).conditions)
    ? ((status as Record<string, unknown>).conditions as Array<Record<string, unknown>>)
    : [];
  return conditions.some((condition) => condition.type === "Complete" && String(condition.status) === "True");
}

function isJobFailed(job: Record<string, unknown>): boolean {
  const status = job.status;
  if (!status || typeof status !== "object") return false;
  const failed = Number((status as Record<string, unknown>).failed ?? 0);
  if (failed > 0) return true;
  const conditions = Array.isArray((status as Record<string, unknown>).conditions)
    ? ((status as Record<string, unknown>).conditions as Array<Record<string, unknown>>)
    : [];
  return conditions.some((condition) => condition.type === "Failed" && String(condition.status) === "True");
}

function isRunnerJob(job: Record<string, unknown>): boolean {
  return labelsOf(job)["app.kubernetes.io/name"] === "sprintfoundry-runner";
}

export function buildSnapshotExporterJobManifest(options: {
  namespace: string;
  runId: string;
  projectId: string;
  image: string;
  ttlSecondsAfterFinished: number;
}): SnapshotExporterJobManifest {
  const env = [
    { name: SESSIONS_DIR_ENV, value: "/workspace/.sprintfoundry/sessions" },
    { name: "SPRINTFOUNDRY_SNAPSHOT_BUCKET", value: asString(process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET) },
    {
      name: "SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT",
      value:
        asString(process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT_IN_CLUSTER) ||
        asString(process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT),
    },
    { name: "SPRINTFOUNDRY_SNAPSHOT_S3_REGION", value: asString(process.env.SPRINTFOUNDRY_SNAPSHOT_S3_REGION) || "us-east-1" },
    { name: "SPRINTFOUNDRY_SNAPSHOT_S3_FORCE_PATH_STYLE", value: asString(process.env.SPRINTFOUNDRY_SNAPSHOT_S3_FORCE_PATH_STYLE) || "0" },
    { name: "AWS_ACCESS_KEY_ID", value: asString(process.env.AWS_ACCESS_KEY_ID) },
    { name: "AWS_SECRET_ACCESS_KEY", value: asString(process.env.AWS_SECRET_ACCESS_KEY) },
    { name: "AWS_SESSION_TOKEN", value: asString(process.env.AWS_SESSION_TOKEN) },
  ].filter((entry) => entry.value !== "");

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: makeSnapshotExporterJobName(options.runId),
      namespace: options.namespace,
      labels: {
        "app.kubernetes.io/name": "sprintfoundry-snapshot-exporter",
        "sprintfoundry.io/project-id": options.projectId,
        "sprintfoundry.io/run-id": options.runId,
      },
    },
    spec: {
      ttlSecondsAfterFinished: options.ttlSecondsAfterFinished,
      backoffLimit: 0,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "sprintfoundry-snapshot-exporter",
            "sprintfoundry.io/project-id": options.projectId,
            "sprintfoundry.io/run-id": options.runId,
          },
        },
        spec: {
          restartPolicy: "Never",
          containers: [
            {
              name: "snapshot-exporter",
              image: options.image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "dist/index.js"],
              args: ["snapshot-export", options.runId],
              env,
              volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
            },
          ],
          volumes: [
            {
              name: "workspace",
              persistentVolumeClaim: {
                claimName: makeRunWorkspacePvcName(options.runId),
              },
            },
          ],
        },
      },
    },
  };
}

export class K8sRunSnapshotController {
  private readonly namespace: string;
  private readonly runnerImage: string;
  private readonly exporterTtlSecondsAfterFinished: number;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly snapshotStore: RunSnapshotStore;
  private readonly k8sClient: K8sSnapshotClient;

  constructor(options: K8sRunSnapshotControllerOptions = {}) {
    this.namespace = asString(options.namespace ?? process.env.SPRINTFOUNDRY_K8S_NAMESPACE) || "default";
    this.runnerImage = asString(options.runnerImage ?? process.env.SPRINTFOUNDRY_RUNNER_IMAGE) || "sprintfoundry-runner:latest";
    this.exporterTtlSecondsAfterFinished = options.exporterTtlSecondsAfterFinished ?? 3600;
    this.logger = options.logger ?? console;
    this.snapshotStore = options.snapshotStore ?? new RunSnapshotStore();
    this.k8sClient = options.k8sClient ?? this.createDefaultK8sClient();
  }

  async reconcileOnce(): Promise<K8sRunSnapshotReconcileSummary> {
    const jobs = await this.k8sClient.listJobs(this.namespace);
    const runnerJobs = jobs.filter(isRunnerJob);
    const jobsByName = new Map(jobs.map((job) => [nameOf(job), job]));
    const summary: K8sRunSnapshotReconcileSummary = {
      inspectedRuns: 0,
      exportersCreated: 0,
      pvcCleanupCompleted: 0,
      snapshotFailuresDetected: 0,
    };

    for (const runnerJob of runnerJobs) {
      if (!isJobSucceeded(runnerJob) && !isJobFailed(runnerJob)) {
        continue;
      }

      summary.inspectedRuns += 1;
      const labels = labelsOf(runnerJob);
      const runId = labels["sprintfoundry.io/run-id"];
      const projectId = labels["sprintfoundry.io/project-id"];
      if (!runId || !projectId) {
        continue;
      }

      const exporterJobName = makeSnapshotExporterJobName(runId);
      const exporterJob = jobsByName.get(exporterJobName);
      if (!exporterJob) {
        if (!this.snapshotStore.isEnabled()) {
          this.logger.warn(
            `[snapshot-controller] Snapshot storage is not configured; skipping exporter job for run ${runId}`
          );
          continue;
        }
        await this.k8sClient.createJob(
          this.namespace,
          buildSnapshotExporterJobManifest({
            namespace: this.namespace,
            runId,
            projectId,
            image: this.runnerImage,
            ttlSecondsAfterFinished: this.exporterTtlSecondsAfterFinished,
          })
        );
        this.logger.log(`[snapshot-controller] Created exporter job ${exporterJobName} for run ${runId}`);
        summary.exportersCreated += 1;
        continue;
      }

      if (isJobFailed(exporterJob)) {
        summary.snapshotFailuresDetected += 1;
        continue;
      }
      if (!isJobSucceeded(exporterJob)) {
        continue;
      }

      const runPods = await this.k8sClient.listPods(this.namespace, `sprintfoundry.io/run-id=${runId}`);
      const remainingPods = runPods
        .filter((pod) => {
          const phase = phaseOf(pod);
          return phase && phase !== "Succeeded" && phase !== "Failed";
        })
        .map(nameOf)
        .filter(Boolean);
      if (remainingPods.length > 0) {
        this.logger.warn(
          `[snapshot-controller] Skipping PVC cleanup for ${runId}; non-terminal pods still exist: ${remainingPods.join(", ")}`
        );
        continue;
      }

      const terminalPods = runPods
        .map(nameOf)
        .filter(Boolean);
      if (terminalPods.length > 0) {
        for (const podName of terminalPods) {
          await this.k8sClient.deletePod(this.namespace, podName);
        }
        this.logger.log(
          `[snapshot-controller] Deleted terminal pods for ${runId}: ${terminalPods.join(", ")}`
        );
        continue;
      }

      const pvcName = makeRunWorkspacePvcName(runId);
      const pvcExists = await this.k8sClient.pvcExists(this.namespace, pvcName);
      if (!pvcExists) {
        continue;
      }

      await this.k8sClient.deletePvc(this.namespace, pvcName);
      await this.markCleanupCompleted(runId, projectId);
      summary.pvcCleanupCompleted += 1;
    }

    return summary;
  }

  private async markCleanupCompleted(runId: string, projectId: string): Promise<void> {
    try {
      const session = await this.snapshotStore.readSessionRecord({ run_id: runId, project_id: projectId });
      const updatedSession: RunSessionMetadata = {
        ...session,
        updated_at: new Date().toISOString(),
        terminal_workflow_state: "cleanup_completed",
      };
      await this.snapshotStore.writeSessionRecord({ run_id: runId, project_id: projectId }, updatedSession);
    } catch (error) {
      this.logger.warn(
        `[snapshot-controller] Cleanup completed for ${runId}, but failed to update uploaded session metadata: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private createDefaultK8sClient(): K8sSnapshotClient {
    const k8sModule = require("@kubernetes/client-node") as {
      KubeConfig: new () => { loadFromDefault(): void; makeApiClient<T>(client: new (...args: unknown[]) => T): T };
      BatchV1Api: new (...args: unknown[]) => unknown;
      CoreV1Api: new (...args: unknown[]) => unknown;
    };

    const kc = new k8sModule.KubeConfig();
    kc.loadFromDefault();
    const batchApi = kc.makeApiClient(k8sModule.BatchV1Api) as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const coreApi = kc.makeApiClient(k8sModule.CoreV1Api) as Record<string, (...args: unknown[]) => Promise<unknown>>;

    return {
      listJobs: async (namespace) => {
        try {
          const result = await batchApi.listNamespacedJob({ namespace });
          return extractK8sListItems(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/namespace was null or undefined/i.test(message)) {
            throw error;
          }
        }
        const legacy = await batchApi.listNamespacedJob(namespace);
        return extractK8sListItems(legacy);
      },
      createJob: async (namespace, manifest) => {
        try {
          await batchApi.createNamespacedJob({ namespace, body: manifest });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/namespace was null or undefined/i.test(message)) {
            throw error;
          }
        }
        await batchApi.createNamespacedJob(namespace, manifest);
      },
      listPods: async (namespace, labelSelector) => {
        try {
          const result = await coreApi.listNamespacedPod({ namespace, labelSelector });
          return extractK8sListItems(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/namespace was null or undefined/i.test(message)) {
            throw error;
          }
        }
        const legacy = await coreApi.listNamespacedPod(namespace, undefined, undefined, undefined, undefined, labelSelector);
        return extractK8sListItems(legacy);
      },
      deletePod: async (namespace, name) => {
        try {
          await coreApi.deleteNamespacedPod({ namespace, name });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return;
          if (!/name was null or undefined|namespace was null or undefined/i.test(message)) {
            throw error;
          }
        }
        await coreApi.deleteNamespacedPod(name, namespace);
      },
      pvcExists: async (namespace, name) => {
        try {
          await coreApi.readNamespacedPersistentVolumeClaim({ namespace, name });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return false;
          if (!/name was null or undefined|namespace was null or undefined/i.test(message)) {
            throw error;
          }
        }
        try {
          await coreApi.readNamespacedPersistentVolumeClaim(name, namespace);
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return false;
          throw error;
        }
      },
      deletePvc: async (namespace, name) => {
        try {
          await coreApi.deleteNamespacedPersistentVolumeClaim({ namespace, name });
          return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/NotFound|404/i.test(message)) return;
          if (!/name was null or undefined|namespace was null or undefined/i.test(message)) {
            throw error;
          }
        }
        await coreApi.deleteNamespacedPersistentVolumeClaim(name, namespace);
      },
    };
  }
}

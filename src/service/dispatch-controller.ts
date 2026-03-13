import http from "node:http";
import { URL, fileURLToPath } from "node:url";
import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { TaskSource } from "../shared/types.js";
import {
  extractGitHubTrigger,
  extractLinearTrigger,
  normalizeGitHubAutoexecuteConfig,
  normalizeLinearAutoexecuteConfig,
  verifyGitHubSignature,
  verifyLinearSignature,
  type GitHubAutoexecuteConfig,
  type LinearAutoexecuteConfig,
} from "./webhook-handler.js";

const require = createRequire(import.meta.url);
const RUN_SANDBOX_MODE_ENV = "SPRINTFOUNDRY_RUN_SANDBOX_MODE";
const WHOLE_RUN_SANDBOX_MODE = "k8s-whole-run";
const RUNS_ROOT_ENV = "SPRINTFOUNDRY_RUNS_ROOT";
const SESSIONS_DIR_ENV = "SPRINTFOUNDRY_SESSIONS_DIR";
const AUTO_RESUME_ENV = "SPRINTFOUNDRY_AUTO_RESUME_EXISTING_RUN";
const SKIP_PR_FINALIZATION_ENV = "SPRINTFOUNDRY_SKIP_PR_FINALIZATION";
const EVENT_SINK_URL_ENV = "SPRINTFOUNDRY_EVENT_SINK_URL";
const INTERNAL_API_TOKEN_ENV = "SPRINTFOUNDRY_INTERNAL_API_TOKEN";

export interface DispatchControllerStartOptions {
  host?: string;
  port?: number;
  configDir?: string;
  redisUrl?: string;
  queuePollIntervalMs?: number;
  queueBlockTimeoutSeconds?: number;
  dedupeTtlSeconds?: number;
  defaultMaxConcurrentRuns?: number;
  activeRunTtlSeconds?: number;
  k8sMode?: boolean;
  runnerImage?: string;
  redisClient?: DispatchRedisClient;
  logger?: Pick<Console, "log" | "warn" | "error">;
  executeLocalRun?: (task: DispatchQueueItem) => Promise<void>;
  createK8sJob?: (manifest: K8sJobManifest, task: DispatchQueueItem, namespace: string) => Promise<void>;
  autoStartConsumer?: boolean;
  now?: () => number;
  idGenerator?: () => string;
  readToken?: string;
  writeToken?: string;
}

export interface DispatchControllerRuntime {
  enqueue(task: DispatchQueueItem): Promise<void>;
  processQueueOnce(): Promise<boolean>;
  close(): Promise<void>;
}

interface RequestLike {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody: string;
}

interface ResponseLike {
  status(code: number): ResponseLike;
  json(body: unknown): void;
}

type NextFunction = (error?: unknown) => void;
type Handler = (req: RequestLike, res: ResponseLike, next: NextFunction) => void | Promise<void>;

export interface ExpressLikeApp {
  post(path: string, ...handlers: Handler[]): void;
  get(path: string, ...handlers: Handler[]): void;
}

class RouteApp implements ExpressLikeApp {
  private readonly routes = new Map<string, Handler[]>();

  post(path: string, ...handlers: Handler[]): void {
    this.routes.set(`POST ${path}`, handlers);
  }

  get(path: string, ...handlers: Handler[]): void {
    this.routes.set(`GET ${path}`, handlers);
  }

  match(method: string, pathname: string): Handler[] | undefined {
    return this.routes.get(`${method.toUpperCase()} ${pathname}`);
  }
}

export interface DispatchQueueItem {
  run_id: string;
  project_id: string;
  project_arg: string | null;
  source: TaskSource;
  ticket_id: string;
  prompt?: string;
  agent?: string;
  trigger_source?: string;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface K8sJobManifest {
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
        serviceAccountName?: string;
        containers: Array<{
          name: string;
          image: string;
          imagePullPolicy: string;
          command: string[];
          args: string[];
          env: Array<
            | { name: string; value: string }
            | {
                name: string;
                valueFrom: {
                  secretKeyRef: {
                    name: string;
                    key: string;
                    optional?: boolean;
                  };
                };
              }
          >;
          envFrom: Array<{ secretRef: { name: string } }>;
          volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
          resources: {
            requests: { cpu: string; memory: string };
            limits: { cpu: string; memory: string };
          };
        }>;
        volumes: Array<
          | { name: string; configMap: { name: string } }
          | { name: string; persistentVolumeClaim: { claimName: string } }
        >;
      };
    };
  };
}

export interface K8sPersistentVolumeClaimManifest {
  apiVersion: "v1";
  kind: "PersistentVolumeClaim";
  metadata: {
    name: string;
    namespace: string;
    labels: Record<string, string>;
    ownerReferences?: Array<{
      apiVersion: string;
      kind: string;
      name: string;
      uid: string;
      controller?: boolean;
      blockOwnerDeletion?: boolean;
    }>;
  };
  spec: {
    accessModes: ["ReadWriteOnce"];
    resources: {
      requests: {
        storage: string;
      };
    };
    storageClassName?: string;
  };
}

interface DispatchProjectConfig {
  fileName: string;
  projectId: string;
  projectArg: string | null;
  maxConcurrentRuns: number;
  validConfig: boolean;
  eventSinkUrl?: string;
  github?: {
    owner: string;
    repo: string;
    autoCfg: GitHubAutoexecuteConfig;
  };
  linear?: {
    teamId: string;
    teamKey: string;
    autoCfg: LinearAutoexecuteConfig;
  };
}

interface DispatchProjectCache {
  loadedAt: number;
  projects: DispatchProjectConfig[];
}

interface DispatchServerRuntime {
  server: http.Server;
  runtime: DispatchControllerRuntime;
  close(): Promise<void>;
}

export interface DispatchRedisClient {
  connect?(): Promise<void>;
  quit?(): Promise<void>;
  ping?(): Promise<string>;
  lPush(key: string, value: string): Promise<number>;
  brPop(keys: string | string[], timeoutSeconds: number): Promise<{ key: string; element: string } | null>;
  set(key: string, value: string, options?: { NX?: boolean; EX?: number }): Promise<string | null>;
  expire(key: string, seconds: number): Promise<number>;
  lLen(key: string): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  zAdd(key: string, members: Array<{ score: number; value: string }>): Promise<number>;
  zCard(key: string): Promise<number>;
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<number>;
  zRem(key: string, members: string[]): Promise<number>;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toLower(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isProjectConfigFileName(name: string): boolean {
  if (!/\.ya?ml$/i.test(name)) return false;
  const lower = name.toLowerCase();
  if (lower === "platform.yaml" || lower === "platform.yml") return false;
  if (lower === "project.example.yaml" || lower === "project.example.yml") return false;
  return true;
}

function projectArgFromFileName(fileName: string): string | null {
  if (fileName === "project.yaml") return null;
  const match = fileName.match(/^project-(.+)\.ya?ml$/);
  if (!match) return null;
  return match[1] ?? null;
}

function interpolateEnvVars(raw: string): string {
  return raw.replace(/\$\{(\w+)\}/g, (_match, envName) => process.env[envName] ?? "");
}

async function loadYamlFile(filePath: string): Promise<Record<string, unknown>> {
  const raw = await fs.readFile(filePath, "utf-8");
  const interpolated = interpolateEnvVars(raw);
  const parsed = parseYaml(interpolated);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

function queueKey(projectId: string): string {
  return `sprintfoundry:dispatch:${projectId}`;
}

function activeSetKey(projectId: string): string {
  return `sprintfoundry:dispatch:active:${projectId}`;
}

function dedupeKey(projectId: string, delivery: string): string {
  return `sprintfoundry:dispatch:dedupe:${projectId}:${delivery}`;
}

function normalizeK8sName(input: string, prefix: string): string {
  const normalized = input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  const value = `${prefix}-${normalized || "run"}`;
  return value.slice(0, 63).replace(/-+$/g, "");
}

function extractBearerToken(headers: Record<string, string | string[] | undefined>): string {
  const rawHeader = headers.authorization;
  const auth = Array.isArray(rawHeader) ? rawHeader[0] : rawHeader;
  const value = String(auth ?? "").trim();
  if (!value.toLowerCase().startsWith("bearer ")) return "";
  return value.slice(7).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function asTaskSource(value: unknown): TaskSource | null {
  const source = asString(value);
  if (source === "github" || source === "linear" || source === "jira" || source === "prompt") {
    return source;
  }
  return null;
}

function normalizeTicketId(source: TaskSource, body: Record<string, unknown>): string | null {
  const ticketId = asString(body.ticket_id);
  if (source === "prompt") {
    return ticketId || `prompt-${Date.now()}`;
  }
  return ticketId || null;
}

function generateRunId(idGenerator: () => string): string {
  return `run-${Date.now()}-${idGenerator()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
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

function makeK8sJobName(runId: string): string {
  return `sf-${sanitizeK8sName(runId)}`;
}

function parseMaybeInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function resolveProjectConcurrentLimit(raw: Record<string, unknown>, fallback: number): number {
  const autoexecute = isRecord(raw.autoexecute) ? raw.autoexecute : {};
  const dispatch = isRecord(raw.dispatch) ? raw.dispatch : {};

  return (
    parseMaybeInteger(dispatch.max_concurrent_runs) ??
    parseMaybeInteger(autoexecute.max_concurrent_runs) ??
    fallback
  );
}

function isValidProjectConfig(raw: Record<string, unknown>): boolean {
  const projectId = asString(raw.project_id);
  const repo = isRecord(raw.repo) ? raw.repo : {};
  const integrations = isRecord(raw.integrations) ? raw.integrations : {};
  const ticketSource = isRecord(integrations.ticket_source) ? integrations.ticket_source : {};
  return !!projectId && !!asString(repo.url) && !!asString(ticketSource.type);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function normalizeHeaders(raw: http.IncomingHttpHeaders): Record<string, string | string[] | undefined> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), value]));
}

function buildRedisClient(options: DispatchControllerStartOptions): DispatchRedisClient {
  if (options.redisClient) return options.redisClient;

  const redisUrl = asString(options.redisUrl ?? process.env.SPRINTFOUNDRY_REDIS_URL);
  if (!redisUrl) {
    throw new Error("SPRINTFOUNDRY_REDIS_URL is required for dispatch controller");
  }

  const redisModule = require("redis") as {
    createClient(config: { url: string }): DispatchRedisClient;
  };
  return redisModule.createClient({ url: redisUrl });
}

async function defaultLocalRunExecutor(task: DispatchQueueItem, configDir: string, logger: Pick<Console, "warn">): Promise<void> {
  const cliArgs = ["run", "--source", task.source, "--config", configDir];

  if (task.source === "prompt") {
    if (task.prompt) {
      cliArgs.push("--prompt", task.prompt);
    }
  } else {
    cliArgs.push("--ticket", task.ticket_id);
  }

  if (task.project_arg) {
    cliArgs.push("--project", task.project_arg);
  }

  if (task.agent) {
    cliArgs.push("--agent", task.agent);
  }

  const runningFromJsEntrypoint = process.argv[1]?.endsWith(".js");
  const command = runningFromJsEntrypoint ? process.execPath : "pnpm";
  const args = runningFromJsEntrypoint ? [process.argv[1], ...cliArgs] : ["dev", "--", ...cliArgs];

  await new Promise<void>((resolve, reject) => {
    const childEnv = {
      ...process.env,
      SPRINTFOUNDRY_TRIGGER_SOURCE: task.trigger_source ?? `${task.source}_dispatch`,
    };

    execFile(command, args, { env: childEnv, maxBuffer: 8 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (error) {
        logger.warn(`[dispatch] local run failed for ${task.run_id}: ${String(stderr ?? "").slice(-500)}`);
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function buildK8sJobManifest(task: DispatchQueueItem, options?: {
  namespace?: string;
  image?: string;
  projectSecretName?: string;
  projectConfigMapName?: string;
  serviceAccountName?: string;
  ttlSecondsAfterFinished?: number;
  cpuRequest?: string;
  cpuLimit?: string;
  memoryRequest?: string;
  memoryLimit?: string;
  workspaceSizeLimit?: string;
  workspaceStorageClassName?: string;
  eventSinkUrl?: string;
}): K8sJobManifest {
  const namespace = asString(options?.namespace) || "default";
  const image = asString(options?.image) || "sprintfoundry-runner:latest";
  const projectSecretName = asString(options?.projectSecretName) || `sprintfoundry-project-${task.project_id}-secrets`;
  const projectConfigMapName = asString(options?.projectConfigMapName) || `sprintfoundry-project-${task.project_id}-config`;
  const workspacePvcName = makeRunWorkspacePvcName(task.run_id);
  const eventSinkUrl = asString(options?.eventSinkUrl) || asString(process.env[EVENT_SINK_URL_ENV]);

  const args = ["run", "--source", task.source, "--config", "/config"];

  if (task.source === "prompt") {
    if (task.prompt) {
      args.push("--prompt", task.prompt);
    }
  } else {
    args.push("--ticket", task.ticket_id);
  }

  if (task.project_arg) {
    args.push("--project", task.project_arg);
  }

  if (task.agent) {
    args.push("--agent", task.agent);
  }

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: makeK8sJobName(task.run_id),
      namespace,
      labels: {
        "app.kubernetes.io/name": "sprintfoundry-runner",
        "sprintfoundry.io/project-id": task.project_id,
        "sprintfoundry.io/run-id": task.run_id,
      },
    },
    spec: {
      ttlSecondsAfterFinished: options?.ttlSecondsAfterFinished ?? 1800,
      backoffLimit: 1,
      template: {
        metadata: {
          labels: {
            "app.kubernetes.io/name": "sprintfoundry-runner",
            "sprintfoundry.io/project-id": task.project_id,
            "sprintfoundry.io/run-id": task.run_id,
          },
        },
        spec: {
          restartPolicy: "Never",
          serviceAccountName: asString(options?.serviceAccountName) || undefined,
          containers: [
            {
              name: "runner",
              image,
              imagePullPolicy: "IfNotPresent",
              command: ["node", "dist/index.js"],
              args,
              env: [
                { name: "SPRINTFOUNDRY_RUN_ID", value: task.run_id },
                { name: "SPRINTFOUNDRY_PROJECT_ID", value: task.project_id },
                { name: "SPRINTFOUNDRY_TICKET_ID", value: task.ticket_id },
                { name: "SPRINTFOUNDRY_TRIGGER_SOURCE", value: task.trigger_source ?? `${task.source}_dispatch` },
                { name: RUN_SANDBOX_MODE_ENV, value: WHOLE_RUN_SANDBOX_MODE },
                { name: RUNS_ROOT_ENV, value: "/workspace" },
                { name: SESSIONS_DIR_ENV, value: "/workspace/.sprintfoundry/sessions" },
                { name: AUTO_RESUME_ENV, value: "1" },
                { name: "HOME", value: "/workspace/home" },
                { name: "CODEX_HOME", value: "/workspace/home/.codex" },
                ...(eventSinkUrl ? [{ name: EVENT_SINK_URL_ENV, value: eventSinkUrl }] : []),
                ...(eventSinkUrl
                  ? [{
                      name: INTERNAL_API_TOKEN_ENV,
                      valueFrom: {
                        secretKeyRef: {
                          name: projectSecretName,
                          key: INTERNAL_API_TOKEN_ENV,
                          optional: true,
                        },
                      },
                    }]
                  : []),
                ...(asString(process.env[SKIP_PR_FINALIZATION_ENV])
                  ? [{ name: SKIP_PR_FINALIZATION_ENV, value: asString(process.env[SKIP_PR_FINALIZATION_ENV]) }]
                  : []),
                { name: "SPRINTFOUNDRY_OTEL_ENABLED", value: process.env.SPRINTFOUNDRY_OTEL_ENABLED ?? "0" },
                { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://otel-collector.monitoring.svc.cluster.local:4318" },
                { name: "OTEL_EXPORTER_OTLP_PROTOCOL", value: process.env.OTEL_EXPORTER_OTLP_PROTOCOL ?? "http/protobuf" },
                { name: "OTEL_METRICS_EXPORTER", value: process.env.OTEL_METRICS_EXPORTER ?? "otlp" },
                { name: "OTEL_LOGS_EXPORTER", value: process.env.OTEL_LOGS_EXPORTER ?? "otlp" },
              ],
              envFrom: [{ secretRef: { name: projectSecretName } }],
              volumeMounts: [
                { name: "project-config", mountPath: "/config", readOnly: true },
                { name: "workspace", mountPath: "/workspace" },
              ],
              resources: {
                requests: {
                  cpu: asString(options?.cpuRequest) || "500m",
                  memory: asString(options?.memoryRequest) || "1Gi",
                },
                limits: {
                  cpu: asString(options?.cpuLimit) || "2",
                  memory: asString(options?.memoryLimit) || "4Gi",
                },
              },
            },
          ],
          volumes: [
            { name: "project-config", configMap: { name: projectConfigMapName } },
            { name: "workspace", persistentVolumeClaim: { claimName: workspacePvcName } },
          ],
        },
      },
    },
  };
}

export function makeRunWorkspacePvcName(runId: string): string {
  return normalizeK8sName(runId, "sf-run-ws");
}

export function buildK8sWorkspacePvcManifest(task: DispatchQueueItem, options?: {
  namespace?: string;
  workspaceSizeLimit?: string;
  workspaceStorageClassName?: string;
}): K8sPersistentVolumeClaimManifest {
  const namespace = asString(options?.namespace) || "default";
  const storageSize = asString(options?.workspaceSizeLimit) || "10Gi";
  const storageClassName = asString(options?.workspaceStorageClassName) || "";
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: makeRunWorkspacePvcName(task.run_id),
      namespace,
      labels: {
        "app.kubernetes.io/name": "sprintfoundry-runner-workspace",
        "sprintfoundry.io/project-id": task.project_id,
        "sprintfoundry.io/run-id": task.run_id,
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: {
        requests: {
          storage: storageSize,
        },
      },
      ...(storageClassName ? { storageClassName } : {}),
    },
  };
}

export function buildJobOwnerReference(job: {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    uid: string;
  };
}): {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller: boolean;
  blockOwnerDeletion: boolean;
} {
  return {
    apiVersion: job.apiVersion ?? "batch/v1",
    kind: job.kind ?? "Job",
    name: job.metadata.name,
    uid: job.metadata.uid,
    controller: false,
    blockOwnerDeletion: false,
  };
}

function withOwnerReference<T extends { metadata?: Record<string, unknown> }>(
  resource: T,
  ownerReference: ReturnType<typeof buildJobOwnerReference>
): T {
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
  const existingOwnerReferences = Array.isArray(metadata.ownerReferences)
    ? (metadata.ownerReferences as Array<Record<string, unknown>>)
    : [];
  const nextOwnerReferences = [
    ...existingOwnerReferences.filter(
      (ref) => !(ref.uid === ownerReference.uid && ref.name === ownerReference.name)
    ),
    ownerReference,
  ];
  return {
    ...resource,
    metadata: {
      ...metadata,
      ownerReferences: nextOwnerReferences,
    },
  };
}

function hasOwnerReference(
  resource: { metadata?: Record<string, unknown> },
  ownerReference: ReturnType<typeof buildJobOwnerReference>
): boolean {
  const metadata = (resource.metadata ?? {}) as Record<string, unknown>;
  const existingOwnerReferences = Array.isArray(metadata.ownerReferences)
    ? (metadata.ownerReferences as Array<Record<string, unknown>>)
    : [];
  return existingOwnerReferences.some(
    (ref) => ref.uid === ownerReference.uid && ref.name === ownerReference.name
  );
}

function isK8sConflictError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const bodyCode = Number((error as { body?: { code?: unknown } } | undefined)?.body?.code);
  return bodyCode === 409 || /Conflict|409|object has been modified|Operation cannot be fulfilled/i.test(message);
}

async function readNamespacedPersistentVolumeClaimCompat(coreApi: any, pvcName: string, namespace: string): Promise<any> {
  try {
    return await coreApi.readNamespacedPersistentVolumeClaim({ name: pvcName, namespace });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expectsLegacyArgs = /name was null or undefined|namespace was null or undefined/i.test(message);
    if (!expectsLegacyArgs) {
      throw error;
    }
    return coreApi.readNamespacedPersistentVolumeClaim(pvcName, namespace);
  }
}

async function replaceNamespacedPersistentVolumeClaimCompat(
  coreApi: any,
  pvcName: string,
  namespace: string,
  body: unknown
): Promise<void> {
  try {
    await coreApi.replaceNamespacedPersistentVolumeClaim({
      name: pvcName,
      namespace,
      body,
    });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expectsLegacyArgs = /name was null or undefined|namespace was null or undefined/i.test(message);
    if (!expectsLegacyArgs) {
      throw error;
    }
  }

  await coreApi.replaceNamespacedPersistentVolumeClaim(pvcName, namespace, body);
}

export async function attachWorkspacePvcToJob(
  coreApi: any,
  namespace: string,
  pvcManifest: K8sPersistentVolumeClaimManifest,
  ownerReference: ReturnType<typeof buildJobOwnerReference>
): Promise<void> {
  const pvcName = pvcManifest.metadata.name;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const currentPvc = await readNamespacedPersistentVolumeClaimCompat(coreApi, pvcName, namespace);
    const currentBody = currentPvc?.body ?? currentPvc;
    if (hasOwnerReference(currentBody, ownerReference)) {
      return;
    }

    const updatedBody = withOwnerReference(currentBody, ownerReference);
    try {
      await replaceNamespacedPersistentVolumeClaimCompat(coreApi, pvcName, namespace, updatedBody);
      return;
    } catch (error) {
      if (isK8sConflictError(error) && attempt < 3) {
        continue;
      }
      throw error;
    }
  }
}

async function readJobUid(batchApi: any, namespace: string, jobName: string): Promise<string> {
  try {
    const job = await batchApi.readNamespacedJob({ name: jobName, namespace });
    return String(job?.body?.metadata?.uid ?? job?.metadata?.uid ?? "").trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expectsLegacyArgs = /name was null or undefined|namespace was null or undefined/i.test(message);
    if (!expectsLegacyArgs) {
      return "";
    }
  }

  try {
    const job = await batchApi.readNamespacedJob(jobName, namespace);
    return String(job?.body?.metadata?.uid ?? job?.metadata?.uid ?? "").trim();
  } catch {
    return "";
  }
}

async function defaultCreateK8sJob(manifest: K8sJobManifest, _task: DispatchQueueItem, namespace: string): Promise<void> {
  let k8sModule: any;
  try {
    k8sModule = require("@kubernetes/client-node");
  } catch (error) {
    throw new Error(
      `SPRINTFOUNDRY_K8S_MODE=true requires @kubernetes/client-node: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const kc = new k8sModule.KubeConfig();
  kc.loadFromDefault();
  const batchApi = kc.makeApiClient(k8sModule.BatchV1Api);
  const coreApi = kc.makeApiClient(k8sModule.CoreV1Api);
  const workspacePvc = buildK8sWorkspacePvcManifest(_task, {
    namespace,
    workspaceSizeLimit: process.env.SPRINTFOUNDRY_K8S_WORKSPACE_SIZE,
    workspaceStorageClassName: process.env.SPRINTFOUNDRY_K8S_WORKSPACE_STORAGE_CLASS,
  });

  try {
    await coreApi.createNamespacedPersistentVolumeClaim({ namespace, body: workspacePvc });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const alreadyExists = /AlreadyExists|409/i.test(message);
    const expectsLegacyArgs = /namespace was null or undefined/i.test(message);
    if (expectsLegacyArgs) {
      try {
        await coreApi.createNamespacedPersistentVolumeClaim(namespace, workspacePvc);
      } catch (legacyError) {
        const legacyMessage = legacyError instanceof Error ? legacyError.message : String(legacyError);
        if (!/AlreadyExists|409/i.test(legacyMessage)) {
          throw legacyError;
        }
      }
    } else if (!alreadyExists) {
      throw error;
    }
  }

  // Support both Kubernetes client signatures:
  // - v1.x: createNamespacedJob({ namespace, body })
  // - older: createNamespacedJob(namespace, body)
  try {
    const createdJob = await batchApi.createNamespacedJob({ namespace, body: manifest });
    const jobBody = createdJob?.body ?? createdJob;
    const uid = String(jobBody?.metadata?.uid ?? "").trim() || await readJobUid(batchApi, namespace, manifest.metadata.name);
    if (uid) {
      await attachWorkspacePvcToJob(coreApi, namespace, workspacePvc, buildJobOwnerReference({
        apiVersion: manifest.apiVersion,
        kind: manifest.kind,
        metadata: {
          name: manifest.metadata.name,
          uid,
        },
      }));
    }
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const expectsLegacyArgs = /namespace was null or undefined/i.test(message);
    if (!expectsLegacyArgs) {
      throw error;
    }
  }

  const createdJob = await batchApi.createNamespacedJob(namespace, manifest);
  const jobBody = createdJob?.body ?? createdJob;
  const uid = String(jobBody?.metadata?.uid ?? "").trim() || await readJobUid(batchApi, namespace, manifest.metadata.name);
  if (uid) {
    await attachWorkspacePvcToJob(coreApi, namespace, workspacePvc, buildJobOwnerReference({
      apiVersion: manifest.apiVersion,
      kind: manifest.kind,
      metadata: {
        name: manifest.metadata.name,
        uid,
      },
    }));
  }
}

class DispatchController implements DispatchControllerRuntime {
  private readonly configDir: string;
  private readonly redis: DispatchRedisClient;
  private readonly logger: Pick<Console, "log" | "warn" | "error">;
  private readonly queuePollIntervalMs: number;
  private readonly queueBlockTimeoutSeconds: number;
  private readonly dedupeTtlSeconds: number;
  private readonly defaultMaxConcurrentRuns: number;
  private readonly activeRunTtlSeconds: number;
  private readonly k8sMode: boolean;
  private readonly now: () => number;
  private readonly idGenerator: () => string;
  private readonly executeLocalRun: (task: DispatchQueueItem) => Promise<void>;
  private readonly createK8sJob: (manifest: K8sJobManifest, task: DispatchQueueItem, namespace: string) => Promise<void>;
  private readonly readToken: string;
  private readonly writeToken: string;
  private readonly runnerImage: string;

  private projectCache: DispatchProjectCache = { loadedAt: 0, projects: [] };
  private running = false;
  private consumerLoop: Promise<void> | null = null;

  constructor(private readonly options: DispatchControllerStartOptions) {
    const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
    const resolvedConfigDir =
      asString(options.configDir) || process.env.SPRINTFOUNDRY_CONFIG_DIR || path.join(repoRoot, "config");
    this.configDir = path.isAbsolute(resolvedConfigDir)
      ? resolvedConfigDir
      : path.resolve(process.cwd(), resolvedConfigDir);
    this.redis = buildRedisClient(options);
    this.logger = options.logger ?? console;
    this.queuePollIntervalMs = options.queuePollIntervalMs ?? parsePositiveInt(process.env.SPRINTFOUNDRY_DISPATCH_QUEUE_POLL_MS, 1000);
    this.queueBlockTimeoutSeconds = options.queueBlockTimeoutSeconds ?? parsePositiveInt(process.env.SPRINTFOUNDRY_DISPATCH_QUEUE_BLOCK_SECONDS, 2);
    this.dedupeTtlSeconds = options.dedupeTtlSeconds ?? parsePositiveInt(process.env.SPRINTFOUNDRY_DISPATCH_DEDUPE_TTL_SECONDS, 1800);
    this.defaultMaxConcurrentRuns = options.defaultMaxConcurrentRuns ?? parsePositiveInt(process.env.SPRINTFOUNDRY_DISPATCH_MAX_CONCURRENT_RUNS, 10);
    this.activeRunTtlSeconds = options.activeRunTtlSeconds ?? parsePositiveInt(process.env.SPRINTFOUNDRY_DISPATCH_ACTIVE_TTL_SECONDS, 3600);
    this.k8sMode = options.k8sMode ?? process.env.SPRINTFOUNDRY_K8S_MODE === "true";
    this.now = options.now ?? (() => Date.now());
    this.idGenerator = options.idGenerator ?? (() => randomUUID().slice(0, 8));
    this.readToken = asString(options.readToken ?? process.env.SPRINTFOUNDRY_DISPATCH_READ_TOKEN);
    this.writeToken = asString(options.writeToken ?? process.env.SPRINTFOUNDRY_DISPATCH_WRITE_TOKEN);
    this.runnerImage = asString(options.runnerImage ?? process.env.SPRINTFOUNDRY_RUNNER_IMAGE) || "sprintfoundry-runner:latest";

    this.executeLocalRun =
      options.executeLocalRun ??
      ((task) => defaultLocalRunExecutor(task, this.configDir, this.logger));

    this.createK8sJob = options.createK8sJob ?? defaultCreateK8sJob;
  }

  async start(): Promise<void> {
    if (this.redis.connect) {
      await this.redis.connect();
    }
    this.running = true;
    if (this.options.autoStartConsumer !== false) {
      this.consumerLoop = this.runConsumerLoop();
    }
  }

  private async runConsumerLoop(): Promise<void> {
    while (this.running) {
      try {
        const processed = await this.processQueueOnce();
        if (!processed) {
          await sleep(this.queuePollIntervalMs);
        }
      } catch (error) {
        this.logger.error(`[dispatch] consumer error: ${error instanceof Error ? error.message : String(error)}`);
        await sleep(this.queuePollIntervalMs);
      }
    }
  }

  private authFailure(res: ResponseLike, status: number, message: string): void {
    res.status(status).json({ error: message });
  }

  private authorize(req: RequestLike, scope: "read" | "write", res: ResponseLike): boolean {
    const readToken = this.readToken;
    const writeToken = this.writeToken;
    if (!readToken && !writeToken) return true;

    const provided = extractBearerToken(req.headers);
    if (!provided) {
      this.authFailure(res, 401, "Authentication required");
      return false;
    }

    const acceptedTokens = new Set<string>();
    if (scope === "write") {
      if (writeToken) acceptedTokens.add(writeToken);
      else if (readToken) acceptedTokens.add(readToken);
    } else {
      if (readToken) acceptedTokens.add(readToken);
      if (writeToken) acceptedTokens.add(writeToken);
    }

    if (!acceptedTokens.has(provided)) {
      this.authFailure(res, 403, "Invalid token");
      return false;
    }

    return true;
  }

  private async loadProjects(force = false): Promise<DispatchProjectConfig[]> {
    const now = this.now();
    if (!force && now - this.projectCache.loadedAt < 15_000) {
      return this.projectCache.projects;
    }

    const entries = await fs.readdir(this.configDir, { withFileTypes: true }).catch(() => []);
    const projectFiles = entries
      // Kubernetes ConfigMap volumes expose keys as symlinks (..data/<key>).
      // Accept symlink entries so dispatch can discover mounted project configs.
      .filter((entry) => entry.isFile() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .filter((name) => isProjectConfigFileName(name))
      .sort();

    const projects: DispatchProjectConfig[] = [];

    for (const fileName of projectFiles) {
      const filePath = path.join(this.configDir, fileName);
      let rawProject: Record<string, unknown>;
      try {
        rawProject = await loadYamlFile(filePath);
      } catch {
        continue;
      }

      const projectId = asString(rawProject.project_id);
      if (!projectId) continue;

      const integrations = isRecord(rawProject.integrations) ? rawProject.integrations : {};
      const ticketSource = isRecord(integrations.ticket_source) ? integrations.ticket_source : {};
      const sourceType = asString(ticketSource.type);
      const ticketSourceConfig = isRecord(ticketSource.config) ? ticketSource.config : {};

      const cfg: DispatchProjectConfig = {
        fileName,
        projectId,
        projectArg: projectArgFromFileName(fileName),
        maxConcurrentRuns: resolveProjectConcurrentLimit(rawProject, this.defaultMaxConcurrentRuns),
        validConfig: isValidProjectConfig(rawProject),
        eventSinkUrl: asString((isRecord(integrations.event_sink) ? integrations.event_sink.url : undefined) ?? ""),
      };

      if (sourceType === "github") {
        const owner = toLower(ticketSourceConfig.owner);
        const repo = toLower(ticketSourceConfig.repo);
        const autoCfg = normalizeGitHubAutoexecuteConfig(rawProject);
        if (owner && repo && autoCfg.enabled) {
          cfg.github = { owner, repo, autoCfg };
        }
      }

      if (sourceType === "linear") {
        const teamId = toLower(ticketSourceConfig.team_id);
        const teamKey = toLower(ticketSourceConfig.team_key);
        const autoCfg = normalizeLinearAutoexecuteConfig(rawProject);
        if (autoCfg.enabled) {
          cfg.linear = { teamId, teamKey, autoCfg };
        }
      }

      projects.push(cfg);
    }

    this.projectCache = { loadedAt: now, projects };
    return projects;
  }

  private async findProjectById(projectId: string): Promise<DispatchProjectConfig | null> {
    const projects = await this.loadProjects();
    return projects.find((project) => project.projectId === projectId) ?? null;
  }

  private async findGitHubProject(owner: string, repo: string): Promise<DispatchProjectConfig | null> {
    const ownerNorm = toLower(owner);
    const repoNorm = toLower(repo);
    const projects = await this.loadProjects();
    return (
      projects.find(
        (project) =>
          project.github &&
          project.github.owner === ownerNorm &&
          project.github.repo === repoNorm,
      ) ?? null
    );
  }

  private async findLinearProject(payload: Record<string, unknown>): Promise<DispatchProjectConfig | null> {
    const projects = (await this.loadProjects()).filter((project) => project.linear);
    if (projects.length === 0) return null;

    const data = isRecord(payload.data) ? payload.data : {};
    const issue = isRecord(data.issue) ? data.issue : {};
    const team = isRecord(data.team) ? data.team : {};

    const identifier = asString(data.identifier || issue.identifier);
    const identifierPrefix = identifier.includes("-") ? identifier.split("-")[0]?.toLowerCase() : "";

    const candidates = new Set<string>(
      [toLower(data.teamId), toLower(team.id), toLower(team.key), toLower(identifierPrefix)].filter(Boolean),
    );

    const matched = projects.find((project) => {
      const linear = project.linear;
      if (!linear) return false;
      if (!linear.teamId && !linear.teamKey) return true;
      if (linear.teamId && candidates.has(linear.teamId)) return true;
      if (linear.teamKey && candidates.has(linear.teamKey)) return true;
      return false;
    });

    return matched ?? null;
  }

  private async shouldDedupe(projectId: string, deliveryId: string, ttlSeconds: number): Promise<boolean> {
    if (!deliveryId) return false;
    const key = dedupeKey(projectId, deliveryId);
    const created = await this.redis.set(key, "1", {
      NX: true,
      EX: ttlSeconds,
    });
    return created !== "OK";
  }

  private async enqueueInternal(task: DispatchQueueItem): Promise<void> {
    await this.redis.lPush(queueKey(task.project_id), JSON.stringify(task));
  }

  async enqueue(task: DispatchQueueItem): Promise<void> {
    await this.enqueueInternal(task);
  }

  private async tryAcquireProjectSlot(projectId: string, runId: string, maxConcurrentRuns: number): Promise<boolean> {
    const key = activeSetKey(projectId);
    const now = this.now();
    await this.redis.zRemRangeByScore(key, 0, now);
    const activeCount = await this.redis.zCard(key);
    if (activeCount >= maxConcurrentRuns) {
      return false;
    }

    const expiresAt = now + this.activeRunTtlSeconds * 1000;
    await this.redis.zAdd(key, [{ score: expiresAt, value: runId }]);
    return true;
  }

  private async releaseProjectSlot(projectId: string, runId: string): Promise<void> {
    await this.redis.zRem(activeSetKey(projectId), [runId]);
  }

  private async dispatchTask(task: DispatchQueueItem): Promise<void> {
    if (this.k8sMode) {
      const project = await this.findProjectById(task.project_id);
      const namespace = asString(process.env.SPRINTFOUNDRY_K8S_NAMESPACE) || task.project_id;
      const secretName = asString(process.env.SPRINTFOUNDRY_K8S_PROJECT_SECRET_NAME) || `sprintfoundry-project-${task.project_id}-secrets`;
      const configMapName = asString(process.env.SPRINTFOUNDRY_K8S_PROJECT_CONFIGMAP_NAME) || `sprintfoundry-project-${task.project_id}-config`;
      const eventSinkUrl = asString(process.env[EVENT_SINK_URL_ENV]) || asString(project?.eventSinkUrl);
      const manifest = buildK8sJobManifest(task, {
        namespace,
        image: this.runnerImage,
        projectSecretName: secretName,
        projectConfigMapName: configMapName,
        serviceAccountName: asString(process.env.SPRINTFOUNDRY_K8S_SERVICE_ACCOUNT) || undefined,
        eventSinkUrl: eventSinkUrl || undefined,
      });
      await this.createK8sJob(manifest, task, namespace);
      return;
    }

    await this.executeLocalRun(task);
    await this.releaseProjectSlot(task.project_id, task.run_id);
  }

  async processQueueOnce(): Promise<boolean> {
    const projects = await this.loadProjects();
    const queueKeys = projects.map((project) => queueKey(project.projectId));
    if (queueKeys.length === 0) {
      return false;
    }

    const popped = await this.redis.brPop(queueKeys, this.queueBlockTimeoutSeconds);
    if (!popped || !popped.element) {
      return false;
    }

    let task: DispatchQueueItem;
    try {
      task = JSON.parse(popped.element) as DispatchQueueItem;
    } catch {
      this.logger.warn("[dispatch] ignoring malformed queue payload");
      return false;
    }

    const project = projects.find((candidate) => candidate.projectId === task.project_id);
    if (!project || !project.validConfig) {
      this.logger.warn(`[dispatch] skipping run ${task.run_id}: invalid or unknown project ${task.project_id}`);
      return true;
    }

    const acquired = await this.tryAcquireProjectSlot(task.project_id, task.run_id, project.maxConcurrentRuns);
    if (!acquired) {
      await this.redis.lPush(queueKey(task.project_id), popped.element);
      return false;
    }

    try {
      await this.dispatchTask(task);
    } catch (error) {
      await this.releaseProjectSlot(task.project_id, task.run_id);
      this.logger.error(
        `[dispatch] dispatch failed for ${task.run_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return true;
  }

  async handleDispatchRun(req: RequestLike, res: ResponseLike): Promise<void> {
    if (!this.authorize(req, "write", res)) return;

    const body = isRecord(req.body) ? req.body : null;
    if (!body) {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    const projectId = asString(body.project_id);
    const source = asTaskSource(body.source);

    if (!projectId || !source) {
      res.status(400).json({ error: "project_id and source are required" });
      return;
    }

    const project = await this.findProjectById(projectId);
    if (!project || !project.validConfig) {
      res.status(404).json({ error: "Project not found or invalid", project_id: projectId });
      return;
    }

    const ticketId = normalizeTicketId(source, body);
    if (!ticketId) {
      res.status(400).json({ error: "ticket_id is required for non-prompt sources" });
      return;
    }

    const runId = generateRunId(this.idGenerator);
    const task: DispatchQueueItem = {
      run_id: runId,
      project_id: project.projectId,
      project_arg: project.projectArg,
      source,
      ticket_id: ticketId,
      prompt: asString(body.prompt) || undefined,
      agent: asString(body.agent) || undefined,
      trigger_source: "api_dispatch",
      created_at: new Date(this.now()).toISOString(),
    };

    await this.enqueueInternal(task);
    res.status(202).json({ run_id: runId, status: "queued" });
  }

  async handleGitHubWebhook(req: RequestLike, res: ResponseLike): Promise<void> {
    const signature = asString(req.headers["x-hub-signature-256"]);
    const delivery = asString(req.headers["x-github-delivery"]);
    const event = asString(req.headers["x-github-event"]);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    const repository = isRecord(payload.repository) ? payload.repository : {};
    const owner = asString((isRecord(repository.owner) ? repository.owner.login : "") || "");
    const repo = asString(repository.name);

    if (!owner || !repo) {
      res.status(400).json({ error: "Missing repository owner/name in payload" });
      return;
    }

    const matched = await this.findGitHubProject(owner, repo);
    if (!matched || !matched.github) {
      res.status(202).json({ accepted: false, ignored: true, reason: "no_matching_project", owner, repo });
      return;
    }

    const autoCfg = matched.github.autoCfg;
    if (!autoCfg.webhookSecret) {
      res.status(403).json({ accepted: false, error: "Webhook secret not configured", project_id: matched.projectId });
      return;
    }

    if (!verifyGitHubSignature(req.rawBody, signature, autoCfg.webhookSecret)) {
      res.status(401).json({ accepted: false, error: "Invalid webhook signature" });
      return;
    }

    const action = asString(payload.action);
    const trigger = extractGitHubTrigger(payload, event, action, autoCfg);
    if (!trigger.allowed || !trigger.ticketId) {
      res.status(202).json({
        accepted: false,
        ignored: true,
        reason: trigger.reason,
        project_id: matched.projectId,
        event,
        action,
      });
      return;
    }

    const fallbackDelivery = `${matched.projectId}:${event}:${action}:${trigger.ticketId}:${asString((isRecord(payload.issue) ? payload.issue.updated_at : "") || (isRecord(payload.comment) ? payload.comment.updated_at : ""))}`;
    const deliveryKey = delivery || fallbackDelivery;
    const dedupeTtl = Math.max(60, Math.floor(autoCfg.dedupeWindowMinutes * 60) || this.dedupeTtlSeconds);

    if (await this.shouldDedupe(matched.projectId, deliveryKey, dedupeTtl)) {
      res.status(202).json({
        accepted: false,
        ignored: true,
        reason: "duplicate_event",
        project_id: matched.projectId,
        ticket_id: trigger.ticketId,
      });
      return;
    }

    const task: DispatchQueueItem = {
      run_id: generateRunId(this.idGenerator),
      project_id: matched.projectId,
      project_arg: matched.projectArg,
      source: "github",
      ticket_id: trigger.ticketId,
      trigger_source: "github_webhook",
      metadata: {
        event,
        action,
        delivery,
      },
      created_at: new Date(this.now()).toISOString(),
    };

    await this.enqueueInternal(task);
    const depth = await this.redis.lLen(queueKey(task.project_id));

    res.status(202).json({
      accepted: true,
      queued: true,
      queue_depth: depth,
      project_id: task.project_id,
      ticket_id: task.ticket_id,
    });
  }

  async handleLinearWebhook(req: RequestLike, res: ResponseLike): Promise<void> {
    const signature = asString(req.headers["linear-signature"]);

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(req.rawBody) as Record<string, unknown>;
    } catch {
      res.status(400).json({ error: "Invalid JSON body" });
      return;
    }

    const matched = await this.findLinearProject(payload);
    if (!matched || !matched.linear) {
      res.status(202).json({
        accepted: false,
        ignored: true,
        reason: "no_matching_project",
        type: asString(payload.type),
        action: asString(payload.action),
      });
      return;
    }

    const autoCfg = matched.linear.autoCfg;
    if (!autoCfg.webhookSecret) {
      res.status(403).json({ accepted: false, error: "Webhook secret not configured", project_id: matched.projectId });
      return;
    }

    if (!verifyLinearSignature(req.rawBody, signature, autoCfg.webhookSecret)) {
      res.status(401).json({ accepted: false, error: "Invalid webhook signature" });
      return;
    }

    const webhookTimestamp = Number(payload.webhookTimestamp ?? NaN);
    if (Number.isFinite(webhookTimestamp) && autoCfg.maxTimestampAgeSeconds > 0) {
      const ageSeconds = Math.abs(this.now() - webhookTimestamp) / 1000;
      if (ageSeconds > autoCfg.maxTimestampAgeSeconds) {
        res.status(401).json({ accepted: false, error: "Webhook timestamp outside accepted window" });
        return;
      }
    }

    const trigger = extractLinearTrigger(payload, autoCfg);
    if (!trigger.allowed || !trigger.ticketId) {
      res.status(202).json({
        accepted: false,
        ignored: true,
        reason: trigger.reason,
        project_id: matched.projectId,
        type: asString(payload.type),
        action: asString(payload.action),
      });
      return;
    }

    const delivery = asString(payload.webhookId);
    const fallbackDelivery = `${matched.projectId}:${asString(payload.type)}:${asString(payload.action)}:${trigger.ticketId}:${asString(payload.createdAt)}`;
    const deliveryKey = delivery || fallbackDelivery;
    const dedupeTtl = Math.max(60, Math.floor(autoCfg.dedupeWindowMinutes * 60) || this.dedupeTtlSeconds);

    if (await this.shouldDedupe(matched.projectId, deliveryKey, dedupeTtl)) {
      res.status(202).json({
        accepted: false,
        ignored: true,
        reason: "duplicate_event",
        project_id: matched.projectId,
        ticket_id: trigger.ticketId,
      });
      return;
    }

    const task: DispatchQueueItem = {
      run_id: generateRunId(this.idGenerator),
      project_id: matched.projectId,
      project_arg: matched.projectArg,
      source: "linear",
      ticket_id: trigger.ticketId,
      trigger_source: "linear_webhook",
      metadata: {
        type: asString(payload.type),
        action: asString(payload.action),
        delivery,
      },
      created_at: new Date(this.now()).toISOString(),
    };

    await this.enqueueInternal(task);
    const depth = await this.redis.lLen(queueKey(task.project_id));

    res.status(202).json({
      accepted: true,
      queued: true,
      queue_depth: depth,
      project_id: task.project_id,
      ticket_id: task.ticket_id,
    });
  }

  async handleHealth(req: RequestLike, res: ResponseLike): Promise<void> {
    if (!this.authorize(req, "read", res)) return;

    let redisStatus: "up" | "down" = "up";
    try {
      if (this.redis.ping) {
        await this.redis.ping();
      }
    } catch {
      redisStatus = "down";
    }

    res.status(redisStatus === "up" ? 200 : 503).json({
      status: redisStatus === "up" ? "ok" : "degraded",
      redis: redisStatus,
      k8s_mode: this.k8sMode,
    });
  }

  async handleQueue(req: RequestLike, res: ResponseLike): Promise<void> {
    if (!this.authorize(req, "read", res)) return;

    const projects = await this.loadProjects();
    const queueDepths = await Promise.all(
      projects.map(async (project) => ({
        project_id: project.projectId,
        depth: await this.redis.lLen(queueKey(project.projectId)),
      })),
    );

    res.status(200).json({
      queues: queueDepths,
      total_depth: queueDepths.reduce((acc, item) => acc + item.depth, 0),
    });
  }

  async close(): Promise<void> {
    this.running = false;
    if (this.consumerLoop) {
      await this.consumerLoop;
    }
    if (this.redis.quit) {
      await this.redis.quit();
    }
  }
}

export async function registerDispatchRoutes(
  app: ExpressLikeApp,
  options: DispatchControllerStartOptions = {},
): Promise<DispatchControllerRuntime> {
  const controller = new DispatchController(options);
  await controller.start();

  app.post("/api/dispatch/run", async (req, res) => {
    await controller.handleDispatchRun(req, res);
  });

  app.post("/api/webhooks/github", async (req, res) => {
    await controller.handleGitHubWebhook(req, res);
  });

  app.post("/api/webhooks/linear", async (req, res) => {
    await controller.handleLinearWebhook(req, res);
  });

  app.get("/api/dispatch/health", async (req, res) => {
    await controller.handleHealth(req, res);
  });

  app.get("/api/dispatch/queue", async (req, res) => {
    await controller.handleQueue(req, res);
  });

  return controller;
}

export async function startDispatchControllerServer(options: DispatchControllerStartOptions = {}): Promise<DispatchServerRuntime> {
  const host = asString(options.host ?? process.env.SPRINTFOUNDRY_DISPATCH_HOST) || "0.0.0.0";
  const port = options.port ?? parsePositiveInt(process.env.SPRINTFOUNDRY_DISPATCH_PORT, 4320);

  const app = new RouteApp();
  const runtime = await registerDispatchRoutes(app, options);

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method ?? "GET";
      const parsedUrl = new URL(req.url ?? "/", "http://localhost");
      const handlers = app.match(method, parsedUrl.pathname);
      if (!handlers) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not_found" }));
        return;
      }

      const rawBody = ["POST", "PUT", "PATCH"].includes(method.toUpperCase()) ? await readBody(req) : "";

      let body: unknown;
      if (rawBody.trim().length > 0) {
        const contentType = asString(req.headers["content-type"]).toLowerCase();
        body = contentType.includes("application/json") ? JSON.parse(rawBody) : rawBody;
      }

      const requestLike: RequestLike = {
        method,
        path: parsedUrl.pathname,
        headers: normalizeHeaders(req.headers),
        body,
        rawBody,
      };

      let statusCode = 200;
      let finished = false;
      const responseLike: ResponseLike = {
        status(code: number) {
          statusCode = code;
          return responseLike;
        },
        json(bodyToSend: unknown) {
          if (finished) return;
          finished = true;
          res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(bodyToSend));
        },
      };

      const runHandler = async (index: number): Promise<void> => {
        const handler = handlers[index];
        if (!handler || finished) return;
        let nextCalled = false;
        await handler(requestLike, responseLike, (error?: unknown) => {
          if (error) {
            throw error;
          }
          nextCalled = true;
        });
        if (nextCalled) {
          await runHandler(index + 1);
        }
      };

      await runHandler(0);
      if (!finished) {
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "not_found" }));
      }
    } catch (error) {
      if (error instanceof SyntaxError) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "invalid_json" }));
        return;
      }

      const logger = options.logger ?? console;
      logger.error(`[dispatch] request failed: ${error instanceof Error ? error.message : String(error)}`);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "internal_error" }));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve();
    });
  });

  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await runtime.close();
  };

  return {
    server,
    runtime,
    close,
  };
}

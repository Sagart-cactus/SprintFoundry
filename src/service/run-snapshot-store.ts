import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import type {
  DurableSnapshotMetadata,
  RunSessionMetadata,
} from "../shared/types.js";

const require = createRequire(import.meta.url);
const execFile = promisify(execFileCb);

export interface S3PutCommandInput {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType?: string;
}

export interface S3GetCommandInput {
  Bucket: string;
  Key: string;
}

export interface S3LikeClient {
  send(command: unknown): Promise<unknown>;
}

export interface RunSnapshotIdentity {
  run_id: string;
  project_id: string;
  tenant_id?: string;
  terminal_status: "completed" | "failed" | "cancelled";
}

export interface RunSnapshotManifest {
  schema_version: 1;
  run_id: string;
  project_id: string;
  tenant_id: string;
  terminal_status: "completed" | "failed" | "cancelled";
  export_reason: "terminal_state";
  created_at: string;
  archive_key: string;
  session_key: string;
  archive_sha256: string;
  archive_size_bytes: number;
  compression: "tar.gz";
  source_backend: "k8s-whole-run";
  source_workspace_path: string;
  restorable_paths: string[];
  excluded_paths: string[];
  sanitization_applied: string[];
}

export interface RunSnapshotUploadResult {
  manifest: RunSnapshotManifest;
  durableSnapshot: DurableSnapshotMetadata;
  session: RunSessionMetadata;
}

export interface RunSnapshotRestoreResult {
  manifest: RunSnapshotManifest;
  session: RunSessionMetadata;
  workspacePath: string;
}

export interface RunSnapshotStoreOptions {
  bucket?: string;
  endpoint?: string;
  region?: string;
  forcePathStyle?: boolean;
  s3Client?: S3LikeClient;
  putCommandFactory?: (input: S3PutCommandInput) => unknown;
  getCommandFactory?: (input: S3GetCommandInput) => unknown;
  logger?: Pick<Console, "warn">;
}

interface ResolvedS3Factories {
  s3Client: S3LikeClient;
  putCommandFactory: (input: S3PutCommandInput) => unknown;
  getCommandFactory: (input: S3GetCommandInput) => unknown;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function isTruthy(value: string | undefined): boolean {
  const normalized = asString(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function normalizeS3Key(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function readS3Body(body: unknown): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === "string") return Buffer.from(body, "utf-8");
  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    return Buffer.from(bytes);
  }
  if (typeof (body as { arrayBuffer?: unknown }).arrayBuffer === "function") {
    const bytes = await (body as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer();
    return Buffer.from(bytes);
  }
  if (typeof (body as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === "function") {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Unsupported S3 response body type");
}

function buildDefaultS3Factories(options: RunSnapshotStoreOptions): ResolvedS3Factories {
  const awsModule = require("@aws-sdk/client-s3") as {
    S3Client: new (config?: Record<string, unknown>) => S3LikeClient;
    PutObjectCommand: new (input: S3PutCommandInput) => unknown;
    GetObjectCommand: new (input: S3GetCommandInput) => unknown;
  };

  const endpoint = asString(options.endpoint ?? process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT) || undefined;
  const region = asString(options.region ?? process.env.SPRINTFOUNDRY_SNAPSHOT_S3_REGION) || "us-east-1";
  const forcePathStyle =
    options.forcePathStyle ??
    isTruthy(process.env.SPRINTFOUNDRY_SNAPSHOT_S3_FORCE_PATH_STYLE);

  const s3Client = new awsModule.S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    ...(forcePathStyle ? { forcePathStyle: true } : {}),
  });

  return {
    s3Client,
    putCommandFactory: (input) => new awsModule.PutObjectCommand(input),
    getCommandFactory: (input) => new awsModule.GetObjectCommand(input),
  };
}

export class RunSnapshotStore {
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly options: RunSnapshotStoreOptions = {}) {
    this.logger = options.logger ?? console;
  }

  isEnabled(): boolean {
    return Boolean(this.resolveBucket());
  }

  async uploadRunSnapshot(
    identity: RunSnapshotIdentity,
    session: RunSessionMetadata,
    workspacePath: string
  ): Promise<RunSnapshotUploadResult> {
    const bucket = this.resolveBucket();
    if (!bucket) {
      throw new Error("Run snapshots are not configured: missing snapshot bucket");
    }

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sf-run-snapshot-"));
    try {
      const stagingRoot = path.join(tempRoot, "staging");
      const stagedWorkspace = path.join(stagingRoot, "workspace");
      const stagedSessionDir = path.join(stagingRoot, "session");
      const archivePath = path.join(tempRoot, "workspace.tar.gz");

      await fs.mkdir(stagingRoot, { recursive: true });
      await fs.mkdir(stagedSessionDir, { recursive: true });
      await fs.cp(workspacePath, stagedWorkspace, { recursive: true });

      await this.sanitizeWorkspace(stagedWorkspace);

      const stagedSessionPath = path.join(stagedSessionDir, `${identity.run_id}.json`);
      await fs.writeFile(stagedSessionPath, JSON.stringify(session, null, 2), "utf-8");

      await this.createTarGz(stagingRoot, archivePath);

      const archiveBuffer = await fs.readFile(archivePath);
      const archiveSha256 = createHash("sha256").update(archiveBuffer).digest("hex");
      const archiveSizeBytes = archiveBuffer.byteLength;
      const prefix = this.buildSnapshotPrefix(identity);
      const archiveKey = `${prefix}/workspace.tar.gz`;
      const manifestKey = `${prefix}/manifest.json`;
      const sessionKey = `${prefix}/session.json`;
      const now = new Date().toISOString();

      const manifest: RunSnapshotManifest = {
        schema_version: 1,
        run_id: identity.run_id,
        project_id: identity.project_id,
        tenant_id: asString(identity.tenant_id) || "shared",
        terminal_status: identity.terminal_status,
        export_reason: "terminal_state",
        created_at: now,
        archive_key: archiveKey,
        session_key: sessionKey,
        archive_sha256: archiveSha256,
        archive_size_bytes: archiveSizeBytes,
        compression: "tar.gz",
        source_backend: "k8s-whole-run",
        source_workspace_path: workspacePath,
        restorable_paths: ["workspace/**", `session/${identity.run_id}.json`],
        excluded_paths: ["/workspace/home/**", "projected-secrets/**"],
        sanitization_applied: [".git/config credentials scrubbed"],
      };

      const durableSnapshot: DurableSnapshotMetadata = {
        status: "completed",
        backend: "s3",
        bucket,
        endpoint: asString(this.options.endpoint ?? process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT) || null,
        region: asString(this.options.region ?? process.env.SPRINTFOUNDRY_SNAPSHOT_S3_REGION) || "us-east-1",
        manifest_key: manifestKey,
        archive_key: archiveKey,
        session_key: sessionKey,
        archive_sha256: archiveSha256,
        archive_size_bytes: archiveSizeBytes,
        terminal_status: identity.terminal_status,
        exported_at: now,
        restore_hint: `sprintfoundry restore ${identity.run_id}`,
        error: null,
      };

      const exportedSession: RunSessionMetadata = {
        ...session,
        updated_at: now,
        terminal_workflow_state: "snapshot_completed",
        durable_snapshot: durableSnapshot,
      };

      const s3 = this.resolveS3();
      await s3.s3Client.send(
        s3.putCommandFactory({
          Bucket: bucket,
          Key: archiveKey,
          Body: archiveBuffer,
          ContentType: "application/gzip",
        })
      );
      await s3.s3Client.send(
        s3.putCommandFactory({
          Bucket: bucket,
          Key: manifestKey,
          Body: Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"),
          ContentType: "application/json",
        })
      );
      await s3.s3Client.send(
        s3.putCommandFactory({
          Bucket: bucket,
          Key: sessionKey,
          Body: Buffer.from(JSON.stringify(exportedSession, null, 2), "utf-8"),
          ContentType: "application/json",
        })
      );

      return {
        manifest,
        durableSnapshot,
        session: exportedSession,
      };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async readManifest(identity: Pick<RunSnapshotIdentity, "run_id" | "project_id" | "tenant_id">): Promise<RunSnapshotManifest> {
    const bucket = this.resolveBucket();
    if (!bucket) {
      throw new Error("Run snapshots are not configured: missing snapshot bucket");
    }
    const prefix = this.buildSnapshotPrefix(identity);
    const key = `${prefix}/manifest.json`;
    const body = await this.getObjectBody(bucket, key);
    return JSON.parse(body.toString("utf-8")) as RunSnapshotManifest;
  }

  async readSessionRecord(
    identity: Pick<RunSnapshotIdentity, "run_id" | "project_id" | "tenant_id">
  ): Promise<RunSessionMetadata> {
    const bucket = this.resolveBucket();
    if (!bucket) {
      throw new Error("Run snapshots are not configured: missing snapshot bucket");
    }
    const manifest = await this.readManifest(identity);
    const body = await this.getObjectBody(bucket, manifest.session_key);
    return JSON.parse(body.toString("utf-8")) as RunSessionMetadata;
  }

  async writeSessionRecord(
    identity: Pick<RunSnapshotIdentity, "run_id" | "project_id" | "tenant_id">,
    session: RunSessionMetadata
  ): Promise<void> {
    const bucket = this.resolveBucket();
    if (!bucket) {
      throw new Error("Run snapshots are not configured: missing snapshot bucket");
    }
    const manifest = await this.readManifest(identity);
    const s3 = this.resolveS3();
    await s3.s3Client.send(
      s3.putCommandFactory({
        Bucket: bucket,
        Key: manifest.session_key,
        Body: Buffer.from(JSON.stringify(session, null, 2), "utf-8"),
        ContentType: "application/json",
      })
    );
  }

  async restoreRunSnapshot(
    identity: Pick<RunSnapshotIdentity, "run_id" | "project_id" | "tenant_id">,
    destinationPath: string
  ): Promise<RunSnapshotRestoreResult> {
    const bucket = this.resolveBucket();
    if (!bucket) {
      throw new Error("Run snapshots are not configured: missing snapshot bucket");
    }
    const manifest = await this.readManifest(identity);
    const archiveBody = await this.getObjectBody(bucket, manifest.archive_key);
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sf-run-restore-"));
    try {
      const archivePath = path.join(tempRoot, "workspace.tar.gz");
      const extractRoot = path.join(tempRoot, "extract");
      await fs.mkdir(extractRoot, { recursive: true });
      await fs.writeFile(archivePath, archiveBody);
      await this.extractTarGz(archivePath, extractRoot);

      const stagedWorkspace = path.join(extractRoot, "workspace");
      const uploadedSessionPath = path.join(extractRoot, "session", `${identity.run_id}.json`);

      await fs.rm(destinationPath, { recursive: true, force: true }).catch(() => undefined);
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
      await fs.cp(stagedWorkspace, destinationPath, { recursive: true });

      let session: RunSessionMetadata;
      try {
        const sessionBody = await this.getObjectBody(bucket, manifest.session_key);
        session = JSON.parse(sessionBody.toString("utf-8")) as RunSessionMetadata;
      } catch (error) {
        this.logger.warn(
          `[run-snapshot] Falling back to archived session payload for ${identity.run_id}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        const raw = await fs.readFile(uploadedSessionPath, "utf-8");
        session = JSON.parse(raw) as RunSessionMetadata;
      }

      return {
        manifest,
        session,
        workspacePath: destinationPath,
      };
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private resolveBucket(): string {
    return asString(this.options.bucket ?? process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET);
  }

  private resolveS3(): ResolvedS3Factories {
    if (this.options.s3Client && this.options.putCommandFactory && this.options.getCommandFactory) {
      return {
        s3Client: this.options.s3Client,
        putCommandFactory: this.options.putCommandFactory,
        getCommandFactory: this.options.getCommandFactory,
      };
    }
    return buildDefaultS3Factories(this.options);
  }

  private buildSnapshotPrefix(identity: Pick<RunSnapshotIdentity, "run_id" | "project_id" | "tenant_id">): string {
    const tenantId = asString(identity.tenant_id) || "shared";
    return normalizeS3Key(
      `tenants/${tenantId}/projects/${identity.project_id}/runs/${identity.run_id}/snapshot`
    );
  }

  private async getObjectBody(bucket: string, key: string): Promise<Buffer> {
    const s3 = this.resolveS3();
    const result = await s3.s3Client.send(
      s3.getCommandFactory({
        Bucket: bucket,
        Key: key,
      })
    ) as { Body?: unknown };
    return readS3Body(result.Body);
  }

  private async sanitizeWorkspace(workspacePath: string): Promise<void> {
    const gitConfigPath = path.join(workspacePath, ".git", "config");
    const gitConfig = await fs.readFile(gitConfigPath, "utf-8").catch(() => "");
    if (gitConfig) {
      const scrubbed = gitConfig.replace(/(https?:\/\/)([^@\s\/]+@)/gi, "$1");
      await fs.writeFile(gitConfigPath, scrubbed, "utf-8");
    }
  }

  private async createTarGz(sourceDir: string, targetArchive: string): Promise<void> {
    await execFile("tar", ["-czf", targetArchive, "-C", sourceDir, "."]);
  }

  private async extractTarGz(archivePath: string, destinationDir: string): Promise<void> {
    await execFile("tar", ["-xzf", archivePath, "-C", destinationDir]);
  }
}

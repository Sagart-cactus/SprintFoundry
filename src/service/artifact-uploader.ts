import path from "node:path";
import { promises as fs } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface S3PutCommandInput {
  Bucket: string;
  Key: string;
  Body: Buffer;
  ContentType?: string;
}

export interface S3LikeClient {
  send(command: unknown): Promise<unknown>;
}

export interface ArtifactUploaderOptions {
  bucket?: string;
  s3Client?: S3LikeClient;
  commandFactory?: (input: S3PutCommandInput) => unknown;
  logger?: Pick<Console, "warn">;
}

export interface ArtifactUploadIdentity {
  run_id: string;
  project_id?: string;
  tenant_id?: string;
}

export interface ArtifactUploadSummary {
  attempted: number;
  uploaded: number;
  skipped: boolean;
  bucket: string | null;
  prefix: string;
}

interface UploadFile {
  localPath: string;
  key: string;
  contentType: string;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeS3Key(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\/+/, "");
}

function contentTypeForKey(key: string): string {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".log") || key.endsWith(".txt")) return "text/plain";
  return "application/octet-stream";
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const pending = [root];
  const files: string[] = [];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;

    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const nextPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(nextPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(nextPath);
      }
    }
  }

  return files;
}

function collectRuntimeLogFiles(entries: string[]): string[] {
  return entries.filter((name) => /^\.(?:planner|codex|claude)-runtime\..+\.log$/i.test(name));
}

function buildDefaultS3ClientAndFactory(): {
  s3Client: S3LikeClient;
  commandFactory: (input: S3PutCommandInput) => unknown;
} {
  const awsModule = require("@aws-sdk/client-s3") as {
    S3Client: new (config?: Record<string, unknown>) => S3LikeClient;
    PutObjectCommand: new (input: S3PutCommandInput) => unknown;
  };

  const s3Client = new awsModule.S3Client({});
  const commandFactory = (input: S3PutCommandInput) => new awsModule.PutObjectCommand(input);
  return { s3Client, commandFactory };
}

export class ArtifactUploader {
  private readonly logger: Pick<Console, "warn">;

  constructor(private readonly options: ArtifactUploaderOptions = {}) {
    this.logger = options.logger ?? console;
  }

  async uploadRunArtifacts(
    run: string | ArtifactUploadIdentity,
    workspacePath: string
  ): Promise<ArtifactUploadSummary> {
    const identity = typeof run === "string" ? { run_id: run } : run;
    const runId = identity.run_id;
    const bucket = asString(this.options.bucket ?? process.env.SPRINTFOUNDRY_ARTIFACT_BUCKET);
    const prefix = this.buildArtifactPrefix(identity);

    if (!bucket) {
      return {
        attempted: 0,
        uploaded: 0,
        skipped: true,
        bucket: null,
        prefix,
      };
    }

    const files = await this.collectUploadFiles(workspacePath, prefix);
    if (files.length === 0) {
      return {
        attempted: 0,
        uploaded: 0,
        skipped: false,
        bucket,
        prefix,
      };
    }

    let s3Client = this.options.s3Client;
    let commandFactory = this.options.commandFactory;

    if (!s3Client || !commandFactory) {
      try {
        const defaults = buildDefaultS3ClientAndFactory();
        s3Client = s3Client ?? defaults.s3Client;
        commandFactory = commandFactory ?? defaults.commandFactory;
      } catch (error) {
        this.logger.warn(
          `[artifacts] skipped upload for run ${runId}: @aws-sdk/client-s3 unavailable (${error instanceof Error ? error.message : String(error)})`,
        );
        return {
          attempted: files.length,
          uploaded: 0,
          skipped: true,
          bucket,
          prefix,
        };
      }
    }

    let uploaded = 0;
    for (const file of files) {
      try {
        const body = await fs.readFile(file.localPath);
        const command = commandFactory({
          Bucket: bucket,
          Key: file.key,
          Body: body,
          ContentType: file.contentType,
        });
        await s3Client.send(command);
        uploaded += 1;
      } catch (error) {
        this.logger.warn(
          `[artifacts] upload failed for ${file.localPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return {
      attempted: files.length,
      uploaded,
      skipped: false,
      bucket,
      prefix,
    };
  }

  private buildArtifactPrefix(identity: ArtifactUploadIdentity): string {
    const tenantId = asString(identity.tenant_id) || "shared";
    const projectId = asString(identity.project_id) || "unknown-project";
    return normalizeS3Key(`tenants/${tenantId}/projects/${projectId}/runs/${identity.run_id}`);
  }

  private async collectUploadFiles(workspacePath: string, prefix: string): Promise<UploadFile[]> {
    const uploads: UploadFile[] = [];

    const stepResultsRoot = path.join(workspacePath, ".sprintfoundry", "step-results");
    if (await pathExists(stepResultsRoot)) {
      const stepFiles = await listFilesRecursive(stepResultsRoot);
      for (const filePath of stepFiles) {
        const relative = normalizeS3Key(path.relative(stepResultsRoot, filePath));
        uploads.push({
          localPath: filePath,
          key: normalizeS3Key(`${prefix}/step-results/${relative}`),
          contentType: contentTypeForKey(filePath),
        });
      }
    }

    const artifactsRoot = path.join(workspacePath, "artifacts");
    if (await pathExists(artifactsRoot)) {
      const artifactFiles = await listFilesRecursive(artifactsRoot);
      for (const filePath of artifactFiles) {
        const relative = normalizeS3Key(path.relative(artifactsRoot, filePath));
        uploads.push({
          localPath: filePath,
          key: normalizeS3Key(`${prefix}/artifacts/${relative}`),
          contentType: contentTypeForKey(filePath),
        });
      }
    }

    const rootEntries = await fs.readdir(workspacePath, { withFileTypes: true }).catch(() => []);
    const runtimeLogNames = collectRuntimeLogFiles(
      rootEntries.filter((entry) => entry.isFile()).map((entry) => entry.name),
    );
    for (const logName of runtimeLogNames) {
      uploads.push({
        localPath: path.join(workspacePath, logName),
        key: normalizeS3Key(`${prefix}/runtime-logs/${logName}`),
        contentType: contentTypeForKey(logName),
      });
    }

    uploads.sort((a, b) => a.key.localeCompare(b.key));
    return uploads;
  }
}

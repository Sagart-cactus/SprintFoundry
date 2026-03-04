import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArtifactUploader, type S3LikeClient, type S3PutCommandInput } from "../src/service/artifact-uploader.js";

interface CapturedCommand {
  input: S3PutCommandInput;
}

class FakeS3Client implements S3LikeClient {
  readonly uploads: CapturedCommand[] = [];

  constructor(private readonly failKeys = new Set<string>()) {}

  async send(command: unknown): Promise<unknown> {
    const captured = command as CapturedCommand;
    if (this.failKeys.has(captured.input.Key)) {
      throw new Error(`forced failure for ${captured.input.Key}`);
    }
    this.uploads.push(captured);
    return {};
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.SPRINTFOUNDRY_ARTIFACT_BUCKET;
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createWorkspaceFixture(): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "sf-artifacts-"));
  tempDirs.push(workspace);

  const stepDir = path.join(workspace, ".sprintfoundry", "step-results");
  const artifactDir = path.join(workspace, "artifacts", "reports");
  mkdirSync(stepDir, { recursive: true });
  mkdirSync(artifactDir, { recursive: true });

  writeFileSync(path.join(stepDir, "step-1.attempt-1.qa.json"), JSON.stringify({ ok: true }), "utf-8");
  writeFileSync(path.join(artifactDir, "summary.txt"), "all good", "utf-8");
  writeFileSync(path.join(workspace, ".codex-runtime.stdout.log"), "runtime stdout", "utf-8");

  return workspace;
}

describe("ArtifactUploader", () => {
  it("no-ops when SPRINTFOUNDRY_ARTIFACT_BUCKET is not set", async () => {
    const workspace = createWorkspaceFixture();
    const fakeS3 = new FakeS3Client();

    const uploader = new ArtifactUploader({
      s3Client: fakeS3,
      commandFactory: (input) => ({ input }),
    });

    const summary = await uploader.uploadRunArtifacts("run-1", workspace);

    expect(summary.skipped).toBe(true);
    expect(summary.attempted).toBe(0);
    expect(fakeS3.uploads).toHaveLength(0);
  });

  it("uploads step-results, runtime logs, and artifacts to runs/{run_id}/", async () => {
    const workspace = createWorkspaceFixture();
    const fakeS3 = new FakeS3Client();

    const uploader = new ArtifactUploader({
      bucket: "sf-artifacts",
      s3Client: fakeS3,
      commandFactory: (input) => ({ input }),
    });

    const summary = await uploader.uploadRunArtifacts("run-xyz", workspace);

    expect(summary.skipped).toBe(false);
    expect(summary.bucket).toBe("sf-artifacts");
    expect(summary.attempted).toBe(3);
    expect(summary.uploaded).toBe(3);

    const keys = fakeS3.uploads.map((entry) => entry.input.Key).sort();
    expect(keys).toEqual([
      "runs/run-xyz/artifacts/reports/summary.txt",
      "runs/run-xyz/runtime-logs/.codex-runtime.stdout.log",
      "runs/run-xyz/step-results/step-1.attempt-1.qa.json",
    ]);

    for (const upload of fakeS3.uploads) {
      expect(upload.input.Bucket).toBe("sf-artifacts");
      expect(Buffer.isBuffer(upload.input.Body)).toBe(true);
    }
  });

  it("logs warnings and continues when individual uploads fail", async () => {
    const workspace = createWorkspaceFixture();
    const failingKey = "runs/run-fail/step-results/step-1.attempt-1.qa.json";
    const fakeS3 = new FakeS3Client(new Set([failingKey]));
    const warn = vi.fn<(message?: unknown) => void>();

    const uploader = new ArtifactUploader({
      bucket: "sf-artifacts",
      s3Client: fakeS3,
      commandFactory: (input) => ({ input }),
      logger: { warn },
    });

    const summary = await uploader.uploadRunArtifacts("run-fail", workspace);

    expect(summary.attempted).toBe(3);
    expect(summary.uploaded).toBe(2);
    expect(warn).toHaveBeenCalled();
    expect(fakeS3.uploads).toHaveLength(2);
  });
});

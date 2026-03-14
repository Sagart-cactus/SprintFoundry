import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  RunSnapshotStore,
  type S3GetCommandInput,
  type S3LikeClient,
  type S3PutCommandInput,
} from "../src/service/run-snapshot-store.js";
import type { RunSessionMetadata } from "../src/shared/types.js";

class FakeSnapshotS3Client implements S3LikeClient {
  readonly objects = new Map<string, Buffer>();

  async send(command: unknown): Promise<unknown> {
    const input = (command as { input: S3PutCommandInput | S3GetCommandInput }).input;
    if ("Body" in input) {
      this.objects.set(`${input.Bucket}/${input.Key}`, Buffer.from(input.Body));
      return {};
    }

    const body = this.objects.get(`${input.Bucket}/${input.Key}`);
    if (!body) {
      throw new Error(`Object not found: ${input.Bucket}/${input.Key}`);
    }
    return {
      Body: body,
    };
  }
}

const tempDirs: string[] = [];

afterEach(() => {
  delete process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET;
  delete process.env.SPRINTFOUNDRY_SNAPSHOT_S3_REGION;
  delete process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT;
  delete process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT_IN_CLUSTER;
  delete process.env.SPRINTFOUNDRY_SNAPSHOT_S3_FORCE_PATH_STYLE;
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createWorkspaceFixture(): string {
  const workspace = mkdtempSync(path.join(os.tmpdir(), "sf-run-snapshot-"));
  tempDirs.push(workspace);
  mkdirSync(path.join(workspace, ".git"), { recursive: true });
  mkdirSync(path.join(workspace, "artifacts"), { recursive: true });
  writeFileSync(
    path.join(workspace, ".git", "config"),
    "[remote \"origin\"]\n\turl = https://ghp_token123@github.com/example/repo.git\n",
    "utf-8"
  );
  writeFileSync(path.join(workspace, "README.md"), "# Snapshot\n", "utf-8");
  writeFileSync(path.join(workspace, "artifacts", "proof.txt"), "snapshot-proof", "utf-8");
  return workspace;
}

function createWholeRunWorkspaceFixture(): { workspace: string; runtimeHome: string } {
  const root = mkdtempSync(path.join(os.tmpdir(), "sf-run-whole-run-"));
  tempDirs.push(root);
  const workspace = path.join(root, "sprintfoundry", "project-a", "run-snapshot-1");
  const runtimeHome = path.join(root, "home");
  mkdirSync(path.join(workspace, ".git"), { recursive: true });
  mkdirSync(path.join(workspace, ".sprintfoundry"), { recursive: true });
  mkdirSync(path.join(runtimeHome, ".codex"), { recursive: true });
  mkdirSync(path.join(runtimeHome, ".claude"), { recursive: true });
  writeFileSync(path.join(workspace, ".git", "config"), "[remote \"origin\"]\n\turl = https://token@example.com/repo.git\n", "utf-8");
  writeFileSync(path.join(workspace, ".sprintfoundry", "sessions.json"), JSON.stringify({ sessions: [] }), "utf-8");
  writeFileSync(path.join(workspace, "README.md"), "# Whole Run Snapshot\n", "utf-8");
  writeFileSync(path.join(runtimeHome, ".codex", "state_5.sqlite"), "sqlite-placeholder", "utf-8");
  writeFileSync(path.join(runtimeHome, ".claude", "projects.json"), "{}", "utf-8");
  return { workspace, runtimeHome };
}

function makeSession(workspacePath: string): RunSessionMetadata {
  return {
    run_id: "run-snapshot-1",
    project_id: "project-a",
    ticket_id: "PROMPT-1",
    ticket_source: "prompt",
    ticket_title: "snapshot test",
    status: "completed",
    current_step: 1,
    total_steps: 1,
    plan_classification: "direct",
    workspace_path: workspacePath,
    branch: "feat/snapshot",
    pr_url: null,
    total_tokens: 10,
    total_cost_usd: 0.01,
    created_at: "2026-03-13T00:00:00.000Z",
    updated_at: "2026-03-13T00:00:00.000Z",
    completed_at: "2026-03-13T00:05:00.000Z",
    error: null,
    terminal_workflow_state: "terminal_pending_snapshot",
    durable_snapshot: null,
  };
}

describe("RunSnapshotStore", () => {
  it("uploads manifest, archive, and session objects with scrubbed workspace data", async () => {
    const workspace = createWorkspaceFixture();
    const session = makeSession(workspace);
    const fakeS3 = new FakeSnapshotS3Client();

    const store = new RunSnapshotStore({
      bucket: "snapshots",
      s3Client: fakeS3,
      putCommandFactory: (input) => ({ input }),
      getCommandFactory: (input) => ({ input }),
    });

    const result = await store.uploadRunSnapshot(
      {
        run_id: session.run_id,
        project_id: session.project_id,
        terminal_status: "completed",
      },
      session,
      workspace
    );

    expect(result.durableSnapshot.archive_key).toBe(
      "tenants/shared/projects/project-a/runs/run-snapshot-1/snapshot/workspace.tar.gz"
    );
    expect(fakeS3.objects.has("snapshots/tenants/shared/projects/project-a/runs/run-snapshot-1/snapshot/manifest.json")).toBe(true);
    expect(fakeS3.objects.has("snapshots/tenants/shared/projects/project-a/runs/run-snapshot-1/snapshot/session.json")).toBe(true);

    const uploadedSession = JSON.parse(
      fakeS3.objects
        .get("snapshots/tenants/shared/projects/project-a/runs/run-snapshot-1/snapshot/session.json")!
        .toString("utf-8")
    ) as RunSessionMetadata;
    expect(uploadedSession.terminal_workflow_state).toBe("snapshot_completed");
    expect(uploadedSession.durable_snapshot?.status).toBe("completed");
  });

  it("prefers the in-cluster snapshot endpoint when no explicit override is provided", async () => {
    process.env.SPRINTFOUNDRY_SNAPSHOT_BUCKET = "snapshots";
    process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT = "http://127.0.0.1:9000";
    process.env.SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT_IN_CLUSTER = "http://minio.snapshots.svc.cluster.local:9000";

    const workspace = createWorkspaceFixture();
    const session = makeSession(workspace);
    const fakeS3 = new FakeSnapshotS3Client();
    const store = new RunSnapshotStore({
      s3Client: fakeS3,
      putCommandFactory: (input) => ({ input }),
      getCommandFactory: (input) => ({ input }),
    });

    const result = await store.uploadRunSnapshot(
      {
        run_id: session.run_id,
        project_id: session.project_id,
        terminal_status: "completed",
      },
      session,
      workspace
    );

    expect(result.durableSnapshot.endpoint).toBe("http://minio.snapshots.svc.cluster.local:9000");
  });

  it("restores a snapshot archive back to a local workspace", async () => {
    const workspace = createWorkspaceFixture();
    const session = makeSession(workspace);
    const fakeS3 = new FakeSnapshotS3Client();
    const store = new RunSnapshotStore({
      bucket: "snapshots",
      s3Client: fakeS3,
      putCommandFactory: (input) => ({ input }),
      getCommandFactory: (input) => ({ input }),
    });

    await store.uploadRunSnapshot(
      {
        run_id: session.run_id,
        project_id: session.project_id,
        terminal_status: "completed",
      },
      session,
      workspace
    );

    const destination = mkdtempSync(path.join(os.tmpdir(), "sf-run-restore-dest-"));
    tempDirs.push(destination);

    const restored = await store.restoreRunSnapshot(
      {
        run_id: session.run_id,
        project_id: session.project_id,
      },
      path.join(destination, "workspace")
    );

    const restoredReadme = await fs.readFile(path.join(restored.workspacePath, "README.md"), "utf-8");
    const restoredGitConfig = await fs.readFile(
      path.join(restored.workspacePath, ".git", "config"),
      "utf-8"
    );

    expect(restoredReadme).toContain("# Snapshot");
    expect(restoredGitConfig).toContain("https://github.com/example/repo.git");
    expect(restoredGitConfig).not.toContain("ghp_token123");
    expect(restored.session.durable_snapshot?.status).toBe("completed");
  });

  it("preserves provider runtime home state and restore warnings for whole-run snapshots", async () => {
    const fixture = createWholeRunWorkspaceFixture();
    const session = makeSession(fixture.workspace);
    const fakeS3 = new FakeSnapshotS3Client();
    const store = new RunSnapshotStore({
      bucket: "snapshots",
      s3Client: fakeS3,
      putCommandFactory: (input) => ({ input }),
      getCommandFactory: (input) => ({ input }),
    });

    const uploaded = await store.uploadRunSnapshot(
      {
        run_id: session.run_id,
        project_id: session.project_id,
        terminal_status: "completed",
      },
      session,
      fixture.workspace
    );

    expect(uploaded.manifest.source_runtime_home_path).toBe(fixture.runtimeHome);
    expect(uploaded.manifest.restorable_paths).toContain("runtime-home/**");

    const destination = mkdtempSync(path.join(os.tmpdir(), "sf-run-restore-whole-run-"));
    tempDirs.push(destination);
    const restored = await store.restoreRunSnapshot(
      {
        run_id: session.run_id,
        project_id: session.project_id,
      },
      path.join(destination, "workspace")
    );

    expect(restored.runtimeHomePath).toBe(path.join(destination, "workspace", ".runtime-home"));
    expect(await fs.readFile(path.join(restored.runtimeHomePath!, ".codex", "state_5.sqlite"), "utf-8")).toBe("sqlite-placeholder");
    expect(await fs.readFile(path.join(restored.runtimeHomePath!, ".claude", "projects.json"), "utf-8")).toBe("{}");
    expect(restored.compatibilityWarnings).toEqual([]);
  });
});

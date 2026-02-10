import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { WorkspaceManager } from "../src/service/workspace-manager.js";
import { makeProjectConfig } from "./fixtures/configs.js";

describe("WorkspaceManager", () => {
  let manager: WorkspaceManager;
  let baseDir: string;

  beforeEach(async () => {
    // Use a unique project_id so each test gets its own base dir under os.tmpdir()
    const projectId = `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    manager = new WorkspaceManager(makeProjectConfig({ project_id: projectId }));
    baseDir = path.join(os.tmpdir(), "agentsdlc", projectId);
  });

  it("create() makes workspace + artifacts/handoff dirs", async () => {
    const runId = "run-001";
    const workspacePath = await manager.create(runId);

    expect(workspacePath).toBe(path.join(baseDir, runId));

    const stat = await fs.stat(workspacePath);
    expect(stat.isDirectory()).toBe(true);

    const artifactsStat = await fs.stat(path.join(workspacePath, "artifacts"));
    expect(artifactsStat.isDirectory()).toBe(true);

    const handoffStat = await fs.stat(
      path.join(workspacePath, "artifacts", "handoff")
    );
    expect(handoffStat.isDirectory()).toBe(true);
  });

  it("getPath() returns expected path format", () => {
    const runId = "run-002";
    const result = manager.getPath(runId);

    expect(result).toBe(path.join(baseDir, runId));
  });

  it("cleanup() removes the workspace", async () => {
    const runId = "run-003";
    await manager.create(runId);

    await manager.cleanup(runId);

    await expect(fs.stat(path.join(baseDir, runId))).rejects.toThrow();
  });

  it("list() returns run IDs", async () => {
    await manager.create("run-a");
    await manager.create("run-b");

    const runs = await manager.list();

    expect(runs).toContain("run-a");
    expect(runs).toContain("run-b");
  });

  it("list() returns [] when baseDir doesn't exist", async () => {
    // Don't create any workspaces — baseDir doesn't exist
    const freshManager = new WorkspaceManager(
      makeProjectConfig({ project_id: `nonexistent-${Date.now()}` })
    );

    const runs = await freshManager.list();

    expect(runs).toEqual([]);
  });
});

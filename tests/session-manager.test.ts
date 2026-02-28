import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { SessionManager } from "../src/service/session-manager.js";
import type { TaskRun, RunSessionMetadata } from "../src/shared/types.js";

// ---------- Helpers ----------

let testDir: string;

function makeRun(overrides?: Partial<TaskRun>): TaskRun {
  return {
    run_id: overrides?.run_id ?? `run-${Date.now()}`,
    project_id: overrides?.project_id ?? "test-project",
    ticket: {
      id: "TEST-1",
      source: "github",
      title: "Test ticket",
      description: "A test description",
      labels: [],
      priority: "p2",
      acceptance_criteria: [],
      linked_tickets: [],
      comments: [],
      author: "tester",
      raw: {},
    },
    plan: null,
    validated_plan: null,
    status: overrides?.status ?? "pending",
    steps: overrides?.steps ?? [],
    total_tokens_used: overrides?.total_tokens_used ?? 0,
    total_cost_usd: overrides?.total_cost_usd ?? 0,
    created_at: new Date("2026-02-27T10:00:00Z"),
    updated_at: new Date("2026-02-27T10:00:00Z"),
    completed_at: overrides?.completed_at ?? null,
    pr_url: overrides?.pr_url ?? null,
    error: overrides?.error ?? null,
  };
}

// ---------- Tests ----------

describe("SessionManager", () => {
  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sf-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("persists and retrieves a session", async () => {
    const mgr = new SessionManager(testDir);
    const run = makeRun({ run_id: "run-abc" });

    await mgr.persist(run, { workspace_path: "/tmp/ws", branch: "feat/test" });

    const session = await mgr.get("run-abc");
    expect(session).not.toBeNull();
    expect(session!.run_id).toBe("run-abc");
    expect(session!.project_id).toBe("test-project");
    expect(session!.ticket_id).toBe("TEST-1");
    expect(session!.ticket_source).toBe("github");
    expect(session!.ticket_title).toBe("Test ticket");
    expect(session!.status).toBe("pending");
    expect(session!.workspace_path).toBe("/tmp/ws");
    expect(session!.branch).toBe("feat/test");
    expect(session!.total_tokens).toBe(0);
    expect(session!.total_cost_usd).toBe(0);
  });

  it("updates an existing session on re-persist", async () => {
    const mgr = new SessionManager(testDir);
    const run = makeRun({ run_id: "run-update" });

    await mgr.persist(run);

    run.status = "executing";
    run.total_tokens_used = 50000;
    run.total_cost_usd = 1.25;
    await mgr.persist(run, { workspace_path: "/tmp/ws2" });

    const session = await mgr.get("run-update");
    expect(session!.status).toBe("executing");
    expect(session!.total_tokens).toBe(50000);
    expect(session!.total_cost_usd).toBe(1.25);
    expect(session!.workspace_path).toBe("/tmp/ws2");
  });

  it("returns null for nonexistent session", async () => {
    const mgr = new SessionManager(testDir);
    const session = await mgr.get("nonexistent");
    expect(session).toBeNull();
  });

  it("lists sessions sorted by updated_at descending", async () => {
    const mgr = new SessionManager(testDir);

    const run1 = makeRun({ run_id: "run-1" });
    const run2 = makeRun({ run_id: "run-2" });
    const run3 = makeRun({ run_id: "run-3" });

    await mgr.persist(run1);
    // Small delay to ensure different updated_at timestamps
    await new Promise((r) => setTimeout(r, 10));
    await mgr.persist(run2);
    await new Promise((r) => setTimeout(r, 10));
    await mgr.persist(run3);

    const sessions = await mgr.list();
    expect(sessions).toHaveLength(3);
    expect(sessions[0].run_id).toBe("run-3");
    expect(sessions[1].run_id).toBe("run-2");
    expect(sessions[2].run_id).toBe("run-1");
  });

  it("lists empty when no sessions exist", async () => {
    const mgr = new SessionManager(testDir);
    const sessions = await mgr.list();
    expect(sessions).toEqual([]);
  });

  it("archives a session", async () => {
    const mgr = new SessionManager(testDir);
    const run = makeRun({ run_id: "run-archive" });

    await mgr.persist(run);
    expect(await mgr.get("run-archive")).not.toBeNull();

    const archived = await mgr.archive("run-archive");
    expect(archived).toBe(true);

    // No longer in active list
    expect(await mgr.get("run-archive")).toBeNull();
    const sessions = await mgr.list();
    expect(sessions).toHaveLength(0);

    // File exists in archive/
    const archivePath = path.join(testDir, "archive", "run-archive.json");
    const raw = await fs.readFile(archivePath, "utf-8");
    const meta = JSON.parse(raw) as RunSessionMetadata;
    expect(meta.run_id).toBe("run-archive");
  });

  it("returns false when archiving nonexistent session", async () => {
    const mgr = new SessionManager(testDir);
    const result = await mgr.archive("nonexistent");
    expect(result).toBe(false);
  });

  it("removes a session", async () => {
    const mgr = new SessionManager(testDir);
    const run = makeRun({ run_id: "run-remove" });

    await mgr.persist(run);
    expect(await mgr.get("run-remove")).not.toBeNull();

    const removed = await mgr.remove("run-remove");
    expect(removed).toBe(true);
    expect(await mgr.get("run-remove")).toBeNull();
  });

  it("returns false when removing nonexistent session", async () => {
    const mgr = new SessionManager(testDir);
    const result = await mgr.remove("nonexistent");
    expect(result).toBe(false);
  });

  it("updateStatus changes only the status field", async () => {
    const mgr = new SessionManager(testDir);
    const run = makeRun({ run_id: "run-cancel", status: "executing" });

    await mgr.persist(run);
    const updated = await mgr.updateStatus("run-cancel", "cancelled");
    expect(updated).toBe(true);

    const session = await mgr.get("run-cancel");
    expect(session!.status).toBe("cancelled");
    expect(session!.ticket_id).toBe("TEST-1"); // unchanged
  });

  it("updateStatus returns false for nonexistent session", async () => {
    const mgr = new SessionManager(testDir);
    const result = await mgr.updateStatus("nonexistent", "cancelled");
    expect(result).toBe(false);
  });

  it("handles completed_at as Date", async () => {
    const mgr = new SessionManager(testDir);
    const run = makeRun({
      run_id: "run-completed",
      status: "completed",
      completed_at: new Date("2026-02-27T12:00:00Z"),
    });

    await mgr.persist(run);
    const session = await mgr.get("run-completed");
    expect(session!.completed_at).toBe("2026-02-27T12:00:00.000Z");
  });

  it("handles pr_url and error", async () => {
    const mgr = new SessionManager(testDir);
    const run = makeRun({
      run_id: "run-pr",
      pr_url: "https://github.com/test/repo/pull/42",
      error: null,
    });

    await mgr.persist(run);
    const session = await mgr.get("run-pr");
    expect(session!.pr_url).toBe("https://github.com/test/repo/pull/42");
    expect(session!.error).toBeNull();
  });

  it("reconciles stale executing status to failed from task.failed event", async () => {
    const mgr = new SessionManager(testDir);
    const workspace = path.join(testDir, "ws-run-reconcile");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".events.jsonl"),
      [
        JSON.stringify({ event_type: "task.created", timestamp: "2026-02-27T10:00:00Z" }),
        JSON.stringify({ event_type: "task.failed", timestamp: "2026-02-27T10:05:00Z" }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const run = makeRun({ run_id: "run-reconcile", status: "executing" });
    await mgr.persist(run, { workspace_path: workspace });

    const session = await mgr.get("run-reconcile");
    expect(session!.status).toBe("failed");
    expect(session!.updated_at).toBe("2026-02-27T10:05:00Z");
  });

  it("reconciles orphaned step.failed to failed when task.failed is missing", async () => {
    const mgr = new SessionManager(testDir);
    const workspace = path.join(testDir, "ws-run-orphan");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".events.jsonl"),
      [
        JSON.stringify({ event_type: "task.created", timestamp: "2026-02-27T10:00:00Z" }),
        JSON.stringify({ event_type: "step.failed", timestamp: "2026-02-27T10:03:00Z", data: { step: 2 } }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const run = makeRun({ run_id: "run-orphan", status: "executing" });
    await mgr.persist(run, { workspace_path: workspace });

    const session = await mgr.get("run-orphan");
    expect(session!.status).toBe("failed");
  });

  it("reconciles human_gate.rejected to failed when task.failed is missing", async () => {
    const mgr = new SessionManager(testDir);
    const workspace = path.join(testDir, "ws-run-rejected");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(
      path.join(workspace, ".events.jsonl"),
      [
        JSON.stringify({ event_type: "task.created", timestamp: "2026-02-27T10:00:00Z" }),
        JSON.stringify({ event_type: "human_gate.requested", timestamp: "2026-02-27T10:03:00Z" }),
        JSON.stringify({ event_type: "human_gate.rejected", timestamp: "2026-02-27T10:04:00Z" }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const run = makeRun({ run_id: "run-rejected", status: "executing" });
    await mgr.persist(run, { workspace_path: workspace });

    const session = await mgr.get("run-rejected");
    expect(session!.status).toBe("failed");
    expect(session!.updated_at).toBe("2026-02-27T10:04:00Z");
  });
});

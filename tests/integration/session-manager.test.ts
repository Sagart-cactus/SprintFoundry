/**
 * Integration tests: Session Manager
 * Persist/read/list/archive sessions with real filesystem.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SessionManager } from "../../src/service/session-manager.js";
import { makeTaskRun, makeCompletedRun, makeFailedRun, makeWaitingRun } from "../helpers/session-factory.js";
import { mkdtempSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";

let tmpDir: string;
let manager: SessionManager;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sf-session-integ-"));
  manager = new SessionManager(tmpDir);
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("Session Manager — persist and read", () => {
  it("persists a running TaskRun and reads it back", async () => {
    const run = makeTaskRun({ run_id: "run-persist-1", status: "executing" });
    await manager.persist(run, { workspace_path: "/tmp/ws", branch: "feat/test" });

    const session = await manager.get("run-persist-1");
    expect(session).not.toBeNull();
    expect(session!.run_id).toBe("run-persist-1");
    expect(session!.status).toBe("executing");
    expect(session!.workspace_path).toBe("/tmp/ws");
    expect(session!.branch).toBe("feat/test");
    expect(session!.ticket_id).toBe("TEST-123");
    expect(session!.total_tokens).toBe(run.total_tokens_used);
  });

  it("persists a completed run with PR URL", async () => {
    const run = makeCompletedRun({ run_id: "run-completed-1" });
    await manager.persist(run);

    const session = await manager.get("run-completed-1");
    expect(session!.status).toBe("completed");
    expect(session!.pr_url).toBe("https://github.com/test/repo/pull/42");
    expect(session!.completed_at).not.toBeNull();
  });

  it("persists a failed run with error", async () => {
    const run = makeFailedRun({ run_id: "run-failed-1" });
    await manager.persist(run);

    const session = await manager.get("run-failed-1");
    expect(session!.status).toBe("failed");
    expect(session!.error).toContain("failed");
  });

  it("returns null for non-existent run", async () => {
    const session = await manager.get("nonexistent");
    expect(session).toBeNull();
  });

  it("overwrites session on re-persist", async () => {
    const run = makeTaskRun({ run_id: "run-overwrite", status: "executing" });
    await manager.persist(run);

    run.status = "completed";
    run.pr_url = "https://github.com/test/repo/pull/99";
    await manager.persist(run);

    const session = await manager.get("run-overwrite");
    expect(session!.status).toBe("completed");
    expect(session!.pr_url).toBe("https://github.com/test/repo/pull/99");
  });
});

describe("Session Manager — flat-file format", () => {
  it("stores session as formatted JSON file", async () => {
    const run = makeTaskRun({ run_id: "run-format-1" });
    await manager.persist(run);

    const filePath = path.join(tmpDir, "run-format-1.json");
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);

    expect(parsed).toHaveProperty("run_id", "run-format-1");
    expect(parsed).toHaveProperty("project_id");
    expect(parsed).toHaveProperty("ticket_id");
    expect(parsed).toHaveProperty("status");
    expect(parsed).toHaveProperty("created_at");
    expect(parsed).toHaveProperty("updated_at");
    // Verify it's indented (formatted JSON)
    expect(raw).toContain("\n ");
  });
});

describe("Session Manager — list", () => {
  it("lists all active sessions sorted by updated_at descending", async () => {
    const run1 = makeTaskRun({ run_id: "run-list-a", status: "completed" });
    const run2 = makeTaskRun({ run_id: "run-list-b", status: "executing" });
    const run3 = makeTaskRun({ run_id: "run-list-c", status: "failed" });

    await manager.persist(run1);
    // Small delays to get different updated_at timestamps
    await new Promise((r) => setTimeout(r, 10));
    await manager.persist(run2);
    await new Promise((r) => setTimeout(r, 10));
    await manager.persist(run3);

    const sessions = await manager.list();
    expect(sessions).toHaveLength(3);
    // Most recently updated first
    expect(sessions[0].run_id).toBe("run-list-c");
    expect(sessions[1].run_id).toBe("run-list-b");
    expect(sessions[2].run_id).toBe("run-list-a");
  });

  it("returns empty list when no sessions exist", async () => {
    const sessions = await manager.list();
    expect(sessions).toHaveLength(0);
  });

  it("skips corrupt session files gracefully", async () => {
    const run = makeTaskRun({ run_id: "run-good" });
    await manager.persist(run);

    // Write a corrupt file
    await fs.writeFile(path.join(tmpDir, "run-corrupt.json"), "not valid json{", "utf-8");

    const sessions = await manager.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].run_id).toBe("run-good");
  });
});

describe("Session Manager — archive", () => {
  it("moves session to archive directory", async () => {
    const run = makeCompletedRun({ run_id: "run-archive-1" });
    await manager.persist(run);

    const archived = await manager.archive("run-archive-1");
    expect(archived).toBe(true);

    // No longer in active list
    const session = await manager.get("run-archive-1");
    expect(session).toBeNull();

    // Exists in archive
    const archivePath = path.join(tmpDir, "archive", "run-archive-1.json");
    const raw = await fs.readFile(archivePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.run_id).toBe("run-archive-1");
  });

  it("returns false when archiving non-existent run", async () => {
    const archived = await manager.archive("nonexistent");
    expect(archived).toBe(false);
  });

  it("archived sessions are excluded from list", async () => {
    const run1 = makeTaskRun({ run_id: "run-arch-a" });
    const run2 = makeTaskRun({ run_id: "run-arch-b" });
    await manager.persist(run1);
    await manager.persist(run2);

    await manager.archive("run-arch-a");

    const sessions = await manager.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].run_id).toBe("run-arch-b");
  });
});

describe("Session Manager — crash recovery", () => {
  it("re-reads sessions from disk after re-creation", async () => {
    const run = makeTaskRun({ run_id: "run-crash-1", status: "executing" });
    await manager.persist(run);

    // Simulate crash: create a new manager pointed at the same dir
    const recovered = new SessionManager(tmpDir);
    const session = await recovered.get("run-crash-1");
    expect(session).not.toBeNull();
    expect(session!.run_id).toBe("run-crash-1");
    expect(session!.status).toBe("executing");
  });

  it("list works on a fresh manager over existing session files", async () => {
    const run1 = makeTaskRun({ run_id: "run-r1" });
    const run2 = makeTaskRun({ run_id: "run-r2" });
    await manager.persist(run1);
    await manager.persist(run2);

    const recovered = new SessionManager(tmpDir);
    const sessions = await recovered.list();
    expect(sessions).toHaveLength(2);
  });
});

describe("Session Manager — status update", () => {
  it("updates only the status field", async () => {
    const run = makeTaskRun({ run_id: "run-status-1", status: "executing" });
    await manager.persist(run);

    const updated = await manager.updateStatus("run-status-1", "cancelled");
    expect(updated).toBe(true);

    const session = await manager.get("run-status-1");
    expect(session!.status).toBe("cancelled");
    expect(session!.ticket_id).toBe("TEST-123"); // other fields unchanged
  });

  it("returns false for non-existent run", async () => {
    const updated = await manager.updateStatus("nonexistent", "cancelled");
    expect(updated).toBe(false);
  });
});

describe("Session Manager — remove", () => {
  it("deletes a session file", async () => {
    const run = makeTaskRun({ run_id: "run-del-1" });
    await manager.persist(run);

    const removed = await manager.remove("run-del-1");
    expect(removed).toBe(true);
    expect(await manager.get("run-del-1")).toBeNull();
  });

  it("returns false for non-existent run", async () => {
    const removed = await manager.remove("nonexistent");
    expect(removed).toBe(false);
  });
});

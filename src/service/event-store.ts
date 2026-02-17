// ============================================================
// SprintFoundry — Event Store
// Stores TaskEvent records for audit logging and replay
// Persists to JSONL files (global log + per-run workspace log)
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import type { TaskEvent } from "../shared/types.js";

export class EventStore {
  private events: TaskEvent[] = [];
  private globalLogPath: string | null = null;
  private runLogPath: string | null = null;
  private initialized = false;
  private pendingBuffer: TaskEvent[] = [];

  constructor(private eventsDir?: string) {}

  /**
   * Initialize write targets. Called once the workspace path is known.
   * - Global log: <eventsDir>/events.jsonl (all runs)
   * - Per-run log: <workspacePath>/.events.jsonl (this run only)
   */
  async initialize(workspacePath?: string): Promise<void> {
    if (this.initialized) return;

    // Global log directory
    if (this.eventsDir) {
      await fs.mkdir(this.eventsDir, { recursive: true });
      this.globalLogPath = path.join(this.eventsDir, "events.jsonl");
    }

    // Per-run log in workspace
    if (workspacePath) {
      this.runLogPath = path.join(workspacePath, ".events.jsonl");
    }

    this.initialized = true;

    // Flush any events that were buffered before initialization
    if (this.pendingBuffer.length > 0) {
      const buffered = this.pendingBuffer;
      this.pendingBuffer = [];
      for (const event of buffered) {
        await this.persistEvent(event);
      }
    }
  }

  async store(event: TaskEvent): Promise<void> {
    // In-memory
    this.events.push(event);

    // Console log
    console.log(
      `[event] ${event.event_type} | run=${event.run_id} | ${JSON.stringify(event.data)}`
    );

    // Buffer events until initialized so no audit trail is lost
    if (!this.initialized) {
      this.pendingBuffer.push(event);
      return;
    }

    await this.persistEvent(event);
  }

  private async persistEvent(event: TaskEvent): Promise<void> {
    const line = JSON.stringify(event) + "\n";

    const writes: Promise<void>[] = [];
    if (this.globalLogPath) {
      writes.push(fs.appendFile(this.globalLogPath, line, "utf-8"));
    }
    if (this.runLogPath) {
      writes.push(fs.appendFile(this.runLogPath, line, "utf-8"));
    }

    if (writes.length > 0) {
      await Promise.all(writes);
    }
  }

  async getByRunId(runId: string): Promise<TaskEvent[]> {
    return this.events.filter((e) => e.run_id === runId);
  }

  async getByType(eventType: TaskEvent["event_type"]): Promise<TaskEvent[]> {
    return this.events.filter((e) => e.event_type === eventType);
  }

  async getAll(): Promise<TaskEvent[]> {
    return [...this.events];
  }

  /**
   * Load events from a JSONL file (for replay/debugging).
   */
  async loadFromFile(filePath: string): Promise<TaskEvent[]> {
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const loaded = lines.map((line) => JSON.parse(line) as TaskEvent);
    this.events.push(...loaded);
    return loaded;
  }

  /**
   * Flush any pending writes. Call at end of run.
   */
  async close(): Promise<void> {
    // No buffered writes to flush with appendFile, but this is the
    // hook for future implementations (e.g., write streams, Postgres).
  }
}

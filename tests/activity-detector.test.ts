import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import {
  findLatestSessionFile,
  parseJsonlFileTail,
  getActivityState,
  getSessionCost,
  toClaudeProjectPath,
} from "../src/service/activity-detector.js";

// ---------- Helpers ----------

let testDir: string;

async function writeJsonl(dir: string, filename: string, lines: object[]): Promise<string> {
  const filePath = path.join(dir, filename);
  const content = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

// ---------- Tests ----------

describe("toClaudeProjectPath", () => {
  it("returns .claude path within workspace", () => {
    const result = toClaudeProjectPath("/tmp/workspace");
    expect(result).toBe("/tmp/workspace/.claude");
  });
});

describe("findLatestSessionFile", () => {
  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sf-activity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("returns null for empty directory", async () => {
    const result = await findLatestSessionFile(testDir);
    expect(result).toBeNull();
  });

  it("returns null for nonexistent directory", async () => {
    const result = await findLatestSessionFile("/nonexistent/path");
    expect(result).toBeNull();
  });

  it("returns the only JSONL file", async () => {
    await writeJsonl(testDir, "session-1.jsonl", [{ type: "start" }]);
    const result = await findLatestSessionFile(testDir);
    expect(result).toBe(path.join(testDir, "session-1.jsonl"));
  });

  it("returns the most recently modified JSONL file", async () => {
    await writeJsonl(testDir, "session-old.jsonl", [{ type: "start" }]);
    // Ensure different mtime
    await new Promise((r) => setTimeout(r, 50));
    await writeJsonl(testDir, "session-new.jsonl", [{ type: "start" }]);

    const result = await findLatestSessionFile(testDir);
    expect(result).toBe(path.join(testDir, "session-new.jsonl"));
  });

  it("ignores non-JSONL files", async () => {
    await fs.writeFile(path.join(testDir, "notes.txt"), "hello", "utf-8");
    await writeJsonl(testDir, "session.jsonl", [{ type: "start" }]);

    const result = await findLatestSessionFile(testDir);
    expect(result).toBe(path.join(testDir, "session.jsonl"));
  });
});

describe("parseJsonlFileTail", () => {
  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sf-jsonl-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("parses a simple JSONL file", async () => {
    const filePath = await writeJsonl(testDir, "test.jsonl", [
      { type: "start", timestamp: "2026-02-27T10:00:00Z" },
      { type: "tool_use", timestamp: "2026-02-27T10:01:00Z" },
    ]);

    const lines = await parseJsonlFileTail(filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe("start");
    expect(lines[1].type).toBe("tool_use");
  });

  it("returns empty array for nonexistent file", async () => {
    const lines = await parseJsonlFileTail("/nonexistent/file.jsonl");
    expect(lines).toEqual([]);
  });

  it("skips malformed lines", async () => {
    const content = '{"type":"good"}\nnot json\n{"type":"also_good"}\n';
    const filePath = path.join(testDir, "mixed.jsonl");
    await fs.writeFile(filePath, content, "utf-8");

    const lines = await parseJsonlFileTail(filePath);
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe("good");
    expect(lines[1].type).toBe("also_good");
  });

  it("reads only the tail when file is large", async () => {
    // Write a file larger than maxBytes
    const largeLine = JSON.stringify({ type: "filler", data: "x".repeat(1000) });
    const lines = Array(100).fill(largeLine);
    lines.push(JSON.stringify({ type: "last", timestamp: "2026-02-27T10:00:00Z" }));
    const filePath = path.join(testDir, "large.jsonl");
    await fs.writeFile(filePath, lines.join("\n") + "\n", "utf-8");

    // Only read last 4KB
    const parsed = await parseJsonlFileTail(filePath, 4096);
    // Should have the last line
    expect(parsed.some((l) => l.type === "last")).toBe(true);
    // Should NOT have all 100 filler lines
    expect(parsed.length).toBeLessThan(100);
  });
});

describe("getActivityState", () => {
  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sf-activity-state-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    // Create the .claude subdirectory (where session files live)
    await fs.mkdir(path.join(testDir, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("returns unknown when no session files exist", async () => {
    const result = await getActivityState(testDir);
    expect(result.state).toBe("unknown");
    expect(result.detail).toContain("No session file");
  });

  it("falls back to codex runtime log when Claude session file is missing", async () => {
    const now = new Date().toISOString();
    await fs.writeFile(
      path.join(testDir, ".codex-runtime.stdout.log"),
      JSON.stringify({ type: "turn.completed", timestamp: now }) + "\n",
      "utf-8"
    );

    const result = await getActivityState(testDir);
    expect(result.state).toBe("exited");
    expect(result.detail).toContain("Runtime log indicates completion");
  });

  it("marks stale runtime log as blocked when no fresh updates exist", async () => {
    const logPath = path.join(testDir, ".codex-runtime.stdout.log");
    await fs.writeFile(logPath, JSON.stringify({ type: "agent_message" }) + "\n", "utf-8");
    const old = new Date(Date.now() - 180_000);
    await fs.utimes(logPath, old, old);

    const result = await getActivityState(testDir, 30_000);
    expect(result.state).toBe("blocked");
  });

  it("returns exited when last event is exit", async () => {
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "start", timestamp: "2026-02-27T10:00:00Z" },
      { type: "exit", timestamp: "2026-02-27T10:05:00Z" },
    ]);

    const result = await getActivityState(testDir);
    expect(result.state).toBe("exited");
    expect(result.last_event_at).toBe("2026-02-27T10:05:00Z");
  });

  it("returns exited when stop_reason is end_turn", async () => {
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "message", timestamp: "2026-02-27T10:00:00Z", message: { role: "assistant", stop_reason: "end_turn" } },
    ]);

    const result = await getActivityState(testDir);
    expect(result.state).toBe("exited");
  });

  it("returns active for recent tool_use events", async () => {
    const now = new Date().toISOString();
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "start", timestamp: "2026-02-27T10:00:00Z" },
      { type: "tool_use", timestamp: now },
    ]);

    const result = await getActivityState(testDir);
    expect(result.state).toBe("active");
  });

  it("returns active for very recent events", async () => {
    const now = new Date().toISOString();
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "text", timestamp: now },
    ]);

    const result = await getActivityState(testDir, 30_000);
    expect(result.state).toBe("active");
  });

  it("returns idle for moderately stale events", async () => {
    const staleTime = new Date(Date.now() - 45_000).toISOString(); // 45s ago
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "text", timestamp: staleTime },
    ]);

    const result = await getActivityState(testDir, 30_000);
    expect(result.state).toBe("idle");
  });

  it("returns blocked for very stale events", async () => {
    const veryStale = new Date(Date.now() - 120_000).toISOString(); // 2 min ago
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "text", timestamp: veryStale },
    ]);

    const result = await getActivityState(testDir, 30_000);
    expect(result.state).toBe("blocked");
  });

  it("returns unknown when no timestamped events exist", async () => {
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "config" },
      { type: "init" },
    ]);

    const result = await getActivityState(testDir);
    expect(result.state).toBe("unknown");
    expect(result.detail).toContain("No timestamped");
  });
});

describe("getSessionCost", () => {
  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `sf-cost-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(path.join(testDir, ".claude"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("returns null when no session files exist", async () => {
    const result = await getSessionCost(testDir);
    expect(result).toBeNull();
  });

  it("returns null when no billing data exists", async () => {
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "start", timestamp: "2026-02-27T10:00:00Z" },
    ]);

    const result = await getSessionCost(testDir);
    expect(result).toBeNull();
  });

  it("accumulates usage tokens", async () => {
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "message", usage: { input_tokens: 1000, output_tokens: 500 } },
      { type: "message", usage: { input_tokens: 2000, output_tokens: 300 } },
    ]);

    const result = await getSessionCost(testDir);
    expect(result).not.toBeNull();
    expect(result!.total_tokens).toBe(3800);
  });

  it("accumulates billing cost_usd", async () => {
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "message", billing: { cost_usd: 0.05 } },
      { type: "message", billing: { cost_usd: 0.10 } },
    ]);

    const result = await getSessionCost(testDir);
    expect(result).not.toBeNull();
    expect(result!.total_cost_usd).toBeCloseTo(0.15);
  });

  it("accumulates costUsd format", async () => {
    await writeJsonl(path.join(testDir, ".claude"), "session.jsonl", [
      { type: "message", costUsd: 0.03 },
      { type: "message", costUsd: 0.07 },
    ]);

    const result = await getSessionCost(testDir);
    expect(result).not.toBeNull();
    expect(result!.total_cost_usd).toBeCloseTo(0.10);
  });
});

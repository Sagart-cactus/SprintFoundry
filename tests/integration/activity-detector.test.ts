/**
 * Integration tests: Activity Detector
 * JSONL parsing, activity state detection, cost extraction.
 * Uses real filesystem with temporary directories.
 */

import { describe, it, expect, afterEach } from "vitest";
import {
  getActivityState,
  getSessionCost,
  findLatestSessionFile,
  parseJsonlFileTail,
  toClaudeProjectPath,
} from "../../src/service/activity-detector.js";
import { createFixtureWorkspace, type FixtureWorkspace } from "../helpers/fixture-workspace.js";

let workspace: FixtureWorkspace;

afterEach(() => {
  workspace?.cleanup();
});

describe("Activity Detector — JSONL parsing", () => {
  it("parses valid JSONL lines from a file", async () => {
    workspace = createFixtureWorkspace();
    const lines = [
      { type: "message", timestamp: new Date().toISOString(), message: { role: "assistant" } },
      { type: "tool_use", timestamp: new Date().toISOString(), message: { role: "assistant" } },
    ];
    workspace.writeClaudeSession(lines);

    const sessionFile = await findLatestSessionFile(toClaudeProjectPath(workspace.path));
    expect(sessionFile).not.toBeNull();

    const parsed = await parseJsonlFileTail(sessionFile!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("message");
    expect(parsed[1].type).toBe("tool_use");
  });

  it("skips malformed JSONL lines", async () => {
    workspace = createFixtureWorkspace();
    const claudeDir = `${workspace.path}/.claude`;
    const { writeFileSync, mkdirSync } = await import("fs");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      `${claudeDir}/session.jsonl`,
      `${JSON.stringify({ type: "a" })}\nnot valid json\n${JSON.stringify({ type: "b" })}\n`,
      "utf-8"
    );

    const parsed = await parseJsonlFileTail(`${claudeDir}/session.jsonl`);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe("a");
    expect(parsed[1].type).toBe("b");
  });

  it("returns empty array for non-existent file", async () => {
    const parsed = await parseJsonlFileTail("/tmp/nonexistent-session.jsonl");
    expect(parsed).toEqual([]);
  });

  it("handles tail reading for large files", async () => {
    workspace = createFixtureWorkspace();
    // Write a large JSONL file
    const lines = Array.from({ length: 500 }, (_, i) => ({
      type: "message",
      timestamp: new Date(Date.now() + i * 100).toISOString(),
      index: i,
    }));
    workspace.writeClaudeSession(lines);

    const sessionFile = await findLatestSessionFile(toClaudeProjectPath(workspace.path));
    // Read only the last ~4KB
    const parsed = await parseJsonlFileTail(sessionFile!, 4096);
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(500);
    // Last parsed entry should be the latest
    expect(parsed[parsed.length - 1].index).toBe(499);
  });
});

describe("Activity Detector — activity state detection", () => {
  it("returns 'unknown' when no session file exists", async () => {
    workspace = createFixtureWorkspace();
    const result = await getActivityState(workspace.path);
    expect(result.state).toBe("unknown");
    expect(result.detail).toContain("No session file");
  });

  it("detects 'active' state for recent events", async () => {
    workspace = createFixtureWorkspace();
    const now = new Date().toISOString();
    workspace.writeClaudeSession([
      { type: "message", timestamp: now, message: { role: "assistant" } },
    ]);

    const result = await getActivityState(workspace.path);
    expect(result.state).toBe("active");
    expect(result.elapsed_ms).not.toBeNull();
    expect(result.elapsed_ms!).toBeLessThan(5000);
  });

  it("detects 'exited' state for exit events", async () => {
    workspace = createFixtureWorkspace();
    workspace.writeClaudeSession([
      { type: "message", timestamp: new Date(Date.now() - 1000).toISOString() },
      { type: "exit", timestamp: new Date().toISOString() },
    ]);

    const result = await getActivityState(workspace.path);
    expect(result.state).toBe("exited");
  });

  it("detects 'exited' state for end_turn stop_reason", async () => {
    workspace = createFixtureWorkspace();
    workspace.writeClaudeSession([
      { type: "message", timestamp: new Date().toISOString(), message: { stop_reason: "end_turn" } },
    ]);

    const result = await getActivityState(workspace.path);
    expect(result.state).toBe("exited");
  });

  it("detects 'idle' state for stale events (within 3x threshold)", async () => {
    workspace = createFixtureWorkspace();
    // 45 seconds ago (within 3x 30s threshold)
    const staleTimestamp = new Date(Date.now() - 45_000).toISOString();
    workspace.writeClaudeSession([
      { type: "message", timestamp: staleTimestamp },
    ]);

    const result = await getActivityState(workspace.path, 30_000);
    expect(result.state).toBe("idle");
  });

  it("detects 'blocked' state for very stale events (beyond 3x threshold)", async () => {
    workspace = createFixtureWorkspace();
    // 2 minutes ago (beyond 3x 30s threshold)
    const veryStaleTimestamp = new Date(Date.now() - 120_000).toISOString();
    workspace.writeClaudeSession([
      { type: "message", timestamp: veryStaleTimestamp },
    ]);

    const result = await getActivityState(workspace.path, 30_000);
    expect(result.state).toBe("blocked");
  });

  it("detects 'active' for recent tool_use events", async () => {
    workspace = createFixtureWorkspace();
    workspace.writeClaudeSession([
      { type: "tool_use", timestamp: new Date().toISOString() },
    ]);

    const result = await getActivityState(workspace.path);
    expect(result.state).toBe("active");
    expect(result.detail).toContain("Processing");
  });

  it("detects 'blocked' for old tool_use with no response", async () => {
    workspace = createFixtureWorkspace();
    const oldTimestamp = new Date(Date.now() - 120_000).toISOString();
    workspace.writeClaudeSession([
      { type: "tool_use", timestamp: oldTimestamp },
    ]);

    const result = await getActivityState(workspace.path, 30_000);
    expect(result.state).toBe("blocked");
    expect(result.detail).toContain("Tool call with no response");
  });

  it("returns 'unknown' when no timestamped events", async () => {
    workspace = createFixtureWorkspace();
    workspace.writeClaudeSession([
      { type: "message" }, // no timestamp
    ]);

    const result = await getActivityState(workspace.path);
    expect(result.state).toBe("unknown");
    expect(result.detail).toContain("No timestamped events");
  });
});

describe("Activity Detector — cost extraction", () => {
  it("extracts cost and tokens from session JSONL", async () => {
    workspace = createFixtureWorkspace();
    workspace.writeClaudeSession([
      {
        type: "message",
        timestamp: new Date().toISOString(),
        usage: { input_tokens: 1000, output_tokens: 500 },
        billing: { cost_usd: 0.05 },
      },
      {
        type: "message",
        timestamp: new Date().toISOString(),
        usage: { input_tokens: 2000, output_tokens: 1000 },
        billing: { cost_usd: 0.10 },
      },
    ]);

    const cost = await getSessionCost(workspace.path);
    expect(cost).not.toBeNull();
    expect(cost!.total_tokens).toBe(4500); // 1000+500+2000+1000
    expect(cost!.total_cost_usd).toBeCloseTo(0.15);
  });

  it("handles costUsd format (alternate field name)", async () => {
    workspace = createFixtureWorkspace();
    workspace.writeClaudeSession([
      {
        type: "message",
        timestamp: new Date().toISOString(),
        costUsd: 0.25,
        usage: { input_tokens: 5000, output_tokens: 2000 },
      },
    ]);

    const cost = await getSessionCost(workspace.path);
    expect(cost).not.toBeNull();
    expect(cost!.total_cost_usd).toBeCloseTo(0.25);
    expect(cost!.total_tokens).toBe(7000);
  });

  it("returns null when no cost data found", async () => {
    workspace = createFixtureWorkspace();
    workspace.writeClaudeSession([
      { type: "message", timestamp: new Date().toISOString() },
    ]);

    const cost = await getSessionCost(workspace.path);
    expect(cost).toBeNull();
  });

  it("returns null when no session file exists", async () => {
    workspace = createFixtureWorkspace();
    const cost = await getSessionCost(workspace.path);
    expect(cost).toBeNull();
  });
});

describe("Activity Detector — findLatestSessionFile", () => {
  it("finds the most recently modified JSONL file", async () => {
    workspace = createFixtureWorkspace();
    const { writeFileSync, mkdirSync, utimesSync } = await import("fs");
    const claudeDir = `${workspace.path}/.claude`;
    mkdirSync(claudeDir, { recursive: true });

    writeFileSync(`${claudeDir}/old-session.jsonl`, '{"type":"a"}\n');
    writeFileSync(`${claudeDir}/new-session.jsonl`, '{"type":"b"}\n');

    // Make "old" actually older
    const past = new Date(Date.now() - 60_000);
    utimesSync(`${claudeDir}/old-session.jsonl`, past, past);

    const latest = await findLatestSessionFile(claudeDir);
    expect(latest).toContain("new-session.jsonl");
  });

  it("returns null for empty directory", async () => {
    workspace = createFixtureWorkspace();
    const { mkdirSync } = await import("fs");
    const claudeDir = `${workspace.path}/.claude`;
    mkdirSync(claudeDir, { recursive: true });

    const latest = await findLatestSessionFile(claudeDir);
    expect(latest).toBeNull();
  });

  it("returns null for non-existent directory", async () => {
    const latest = await findLatestSessionFile("/tmp/nonexistent-dir-12345");
    expect(latest).toBeNull();
  });
});

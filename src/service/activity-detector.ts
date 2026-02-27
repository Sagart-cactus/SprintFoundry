// ============================================================
// SprintFoundry — Activity Detector
// Reads Claude Code JSONL session files to determine agent state.
// Inspired by agent-orchestrator's activity detection approach.
// ============================================================

import * as fs from "fs/promises";
import * as path from "path";
import type { ActivityState, ActivityDetection } from "../shared/types.js";

// Claude Code stores session JSONL in ~/.claude/projects/<project-hash>/
const CLAUDE_DIR = ".claude";

interface JsonlLine {
  type?: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: unknown;
    stop_reason?: string;
  };
  [key: string]: unknown;
}

/**
 * Convert a workspace path to the Claude Code project path
 * where JSONL session files are stored.
 */
export function toClaudeProjectPath(workspacePath: string): string {
  // Claude Code hashes the absolute workspace path for project identification.
  // The actual path format is: ~/.claude/projects/<hash>/
  // We look for the .claude directory in the workspace first (local config),
  // then fall back to the user-global location.
  return path.join(workspacePath, CLAUDE_DIR);
}

/**
 * Find the most recently modified JSONL file in a directory.
 */
export async function findLatestSessionFile(dir: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(dir);
    const jsonlFiles = entries.filter((e) => e.endsWith(".jsonl"));
    if (jsonlFiles.length === 0) return null;

    let latest: { file: string; mtime: number } | null = null;
    for (const file of jsonlFiles) {
      const fullPath = path.join(dir, file);
      const stat = await fs.stat(fullPath);
      if (!latest || stat.mtimeMs > latest.mtime) {
        latest = { file: fullPath, mtime: stat.mtimeMs };
      }
    }
    return latest?.file ?? null;
  } catch {
    return null;
  }
}

/**
 * Read the tail of a JSONL file (last N bytes) and parse lines.
 * More efficient than reading the entire file for large session logs.
 */
export async function parseJsonlFileTail(
  filePath: string,
  maxBytes = 32_768
): Promise<JsonlLine[]> {
  try {
    const stat = await fs.stat(filePath);
    const fileSize = stat.size;
    const readSize = Math.min(maxBytes, fileSize);
    const offset = Math.max(0, fileSize - readSize);

    const handle = await fs.open(filePath, "r");
    try {
      const buffer = Buffer.alloc(readSize);
      await handle.read(buffer, 0, readSize, offset);
      const text = buffer.toString("utf-8");

      // If we read from the middle of the file, skip the first partial line
      const lines = text.split("\n");
      if (offset > 0) {
        lines.shift();
      }

      const parsed: JsonlLine[] = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          parsed.push(JSON.parse(trimmed) as JsonlLine);
        } catch {
          // Skip malformed lines
        }
      }
      return parsed;
    } finally {
      await handle.close();
    }
  } catch {
    return [];
  }
}

/**
 * Classify agent activity based on the last few JSONL events.
 */
function classifyActivity(
  lines: JsonlLine[],
  thresholdMs: number
): ActivityDetection {
  if (lines.length === 0) {
    return { state: "unknown", last_event_at: null, elapsed_ms: null, detail: "No JSONL data" };
  }

  // Find the most recent line with a timestamp
  let lastTimestamp: string | null = null;
  let lastLine: JsonlLine | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].timestamp) {
      lastTimestamp = lines[i].timestamp!;
      lastLine = lines[i];
      break;
    }
  }

  if (!lastTimestamp || !lastLine) {
    return { state: "unknown", last_event_at: null, elapsed_ms: null, detail: "No timestamped events" };
  }

  const elapsed = Date.now() - new Date(lastTimestamp).getTime();

  // Check for exit signals
  const lastType = lastLine.type;
  if (lastType === "exit" || lastType === "result" || lastLine.message?.stop_reason === "end_turn") {
    return { state: "exited", last_event_at: lastTimestamp, elapsed_ms: elapsed, detail: `Last event: ${lastType}` };
  }

  // Check if the agent appears to be waiting for input
  if (lastType === "tool_use" || lastType === "tool_result") {
    if (elapsed > thresholdMs * 2) {
      return { state: "blocked", last_event_at: lastTimestamp, elapsed_ms: elapsed, detail: "Tool call with no response" };
    }
    return { state: "active", last_event_at: lastTimestamp, elapsed_ms: elapsed, detail: `Processing: ${lastType}` };
  }

  // Recent activity means active
  if (elapsed < thresholdMs) {
    return { state: "active", last_event_at: lastTimestamp, elapsed_ms: elapsed, detail: `Last event: ${lastType ?? "unknown"}` };
  }

  // Stale but not exited
  if (elapsed < thresholdMs * 3) {
    return { state: "idle", last_event_at: lastTimestamp, elapsed_ms: elapsed, detail: `Idle for ${Math.round(elapsed / 1000)}s` };
  }

  return { state: "blocked", last_event_at: lastTimestamp, elapsed_ms: elapsed, detail: `No activity for ${Math.round(elapsed / 1000)}s` };
}

/**
 * Detect the activity state of an agent running in a workspace.
 *
 * @param workspacePath - The agent's workspace directory
 * @param thresholdMs - How many ms of inactivity before marking idle (default 30s)
 */
export async function getActivityState(
  workspacePath: string,
  thresholdMs = 30_000
): Promise<ActivityDetection> {
  const claudeDir = toClaudeProjectPath(workspacePath);
  const sessionFile = await findLatestSessionFile(claudeDir);

  if (!sessionFile) {
    return { state: "unknown", last_event_at: null, elapsed_ms: null, detail: "No session file found" };
  }

  const lines = await parseJsonlFileTail(sessionFile);
  return classifyActivity(lines, thresholdMs);
}

/**
 * Extract cost/usage info from a Claude Code session JSONL.
 * Returns null if no billing data found.
 */
export async function getSessionCost(
  workspacePath: string
): Promise<{ total_cost_usd: number; total_tokens: number } | null> {
  const claudeDir = toClaudeProjectPath(workspacePath);
  const sessionFile = await findLatestSessionFile(claudeDir);
  if (!sessionFile) return null;

  const lines = await parseJsonlFileTail(sessionFile, 65_536);

  let totalCost = 0;
  let totalTokens = 0;
  for (const line of lines) {
    const usage = line.usage as Record<string, number> | undefined;
    if (usage) {
      totalTokens += (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
    }
    const billing = line.billing as Record<string, number> | undefined;
    if (billing?.cost_usd) {
      totalCost += billing.cost_usd;
    }
    // Also check costUsd format
    if (typeof (line as any).costUsd === "number") {
      totalCost += (line as any).costUsd;
    }
  }

  if (totalCost === 0 && totalTokens === 0) return null;
  return { total_cost_usd: totalCost, total_tokens: totalTokens };
}

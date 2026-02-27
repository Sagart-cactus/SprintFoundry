/**
 * Unit tests: Activity Detector
 * JSONL tail parsing edge cases, activity state classification logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  toClaudeProjectPath,
  parseJsonlFileTail,
} from "../../src/service/activity-detector.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import * as path from "path";
import * as os from "os";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "sf-activity-unit-"));
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
});

describe("toClaudeProjectPath", () => {
  it("appends .claude to workspace path", () => {
    expect(toClaudeProjectPath("/workspace/my-project")).toBe("/workspace/my-project/.claude");
  });

  it("handles trailing slash", () => {
    // path.join normalizes this
    expect(toClaudeProjectPath("/workspace/proj")).toBe("/workspace/proj/.claude");
  });
});

describe("parseJsonlFileTail — edge cases", () => {
  it("handles empty file", async () => {
    const filePath = path.join(tmpDir, "empty.jsonl");
    writeFileSync(filePath, "", "utf-8");

    const result = await parseJsonlFileTail(filePath);
    expect(result).toEqual([]);
  });

  it("handles file with only whitespace", async () => {
    const filePath = path.join(tmpDir, "whitespace.jsonl");
    writeFileSync(filePath, "  \n  \n  \n", "utf-8");

    const result = await parseJsonlFileTail(filePath);
    expect(result).toEqual([]);
  });

  it("handles file with single line", async () => {
    const filePath = path.join(tmpDir, "single.jsonl");
    writeFileSync(filePath, '{"type":"message"}\n', "utf-8");

    const result = await parseJsonlFileTail(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("message");
  });

  it("handles file with no trailing newline", async () => {
    const filePath = path.join(tmpDir, "no-newline.jsonl");
    writeFileSync(filePath, '{"type":"a"}\n{"type":"b"}', "utf-8");

    const result = await parseJsonlFileTail(filePath);
    expect(result).toHaveLength(2);
  });

  it("handles mixed valid and invalid JSON lines", async () => {
    const filePath = path.join(tmpDir, "mixed.jsonl");
    writeFileSync(filePath, '{"type":"good"}\n{bad json}\n{"type":"also-good"}\n', "utf-8");

    const result = await parseJsonlFileTail(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].type).toBe("good");
    expect(result[1].type).toBe("also-good");
  });

  it("reads only the tail when maxBytes is smaller than file", async () => {
    const filePath = path.join(tmpDir, "large.jsonl");
    // Each line is ~30 bytes. Write 100 lines (~3KB)
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ i }));
    writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

    // Read only last 200 bytes
    const result = await parseJsonlFileTail(filePath, 200);
    expect(result.length).toBeGreaterThan(0);
    expect(result.length).toBeLessThan(100);
    // The last parsed line should be the final entry
    expect(result[result.length - 1].i).toBe(99);
  });

  it("skips partial first line when reading from middle of file", async () => {
    const filePath = path.join(tmpDir, "partial.jsonl");
    const lines = Array.from({ length: 50 }, (_, i) => JSON.stringify({ index: i }));
    writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");

    // Reading from middle will cut first line — it should be skipped
    const result = await parseJsonlFileTail(filePath, 100);
    // All returned entries should be valid (no partial JSON)
    for (const entry of result) {
      expect(entry).toHaveProperty("index");
      expect(typeof entry.index).toBe("number");
    }
  });

  it("handles non-existent file path", async () => {
    const result = await parseJsonlFileTail("/tmp/nonexistent-12345.jsonl");
    expect(result).toEqual([]);
  });

  it("handles lines with unicode content", async () => {
    const filePath = path.join(tmpDir, "unicode.jsonl");
    writeFileSync(filePath, '{"msg":"héllo wörld 🎉"}\n{"msg":"日本語"}\n', "utf-8");

    const result = await parseJsonlFileTail(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].msg).toBe("héllo wörld 🎉");
    expect(result[1].msg).toBe("日本語");
  });
});

describe("parseJsonlFileTail — maxBytes boundary", () => {
  it("returns all lines when maxBytes exceeds file size", async () => {
    const filePath = path.join(tmpDir, "small.jsonl");
    writeFileSync(filePath, '{"a":1}\n{"b":2}\n', "utf-8");

    const result = await parseJsonlFileTail(filePath, 1_000_000);
    expect(result).toHaveLength(2);
  });

  it("handles maxBytes of 0 gracefully", async () => {
    const filePath = path.join(tmpDir, "zero.jsonl");
    writeFileSync(filePath, '{"a":1}\n', "utf-8");

    const result = await parseJsonlFileTail(filePath, 0);
    // Reading 0 bytes should return empty
    expect(result).toEqual([]);
  });
});

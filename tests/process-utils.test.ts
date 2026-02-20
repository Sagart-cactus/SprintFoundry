import { describe, expect, it } from "vitest";
import { parseTokenUsage, parseRuntimeId } from "../src/service/runtime/process-utils.js";

describe("parseTokenUsage", () => {
  it("parses Claude usage.total_tokens", () => {
    const output = JSON.stringify({ usage: { total_tokens: 1234 } });
    expect(parseTokenUsage(output)).toBe(1234);
  });

  it("parses Claude usage input/output tokens when total_tokens is absent", () => {
    const output = JSON.stringify({
      usage: { input_tokens: 3, output_tokens: 12, cache_creation_input_tokens: 10 },
    });
    expect(parseTokenUsage(output)).toBe(15);
  });

  it("parses Codex JSONL turn.completed usage", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "abc" }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 7868, cached_input_tokens: 6528, output_tokens: 23 },
      }),
    ].join("\n");

    expect(parseTokenUsage(output)).toBe(7891);
  });

  it("parses multiple JSONL usage rows by summing them", () => {
    const output = [
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2 } }),
      JSON.stringify({ type: "turn.completed", usage: { input_tokens: 3, output_tokens: 5 } }),
    ].join("\n");

    expect(parseTokenUsage(output)).toBe(20);
  });

  it("falls back to legacy tokens_used", () => {
    const output = JSON.stringify({ tokens_used: 777 });
    expect(parseTokenUsage(output)).toBe(777);
  });

  it("falls back to regex for plain text", () => {
    const output = "Process completed. Tokens: 5678\nDone.";
    expect(parseTokenUsage(output)).toBe(5678);
  });

  it("returns 0 when token info is absent", () => {
    const output = "no token info here";
    expect(parseTokenUsage(output)).toBe(0);
  });
});

describe("parseRuntimeId", () => {
  it("extracts Codex thread_id from JSONL output", () => {
    const output = [
      JSON.stringify({ type: "thread.started", thread_id: "019c7c09-e8f0-7bd0-a22f-035f072fdf4f" }),
      JSON.stringify({ type: "turn.started" }),
    ].join("\n");

    expect(parseRuntimeId("codex", output)).toBe("019c7c09-e8f0-7bd0-a22f-035f072fdf4f");
  });

  it("extracts Codex thread_id from single JSON output", () => {
    const output = JSON.stringify({
      type: "thread.started",
      thread_id: "019c7c07-9552-7523-95f7-d4c87803dc9f",
    });

    expect(parseRuntimeId("codex", output)).toBe("019c7c07-9552-7523-95f7-d4c87803dc9f");
  });

  it("returns null for codex output without thread.started event", () => {
    const output = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 2 } });
    expect(parseRuntimeId("codex", output)).toBeNull();
  });

  it("returns null for non-codex commands", () => {
    const output = JSON.stringify({ type: "thread.started", thread_id: "thread-abc" });
    expect(parseRuntimeId("claude", output)).toBeNull();
  });
});

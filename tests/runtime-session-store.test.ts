import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { RuntimeSessionStore } from "../src/service/runtime-session-store.js";

describe("RuntimeSessionStore", () => {
  it("records sessions and returns latest by agent", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-session-store-"));
    const store = new RuntimeSessionStore();

    await store.record(workspace, {
      run_id: "run-1",
      agent: "developer",
      step_number: 1,
      step_attempt: 1,
      runtime_provider: "codex",
      runtime_mode: "local_process",
      session_id: "session-1",
      updated_at: "2026-02-19T00:00:00.000Z",
    });
    await store.record(workspace, {
      run_id: "run-1",
      agent: "developer",
      step_number: 901,
      step_attempt: 1,
      runtime_provider: "codex",
      runtime_mode: "local_process",
      session_id: "session-2",
      resume_used: true,
      resume_failed: true,
      resume_fallback: true,
      token_savings_cached_input_tokens: 512,
      updated_at: "2026-02-19T00:01:00.000Z",
    });

    const latest = await store.findLatestByAgent(workspace, "run-1", "developer");
    expect(latest?.session_id).toBe("session-2");
    expect(latest?.step_number).toBe(901);
    expect(latest?.resume_used).toBe(true);
    expect(latest?.resume_failed).toBe(true);
    expect(latest?.resume_fallback).toBe(true);
    expect(latest?.token_savings_cached_input_tokens).toBe(512);

    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("does not lose records when writes happen concurrently", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-session-store-race-"));
    const store = new RuntimeSessionStore();

    await Promise.all([
      store.record(workspace, {
        run_id: "run-race",
        agent: "developer",
        step_number: 1,
        step_attempt: 1,
        runtime_provider: "codex",
        runtime_mode: "local_process",
        session_id: "session-a",
        updated_at: "2026-02-19T00:00:00.000Z",
      }),
      store.record(workspace, {
        run_id: "run-race",
        agent: "qa",
        step_number: 2,
        step_attempt: 1,
        runtime_provider: "claude-code",
        runtime_mode: "local_process",
        session_id: "session-b",
        updated_at: "2026-02-19T00:00:01.000Z",
      }),
    ]);

    const raw = JSON.parse(
      await fs.readFile(path.join(workspace, ".sprintfoundry", "sessions.json"), "utf-8")
    ) as { sessions: Array<{ session_id: string }> };
    const ids = raw.sessions.map((s) => s.session_id).sort();
    expect(ids).toEqual(["session-a", "session-b"]);

    await fs.rm(workspace, { recursive: true, force: true });
  });
});

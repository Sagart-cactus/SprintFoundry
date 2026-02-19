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
      updated_at: "2026-02-19T00:01:00.000Z",
    });

    const latest = await store.findLatestByAgent(workspace, "run-1", "developer");
    expect(latest?.session_id).toBe("session-2");
    expect(latest?.step_number).toBe(901);

    await fs.rm(workspace, { recursive: true, force: true });
  });
});

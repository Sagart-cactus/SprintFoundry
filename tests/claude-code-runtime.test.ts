import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { EventEmitter } from "events";
import type { RuntimeStepContext } from "../src/service/runtime/types.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
const { spawn: mockSpawn } = await import("child_process");
const { ClaudeCodeRuntime } = await import("../src/service/runtime/claude-code-runtime.js");

function makeContext(workspacePath: string, mode: "local_process" | "container" = "local_process"): RuntimeStepContext {
  return {
    stepNumber: 1,
    stepAttempt: 1,
    agent: "developer",
    task: "Implement feature",
    context_inputs: [{ type: "ticket" }],
    workspacePath,
    modelConfig: { provider: "anthropic", model: "claude-sonnet-4-6" },
    apiKey: "sk-ant-test",
    timeoutMinutes: 1,
    tokenBudget: 500_000,
    previousStepResults: [],
    plugins: ["/tmp/plugin-a", "/tmp/plugin-b"],
    cliFlags: { max_budget_usd: 2.5, skip_permissions: true },
    runtime: { provider: "claude-code", mode, env: { EXTRA_ENV: "yes" } },
    containerImage: "ghcr.io/org/agent:latest",
  };
}

describe("ClaudeCodeRuntime", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-runtime-test-"));
  });

  it("uses SDK query() for local mode and maps context fields to options", async () => {
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "System prompt from file", "utf-8");
    await fs.writeFile(path.join(tmpDir, ".agent-task.md"), "Task prompt from file", "utf-8");

    (mockQuery as any).mockImplementationOnce(({ options }: any) => (async function* () {
      options.stderr("sdk stderr line");
      yield { type: "system", subtype: "init", session_id: "sdk-session-123" };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0.42,
        usage: {
          input_tokens: 12,
          output_tokens: 30,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: { web_search_requests: 0 },
        },
        modelUsage: {},
        permission_denials: [],
        result: "ok",
        uuid: "00000000-0000-0000-0000-000000000000",
        session_id: "sdk-session-123",
      };
    })());

    const runtime = new ClaudeCodeRuntime();
    const result = await runtime.runStep(makeContext(tmpDir));

    expect(mockQuery).toHaveBeenCalledTimes(1);
    const call = (mockQuery as any).mock.calls[0][0];
    expect(call.prompt).toBe("Task prompt from file");
    expect(call.options.systemPrompt).toBe("System prompt from file");
    expect(call.options.cwd).toBe(tmpDir);
    expect(call.options.model).toBe("claude-sonnet-4-6");
    expect(call.options.maxBudgetUsd).toBe(2.5);
    expect(call.options.permissionMode).toBe("bypassPermissions");
    expect(call.options.allowDangerouslySkipPermissions).toBe(true);
    expect(call.options.plugins).toEqual([
      { type: "local", path: "/tmp/plugin-a" },
      { type: "local", path: "/tmp/plugin-b" },
    ]);
    expect(call.options.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(call.options.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(call.options.env.EXTRA_ENV).toBe("yes");

    expect(result.tokens_used).toBe(42);
    expect(result.runtime_id).toBe("sdk-session-123");
    expect(result.cost_usd).toBe(0.42);
    expect(result.usage).toMatchObject({ input_tokens: 12, output_tokens: 30 });

    const stdoutLog = await fs.readFile(path.join(tmpDir, ".claude-runtime.stdout.log"), "utf-8");
    const stderrLog = await fs.readFile(path.join(tmpDir, ".claude-runtime.stderr.log"), "utf-8");
    const latestDebug = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".claude-runtime.debug.json"), "utf-8")
    );
    const stepDebug = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, ".claude-runtime.step-1.attempt-1.debug.json"),
        "utf-8"
      )
    );
    expect(stdoutLog).toContain('"type":"result"');
    expect(stderrLog).toContain("sdk stderr line");
    expect(latestDebug.runtime_command).toBe("claude-sdk");
    expect(latestDebug.runtime_mode).toBe("local_process");
    expect(stepDebug.runtime_provider).toBe("claude-code");
  });

  it("times out local SDK execution using AbortController", async () => {
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "System prompt", "utf-8");
    await fs.writeFile(path.join(tmpDir, ".agent-task.md"), "Task prompt", "utf-8");

    (mockQuery as any).mockImplementationOnce(({ options }: any) => (async function* () {
      await new Promise((_, reject) => {
        const signal = options.abortController.signal as AbortSignal;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    })());

    const runtime = new ClaudeCodeRuntime();
    const ctx = makeContext(tmpDir);
    ctx.timeoutMinutes = 0.001;

    await expect(runtime.runStep(ctx)).rejects.toThrow(/timed out/);
  });

  it("keeps container mode on docker CLI path", async () => {
    const proc = new EventEmitter() as any;
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.on = proc.addListener.bind(proc);

    (mockSpawn as any)
      .mockReturnValueOnce(proc)
      .mockReturnValueOnce(new EventEmitter());

    const runtime = new ClaudeCodeRuntime();
    const promise = runtime.runStep(makeContext(tmpDir, "container"));

    setTimeout(() => {
      proc.stdout.emit("data", Buffer.from(JSON.stringify({ usage: { total_tokens: 9 } })));
      proc.emit("close", 0);
    }, 5);

    const result = await promise;
    const latestDebug = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".claude-runtime.debug.json"), "utf-8")
    );
    const stepDebug = JSON.parse(
      await fs.readFile(
        path.join(tmpDir, ".claude-runtime.step-1.attempt-1.debug.json"),
        "utf-8"
      )
    );

    expect((mockSpawn as any).mock.calls[0][0]).toBe("docker");
    expect(result.runtime_id).toContain("sprintfoundry-developer-");
    expect(result.tokens_used).toBe(9);
    expect(latestDebug.runtime_command).toBe("docker");
    expect(latestDebug.runtime_mode).toBe("container");
    expect(stepDebug.runtime_provider).toBe("claude-code");
  });
});

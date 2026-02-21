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

vi.mock("../src/service/runtime/process-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../src/service/runtime/process-utils.js")>(
    "../src/service/runtime/process-utils.js"
  );
  return { ...actual, runProcess: vi.fn() };
});

const { query: mockQuery } = await import("@anthropic-ai/claude-agent-sdk");
const { spawn: mockSpawn } = await import("child_process");
const { runProcess: mockRunProcess } = await import("../src/service/runtime/process-utils.js");
const { ClaudeCodeRuntime } = await import("../src/service/runtime/claude-code-runtime.js");

function makeContext(workspacePath: string, mode: "local_sdk" | "local_process" | "container" = "local_sdk"): RuntimeStepContext {
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
    expect(result.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_sdk",
        runtime_id: "sdk-session-123",
        step_attempt: 1,
      },
      usage: { input_tokens: 12, output_tokens: 30 },
      billing: { cost_usd: 0.42, cost_source: "runtime_reported" },
    });

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
    expect(latestDebug.runtime_mode).toBe("local_sdk");
    expect(stepDebug.runtime_provider).toBe("claude-code");
  });

  it("passes resume to SDK query when resumeSessionId is provided", async () => {
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "System prompt", "utf-8");
    await fs.writeFile(path.join(tmpDir, ".agent-task.md"), "Task prompt", "utf-8");

    (mockQuery as any).mockImplementationOnce(() => (async function* () {
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        result: "ok",
        uuid: "00000000-0000-0000-0000-000000000001",
        session_id: "sdk-session-456",
      };
    })());

    const runtime = new ClaudeCodeRuntime();
    const result = await runtime.runStep({
      ...makeContext(tmpDir),
      resumeSessionId: "session-old-222",
    });

    const call = (mockQuery as any).mock.calls[0][0];
    expect(call.options.resume).toBe("session-old-222");
    expect(result.resume_used).toBe(true);
    expect(result.runtime_metadata?.resume).toMatchObject({
      requested: true,
      used: true,
      failed: false,
      fallback_to_fresh: false,
      source_session_id: "session-old-222",
    });
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
    expect(result.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "container",
        step_attempt: 1,
      },
    });
    expect(latestDebug.runtime_command).toBe("docker");
    expect(latestDebug.runtime_mode).toBe("container");
    expect(stepDebug.runtime_provider).toBe("claude-code");
  });

  it("uses CLI subprocess (not SDK) for local_process mode", async () => {
    (mockRunProcess as any).mockResolvedValueOnce({
      tokensUsed: 77,
      runtimeId: "local-claude-cli-abc",
      stdout: "",
      stderr: "",
    });

    const runtime = new ClaudeCodeRuntime();
    const result = await runtime.runStep(makeContext(tmpDir, "local_process"));

    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockRunProcess).toHaveBeenCalledOnce();

    const [command, args, opts] = (mockRunProcess as any).mock.calls[0];
    expect(command).toBe("claude");
    expect(args[0]).toBe("-p");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--max-budget-usd");
    expect(opts.env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(opts.env.ANTHROPIC_MODEL).toBe("claude-sonnet-4-6");
    expect(opts.env.EXTRA_ENV).toBe("yes");

    expect(result.tokens_used).toBe(77);
    expect(result.runtime_id).toBe("local-claude-cli-abc");
    expect(result.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "claude-code",
        mode: "local_process",
        runtime_id: "local-claude-cli-abc",
        step_attempt: 1,
      },
    });

    const latestDebug = JSON.parse(
      await fs.readFile(path.join(tmpDir, ".claude-runtime.debug.json"), "utf-8")
    );
    expect(latestDebug.runtime_command).toBe("claude");
    expect(latestDebug.runtime_mode).toBe("local_process");
  });

  it("uses --resume for local_process mode when resumeSessionId is provided", async () => {
    (mockRunProcess as any).mockResolvedValueOnce({
      tokensUsed: 3,
      runtimeId: "local-claude-cli-xyz",
      stdout: "",
      stderr: "",
    });

    const runtime = new ClaudeCodeRuntime();
    await runtime.runStep({
      ...makeContext(tmpDir, "local_process"),
      resumeSessionId: "claude-session-123",
    });

    const args = (mockRunProcess as any).mock.calls[0][1] as string[];
    expect(args.slice(0, 4)).toEqual(["--resume", "claude-session-123", "-p", expect.any(String)]);
  });

  it("emits streaming activity events in local_sdk mode", async () => {
    await fs.writeFile(path.join(tmpDir, "CLAUDE.md"), "System prompt from file", "utf-8");
    await fs.writeFile(path.join(tmpDir, ".agent-task.md"), "Task prompt from file", "utf-8");
    const activities: Array<{ type: string; data: Record<string, unknown> }> = [];

    (mockQuery as any).mockImplementationOnce(() => (async function* () {
      yield {
        type: "assistant",
        content: [
          { type: "thinking", text: "Planning command and edits" },
          { type: "tool_use", name: "bash", input: { command: "npm test -- foo" } },
          { type: "tool_use", name: "write_file", input: { path: "src/index.ts" } },
          { type: "tool_use", name: "web_search", input: { query: "x" } },
        ],
      };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        stop_reason: null,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 1 },
        modelUsage: {},
        permission_denials: [],
        result: "ok",
        uuid: "00000000-0000-0000-0000-000000000002",
        session_id: "sdk-session-activity-1",
      };
    })());

    const runtime = new ClaudeCodeRuntime();
    await runtime.runStep({
      ...makeContext(tmpDir, "local_sdk"),
      onActivity: async (event) => {
        activities.push(event);
      },
    });

    const types = activities.map((a) => a.type);
    expect(types).toContain("agent_thinking");
    expect(types).toContain("agent_command_run");
    expect(types).toContain("agent_file_edit");
    expect(types).toContain("agent_tool_call");
  });
});

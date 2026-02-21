import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { RuntimeStepContext } from "../src/service/runtime/types.js";

// Module-level mock state — shared between factory closures and test assertions.
// Defined before any dynamic imports so they are initialized by the time factories are invoked.
const mockRunStreamedFn = vi.fn();
const mockStartThreadFn = vi.fn();
const mockResumeThreadFn = vi.fn();
const mockCodexConstructorCalls: Array<{ env: Record<string, string> }> = [];

// vi.mock is hoisted, but factory bodies run lazily (at first import).
// By the time the factories execute, the module-level vars above are initialized.
vi.mock("@openai/codex-sdk", () => ({
  // Regular function (not arrow) so it can be used as a constructor with `new`.
  Codex: function MockCodex(this: any, opts: { env: Record<string, string> }) {
    mockCodexConstructorCalls.push({ env: opts?.env ?? {} });
    return { startThread: mockStartThreadFn, resumeThread: mockResumeThreadFn };
  },
}));

vi.mock("../src/service/runtime/process-utils.js", () => ({
  runProcess: vi.fn(),
}));

const { runProcess } = await import("../src/service/runtime/process-utils.js");
const { CodexRuntime } = await import("../src/service/runtime/codex-runtime.js");

type StreamedTurnInput = {
  usage?: { input_tokens: number; cached_input_tokens: number; output_tokens: number } | null;
  items?: Array<Record<string, unknown>>;
  finalResponse?: string;
};

function buildStreamedTurn({
  usage = { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
  items = [],
  finalResponse = "",
}: StreamedTurnInput) {
  const events = async function* () {
    yield { type: "turn.started" };
    for (const item of items) {
      yield { type: "item.started", item };
      yield { type: "item.completed", item };
    }
    if (finalResponse) {
      const messageItem = { id: "msg-1", type: "agent_message", text: finalResponse };
      yield { type: "item.started", item: messageItem };
      yield { type: "item.completed", item: messageItem };
    }
    if (usage) {
      yield { type: "turn.completed", usage };
    }
  };
  return { events: events() };
}

function makeContext(
  workspacePath: string,
  overrides?: Partial<RuntimeStepContext>
): RuntimeStepContext {
  return {
    stepNumber: overrides?.stepNumber ?? 1,
    stepAttempt: overrides?.stepAttempt ?? 1,
    agent: overrides?.agent ?? "developer",
    task: overrides?.task ?? "Build a feature",
    context_inputs: overrides?.context_inputs ?? [{ type: "ticket" }],
    workspacePath,
    modelConfig: overrides?.modelConfig ?? { provider: "openai", model: "gpt-5" },
    apiKey: overrides?.apiKey ?? "sk-openai-test-key",
    timeoutMinutes: overrides?.timeoutMinutes ?? 5,
    tokenBudget: overrides?.tokenBudget ?? 5000,
    previousStepResults: overrides?.previousStepResults ?? [],
    runtime: overrides?.runtime ?? { provider: "codex", mode: "local_sdk" },
    codexHomeDir: overrides?.codexHomeDir,
    codexSkillNames: overrides?.codexSkillNames,
    plugins: overrides?.plugins,
    cliFlags: overrides?.cliFlags,
    containerResources: overrides?.containerResources,
    containerImage: overrides?.containerImage,
    resumeSessionId: overrides?.resumeSessionId,
    resumeReason: overrides?.resumeReason,
    onActivity: overrides?.onActivity,
    guardrails: overrides?.guardrails,
  };
}

describe("CodexRuntime local_sdk mode", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCodexConstructorCalls.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-sdk-test-"));
    process.env = { ...originalEnv };

    mockRunStreamedFn.mockResolvedValue(buildStreamedTurn({}));
    mockStartThreadFn.mockReturnValue({ id: "thread-sdk-123", runStreamed: mockRunStreamedFn });
    mockResumeThreadFn.mockResolvedValue({
      id: "thread-sdk-resume-123",
      runStreamed: mockRunStreamedFn,
    });
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("calls Codex constructor and startThread, not runProcess", async () => {
    const runtime = new CodexRuntime();
    const result = await runtime.runStep(makeContext(tmpDir));

    expect(mockCodexConstructorCalls).toHaveLength(1);
    expect(mockStartThreadFn).toHaveBeenCalledOnce();
    expect(mockResumeThreadFn).not.toHaveBeenCalled();
    expect(runProcess).not.toHaveBeenCalled();
    expect(result.tokens_used).toBe(150); // 100 + 50
    expect(result.runtime_id).toBe("thread-sdk-123");
    expect(result.usage).toEqual({
      input_tokens: 100,
      cached_input_tokens: 0,
      output_tokens: 50,
    });
    expect(result.resume_used).toBe(false);
    expect(result.resume_failed).toBe(false);
    expect(result.resume_fallback).toBe(false);
    expect(result.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "codex",
        mode: "local_sdk",
        runtime_id: "thread-sdk-123",
        step_attempt: 1,
      },
      usage: {
        input_tokens: 100,
        cached_input_tokens: 0,
        output_tokens: 50,
      },
    });
  });

  it("passes OPENAI_API_KEY and OPENAI_MODEL in env to Codex constructor", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        apiKey: "sk-openai-secret",
        modelConfig: { provider: "openai", model: "gpt-5-turbo" },
      })
    );

    const constructorEnv = mockCodexConstructorCalls[0].env;
    expect(constructorEnv.OPENAI_API_KEY).toBe("sk-openai-secret");
    expect(constructorEnv.OPENAI_MODEL).toBe("gpt-5-turbo");
  });

  it("forwards CODEX_HOME when codexHomeDir is set", async () => {
    const codexHome = path.join(tmpDir, ".codex-home");
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { codexHomeDir: codexHome }));

    const constructorEnv = mockCodexConstructorCalls[0].env;
    expect(constructorEnv.CODEX_HOME).toBe(codexHome);
  });

  it("does not include CODEX_HOME when codexHomeDir is not set", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { codexHomeDir: undefined }));

    const constructorEnv = mockCodexConstructorCalls[0].env;
    expect(constructorEnv.CODEX_HOME).toBeUndefined();
  });

  it("does not forward unrelated parent env secrets", async () => {
    process.env.UNRELATED_PARENT_SECRET = "dont-forward-me";
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir));

    const constructorEnv = mockCodexConstructorCalls[0].env;
    expect(constructorEnv.UNRELATED_PARENT_SECRET).toBeUndefined();
  });

  it("passes workspacePath, model, and correct thread options to startThread", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        modelConfig: { provider: "openai", model: "gpt-5" },
      })
    );

    expect(mockStartThreadFn).toHaveBeenCalledWith({
      workingDirectory: tmpDir,
      model: "gpt-5",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
  });

  it("passes modelReasoningEffort to SDK when model is codex", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        modelConfig: { provider: "openai", model: "gpt-5.3-codex" },
        runtime: {
          provider: "codex",
          mode: "local_sdk",
          model_reasoning_effort: "high",
        },
      })
    );

    expect(mockStartThreadFn).toHaveBeenCalledWith({
      workingDirectory: tmpDir,
      model: "gpt-5.3-codex",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
      modelReasoningEffort: "high",
    });
  });

  it("ignores modelReasoningEffort for non-codex SDK models", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        modelConfig: { provider: "openai", model: "gpt-4.1" },
        runtime: {
          provider: "codex",
          mode: "local_sdk",
          model_reasoning_effort: "high",
        },
      })
    );

    expect(mockStartThreadFn).toHaveBeenCalledWith({
      workingDirectory: tmpDir,
      model: "gpt-4.1",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
  });

  it("writes step-prefixed debug files to workspace", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { stepNumber: 3, stepAttempt: 2 }));

    const stepDebugPath = path.join(
      tmpDir,
      ".codex-runtime.step-3.attempt-2.debug.json"
    );
    const legacyDebugPath = path.join(tmpDir, ".codex-runtime.debug.json");

    const stepContent = JSON.parse(await fs.readFile(stepDebugPath, "utf-8"));
    const legacyContent = JSON.parse(await fs.readFile(legacyDebugPath, "utf-8"));

    expect(stepContent.runtime_mode).toBe("local_sdk");
    expect(stepContent.step_number).toBe(3);
    expect(stepContent.step_attempt).toBe(2);
    expect(legacyContent.runtime_mode).toBe("local_sdk");
  });

  it("writes SDK stdout/stderr logs so monitor can render agent output", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { stepNumber: 4, stepAttempt: 3 }));

    const stepStdoutPath = path.join(tmpDir, ".codex-runtime.step-4.attempt-3.stdout.log");
    const stepStderrPath = path.join(tmpDir, ".codex-runtime.step-4.attempt-3.stderr.log");
    const legacyStdoutPath = path.join(tmpDir, ".codex-runtime.stdout.log");
    const legacyStderrPath = path.join(tmpDir, ".codex-runtime.stderr.log");

    const [stepStdout, stepStderr, legacyStdout, legacyStderr] = await Promise.all([
      fs.readFile(stepStdoutPath, "utf-8"),
      fs.readFile(stepStderrPath, "utf-8"),
      fs.readFile(legacyStdoutPath, "utf-8"),
      fs.readFile(legacyStderrPath, "utf-8"),
    ]);

    expect(stepStdout).toContain('"type":"thread.started"');
    expect(stepStdout).toContain('"type":"turn.completed"');
    expect(stepStderr).toBe("");
    expect(legacyStdout).toContain('"type":"thread.started"');
    expect(legacyStderr).toBe("");
  });

  it("emits runtime activity events from SDK turn items", async () => {
    mockRunStreamedFn.mockResolvedValueOnce(
      buildStreamedTurn({
        usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 3 },
        items: [
          { id: "cmd-1", type: "command_execution", command: "npm test" },
          { id: "tool-1", type: "tool_call", tool_name: "read_file" },
        ],
        finalResponse: "done",
      })
    );
    const onActivity = vi.fn();

    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { onActivity }));

    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_command_run",
        data: expect.objectContaining({ command: "npm test" }),
      })
    );
    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_tool_call",
        data: expect.objectContaining({ tool_name: "read_file" }),
      })
    );
  });

  it("blocks command executions that violate guardrails", async () => {
    mockRunStreamedFn.mockResolvedValueOnce(
      buildStreamedTurn({
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 },
        items: [{ id: "cmd-guard", type: "command_execution", command: "rm -rf /" }],
      })
    );

    const onActivity = vi.fn();
    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          guardrails: { deny_commands: ["rm\\s+-rf"] },
          onActivity,
        })
      )
    ).rejects.toThrow(/Guardrail blocked/);

    expect(onActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "agent_guardrail_block",
        data: expect.objectContaining({ command: "rm -rf /" }),
      })
    );
  });

  it("blocks file changes outside allow_paths guardrails", async () => {
    mockRunStreamedFn.mockResolvedValueOnce(
      buildStreamedTurn({
        usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1 },
        items: [
          {
            id: "file-guard",
            type: "file_change",
            changes: [{ path: "secrets.txt", kind: "update" }],
          },
        ],
      })
    );

    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          guardrails: { allow_paths: ["src/**"] },
        })
      )
    ).rejects.toThrow(/Guardrail blocked/);
  });

  it("returns zero tokens when usage is missing", async () => {
    mockRunStreamedFn.mockResolvedValue(buildStreamedTurn({ usage: null, finalResponse: "" }));
    const runtime = new CodexRuntime();
    const result = await runtime.runStep(makeContext(tmpDir));

    expect(result.tokens_used).toBe(0);
  });

  it("returns empty runtime_id when thread.id is null/undefined", async () => {
    mockStartThreadFn.mockReturnValue({ id: undefined, runStreamed: mockRunStreamedFn });
    const runtime = new CodexRuntime();
    const result = await runtime.runStep(makeContext(tmpDir));

    expect(result.runtime_id).toBe("");
  });

  it("forwards extra runtime.env keys to Codex constructor env", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        runtime: {
          provider: "codex",
          mode: "local_sdk",
          env: { MY_CUSTOM_VAR: "custom-value" },
        },
      })
    );

    const constructorEnv = mockCodexConstructorCalls[0].env;
    expect(constructorEnv.MY_CUSTOM_VAR).toBe("custom-value");
  });

  it("uses workspace .agent-task.md content as primary SDK prompt when present", async () => {
    await fs.writeFile(
      path.join(tmpDir, ".agent-task.md"),
      "# SDK Task\n\nFollow this instruction from workspace task file.",
      "utf-8"
    );
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { task: "Fallback task should not be primary" }));

    const prompt = vi.mocked(mockRunStreamedFn).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("# .agent-task.md");
    expect(prompt).toContain("Follow this instruction from workspace task file.");
    expect(prompt).toContain("Primary task: Fallback task should not be primary");
  });

  it("falls back to synthesized prompt when workspace .agent-task.md is absent", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { task: "Use synthesized task prompt" }));

    const prompt = vi.mocked(mockRunStreamedFn).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Read .agent-task.md and AGENTS.md");
    expect(prompt).toContain("Primary task: Use synthesized task prompt");
  });

  it("enforces SDK timeout and still writes debug artifacts", async () => {
    mockRunStreamedFn.mockImplementation(() => new Promise(() => {}));
    const runtime = new CodexRuntime();
    const startedAt = Date.now();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          stepNumber: 8,
          stepAttempt: 2,
          timeoutMinutes: 0.0005,
        })
      )
    ).rejects.toThrow(/Codex SDK run timed out/);
    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(20);
    expect(elapsedMs).toBeLessThan(2000);

    const stepDebugPath = path.join(
      tmpDir,
      ".codex-runtime.step-8.attempt-2.debug.json"
    );
    const debugContent = JSON.parse(await fs.readFile(stepDebugPath, "utf-8"));
    expect(debugContent.runtime_mode).toBe("local_sdk");
  });

  it("treats non-positive SDK timeout as immediate timeout to match local_process semantics", async () => {
    mockRunStreamedFn.mockImplementation(() => new Promise(() => {}));
    const runtime = new CodexRuntime();
    const startedAt = Date.now();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          timeoutMinutes: 0,
        })
      )
    ).rejects.toThrow(/Codex SDK run timed out after 0ms/);

    const elapsedMs = Date.now() - startedAt;
    expect(elapsedMs).toBeLessThan(500);
  });

  it("times out immediately even when SDK run would resolve immediately", async () => {
    mockRunStreamedFn.mockResolvedValue(
      buildStreamedTurn({
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
        finalResponse: "ok",
      })
    );
    const runtime = new CodexRuntime();

    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          timeoutMinutes: 0,
        })
      )
    ).rejects.toThrow(/Codex SDK run timed out after 0ms/);

    expect(mockRunStreamedFn).not.toHaveBeenCalled();
  });

  it("passes AbortSignal to SDK turn and aborts it on timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    mockRunStreamedFn.mockImplementation(
      (_prompt: string, options?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          observedSignal = options?.signal;
          observedSignal?.addEventListener("abort", () => {
            reject(new Error("aborted"));
          });
        })
    );

    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          timeoutMinutes: 0.0005,
        })
      )
    ).rejects.toThrow(/Codex SDK run timed out/);

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("falls back to synthesized prompt when workspace .agent-task.md is empty", async () => {
    await fs.writeFile(path.join(tmpDir, ".agent-task.md"), "   \n\n", "utf-8");
    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { task: "Use fallback when task file is empty" }));

    const prompt = vi.mocked(mockRunStreamedFn).mock.calls[0]?.[0] as string;
    expect(prompt).toContain("Read .agent-task.md and AGENTS.md");
    expect(prompt).not.toContain("# .agent-task.md");
    expect(prompt).toContain("Primary task: Use fallback when task file is empty");
  });

  it("uses resumeThread in SDK mode when resumeSessionId is present", async () => {
    const runtime = new CodexRuntime();
    const result = await runtime.runStep(
      makeContext(tmpDir, { resumeSessionId: "sdk-session-111" })
    );

    expect(mockResumeThreadFn).toHaveBeenCalledWith("sdk-session-111", {
      workingDirectory: tmpDir,
      model: "gpt-5",
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });
    expect(mockStartThreadFn).not.toHaveBeenCalled();
    expect(result.runtime_id).toBe("thread-sdk-resume-123");
    expect(result.resume_used).toBe(true);
    expect(result.resume_failed).toBe(false);
    expect(result.resume_fallback).toBe(false);
    expect(result.runtime_metadata?.resume).toMatchObject({
      requested: true,
      used: true,
      failed: false,
      fallback_to_fresh: false,
      source_session_id: "sdk-session-111",
    });
  });

  it("falls back to fresh SDK thread once when resumeThread fails with invalid session", async () => {
    mockResumeThreadFn.mockRejectedValueOnce(new Error("invalid session"));
    const runtime = new CodexRuntime();
    const result = await runtime.runStep(
      makeContext(tmpDir, { resumeSessionId: "sdk-session-222" })
    );

    expect(mockResumeThreadFn).toHaveBeenCalledOnce();
    expect(mockStartThreadFn).toHaveBeenCalledOnce();
    expect(result.runtime_id).toBe("thread-sdk-123");
    expect(result.resume_used).toBe(true);
    expect(result.resume_failed).toBe(true);
    expect(result.resume_fallback).toBe(true);
    expect(result.runtime_metadata?.resume).toMatchObject({
      requested: true,
      used: true,
      failed: true,
      fallback_to_fresh: true,
      source_session_id: "sdk-session-222",
    });
  });

  it("does not fallback in SDK mode for non-session resume errors", async () => {
    mockResumeThreadFn.mockRejectedValueOnce(new Error("rate limit exceeded"));
    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(makeContext(tmpDir, { resumeSessionId: "sdk-session-333" }))
    ).rejects.toThrow(/rate limit exceeded/);

    expect(mockResumeThreadFn).toHaveBeenCalledOnce();
    expect(mockStartThreadFn).not.toHaveBeenCalled();
  });

  it("does not fallback in SDK mode for generic 'not found' errors without session/thread context", async () => {
    mockResumeThreadFn.mockRejectedValueOnce(new Error("artifact not found"));
    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(makeContext(tmpDir, { resumeSessionId: "sdk-session-334" }))
    ).rejects.toThrow(/artifact not found/);

    expect(mockResumeThreadFn).toHaveBeenCalledOnce();
    expect(mockStartThreadFn).not.toHaveBeenCalled();
  });

  it("exposes optional token-savings hook when SDK reports cached_input_tokens", async () => {
    mockRunStreamedFn.mockResolvedValue(
      buildStreamedTurn({
        usage: { input_tokens: 120, cached_input_tokens: 700, output_tokens: 60 },
        finalResponse: "",
      })
    );

    const runtime = new CodexRuntime();
    const result = await runtime.runStep(makeContext(tmpDir));

    expect(result.token_savings).toEqual({ cached_input_tokens: 700 });
    expect(result.usage).toEqual({
      input_tokens: 120,
      cached_input_tokens: 700,
      output_tokens: 60,
    });
    expect(result.runtime_metadata?.token_savings).toEqual({ cached_input_tokens: 700 });
  });
});

describe("CodexRuntime local_process mode (unchanged behavior)", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCodexConstructorCalls.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-process-test-"));
    process.env = { ...originalEnv };

    vi.mocked(runProcess).mockResolvedValue({
      tokensUsed: 200,
      runtimeId: "local-codex-process-123",
      stdout: "{}",
      stderr: "",
    } as any);
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("calls runProcess, not Codex, for local_process mode", async () => {
    const runtime = new CodexRuntime();
    const result = await runtime.runStep(
      makeContext(tmpDir, { runtime: { provider: "codex", mode: "local_process" } })
    );

    expect(mockCodexConstructorCalls).toHaveLength(0);
    expect(runProcess).toHaveBeenCalledOnce();
    expect(result.tokens_used).toBe(200);
    expect(result.runtime_id).toBe("local-codex-process-123");
    expect(result.runtime_metadata).toMatchObject({
      schema_version: 1,
      runtime: {
        provider: "codex",
        mode: "local_process",
        runtime_id: "local-codex-process-123",
      },
    });
  });

  it("extracts usage/token_savings from local_process JSON output when present", async () => {
    vi.mocked(runProcess).mockResolvedValueOnce({
      tokensUsed: 350,
      runtimeId: "local-codex-process-usage",
      stdout: JSON.stringify({
        usage: {
          input_tokens: 200,
          cached_input_tokens: 120,
          output_tokens: 150,
        },
      }),
      stderr: "",
    } as any);

    const runtime = new CodexRuntime();
    const result = await runtime.runStep(
      makeContext(tmpDir, { runtime: { provider: "codex", mode: "local_process" } })
    );

    expect(result.usage).toEqual({
      input_tokens: 200,
      cached_input_tokens: 120,
      output_tokens: 150,
    });
    expect(result.token_savings).toEqual({ cached_input_tokens: 120 });
    expect(result.runtime_metadata?.usage).toEqual({
      input_tokens: 200,
      cached_input_tokens: 120,
      output_tokens: 150,
    });
    expect(result.runtime_metadata?.token_savings).toEqual({ cached_input_tokens: 120 });
  });

  it("does not forward unrelated parent env secrets (local_process security)", async () => {
    process.env.UNRELATED_PARENT_SECRET = "dont-forward-me";
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, { runtime: { provider: "codex", mode: "local_process" } })
    );

    const callEnv = vi.mocked(runProcess).mock.calls[0][2].env as Record<
      string,
      string | undefined
    >;
    expect(callEnv.UNRELATED_PARENT_SECRET).toBeUndefined();
  });

  it("passes model_reasoning_effort config for codex local_process model", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        modelConfig: { provider: "openai", model: "gpt-5.3-codex" },
        runtime: {
          provider: "codex",
          mode: "local_process",
          model_reasoning_effort: "medium",
        },
      })
    );

    const args = vi.mocked(runProcess).mock.calls[0][1] as string[];
    expect(args).toContain("--config");
    expect(args).toContain('model_reasoning_effort="medium"');
  });

  it("ignores model_reasoning_effort config for non-codex local_process model", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        modelConfig: { provider: "openai", model: "gpt-4.1" },
        runtime: {
          provider: "codex",
          mode: "local_process",
          model_reasoning_effort: "medium",
        },
      })
    );

    const args = vi.mocked(runProcess).mock.calls[0][1] as string[];
    expect(args.some((arg) => arg.includes("model_reasoning_effort"))).toBe(false);
  });

  it("keeps synthesized prompt contract in local_process mode", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        task: "Process mode task contract",
        runtime: { provider: "codex", mode: "local_process" },
      })
    );

    const args = vi.mocked(runProcess).mock.calls[0][1] as string[];
    expect(args[0]).toBe("exec");
    expect(args[1]).toContain("Primary task: Process mode task contract");
    expect(args[1]).toContain("Read .agent-task.md and AGENTS.md");
  });

  it("uses CLI resume path in local_process mode when resumeSessionId is present", async () => {
    const runtime = new CodexRuntime();
    await runtime.runStep(
      makeContext(tmpDir, {
        runtime: { provider: "codex", mode: "local_process" },
        resumeSessionId: "process-session-123",
      })
    );

    const args = vi.mocked(runProcess).mock.calls[0][1] as string[];
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("process-session-123");
  });

  it("falls back to one fresh local_process run when resume command fails with invalid session", async () => {
    vi.mocked(runProcess)
      .mockRejectedValueOnce(new Error("Process codex exited with code 1. invalid session"))
      .mockResolvedValueOnce({
        tokensUsed: 321,
        runtimeId: "local-codex-process-fresh-1",
        stdout: "{}",
        stderr: "",
      } as any);

    const runtime = new CodexRuntime();
    const result = await runtime.runStep(
      makeContext(tmpDir, {
        runtime: { provider: "codex", mode: "local_process" },
        resumeSessionId: "process-session-999",
      })
    );

    expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(2);
    const resumeArgs = vi.mocked(runProcess).mock.calls[0][1] as string[];
    const fallbackArgs = vi.mocked(runProcess).mock.calls[1][1] as string[];
    expect(resumeArgs.slice(0, 3)).toEqual(["exec", "resume", "process-session-999"]);
    expect(fallbackArgs[0]).toBe("exec");
    expect(fallbackArgs[1]).not.toBe("resume");
    expect(result.runtime_id).toBe("local-codex-process-fresh-1");
    expect(result.tokens_used).toBe(321);
    expect(result.resume_used).toBe(true);
    expect(result.resume_failed).toBe(true);
    expect(result.resume_fallback).toBe(true);
    expect(result.runtime_metadata?.resume).toMatchObject({
      requested: true,
      used: true,
      failed: true,
      fallback_to_fresh: true,
      source_session_id: "process-session-999",
    });
  });

  it("fails local_process step when resume and single fallback both fail", async () => {
    vi.mocked(runProcess)
      .mockRejectedValueOnce(new Error("Process codex exited with code 1. invalid session"))
      .mockRejectedValueOnce(new Error("Process codex exited with code 1. prompt execution failed"));

    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          runtime: { provider: "codex", mode: "local_process" },
          resumeSessionId: "process-session-500",
        })
      )
    ).rejects.toThrow(/prompt execution failed/);

    expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(2);
  });

  it("does not fallback in local_process mode for non-session resume errors", async () => {
    vi.mocked(runProcess).mockRejectedValueOnce(
      new Error("Process codex exited with code 1. rate limit exceeded")
    );

    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, {
          runtime: { provider: "codex", mode: "local_process" },
          resumeSessionId: "process-session-501",
        })
      )
    ).rejects.toThrow(/rate limit exceeded/);

    expect(vi.mocked(runProcess)).toHaveBeenCalledTimes(1);
  });
});

describe("CodexRuntime unsupported modes", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCodexConstructorCalls.length = 0;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-unsupported-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("throws for container mode", async () => {
    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, { runtime: { provider: "codex", mode: "container" } })
      )
    ).rejects.toThrow("Codex runtime supports only local_process and local_sdk modes");
  });

  it("throws for remote mode", async () => {
    const runtime = new CodexRuntime();
    await expect(
      runtime.runStep(
        makeContext(tmpDir, { runtime: { provider: "codex", mode: "remote" } })
      )
    ).rejects.toThrow("Codex runtime supports only local_process and local_sdk modes");
  });
});

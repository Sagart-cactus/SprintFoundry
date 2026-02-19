import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { RuntimeStepContext } from "../src/service/runtime/types.js";

// Module-level mock state — shared between factory closures and test assertions.
// Defined before any dynamic imports so they are initialized by the time factories are invoked.
const mockRunFn = vi.fn();
const mockStartThreadFn = vi.fn();
const mockCodexConstructorCalls: Array<{ env: Record<string, string> }> = [];

// vi.mock is hoisted, but factory bodies run lazily (at first import).
// By the time the factories execute, the module-level vars above are initialized.
vi.mock("@openai/codex-sdk", () => ({
  // Regular function (not arrow) so it can be used as a constructor with `new`.
  Codex: function MockCodex(this: any, opts: { env: Record<string, string> }) {
    mockCodexConstructorCalls.push({ env: opts?.env ?? {} });
    return { startThread: mockStartThreadFn };
  },
}));

vi.mock("../src/service/runtime/process-utils.js", () => ({
  runProcess: vi.fn(),
}));

const { runProcess } = await import("../src/service/runtime/process-utils.js");
const { CodexRuntime } = await import("../src/service/runtime/codex-runtime.js");

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

    mockRunFn.mockResolvedValue({
      usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 50 },
      finalResponse: "",
    });
    mockStartThreadFn.mockReturnValue({ id: "thread-sdk-123", run: mockRunFn });
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
    expect(runProcess).not.toHaveBeenCalled();
    expect(result.tokens_used).toBe(150); // 100 + 50
    expect(result.runtime_id).toBe("thread-sdk-123");
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

  it("returns zero tokens when usage is missing", async () => {
    mockRunFn.mockResolvedValue({ usage: null, finalResponse: "" });
    const runtime = new CodexRuntime();
    const result = await runtime.runStep(makeContext(tmpDir));

    expect(result.tokens_used).toBe(0);
  });

  it("returns empty runtime_id when thread.id is null/undefined", async () => {
    mockStartThreadFn.mockReturnValue({ id: undefined, run: mockRunFn });
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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { RuntimeStepContext } from "../src/service/runtime/types.js";

vi.mock("../src/service/runtime/process-utils.js", () => ({
  runProcess: vi.fn(),
}));

const { runProcess } = await import("../src/service/runtime/process-utils.js");
const { CodexRuntime } = await import("../src/service/runtime/codex-runtime.js");

function makeContext(workspacePath: string, overrides?: Partial<RuntimeStepContext>): RuntimeStepContext {
  return {
    stepNumber: overrides?.stepNumber ?? 7,
    stepAttempt: overrides?.stepAttempt ?? 1,
    agent: overrides?.agent ?? "developer",
    task: overrides?.task ?? "Security-focused QA check",
    context_inputs: overrides?.context_inputs ?? [{ type: "ticket" }],
    workspacePath,
    modelConfig: overrides?.modelConfig ?? { provider: "openai", model: "gpt-5" },
    apiKey: overrides?.apiKey ?? "sk-openai-top-secret",
    timeoutMinutes: overrides?.timeoutMinutes ?? 1,
    tokenBudget: overrides?.tokenBudget ?? 1000,
    previousStepResults: overrides?.previousStepResults ?? [],
    runtime: overrides?.runtime ?? { provider: "codex", mode: "local_process" },
    codexHomeDir: overrides?.codexHomeDir,
    codexSkillNames: overrides?.codexSkillNames,
    plugins: overrides?.plugins,
    cliFlags: overrides?.cliFlags,
    containerResources: overrides?.containerResources,
    containerImage: overrides?.containerImage,
  };
}

describe("CodexRuntime security handling", () => {
  let tmpDir: string;
  const originalEnv = { ...process.env };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-runtime-security-"));
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("does not forward unrelated parent env secrets to Codex subprocess", async () => {
    process.env.UNRELATED_PARENT_SECRET = "dont-forward-me";

    (runProcess as any).mockResolvedValue({
      tokensUsed: 12,
      runtimeId: "local-codex-123",
      stdout: "{}",
      stderr: "",
    });

    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir));

    const firstCallEnv = (runProcess as any).mock.calls[0][2].env as Record<string, string | undefined>;
    expect(firstCallEnv.UNRELATED_PARENT_SECRET).toBeUndefined();
  });

  it("does not drop CODEX_HOME based on a spoofable stdout string even when fallback is enabled", async () => {
    const spoofedAuthMessage = "401 Unauthorized: Missing bearer or basic authentication in header";

    (runProcess as any)
      .mockImplementationOnce(async (_command: string, _args: string[], options: { outputFiles?: { stdoutPath?: string } }) => {
        if (options.outputFiles?.stdoutPath) {
          await fs.writeFile(options.outputFiles.stdoutPath, `model said: ${spoofedAuthMessage}`, "utf-8");
        }
        throw new Error("Process codex exited with code 1. unrelated failure");
      })
      .mockResolvedValueOnce({
        tokensUsed: 34,
        runtimeId: "local-codex-456",
        stdout: "{}",
        stderr: "",
      });

    const runtime = new CodexRuntime();
    const context = makeContext(tmpDir, {
      runtime: {
        provider: "codex",
        mode: "local_process",
        env: {
          SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK: "1",
        },
      },
      codexHomeDir: path.join(tmpDir, ".codex-home"),
      codexSkillNames: ["security-policy"],
    });

    await expect(runtime.runStep(context)).rejects.toThrow(/exited with code 1/);
    expect((runProcess as any).mock.calls.length).toBe(1);
  });

  it("does not persist raw OPENAI_API_KEY value in debug artifacts", async () => {
    const apiKey = "sk-openai-never-log-this";

    (runProcess as any).mockResolvedValue({
      tokensUsed: 1,
      runtimeId: "local-codex-789",
      stdout: "{}",
      stderr: "",
    });

    const runtime = new CodexRuntime();
    await runtime.runStep(makeContext(tmpDir, { apiKey }));

    const debugPath = path.join(tmpDir, ".codex-runtime.debug.json");
    const debugContent = await fs.readFile(debugPath, "utf-8");
    expect(debugContent).not.toContain(apiKey);
  });

  it("retries without CODEX_HOME only when fallback is explicitly enabled and stderr has trusted auth signature", async () => {
    const trustedAuthMessage = "401 Unauthorized: Missing bearer or basic authentication in header";

    (runProcess as any)
      .mockImplementationOnce(async (_command: string, _args: string[], options: { outputFiles?: { stderrPath?: string } }) => {
        if (options.outputFiles?.stderrPath) {
          await fs.writeFile(options.outputFiles.stderrPath, trustedAuthMessage, "utf-8");
        }
        throw new Error("Process codex exited with code 1. auth failure");
      })
      .mockResolvedValueOnce({
        tokensUsed: 34,
        runtimeId: "local-codex-456",
        stdout: "{}",
        stderr: "",
      });

    const runtime = new CodexRuntime();
    const context = makeContext(tmpDir, {
      runtime: {
        provider: "codex",
        mode: "local_process",
        env: {
          SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK: "1",
        },
      },
      codexHomeDir: path.join(tmpDir, ".codex-home"),
      codexSkillNames: ["security-policy"],
    });

    await expect(runtime.runStep(context)).resolves.toMatchObject({
      runtime_id: "local-codex-456",
      tokens_used: 34,
    });
    expect((runProcess as any).mock.calls.length).toBe(2);
    const retryCallEnv = (runProcess as any).mock.calls[1][2].env as Record<string, string | undefined>;
    expect(retryCallEnv.CODEX_HOME).toBeUndefined();
  });
});

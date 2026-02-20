import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";
import type { AgentRunConfig } from "../src/service/agent-runner.js";
import type { RuntimeStepContext } from "../src/service/runtime/types.js";

const mockSdkRunFn = vi.fn();
const mockStartThreadFn = vi.fn();
const mockResumeThreadFn = vi.fn();
const mockCodexConstructorCalls: Array<{ env: Record<string, string> }> = [];

vi.mock("@openai/codex-sdk", () => ({
  Codex: function MockCodex(this: unknown, opts: { env: Record<string, string> }) {
    mockCodexConstructorCalls.push({ env: opts?.env ?? {} });
    return {
      startThread: mockStartThreadFn,
      resumeThread: mockResumeThreadFn,
    };
  },
}));

vi.mock("../src/service/runtime/process-utils.js", () => ({
  runProcess: vi.fn(),
}));

const { runProcess } = await import("../src/service/runtime/process-utils.js");
const { AgentRunner } = await import("../src/service/agent-runner.js");

function makeRunConfig(workspacePath: string): AgentRunConfig {
  return {
    stepNumber: 7,
    stepAttempt: 1,
    agent: "code-review",
    task: "Validate staged Codex skills are available and used",
    context_inputs: [{ type: "ticket" }],
    workspacePath,
    modelConfig: { provider: "openai", model: "gpt-5" },
    apiKey: "sk-openai-test-key",
    tokenBudget: 50_000,
    timeoutMinutes: 5,
    previousStepResults: [],
  };
}

describe("Codex local_sdk integration for code-review staged skills", () => {
  let tmpDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCodexConstructorCalls.length = 0;

    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-code-review-integration-"));

    mockSdkRunFn.mockResolvedValue({
      usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 60 },
      finalResponse: "ok",
    });
    mockStartThreadFn.mockReturnValue({ id: "thread-code-review-1", run: mockSdkRunFn });
    mockResumeThreadFn.mockResolvedValue({ id: "thread-code-review-resume-1", run: mockSdkRunFn });
    vi.mocked(runProcess).mockResolvedValue({
      tokensUsed: 210,
      runtimeId: "local-codex-process-1",
      stdout: "",
      stderr: "",
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("stages skills, injects CODEX_HOME/skills into local_sdk runtime, and leaves execution evidence", async () => {
    const workspacePath = path.join(tmpDir, "workspace");
    await fs.mkdir(workspacePath, { recursive: true });

    const skillNames = ["code-quality", "error-handling", "performance-review"];
    const catalog: Record<string, { path: string }> = {};
    for (const skillName of skillNames) {
      const sourceDir = path.join(tmpDir, "skill-catalog", skillName);
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "SKILL.md"), `# ${skillName}\n`, "utf-8");
      catalog[skillName] = { path: sourceDir };
    }

    await fs.writeFile(
      path.join(workspacePath, ".agent-result.json"),
      JSON.stringify(
        {
          status: "complete",
          summary: "Code review completed",
          artifacts_created: [],
          artifacts_modified: [],
          issues: [],
          metadata: {},
        },
        null,
        2
      ),
      "utf-8"
    );

    const runner = new AgentRunner(
      makePlatformConfig({
        defaults: {
          ...makePlatformConfig().defaults,
          codex_skills_enabled: true,
          codex_skill_catalog: catalog,
          codex_skills_per_agent: {
            "code-review": skillNames,
          },
        },
      }),
      makeProjectConfig({
        runtime_overrides: {
          "code-review": { provider: "codex", mode: "local_sdk" },
        },
      })
    );

    const runResult = await runner.run(makeRunConfig(workspacePath));

    const expectedCodexHome = path.join(workspacePath, ".codex-home");
    const expectedSkillsDir = path.join(expectedCodexHome, "skills");

    for (const skillName of skillNames) {
      await expect(
        fs.access(path.join(expectedSkillsDir, skillName, "SKILL.md"))
      ).resolves.toBeUndefined();
    }

    const manifest = JSON.parse(
      await fs.readFile(path.join(expectedSkillsDir, ".manifest.json"), "utf-8")
    ) as { skills: string[] };
    expect(manifest.skills).toEqual(skillNames);

    const agentsProfile = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf-8");
    expect(agentsProfile).toContain("## Runtime Skills");
    expect(agentsProfile).toContain("code-quality");
    expect(agentsProfile).toContain("error-handling");
    expect(agentsProfile).toContain("performance-review");

    expect(mockCodexConstructorCalls).toHaveLength(1);
    const constructorEnv = mockCodexConstructorCalls[0].env;
    expect(constructorEnv.CODEX_HOME).toBe(expectedCodexHome);
    expect(constructorEnv.OPENAI_API_KEY).toBe("sk-openai-test-key");
    expect(constructorEnv.OPENAI_MODEL).toBe("gpt-5");

    expect(mockStartThreadFn).toHaveBeenCalledOnce();
    expect(mockSdkRunFn).toHaveBeenCalledOnce();
    expect(runProcess).not.toHaveBeenCalled();

    const executedPrompt = vi.mocked(mockSdkRunFn).mock.calls[0]?.[0] as string;
    expect(executedPrompt).toContain("# Task for code-review Agent");
    expect(executedPrompt).toContain(
      "Skills available in CODEX_HOME: code-quality, error-handling, performance-review"
    );

    const debugPath = path.join(workspacePath, ".codex-runtime.step-7.attempt-1.debug.json");
    const debugPayload = JSON.parse(await fs.readFile(debugPath, "utf-8")) as {
      runtime_mode: string;
      codex_home: string;
      skill_names: string[];
    };
    expect(debugPayload.runtime_mode).toBe("local_sdk");
    expect(debugPayload.codex_home).toBe(expectedCodexHome);
    expect(debugPayload.skill_names).toEqual(skillNames);

    expect(runResult.tokens_used).toBe(180);
    expect(runResult.container_id).toBe("thread-code-review-1");
    expect(runResult.agentResult.status).toBe("complete");
  });

  it("matches local_sdk skill behavior in local_process mode and leaves runtime evidence", async () => {
    const workspacePath = path.join(tmpDir, "workspace-local-process");
    await fs.mkdir(workspacePath, { recursive: true });

    const skillNames = ["code-quality", "error-handling", "performance-review"];
    const catalog: Record<string, { path: string }> = {};
    for (const skillName of skillNames) {
      const sourceDir = path.join(tmpDir, "skill-catalog-local-process", skillName);
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(path.join(sourceDir, "SKILL.md"), `# ${skillName}\n`, "utf-8");
      catalog[skillName] = { path: sourceDir };
    }

    await fs.writeFile(
      path.join(workspacePath, ".agent-result.json"),
      JSON.stringify(
        {
          status: "complete",
          summary: "Code review completed",
          artifacts_created: [],
          artifacts_modified: [],
          issues: [],
          metadata: {},
        },
        null,
        2
      ),
      "utf-8"
    );

    vi.mocked(runProcess).mockImplementationOnce(
      async (
        _command: string,
        _args: string[],
        options: {
          cwd: string;
          env: Record<string, string | undefined>;
          timeoutMs: number;
          parseTokensFromStdout?: boolean;
          outputFiles?: { stdoutPath?: string; stderrPath?: string };
        }
      ) => {
        if (options.outputFiles?.stdoutPath) {
          await fs.writeFile(
            options.outputFiles.stdoutPath,
            "{\"type\":\"result\",\"usage\":{\"input_tokens\":90,\"output_tokens\":30}}\n",
            "utf-8"
          );
        }
        if (options.outputFiles?.stderrPath) {
          await fs.writeFile(options.outputFiles.stderrPath, "", "utf-8");
        }
        return {
          tokensUsed: 120,
          runtimeId: "local-codex-process-skill-test-1",
          stdout: "{\"type\":\"result\"}",
          stderr: "",
        };
      }
    );

    const runner = new AgentRunner(
      makePlatformConfig({
        defaults: {
          ...makePlatformConfig().defaults,
          codex_skills_enabled: true,
          codex_skill_catalog: catalog,
          codex_skills_per_agent: {
            "code-review": skillNames,
          },
        },
      }),
      makeProjectConfig({
        runtime_overrides: {
          "code-review": { provider: "codex", mode: "local_process" },
        },
      })
    );

    const runResult = await runner.run(makeRunConfig(workspacePath));

    const expectedCodexHome = path.join(workspacePath, ".codex-home");
    const expectedSkillsDir = path.join(expectedCodexHome, "skills");

    for (const skillName of skillNames) {
      await expect(
        fs.access(path.join(expectedSkillsDir, skillName, "SKILL.md"))
      ).resolves.toBeUndefined();
    }

    const manifest = JSON.parse(
      await fs.readFile(path.join(expectedSkillsDir, ".manifest.json"), "utf-8")
    ) as { skills: string[] };
    expect(manifest.skills).toEqual(skillNames);

    const agentsProfile = await fs.readFile(path.join(workspacePath, "AGENTS.md"), "utf-8");
    expect(agentsProfile).toContain("## Runtime Skills");
    expect(agentsProfile).toContain("code-quality");
    expect(agentsProfile).toContain("error-handling");
    expect(agentsProfile).toContain("performance-review");

    expect(mockCodexConstructorCalls).toHaveLength(0);
    expect(mockStartThreadFn).not.toHaveBeenCalled();
    expect(mockSdkRunFn).not.toHaveBeenCalled();
    expect(runProcess).toHaveBeenCalledOnce();

    const processCall = vi.mocked(runProcess).mock.calls[0] as [
      string,
      string[],
      {
        cwd: string;
        env: Record<string, string | undefined>;
      },
    ];
    const [command, args, options] = processCall;
    expect(command).toBe("codex");
    expect(args[0]).toBe("exec");
    expect(args[1]).toContain("Primary task: Validate staged Codex skills are available and used");
    expect(args[1]).toContain(
      "Skills available in CODEX_HOME: code-quality, error-handling, performance-review"
    );
    expect(options.cwd).toBe(workspacePath);
    expect(options.env.CODEX_HOME).toBe(expectedCodexHome);
    expect(options.env.OPENAI_API_KEY).toBe("sk-openai-test-key");
    expect(options.env.OPENAI_MODEL).toBe("gpt-5");

    const debugPath = path.join(workspacePath, ".codex-runtime.step-7.attempt-1.debug.json");
    const debugPayload = JSON.parse(await fs.readFile(debugPath, "utf-8")) as {
      runtime_mode: RuntimeStepContext["runtime"]["mode"];
      codex_home: string;
      skill_names: string[];
    };
    expect(debugPayload.runtime_mode).toBe("local_process");
    expect(debugPayload.codex_home).toBe(expectedCodexHome);
    expect(debugPayload.skill_names).toEqual(skillNames);

    const stepStdoutPath = path.join(workspacePath, ".codex-runtime.step-7.attempt-1.stdout.log");
    const legacyStdoutPath = path.join(workspacePath, ".codex-runtime.stdout.log");
    const stepStdout = await fs.readFile(stepStdoutPath, "utf-8");
    const legacyStdout = await fs.readFile(legacyStdoutPath, "utf-8");
    expect(stepStdout).toContain("\"usage\":{\"input_tokens\":90,\"output_tokens\":30}");
    expect(legacyStdout).toContain("\"usage\":{\"input_tokens\":90,\"output_tokens\":30}");

    expect(runResult.tokens_used).toBe(120);
    expect(runResult.container_id).toBe("local-codex-process-skill-test-1");
    expect(runResult.agentResult.status).toBe("complete");
  });
});

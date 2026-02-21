import type {
  AgentRuntime,
  RuntimeActivityEvent,
  RuntimeStepContext,
  RuntimeStepResult,
} from "./types.js";
import { runProcess } from "./process-utils.js";
import { Codex } from "@openai/codex-sdk";
import * as path from "path";
import * as fs from "fs/promises";
import type { RuntimeMetadataEnvelope } from "../../shared/types.js";

const FORWARDED_PARENT_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "TERM",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "NO_PROXY",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;
// Explicit opt-in guard for a narrow local CLI compatibility fallback.
const CODEX_HOME_FALLBACK_ENV_FLAG = "SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK";
const CODEX_AUTH_HEADER_ERROR_SIGNATURE =
  "401 Unauthorized: Missing bearer or basic authentication in header";
type ProcessRunResult = Awaited<ReturnType<typeof runProcess>>;
type CodexThreadHandle = {
  id?: unknown;
  run: (prompt: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
};
type ResumeTelemetry = {
  resume_used: boolean;
  resume_failed: boolean;
  resume_fallback: boolean;
};

export class CodexRuntime implements AgentRuntime {
  async runStep(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    if (config.runtime.mode !== "local_process" && config.runtime.mode !== "local_sdk") {
      throw new Error("Codex runtime supports only local_process and local_sdk modes");
    }
    if (config.runtime.mode === "local_sdk") return this.runSdk(config);
    return this.runLocalProcess(config);
  }

  private async runLocalProcess(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    await fs.mkdir(config.workspacePath, { recursive: true });

    const prompt = this.buildSynthesizedPrompt(config);
    const runtimeArgs = config.runtime.args ?? [];
    const hasSandboxFlag = runtimeArgs.includes("--sandbox") || runtimeArgs.includes("-s");
    const hasBypassFlag = runtimeArgs.includes("--dangerously-bypass-approvals-and-sandbox");
    const reasoningEffort = this.resolveModelReasoningEffort(config.runtime.model_reasoning_effort, config.modelConfig.model);
    const hasReasoningEffortArg = runtimeArgs.some(
      (arg) => arg.includes("model_reasoning_effort")
    );
    const args = [
      "exec",
      ...(reasoningEffort && !hasReasoningEffortArg
        ? ["--config", `model_reasoning_effort=\"${reasoningEffort}\"`]
        : []),
      prompt,
      "--json",
      ...(hasSandboxFlag || hasBypassFlag ? [] : ["--sandbox", "workspace-write"]),
    ];
    const env = this.buildRuntimeEnv(config);
    const codexHomeFallbackEnabled =
      process.env[CODEX_HOME_FALLBACK_ENV_FLAG] === "1" ||
      config.runtime.env?.[CODEX_HOME_FALLBACK_ENV_FLAG] === "1";

    const stepPrefix = `.codex-runtime.step-${config.stepNumber}.attempt-${config.stepAttempt}`;
    const legacyPaths = {
      debugPath: path.join(config.workspacePath, ".codex-runtime.debug.json"),
      stdoutPath: path.join(config.workspacePath, ".codex-runtime.stdout.log"),
      stderrPath: path.join(config.workspacePath, ".codex-runtime.stderr.log"),
    };
    const stepPaths = {
      debugPath: path.join(config.workspacePath, `${stepPrefix}.debug.json`),
      stdoutPath: path.join(config.workspacePath, `${stepPrefix}.stdout.log`),
      stderrPath: path.join(config.workspacePath, `${stepPrefix}.stderr.log`),
      retryStdoutPath: path.join(config.workspacePath, `${stepPrefix}.retry.stdout.log`),
      retryStderrPath: path.join(config.workspacePath, `${stepPrefix}.retry.stderr.log`),
    };
    const debugPayload: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_command: config.runtime.command ?? "codex",
      runtime_mode: config.runtime.mode,
      resume_session_id: config.resumeSessionId ?? "",
      runtime_args: runtimeArgs,
      has_sandbox_flag: hasSandboxFlag,
      has_bypass_flag: hasBypassFlag,
      openai_model: env.OPENAI_MODEL ?? "",
      openai_api_key_present: Boolean(env.OPENAI_API_KEY),
      codex_home: env.CODEX_HOME ?? "",
      codex_home_present: Boolean(env.CODEX_HOME),
      codex_home_fallback_enabled: codexHomeFallbackEnabled,
      skill_names: config.codexSkillNames ?? [],
    };
    await this.writeDebugFiles(stepPaths.debugPath, legacyPaths.debugPath, debugPayload);

    console.log(
      `[codex-runtime] Debug env: openai_model=${env.OPENAI_MODEL}, openai_api_key_present=${Boolean(env.OPENAI_API_KEY)}, codex_home_present=${Boolean(env.CODEX_HOME)}, skills=${(config.codexSkillNames ?? []).join(",") || "none"}`
    );

    const command = config.runtime.command ?? "codex";
    const baseOutputFiles = {
      stdoutPath: stepPaths.stdoutPath,
      stderrPath: stepPaths.stderrPath,
    };

    const runWithCurrentEnv = async (cliArgs: string[]) => {
      const processResult = await this.runProcessWithCodexHomeFallback({
        command,
        runtimeArgs,
        execArgs: cliArgs,
        config,
        env,
        codexHomeFallbackEnabled,
        outputPaths: {
          firstStdoutPath: baseOutputFiles.stdoutPath,
          firstStderrPath: baseOutputFiles.stderrPath,
          retryStdoutPath: stepPaths.retryStdoutPath,
          retryStderrPath: stepPaths.retryStderrPath,
        },
        debugPayload,
        debugPaths: {
          stepDebugPath: stepPaths.debugPath,
          legacyDebugPath: legacyPaths.debugPath,
        },
      });
      await this.copyLogPair(
        processResult.usedOutputPaths.stdoutPath,
        processResult.usedOutputPaths.stderrPath,
        legacyPaths.stdoutPath,
        legacyPaths.stderrPath
      );
      return processResult.result;
    };

    const resumeArgs = config.resumeSessionId
      ? [
        "exec",
        "resume",
        config.resumeSessionId,
        ...(reasoningEffort && !hasReasoningEffortArg
          ? ["--config", `model_reasoning_effort=\"${reasoningEffort}\"`]
          : []),
        prompt,
        "--json",
        ...(hasSandboxFlag || hasBypassFlag ? [] : ["--sandbox", "workspace-write"]),
      ]
      : null;

    const resumeUsed = Boolean(config.resumeSessionId);
    let resumeFailed = false;
    let resumeFallback = false;
    let result;
    if (resumeArgs) {
      try {
        result = await runWithCurrentEnv(resumeArgs);
      } catch (error) {
        resumeFailed = true;
        if (!this.isInvalidOrExpiredResumeError(error)) {
          throw this.withResumeTelemetry(error, {
            resume_used: resumeUsed,
            resume_failed: resumeFailed,
            resume_fallback: resumeFallback,
          });
        }
        resumeFallback = true;
        console.warn(
          `[codex-runtime] Resume run failed for session ${config.resumeSessionId}; retrying with fresh run.`
        );
        try {
          result = await runWithCurrentEnv(args);
        } catch (fallbackError) {
          throw this.withResumeTelemetry(fallbackError, {
            resume_used: resumeUsed,
            resume_failed: resumeFailed,
            resume_fallback: resumeFallback,
          });
        }
      }
    } else {
      result = await runWithCurrentEnv(args);
    }

    const usage = this.extractProcessUsage(result.stdout);
    const tokenSavings = usage ? this.extractTokenSavings(usage) : undefined;
    const runtimeMetadata = this.buildRuntimeMetadata(config, result.runtimeId, {
      usage,
      resume: this.buildResumeMetadata(config, {
        resume_used: resumeUsed,
        resume_failed: resumeFailed,
        resume_fallback: resumeFallback,
      }),
      token_savings: tokenSavings,
      provider_metadata: {
        output_parsing: usage ? "single_json" : "none",
      },
    });
    return {
      tokens_used: result.tokensUsed,
      runtime_id: result.runtimeId,
      usage,
      resume_used: resumeUsed,
      resume_failed: resumeFailed,
      resume_fallback: resumeFallback,
      token_savings: tokenSavings,
      runtime_metadata: runtimeMetadata,
    };
  }

  private async runSdk(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    await fs.mkdir(config.workspacePath, { recursive: true });

    const prompt = await this.buildSdkPrompt(config);

    const env = this.buildRuntimeEnv(config);

    const stepPrefix = `.codex-runtime.step-${config.stepNumber}.attempt-${config.stepAttempt}`;
    const legacyDebugPath = path.join(config.workspacePath, ".codex-runtime.debug.json");
    const stepDebugPath = path.join(config.workspacePath, `${stepPrefix}.debug.json`);
    const stepStdoutPath = path.join(config.workspacePath, `${stepPrefix}.stdout.log`);
    const stepStderrPath = path.join(config.workspacePath, `${stepPrefix}.stderr.log`);
    const legacyStdoutPath = path.join(config.workspacePath, ".codex-runtime.stdout.log");
    const legacyStderrPath = path.join(config.workspacePath, ".codex-runtime.stderr.log");

    const debugPayload: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      step_number: config.stepNumber,
      step_attempt: config.stepAttempt,
      runtime_mode: config.runtime.mode,
      openai_model: env.OPENAI_MODEL ?? "",
      openai_api_key_present: Boolean(env.OPENAI_API_KEY),
      codex_home: env.CODEX_HOME ?? "",
      codex_home_present: Boolean(env.CODEX_HOME),
      skill_names: config.codexSkillNames ?? [],
    };
    await this.writeDebugFiles(stepDebugPath, legacyDebugPath, debugPayload);

    console.log(
      `[codex-runtime] SDK mode: openai_model=${env.OPENAI_MODEL}, openai_api_key_present=${Boolean(env.OPENAI_API_KEY)}, codex_home_present=${Boolean(env.CODEX_HOME)}, skills=${(config.codexSkillNames ?? []).join(",") || "none"}`
    );

    const codex = new Codex({ env: env as Record<string, string> });
    const threadOptions: {
      workingDirectory: string;
      model: string;
      sandboxMode: "workspace-write";
      approvalPolicy: "never";
      skipGitRepoCheck: true;
      modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    } = {
      workingDirectory: config.workspacePath,
      model: config.modelConfig.model,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    };
    const sdkReasoningEffort = this.resolveModelReasoningEffort(
      config.runtime.model_reasoning_effort,
      config.modelConfig.model
    );
    if (sdkReasoningEffort) {
      threadOptions.modelReasoningEffort = sdkReasoningEffort;
    }
    const resumeUsed = Boolean(config.resumeSessionId);
    let resumeFailed = false;
    let resumeFallback = false;
    if (config.resumeSessionId) {
      let resumedThread: CodexThreadHandle | null = null;
      try {
        resumedThread = await this.startOrResumeSdkThread(codex, config, threadOptions);
      } catch (error) {
        resumeFailed = true;
        if (!this.isInvalidOrExpiredResumeError(error)) {
          throw this.withResumeTelemetry(error, {
            resume_used: resumeUsed,
            resume_failed: resumeFailed,
            resume_fallback: resumeFallback,
          });
        }
        resumeFallback = true;
        console.warn(
          `[codex-runtime] Resume run failed for session ${config.resumeSessionId}; retrying with fresh SDK thread.`
        );
        const freshThread = codex.startThread(threadOptions);
        let freshTurn;
        try {
          freshTurn = await this.runSdkTurnWithTimeout(
            (signal) => freshThread.run(prompt, { signal }),
            config.timeoutMinutes * 60 * 1000,
            config
          );
        } catch (fallbackError) {
          await this.writeSdkLogs({
            stepStdoutPath,
            stepStderrPath,
            legacyStdoutPath,
            legacyStderrPath,
            stdoutLines: [],
            stderrLines: [this.sdkErrorLine(fallbackError)],
          });
          throw this.withResumeTelemetry(fallbackError, {
            resume_used: resumeUsed,
            resume_failed: resumeFailed,
            resume_fallback: resumeFallback,
          });
        }
        const { usage, tokenSavings } = await this.captureSdkTurnTelemetry(
          config,
          freshTurn,
          this.extractSdkRuntimeId(freshThread),
          {
            stepStdoutPath,
            stepStderrPath,
            legacyStdoutPath,
            legacyStderrPath,
          }
        );
        const runtimeMetadata = this.buildRuntimeMetadata(config, this.extractSdkRuntimeId(freshThread), {
          usage,
          resume: this.buildResumeMetadata(config, {
            resume_used: resumeUsed,
            resume_failed: resumeFailed,
            resume_fallback: resumeFallback,
          }),
          token_savings: tokenSavings,
          provider_metadata: {
            output_parsing: "sdk_turn",
            session_id_source: "sdk_thread",
          },
        });
        return {
          tokens_used: this.extractSdkTokensUsed(usage),
          runtime_id: this.extractSdkRuntimeId(freshThread),
          usage,
          token_savings: tokenSavings,
          resume_used: resumeUsed,
          resume_failed: resumeFailed,
          resume_fallback: resumeFallback,
          runtime_metadata: runtimeMetadata,
        };
      }
      try {
        const resumedTurn = await this.runSdkTurnWithTimeout(
          (signal) => resumedThread.run(prompt, { signal }),
          config.timeoutMinutes * 60 * 1000,
          config
        );
        const { usage, tokenSavings } = await this.captureSdkTurnTelemetry(
          config,
          resumedTurn,
          this.extractSdkRuntimeId(resumedThread),
          {
            stepStdoutPath,
            stepStderrPath,
            legacyStdoutPath,
            legacyStderrPath,
          }
        );
        const runtimeMetadata = this.buildRuntimeMetadata(config, this.extractSdkRuntimeId(resumedThread), {
          usage,
          resume: this.buildResumeMetadata(config, {
            resume_used: resumeUsed,
            resume_failed: resumeFailed,
            resume_fallback: resumeFallback,
          }),
          token_savings: tokenSavings,
          provider_metadata: {
            output_parsing: "sdk_turn",
            session_id_source: "sdk_thread",
          },
        });
        return {
          tokens_used: this.extractSdkTokensUsed(usage),
          runtime_id: this.extractSdkRuntimeId(resumedThread),
          usage,
          token_savings: tokenSavings,
          resume_used: resumeUsed,
          resume_failed: resumeFailed,
          resume_fallback: resumeFallback,
          runtime_metadata: runtimeMetadata,
        };
      } catch (error) {
        await this.writeSdkLogs({
          stepStdoutPath,
          stepStderrPath,
          legacyStdoutPath,
          legacyStderrPath,
          stdoutLines: [],
          stderrLines: [this.sdkErrorLine(error)],
        });
        throw this.withResumeTelemetry(error, {
          resume_used: resumeUsed,
          resume_failed: resumeFailed,
          resume_fallback: resumeFallback,
        });
      }
    }

    const thread = codex.startThread(threadOptions);
    const turn = await this.runSdkTurnWithTimeout(
      (signal) => thread.run(prompt, { signal }),
      config.timeoutMinutes * 60 * 1000,
      config
    );
    const { usage, tokenSavings } = await this.captureSdkTurnTelemetry(
      config,
      turn,
      this.extractSdkRuntimeId(thread),
      {
        stepStdoutPath,
        stepStderrPath,
        legacyStdoutPath,
        legacyStderrPath,
      }
    );
    const runtimeMetadata = this.buildRuntimeMetadata(config, this.extractSdkRuntimeId(thread), {
      usage,
      resume: this.buildResumeMetadata(config, {
        resume_used: resumeUsed,
        resume_failed: resumeFailed,
        resume_fallback: resumeFallback,
      }),
      token_savings: tokenSavings,
      provider_metadata: {
        output_parsing: "sdk_turn",
        session_id_source: "sdk_thread",
      },
    });

    return {
      tokens_used: this.extractSdkTokensUsed(usage),
      runtime_id: this.extractSdkRuntimeId(thread),
      usage,
      token_savings: tokenSavings,
      resume_used: resumeUsed,
      resume_failed: resumeFailed,
      resume_fallback: resumeFallback,
      runtime_metadata: runtimeMetadata,
    };
  }

  private async captureSdkTurnTelemetry(
    config: RuntimeStepContext,
    turn: unknown,
    runtimeId: string,
    logPaths: {
      stepStdoutPath: string;
      stepStderrPath: string;
      legacyStdoutPath: string;
      legacyStderrPath: string;
    }
  ): Promise<{
    usage: Record<string, number>;
    tokenSavings?: Record<string, number>;
  }> {
    const usage = this.extractSdkUsage(turn);
    const tokenSavings = this.extractTokenSavings(usage);
    const activityEvents = this.extractSdkActivityEvents(turn);
    await this.emitSdkActivityEvents(config, activityEvents);
    const stdoutLines = this.buildSdkStdoutLines({
      runtimeId,
      usage,
      activityEvents,
      finalResponse: this.extractSdkFinalResponse(turn),
    });
    await this.writeSdkLogs({
      ...logPaths,
      stdoutLines,
      stderrLines: [],
    });
    return { usage, tokenSavings };
  }

  private async startOrResumeSdkThread(
    codex: Codex,
    config: RuntimeStepContext,
    threadOptions: {
      workingDirectory: string;
      model: string;
      sandboxMode: "workspace-write";
      approvalPolicy: "never";
      skipGitRepoCheck: true;
      modelReasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
    }
  ): Promise<CodexThreadHandle> {
    if (!config.resumeSessionId) {
      return codex.startThread(threadOptions) as CodexThreadHandle;
    }
    const resumableCodex = codex as Codex & {
      resumeThread: (
        sessionId: string,
        options: typeof threadOptions
      ) => Promise<CodexThreadHandle> | CodexThreadHandle;
    };
    return await resumableCodex.resumeThread(config.resumeSessionId, threadOptions);
  }

  private async runProcessWithCodexHomeFallback(params: {
    command: string;
    runtimeArgs: string[];
    execArgs: string[];
    config: RuntimeStepContext;
    env: Record<string, string | undefined>;
    codexHomeFallbackEnabled: boolean;
    outputPaths: {
      firstStdoutPath: string;
      firstStderrPath: string;
      retryStdoutPath: string;
      retryStderrPath: string;
    };
    debugPayload: Record<string, unknown>;
    debugPaths: {
      stepDebugPath: string;
      legacyDebugPath: string;
    };
  }): Promise<{
    result: ProcessRunResult;
    usedOutputPaths: { stdoutPath: string; stderrPath: string };
  }> {
    try {
      const result = await runProcess(
        params.command,
        [...params.runtimeArgs, ...params.execArgs],
        {
          cwd: params.config.workspacePath,
          env: params.env,
          timeoutMs: params.config.timeoutMinutes * 60 * 1000,
          parseTokensFromStdout: true,
          outputFiles: {
            stdoutPath: params.outputPaths.firstStdoutPath,
            stderrPath: params.outputPaths.firstStderrPath,
          },
        }
      );
      return {
        result,
        usedOutputPaths: {
          stdoutPath: params.outputPaths.firstStdoutPath,
          stderrPath: params.outputPaths.firstStderrPath,
        },
      };
    } catch (error) {
      const firstStderr = await fs
        .readFile(params.outputPaths.firstStderrPath, "utf-8")
        .catch(() => "");
      // Keep behavior decision: preserve a single bounded retry for local CLI auth-header 401s.
      // Simplification rejected: removing this retry regresses staged CODEX_HOME compatibility.
      // Security guardrails:
      // - opt-in only via CODEX_HOME_FALLBACK_ENV_FLAG;
      // - trusted stderr signature only (never stdout);
      // - single retry without CODEX_HOME, then normal error propagation.
      if (
        this.shouldRetryWithoutCodexHome(
          params.env,
          error,
          firstStderr,
          params.codexHomeFallbackEnabled
        )
      ) {
        console.warn(
          "[codex-runtime] Retrying once without CODEX_HOME after trusted auth-header failure."
        );
        const fallbackEnv = { ...params.env };
        delete fallbackEnv.CODEX_HOME;
        const fallbackPayload = {
          ...params.debugPayload,
          fallback_without_codex_home: true,
          fallback_reason: "trusted_auth_header_error",
        };
        await this.writeDebugFiles(
          params.debugPaths.stepDebugPath,
          params.debugPaths.legacyDebugPath,
          fallbackPayload
        );
        const result = await runProcess(
          params.command,
          [...params.runtimeArgs, ...params.execArgs],
          {
            cwd: params.config.workspacePath,
            env: fallbackEnv,
            timeoutMs: params.config.timeoutMinutes * 60 * 1000,
            parseTokensFromStdout: true,
            outputFiles: {
              stdoutPath: params.outputPaths.retryStdoutPath,
              stderrPath: params.outputPaths.retryStderrPath,
            },
          }
        );
        return {
          result,
          usedOutputPaths: {
            stdoutPath: params.outputPaths.retryStdoutPath,
            stderrPath: params.outputPaths.retryStderrPath,
          },
        };
      }
      throw error;
    }
  }

  private buildRuntimeEnv(config: RuntimeStepContext): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const key of FORWARDED_PARENT_ENV_KEYS) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
    if (config.apiKey) {
      env.OPENAI_API_KEY = config.apiKey;
    }
    env.OPENAI_MODEL = config.modelConfig.model;
    if (config.codexHomeDir) {
      env.CODEX_HOME = config.codexHomeDir;
    }
    for (const [key, value] of Object.entries(config.runtime.env ?? {})) {
      env[key] = value;
    }
    return env;
  }

  private resolveModelReasoningEffort(
    effort: RuntimeStepContext["runtime"]["model_reasoning_effort"] | undefined,
    model: string
  ): RuntimeStepContext["runtime"]["model_reasoning_effort"] | undefined {
    if (!effort) return undefined;
    return this.isCodexModel(model) ? effort : undefined;
  }

  private isCodexModel(model: string): boolean {
    return /codex/i.test(model);
  }

  private shouldRetryWithoutCodexHome(
    env: Record<string, string | undefined>,
    error: unknown,
    stderrOutput: string,
    codexHomeFallbackEnabled: boolean
  ): boolean {
    // Guarded fallback contract:
    // - opt-in only: disabled unless explicit flag enables it;
    // - trusted signal only: exact auth-header signature from stderr (not stdout);
    // - bounded behavior: requires non-zero process exit and retries only once upstream.
    if (!env.CODEX_HOME || !codexHomeFallbackEnabled) return false;
    if (!(error instanceof Error)) return false;
    const errorMessage = error.message.toLowerCase();
    const hasExitCodeSignal = /exited with code\s+[1-9]\d*/i.test(errorMessage);
    const trustedAuthSignal = stderrOutput.includes(CODEX_AUTH_HEADER_ERROR_SIGNATURE);
    return hasExitCodeSignal && trustedAuthSignal;
  }

  private buildSynthesizedPrompt(config: RuntimeStepContext): string {
    return [
      "You are executing one agent step in SprintFoundry.",
      `Primary task: ${config.task}`,
      "Read .agent-task.md and AGENTS.md, then complete the actual work requested there.",
      config.codexSkillNames && config.codexSkillNames.length > 0
        ? `Skills available in CODEX_HOME: ${config.codexSkillNames.join(", ")}. Use them when relevant.`
        : "No additional runtime skills were provided for this step.",
      "Create/modify the required project artifacts and code files first.",
      "Do not stop after only updating .agent-result.json.",
      "Only after doing the real work, write .agent-result.json with accurate status and artifact lists.",
      "If truly blocked, set status=blocked or needs_rework with concrete issues.",
    ].join("\n");
  }

  private async buildSdkPrompt(config: RuntimeStepContext): Promise<string> {
    const taskPrompt = await this.readWorkspaceTaskPrompt(config.workspacePath);
    if (!taskPrompt) {
      return this.buildSynthesizedPrompt(config);
    }
    return [
      "You are executing one agent step in SprintFoundry.",
      `Primary task: ${config.task}`,
      "Follow the workspace task file contents below as the primary step instructions.",
      "",
      "# .agent-task.md",
      taskPrompt,
      "",
      config.codexSkillNames && config.codexSkillNames.length > 0
        ? `Skills available in CODEX_HOME: ${config.codexSkillNames.join(", ")}. Use them when relevant.`
        : "No additional runtime skills were provided for this step.",
      "Create/modify the required project artifacts and code files first.",
      "Do not stop after only updating .agent-result.json.",
      "Only after doing the real work, write .agent-result.json with accurate status and artifact lists.",
      "If truly blocked, set status=blocked or needs_rework with concrete issues.",
    ].join("\n");
  }

  private async readWorkspaceTaskPrompt(workspacePath: string): Promise<string | undefined> {
    const taskPath = path.join(workspacePath, ".agent-task.md");
    try {
      const taskPrompt = await fs.readFile(taskPath, "utf-8");
      const trimmed = taskPrompt.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }

  private async runSdkTurnWithTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>,
    timeoutMs: number,
    config: RuntimeStepContext
  ): Promise<T> {
    const controller = new AbortController();
    const effectiveTimeoutMs = Math.max(0, timeoutMs);
    const timeoutError = new Error(
      `Codex SDK run timed out after ${effectiveTimeoutMs}ms (step=${config.stepNumber}, attempt=${config.stepAttempt})`
    );

    if (effectiveTimeoutMs === 0) {
      controller.abort(timeoutError);
      throw timeoutError;
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const runResultPromise = run(controller.signal);
    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const settle = (handler: () => void) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
        }
        handler();
      };
      timeoutHandle = setTimeout(() => {
        controller.abort(timeoutError);
        settle(() => reject(timeoutError));
      }, effectiveTimeoutMs);

      runResultPromise.then(
        (turn) => settle(() => resolve(turn)),
        (error) => settle(() => reject(error))
      );
    });
  }

  private extractSdkTokensUsed(usage: Record<string, number>): number {
    return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }

  private extractSdkUsage(turn: unknown): Record<string, number> {
    if (!turn || typeof turn !== "object") {
      return {
        input_tokens: 0,
        cached_input_tokens: 0,
        output_tokens: 0,
      };
    }
    const usage =
      (turn as {
        usage?: {
          input_tokens?: number;
          cached_input_tokens?: number;
          output_tokens?: number;
        } | null;
      }).usage ?? null;
    return {
      input_tokens: usage?.input_tokens ?? 0,
      cached_input_tokens: usage?.cached_input_tokens ?? 0,
      output_tokens: usage?.output_tokens ?? 0,
    };
  }

  private extractSdkActivityEvents(turn: unknown): RuntimeActivityEvent[] {
    if (!this.isRecord(turn)) return [];
    const items = Array.isArray(turn.items) ? turn.items : [];
    const events: RuntimeActivityEvent[] = [];
    for (const item of items) {
      if (!this.isRecord(item)) continue;
      const lowerType = this.pickString(item, ["type"]).toLowerCase();
      const command =
        this.pickString(item, ["command", "cmd"]) ||
        (this.isRecord(item.input) ? this.pickString(item.input, ["command", "cmd"]) : "");
      const filePath =
        this.pickString(item, ["path", "file_path", "target_path"]) ||
        (this.isRecord(item.input) ? this.pickString(item.input, ["path", "file_path", "target_path"]) : "");
      const toolName =
        this.pickString(item, ["tool_name", "name"]) ||
        (this.isRecord(item.input) ? this.pickString(item.input, ["tool_name", "name"]) : "");
      const text =
        this.pickString(item, ["text", "message", "output_text"]) ||
        this.textFromValue(item.output) ||
        this.textFromValue(item.content) ||
        (this.isRecord(item.input) ? this.pickString(item.input, ["text", "message"]) : "");

      if (command) {
        events.push({
          type: "agent_command_run",
          data: {
            command: this.truncate(command, 240),
            ...(toolName ? { tool_name: toolName } : {}),
          },
        });
        continue;
      }

      if (filePath) {
        events.push({
          type: "agent_file_edit",
          data: {
            path: filePath,
            ...(toolName ? { tool_name: toolName } : {}),
          },
        });
        continue;
      }

      if (toolName) {
        events.push({
          type: "agent_tool_call",
          data: {
            tool_name: toolName,
          },
        });
        continue;
      }

      if (lowerType.includes("thought") || lowerType.includes("reason")) {
        events.push({
          type: "agent_thinking",
          data: {
            kind: lowerType || "thought",
            text: this.truncate(text || "thinking", 300),
          },
        });
      }
    }
    return events;
  }

  private buildSdkStdoutLines(params: {
    runtimeId: string;
    usage: Record<string, number>;
    activityEvents: RuntimeActivityEvent[];
    finalResponse: string;
  }): string[] {
    const lines: string[] = [];
    if (params.runtimeId) {
      lines.push(
        JSON.stringify({
          type: "thread.started",
          thread_id: params.runtimeId,
        })
      );
    }
    for (const activity of params.activityEvents) {
      lines.push(JSON.stringify(this.sdkActivityToLogItem(activity)));
    }
    if (params.finalResponse) {
      lines.push(
        JSON.stringify({
          type: "agent_message",
          item: {
            type: "agent_message",
            message: this.truncate(params.finalResponse, 1200),
          },
        })
      );
    }
    lines.push(
      JSON.stringify({
        type: "turn.completed",
        usage: params.usage,
      })
    );
    return lines;
  }

  private sdkActivityToLogItem(activity: RuntimeActivityEvent): Record<string, unknown> {
    if (activity.type === "agent_command_run") {
      return {
        type: "command_execution",
        item: {
          type: "command_execution",
          command: activity.data.command ?? "",
          tool_name: activity.data.tool_name ?? "",
        },
      };
    }
    if (activity.type === "agent_file_edit") {
      return {
        type: "file_edit",
        item: {
          type: "file_edit",
          path: activity.data.path ?? "",
          tool_name: activity.data.tool_name ?? "",
        },
      };
    }
    if (activity.type === "agent_tool_call") {
      return {
        type: "tool_call",
        item: {
          type: "tool_call",
          tool_name: activity.data.tool_name ?? "",
        },
      };
    }
    return {
      type: "thought",
      item: {
        type: "thought",
        text: activity.data.text ?? activity.data.kind ?? "",
      },
    };
  }

  private async emitSdkActivityEvents(
    config: RuntimeStepContext,
    events: RuntimeActivityEvent[]
  ): Promise<void> {
    if (!config.onActivity || events.length === 0) return;
    for (const event of events) {
      try {
        await config.onActivity(event);
      } catch (error) {
        console.warn(
          `[codex-runtime] Failed to emit activity event ${event.type}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private async writeSdkLogs(params: {
    stepStdoutPath: string;
    stepStderrPath: string;
    legacyStdoutPath: string;
    legacyStderrPath: string;
    stdoutLines: string[];
    stderrLines: string[];
  }): Promise<void> {
    const stdout = params.stdoutLines.join("\n");
    const stderr = params.stderrLines.join("\n");
    await Promise.all([
      fs.writeFile(params.stepStdoutPath, stdout, "utf-8"),
      fs.writeFile(params.stepStderrPath, stderr, "utf-8"),
      fs.writeFile(params.legacyStdoutPath, stdout, "utf-8"),
      fs.writeFile(params.legacyStderrPath, stderr, "utf-8"),
    ]);
  }

  private extractSdkFinalResponse(turn: unknown): string {
    if (!this.isRecord(turn)) return "";
    const fromTop =
      this.pickString(turn, ["finalResponse", "output_text", "text", "message"]) ||
      this.textFromValue(turn.output);
    if (fromTop) return fromTop;
    return "";
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object";
  }

  private pickString(value: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const candidate = value[key];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    return "";
  }

  private textFromValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((entry) => (this.isRecord(entry) ? this.pickString(entry, ["text", "message", "output_text"]) : ""))
        .filter(Boolean)
        .join("\n");
    }
    if (this.isRecord(value)) return this.pickString(value, ["text", "message", "output_text"]);
    return "";
  }

  private truncate(value: string, maxLength: number): string {
    const normalized = String(value ?? "");
    if (normalized.length <= maxLength) return normalized;
    return `${normalized.slice(0, maxLength)}...`;
  }

  private sdkErrorLine(error: unknown): string {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  private extractProcessUsage(stdout: string): Record<string, number> | undefined {
    const trimmed = stdout.trim();
    if (!trimmed) return undefined;
    const candidates = trimmed.split(/\r?\n/).reverse();
    for (const candidate of candidates) {
      const usage = this.extractUsageFromJsonCandidate(candidate.trim());
      if (usage) return usage;
    }
    return this.extractUsageFromJsonCandidate(trimmed);
  }

  private extractUsageFromJsonCandidate(jsonText: string): Record<string, number> | undefined {
    if (!jsonText || (!jsonText.startsWith("{") && !jsonText.startsWith("["))) return undefined;
    try {
      const parsed = JSON.parse(jsonText) as Record<string, unknown>;
      const usageRecord =
        parsed["usage"] && typeof parsed["usage"] === "object" && parsed["usage"] !== null
          ? (parsed["usage"] as Record<string, unknown>)
          : undefined;
      if (!usageRecord) return undefined;
      const normalized: Record<string, number> = {};
      for (const [key, value] of Object.entries(usageRecord)) {
        if (typeof value === "number" && Number.isFinite(value)) {
          normalized[key] = value;
          continue;
        }
        if (typeof value === "string") {
          const parsedNumber = Number(value);
          if (Number.isFinite(parsedNumber)) normalized[key] = parsedNumber;
        }
      }
      return Object.keys(normalized).length > 0 ? normalized : undefined;
    } catch {
      return undefined;
    }
  }

  private extractTokenSavings(usage: Record<string, number>): Record<string, number> | undefined {
    const cachedInputTokens = usage.cached_input_tokens ?? 0;
    if (cachedInputTokens <= 0) return undefined;
    return {
      cached_input_tokens: cachedInputTokens,
    };
  }

  private buildRuntimeMetadata(
    config: RuntimeStepContext,
    runtimeId: string,
    extras?: Omit<RuntimeMetadataEnvelope, "schema_version" | "runtime">
  ): RuntimeMetadataEnvelope {
    return {
      schema_version: 1,
      runtime: {
        provider: config.runtime.provider,
        mode: config.runtime.mode,
        runtime_id: runtimeId,
        step_attempt: config.stepAttempt,
      },
      ...extras,
    };
  }

  private buildResumeMetadata(
    config: RuntimeStepContext,
    telemetry: ResumeTelemetry
  ): RuntimeMetadataEnvelope["resume"] | undefined {
    if (!config.resumeSessionId && !telemetry.resume_used) return undefined;
    return {
      requested: Boolean(config.resumeSessionId),
      used: telemetry.resume_used,
      failed: telemetry.resume_failed,
      fallback_to_fresh: telemetry.resume_fallback,
      source_session_id: config.resumeSessionId,
      reason: config.resumeReason,
    };
  }

  private isInvalidOrExpiredResumeError(error: unknown): boolean {
    const message = this.resumeErrorMessage(error).toLowerCase();
    if (!message) return false;
    const hasResumeSubject =
      /\b(session|thread|resume)\b/.test(message) ||
      /\bsession[_\s-]*id\b/.test(message) ||
      /\bthread[_\s-]*id\b/.test(message);
    if (!hasResumeSubject) return false;
    return /\b(invalid|expired|not found|unknown)\b/.test(message);
  }

  private resumeErrorMessage(error: unknown): string {
    if (!error) return "";
    if (error instanceof Error) {
      const parts = [error.message];
      const maybeCode = (error as Error & { code?: unknown; category?: unknown; name?: unknown });
      if (typeof maybeCode.code === "string") parts.push(maybeCode.code);
      if (typeof maybeCode.category === "string") parts.push(maybeCode.category);
      if (typeof maybeCode.name === "string") parts.push(maybeCode.name);
      return parts.filter(Boolean).join(" ");
    }
    if (typeof error === "string") return error;
    if (typeof error === "object") {
      try {
        return JSON.stringify(error);
      } catch {
        return String(error);
      }
    }
    return String(error);
  }

  private extractSdkRuntimeId(thread: unknown): string {
    if (!thread || typeof thread !== "object") return "";
    const id = (thread as { id?: unknown }).id;
    return typeof id === "string" ? id : "";
  }

  private withResumeTelemetry(
    error: unknown,
    telemetry: ResumeTelemetry
  ): Error & ResumeTelemetry {
    const baseError =
      error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
    const enriched = baseError as Error & ResumeTelemetry;
    enriched.resume_used = telemetry.resume_used;
    enriched.resume_failed = telemetry.resume_failed;
    enriched.resume_fallback = telemetry.resume_fallback;
    return enriched;
  }

  private async writeDebugFiles(
    stepDebugPath: string,
    legacyDebugPath: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const content = JSON.stringify(payload, null, 2);
    await Promise.all([
      fs.writeFile(stepDebugPath, content, "utf-8"),
      fs.writeFile(legacyDebugPath, content, "utf-8"),
    ]);
  }

  private async copyLogPair(
    sourceStdoutPath: string,
    sourceStderrPath: string,
    legacyStdoutPath: string,
    legacyStderrPath: string
  ): Promise<void> {
    const stdout = await fs.readFile(sourceStdoutPath, "utf-8").catch(() => "");
    const stderr = await fs.readFile(sourceStderrPath, "utf-8").catch(() => "");
    await Promise.all([
      fs.writeFile(legacyStdoutPath, stdout, "utf-8"),
      fs.writeFile(legacyStderrPath, stderr, "utf-8"),
    ]);
  }
}

import type { AgentRuntime, RuntimeStepContext, RuntimeStepResult } from "./types.js";
import { runProcess } from "./process-utils.js";
import { Codex } from "@openai/codex-sdk";
import * as path from "path";
import * as fs from "fs/promises";

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
const CODEX_HOME_FALLBACK_ENV_FLAG = "SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK";
const CODEX_AUTH_HEADER_ERROR_SIGNATURE =
  "401 Unauthorized: Missing bearer or basic authentication in header";
type ProcessRunResult = Awaited<ReturnType<typeof runProcess>>;
type CodexThreadHandle = {
  id?: unknown;
  run: (prompt: string, options?: { signal?: AbortSignal }) => Promise<unknown>;
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

    let result;
    if (resumeArgs) {
      try {
        result = await runWithCurrentEnv(resumeArgs);
      } catch (error) {
        console.warn(
          `[codex-runtime] Resume run failed for session ${config.resumeSessionId}; retrying with fresh run.`
        );
        result = await runWithCurrentEnv(args);
      }
    } else {
      result = await runWithCurrentEnv(args);
    }

    return {
      tokens_used: result.tokensUsed,
      runtime_id: result.runtimeId,
    };
  }

  private async runSdk(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    await fs.mkdir(config.workspacePath, { recursive: true });

    const prompt = await this.buildSdkPrompt(config);

    const env = this.buildRuntimeEnv(config);

    const stepPrefix = `.codex-runtime.step-${config.stepNumber}.attempt-${config.stepAttempt}`;
    const legacyDebugPath = path.join(config.workspacePath, ".codex-runtime.debug.json");
    const stepDebugPath = path.join(config.workspacePath, `${stepPrefix}.debug.json`);

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
    if (config.resumeSessionId) {
      try {
        const resumedThread = await this.startOrResumeSdkThread(codex, config, threadOptions);
        const resumedTurn = await this.runSdkTurnWithTimeout(
          (signal) => resumedThread.run(prompt, { signal }),
          config.timeoutMinutes * 60 * 1000,
          config
        );
        return {
          tokens_used: this.extractSdkTokensUsed(resumedTurn),
          runtime_id: this.extractSdkRuntimeId(resumedThread),
        };
      } catch {
        console.warn(
          `[codex-runtime] Resume run failed for session ${config.resumeSessionId}; retrying with fresh SDK thread.`
        );
        const freshThread = codex.startThread(threadOptions);
        const freshTurn = await this.runSdkTurnWithTimeout(
          (signal) => freshThread.run(prompt, { signal }),
          config.timeoutMinutes * 60 * 1000,
          config
        );
        return {
          tokens_used: this.extractSdkTokensUsed(freshTurn),
          runtime_id: this.extractSdkRuntimeId(freshThread),
        };
      }
    }

    const thread = codex.startThread(threadOptions);
    const turn = await this.runSdkTurnWithTimeout(
      (signal) => thread.run(prompt, { signal }),
      config.timeoutMinutes * 60 * 1000,
      config
    );

    return {
      tokens_used: this.extractSdkTokensUsed(turn),
      runtime_id: this.extractSdkRuntimeId(thread),
    };
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
      // Security rationale: this retry can only happen when a trusted auth-header signature
      // is seen on stderr and the fallback flag is explicitly enabled. We avoid stdout-triggered
      // retries to prevent spoofable model output from mutating execution environment behavior.
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
    // Security rationale:
    // - opt-in only: retry is disabled unless an explicit env flag enables it;
    // - trusted signal only: match auth-header signature from process stderr, not stdout;
    // - bounded behavior: only retry after a non-zero process exit to avoid silent loops.
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

  private extractSdkTokensUsed(turn: unknown): number {
    if (!turn || typeof turn !== "object") return 0;
    const usage =
      (turn as { usage?: { input_tokens?: number; output_tokens?: number } | null }).usage ??
      null;
    return (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0);
  }

  private extractSdkRuntimeId(thread: unknown): string {
    if (!thread || typeof thread !== "object") return "";
    const id = (thread as { id?: unknown }).id;
    return typeof id === "string" ? id : "";
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

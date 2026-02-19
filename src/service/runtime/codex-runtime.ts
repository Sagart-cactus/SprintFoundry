import type { AgentRuntime, RuntimeStepContext, RuntimeStepResult } from "./types.js";
import { runProcess } from "./process-utils.js";
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

export class CodexRuntime implements AgentRuntime {
  async runStep(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    if (config.runtime.mode !== "local_process") {
      throw new Error("Codex runtime currently supports only local_process mode");
    }
    await fs.mkdir(config.workspacePath, { recursive: true });

    const prompt = [
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
    const runtimeArgs = config.runtime.args ?? [];
    const hasSandboxFlag = runtimeArgs.includes("--sandbox") || runtimeArgs.includes("-s");
    const hasBypassFlag = runtimeArgs.includes("--dangerously-bypass-approvals-and-sandbox");
    const args = [
      "exec",
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

    let result;
    try {
      result = await runProcess(command, [...runtimeArgs, ...args], {
        cwd: config.workspacePath,
        env,
        timeoutMs: config.timeoutMinutes * 60 * 1000,
        parseTokensFromStdout: true,
        outputFiles: baseOutputFiles,
      });
      await this.copyLogPair(
        baseOutputFiles.stdoutPath,
        baseOutputFiles.stderrPath,
        legacyPaths.stdoutPath,
        legacyPaths.stderrPath
      );
    } catch (error) {
      const firstStderr = await fs.readFile(baseOutputFiles.stderrPath, "utf-8").catch(() => "");
      if (this.shouldRetryWithoutCodexHome(env, error, firstStderr, codexHomeFallbackEnabled)) {
        console.warn(
          "[codex-runtime] Retrying once without CODEX_HOME after trusted auth-header failure."
        );
        const fallbackEnv = { ...env };
        delete fallbackEnv.CODEX_HOME;
        await fs.writeFile(
          stepPaths.debugPath,
          JSON.stringify(
            {
              ...debugPayload,
              fallback_without_codex_home: true,
              fallback_reason: "trusted_auth_header_error",
            },
            null,
            2
          ),
          "utf-8"
        );
        await fs.writeFile(
          legacyPaths.debugPath,
          JSON.stringify(
            {
              ...debugPayload,
              fallback_without_codex_home: true,
              fallback_reason: "trusted_auth_header_error",
            },
            null,
            2
          ),
          "utf-8"
        );
        result = await runProcess(command, [...runtimeArgs, ...args], {
          cwd: config.workspacePath,
          env: fallbackEnv,
          timeoutMs: config.timeoutMinutes * 60 * 1000,
          parseTokensFromStdout: true,
          outputFiles: {
            stdoutPath: stepPaths.retryStdoutPath,
            stderrPath: stepPaths.retryStderrPath,
          },
        });
        await this.copyLogPair(
          stepPaths.retryStdoutPath,
          stepPaths.retryStderrPath,
          legacyPaths.stdoutPath,
          legacyPaths.stderrPath
        );
      } else {
        await this.copyLogPair(
          baseOutputFiles.stdoutPath,
          baseOutputFiles.stderrPath,
          legacyPaths.stdoutPath,
          legacyPaths.stderrPath
        );
        throw error;
      }
    }

    return {
      tokens_used: result.tokensUsed,
      runtime_id: result.runtimeId,
    };
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

  private shouldRetryWithoutCodexHome(
    env: Record<string, string | undefined>,
    error: unknown,
    stderrOutput: string,
    codexHomeFallbackEnabled: boolean
  ): boolean {
    if (!env.CODEX_HOME || !codexHomeFallbackEnabled) return false;
    if (!(error instanceof Error)) return false;
    const errorMessage = error.message.toLowerCase();
    const hasExitCodeSignal = /exited with code\s+[1-9]\d*/i.test(errorMessage);
    const trustedAuthSignal = stderrOutput.includes(CODEX_AUTH_HEADER_ERROR_SIGNATURE);
    return hasExitCodeSignal && trustedAuthSignal;
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

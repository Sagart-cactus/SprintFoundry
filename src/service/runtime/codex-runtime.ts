import type { AgentRuntime, RuntimeStepContext, RuntimeStepResult } from "./types.js";
import { runProcess } from "./process-utils.js";
import * as path from "path";
import * as fs from "fs/promises";

export class CodexRuntime implements AgentRuntime {
  async runStep(config: RuntimeStepContext): Promise<RuntimeStepResult> {
    if (config.runtime.mode !== "local_process") {
      throw new Error("Codex runtime currently supports only local_process mode");
    }

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
    const args = ["exec", prompt, "--json", ...(hasSandboxFlag ? [] : ["--sandbox", "workspace-write"])];
    const env = {
      ...process.env,
      ...(config.apiKey ? { OPENAI_API_KEY: config.apiKey } : {}),
      OPENAI_MODEL: config.modelConfig.model,
      ...(config.codexHomeDir ? { CODEX_HOME: config.codexHomeDir } : {}),
      ...(config.runtime.env ?? {}),
    };

    // Runtime-auth debugging without exposing secrets.
    const debugPath = path.join(config.workspacePath, ".codex-runtime.debug.json");
    await fs.writeFile(
      debugPath,
      JSON.stringify(
        {
          timestamp: new Date().toISOString(),
          runtime_command: config.runtime.command ?? "codex",
          runtime_mode: config.runtime.mode,
          runtime_args: runtimeArgs,
          has_sandbox_flag: hasSandboxFlag,
          openai_model: env.OPENAI_MODEL ?? "",
          openai_api_key_present: Boolean(env.OPENAI_API_KEY),
          codex_home: env.CODEX_HOME ?? "",
          codex_home_present: Boolean(env.CODEX_HOME),
          skill_names: config.codexSkillNames ?? [],
        },
        null,
        2
      ),
      "utf-8"
    );

    console.log(
      `[codex-runtime] Debug env: openai_model=${env.OPENAI_MODEL}, openai_api_key_present=${Boolean(env.OPENAI_API_KEY)}, codex_home_present=${Boolean(env.CODEX_HOME)}, skills=${(config.codexSkillNames ?? []).join(",") || "none"}`
    );

    const command = config.runtime.command ?? "codex";
    const baseOutputFiles = {
      stdoutPath: path.join(config.workspacePath, ".codex-runtime.stdout.log"),
      stderrPath: path.join(config.workspacePath, ".codex-runtime.stderr.log"),
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
    } catch (error) {
      // Fallback path: some Codex/OpenAI auth flows fail only when CODEX_HOME is overridden.
      // Retry once without CODEX_HOME if we detect that signature.
      const firstStdout = await fs.readFile(baseOutputFiles.stdoutPath, "utf-8").catch(() => "");
      const hasAuthHeaderError = firstStdout.includes(
        "401 Unauthorized: Missing bearer or basic authentication in header"
      );
      if (env.CODEX_HOME && hasAuthHeaderError) {
        console.warn(
          "[codex-runtime] Detected auth-header error with CODEX_HOME override; retrying once without CODEX_HOME."
        );
        const fallbackEnv = { ...env };
        delete fallbackEnv.CODEX_HOME;
        await fs.writeFile(
          debugPath,
          JSON.stringify(
            {
              ...(JSON.parse(await fs.readFile(debugPath, "utf-8")) as Record<string, unknown>),
              fallback_without_codex_home: true,
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
            stdoutPath: path.join(config.workspacePath, ".codex-runtime.retry.stdout.log"),
            stderrPath: path.join(config.workspacePath, ".codex-runtime.retry.stderr.log"),
          },
        });
      } else {
        throw error;
      }
    }

    return {
      tokens_used: result.tokensUsed,
      runtime_id: result.runtimeId,
    };
  }
}

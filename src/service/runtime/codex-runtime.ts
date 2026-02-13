import type { AgentRuntime, RuntimeStepContext, RuntimeStepResult } from "./types.js";
import { runProcess } from "./process-utils.js";
import * as path from "path";

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

    const result = await runProcess(
      config.runtime.command ?? "codex",
      [...runtimeArgs, ...args],
      {
        cwd: config.workspacePath,
        env: {
          ...process.env,
          ...(config.apiKey ? { OPENAI_API_KEY: config.apiKey } : {}),
          OPENAI_MODEL: config.modelConfig.model,
          ...(config.codexHomeDir ? { CODEX_HOME: config.codexHomeDir } : {}),
          ...(config.runtime.env ?? {}),
        },
        timeoutMs: config.timeoutMinutes * 60 * 1000,
        parseTokensFromStdout: true,
        outputFiles: {
          stdoutPath: path.join(config.workspacePath, ".codex-runtime.stdout.log"),
          stderrPath: path.join(config.workspacePath, ".codex-runtime.stderr.log"),
        },
      }
    );

    return {
      tokens_used: result.tokensUsed,
      runtime_id: result.runtimeId,
    };
  }
}

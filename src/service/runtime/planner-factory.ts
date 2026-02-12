import type { PlatformConfig, ProjectConfig } from "../../shared/types.js";
import { OrchestratorAgent } from "../orchestrator-agent.js";
import { ClaudeCodePlannerRuntime } from "./claude-code-planner-runtime.js";
import { CodexPlannerRuntime } from "./codex-planner-runtime.js";
import type { PlannerRuntime } from "./types.js";

export class PlannerFactory {
  create(platformConfig: PlatformConfig, projectConfig: ProjectConfig): PlannerRuntime {
    const runtime =
      projectConfig.planner_runtime_override ??
      platformConfig.defaults.planner_runtime ??
      { provider: "claude-code" as const, mode: "local_process" as const };

    if (runtime.provider === "codex") {
      return new CodexPlannerRuntime(platformConfig, projectConfig);
    }

    // For claude-code in local_process mode, use the CLI-based planner
    // which relies on local Claude Code auth (no API key required).
    // For container/remote modes, use the SDK-based OrchestratorAgent
    // which needs an explicit API key.
    if (runtime.mode === "local_process") {
      return new ClaudeCodePlannerRuntime(platformConfig, projectConfig);
    }
    return new OrchestratorAgent(platformConfig, projectConfig);
  }
}

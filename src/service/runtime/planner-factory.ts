import type { PlatformConfig, ProjectConfig } from "../../shared/types.js";
import { OrchestratorAgent } from "../orchestrator-agent.js";
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
    return new OrchestratorAgent(platformConfig, projectConfig);
  }
}

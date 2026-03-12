import type { PlatformConfig, ProjectConfig } from "../shared/types.js";

export function resolveDefaultDirectAgent(
  platformConfig: PlatformConfig,
  projectConfig: ProjectConfig
): string | undefined {
  const allowedAgents = new Set(projectConfig.agents ?? []);
  const hasProjectFilter = allowedAgents.size > 0;
  const agentDefinitions = platformConfig.agent_definitions ?? [];

  const preferredAgents = [
    "developer",
    "go-developer",
    ...agentDefinitions
      .filter((definition) => definition.role === "developer")
      .map((definition) => definition.type),
  ];

  for (const agent of preferredAgents) {
    const known = agentDefinitions.some((definition) => definition.type === agent);
    if (!known) continue;
    if (hasProjectFilter && !allowedAgents.has(agent)) continue;
    return agent;
  }

  if (hasProjectFilter) {
    return projectConfig.agents?.[0];
  }

  return agentDefinitions[0]?.type;
}

import type { PlatformConfig, ProjectConfig } from "../shared/types.js";

export function resolveDefaultDirectAgent(
  platformConfig: PlatformConfig,
  projectConfig: ProjectConfig
): string | undefined {
  const agentDefinitions = platformConfig.agent_definitions ?? [];

  const preferredAgents = [
    "generic",
    "developer",
    "go-developer",
    ...agentDefinitions
      .filter((definition) => definition.role === "developer")
      .map((definition) => definition.type),
  ];

  for (const agent of preferredAgents) {
    const known = agentDefinitions.some((definition) => definition.type === agent);
    if (!known) continue;
    return agent;
  }

  if ((projectConfig.agents?.length ?? 0) > 0) {
    return projectConfig.agents?.[0];
  }

  return agentDefinitions[0]?.type;
}

import * as fs from "fs/promises";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import type { AgentDefinition, PlatformConfig, ProjectConfig } from "../shared/types.js";

export async function loadYaml<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, "utf-8");
  // Interpolate environment variables: ${VAR_NAME}
  const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, varName) => {
    return process.env[varName] ?? "";
  });
  return parseYaml(interpolated) as T;
}

export async function loadConfig(configDir: string, projectName?: string) {
  const platformPath = path.join(configDir, "platform.yaml");
  const platform = await loadYaml<PlatformConfig>(platformPath);

  // Resolve project config path:
  //   --project given: try <name>.yaml, then project-<name>.yaml
  //   no --project: default to project.yaml
  let project: ProjectConfig;
  if (projectName) {
    const candidates = [
      path.join(configDir, `${projectName}.yaml`),
      path.join(configDir, `project-${projectName}.yaml`),
    ];

    let loaded = false;
    for (const candidate of candidates) {
      try {
        project = await loadYaml<ProjectConfig>(candidate);
        console.log(`Loaded project config: ${path.basename(candidate)}`);
        loaded = true;
        break;
      } catch {
        // try next candidate
      }
    }

    if (!loaded) {
      throw new Error(
        `Could not find project config for "${projectName}". ` +
        `Tried: ${candidates.map((c) => path.basename(c)).join(", ")}`
      );
    }
  } else {
    const projectPath = path.join(configDir, "project.yaml");
    try {
      project = await loadYaml<ProjectConfig>(projectPath);
    } catch {
      throw new Error(
        "config/project.yaml not found. Copy config/project.example.yaml to config/project.yaml and configure it."
      );
    }
  }

  const resolved = project!;
  // Ensure optional fields are never undefined
  resolved.rules = resolved.rules ?? [];
  resolved.agents = resolved.agents ?? [];
  resolved.integrations = resolved.integrations ?? ({} as typeof resolved.integrations);
  resolved.branch_strategy = resolved.branch_strategy ?? {
    prefix: "feat/",
    include_ticket_id: true,
    naming: "kebab-case",
  };

  // Merge custom agent definitions from config/agents/*.yaml
  // Each file defines a single AgentDefinition; types not already in platform.yaml are added.
  const agentsDir = path.join(configDir, "agents");
  try {
    const entries = await fs.readdir(agentsDir);
    for (const entry of entries) {
      if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
      try {
        const raw = await fs.readFile(path.join(agentsDir, entry), "utf-8");
        const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? "");
        const def = parseYaml(interpolated) as AgentDefinition;
        if (def?.type && !platform.agent_definitions.find((a) => a.type === def.type)) {
          platform.agent_definitions.push(def);
        }
      } catch {
        // Skip malformed or unreadable agent files
      }
    }
  } catch {
    // config/agents/ directory doesn't exist — that's fine
  }

  return { platform, project: resolved };
}

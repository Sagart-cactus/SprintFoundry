import * as fs from "fs/promises";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import type { PlatformConfig, ProjectConfig } from "../shared/types.js";

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

  return { platform, project: resolved };
}

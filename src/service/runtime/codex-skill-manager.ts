import * as fs from "fs/promises";
import * as path from "path";
import type { AgentType, PlatformConfig, ProjectConfig } from "../../shared/types.js";

export interface CodexSkillResolution {
  enabled: boolean;
  skillNames: string[];
}

export interface CodexSkillStageResult {
  codexHomeDir: string;
  skillNames: string[];
}

export class CodexSkillManager {
  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig,
    private projectRoot: string
  ) {}

  resolveForAgent(agent: AgentType): CodexSkillResolution {
    const enabled =
      this.projectConfig.codex_skills_enabled ??
      this.platformConfig.defaults.codex_skills_enabled ??
      false;
    if (!enabled) return { enabled: false, skillNames: [] };

    const projectSkills = this.projectConfig.codex_skills_overrides?.[agent];
    const defaultSkills = this.platformConfig.defaults.codex_skills_per_agent?.[agent];
    const skillNames = [...(projectSkills ?? defaultSkills ?? [])];
    return { enabled: true, skillNames };
  }

  async stageSkills(
    workspacePath: string,
    skillNames: string[]
  ): Promise<CodexSkillStageResult> {
    const codexHomeDir = path.join(workspacePath, ".codex-home");
    const skillsDir = path.join(codexHomeDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    await this.copyAuthState(codexHomeDir);

    if (skillNames.length === 0) {
      await this.writeManifest(codexHomeDir, []);
      return { codexHomeDir, skillNames: [] };
    }

    const catalog = {
      ...(this.platformConfig.defaults.codex_skill_catalog ?? {}),
      ...(this.projectConfig.codex_skill_catalog_overrides ?? {}),
    };

    for (const skillName of skillNames) {
      const def = catalog[skillName];
      if (!def) {
        throw new Error(
          `Codex skill "${skillName}" is not defined in codex_skill_catalog or codex_skill_catalog_overrides`
        );
      }

      const sourceDir = this.resolveSkillSource(def.path);
      await this.validateSkillDir(sourceDir, skillName);
      const targetDir = path.join(skillsDir, skillName);
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.cp(sourceDir, targetDir, { recursive: true });
    }

    await this.writeManifest(codexHomeDir, skillNames);
    return { codexHomeDir, skillNames };
  }

  private async copyAuthState(codexHomeDir: string): Promise<void> {
    // Preserve Codex authentication/config when using a workspace-scoped CODEX_HOME.
    const defaultHome = process.env["CODEX_HOME"] || path.join(process.env["HOME"] || "", ".codex");
    const files = ["auth.json", "config.toml"];

    for (const filename of files) {
      const src = path.join(defaultHome, filename);
      const dst = path.join(codexHomeDir, filename);
      const exists = await fs.access(src).then(() => true).catch(() => false);
      if (!exists) continue;
      await fs.copyFile(src, dst);
    }
  }

  private resolveSkillSource(configuredPath: string): string {
    if (path.isAbsolute(configuredPath)) return configuredPath;
    return path.resolve(this.projectRoot, configuredPath);
  }

  private async validateSkillDir(dir: string, skillName: string): Promise<void> {
    await fs.access(dir);
    await fs.access(path.join(dir, "SKILL.md")).catch(() => {
      throw new Error(
        `Codex skill "${skillName}" at ${dir} is missing SKILL.md`
      );
    });
  }

  private async writeManifest(codexHomeDir: string, skillNames: string[]): Promise<void> {
    await fs.writeFile(
      path.join(codexHomeDir, "skills", ".manifest.json"),
      JSON.stringify(
        {
          generated_at: new Date().toISOString(),
          skills: skillNames,
        },
        null,
        2
      ),
      "utf-8"
    );
  }
}

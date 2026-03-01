import * as fs from "fs/promises";
import type { Dirent } from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type {
  AgentType,
  PlatformConfig,
  ProjectConfig,
  RuntimeProvider,
  SkillDefinition,
  SkillGuardrails,
  SkillSource,
} from "../../shared/types.js";

export interface CodexSkillResolution {
  enabled: boolean;
  skillNames: string[];
  warnings: string[];
}

export interface CodexSkillStageResult {
  codexHomeDir?: string;
  skillsDir: string;
  skillNames: string[];
  warnings: string[];
  runtimeProvider: RuntimeProvider;
  skillHashes: Record<string, string>;
}

export class CodexSkillManager {
  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig,
    private projectRoot: string
  ) {}

  resolveForAgent(
    agent: AgentType,
    runtimeProvider: RuntimeProvider = "codex"
  ): CodexSkillResolution {
    const skillsV2Enabled =
      this.projectConfig.skills_v2_enabled ??
      this.platformConfig.defaults.skills_v2_enabled ??
      false;

    if (!skillsV2Enabled) {
      if (runtimeProvider !== "codex") {
        return { enabled: false, skillNames: [], warnings: [] };
      }
      const enabled =
        this.projectConfig.codex_skills_enabled ??
        this.platformConfig.defaults.codex_skills_enabled ??
        false;
      if (!enabled) return { enabled: false, skillNames: [], warnings: [] };
      const projectSkills = this.projectConfig.codex_skills_overrides?.[agent];
      const defaultSkills = this.platformConfig.defaults.codex_skills_per_agent?.[agent];
      const skillNames = this.dedupe(projectSkills ?? defaultSkills ?? []);
      const warnings = this.evaluateCountGuardrails(skillNames, runtimeProvider);
      return { enabled: true, skillNames, warnings };
    }

    const enabled =
      this.projectConfig.skills_enabled ??
      this.platformConfig.defaults.skills_enabled ??
      (runtimeProvider === "codex"
        ? (this.projectConfig.codex_skills_enabled ??
          this.platformConfig.defaults.codex_skills_enabled)
        : undefined) ??
      false;
    if (!enabled) return { enabled: false, skillNames: [], warnings: [] };

    const projectSkills =
      this.projectConfig.skill_assignments?.[agent] ??
      (runtimeProvider === "codex"
        ? this.projectConfig.codex_skills_overrides?.[agent]
        : undefined);
    const defaultSkills =
      this.platformConfig.defaults.skill_assignments_per_agent?.[agent] ??
      (runtimeProvider === "codex"
        ? this.platformConfig.defaults.codex_skills_per_agent?.[agent]
        : undefined);
    const skillNames = this.dedupe(projectSkills ?? defaultSkills ?? []);
    const warnings = this.evaluateCountGuardrails(skillNames, runtimeProvider);
    return { enabled: true, skillNames, warnings };
  }

  async stageSkills(
    workspacePath: string,
    skillNames: string[],
    runtimeProvider: RuntimeProvider = "codex"
  ): Promise<CodexSkillStageResult> {
    const skillsV2Enabled =
      this.projectConfig.skills_v2_enabled ??
      this.platformConfig.defaults.skills_v2_enabled ??
      false;
    const warnings: string[] = [];
    const skillHashes: Record<string, string> = {};
    const destination = this.resolveDestination(workspacePath, runtimeProvider);
    await fs.mkdir(destination.skillsDir, { recursive: true });

    if (destination.codexHomeDir) {
      await this.copyAuthState(destination.codexHomeDir);
    }

    if (skillNames.length === 0) {
      if (destination.codexHomeDir) {
        await this.writeManifest(destination.codexHomeDir, []);
      }
      return {
        codexHomeDir: destination.codexHomeDir,
        skillsDir: destination.skillsDir,
        skillNames: [],
        warnings,
        runtimeProvider,
        skillHashes,
      };
    }

    const catalog = await this.resolveCatalog(workspacePath, runtimeProvider, skillsV2Enabled);

    for (const skillName of skillNames) {
      const def = catalog[skillName];
      if (!def) {
        throw new Error(
          `Skill "${skillName}" is not defined for runtime ${runtimeProvider}. ` +
          `Add it in skill_catalog_overrides/codex_skill_catalog_overrides, skill_sources, or repo-level skills.`
        );
      }
      const targetDir = path.join(destination.skillsDir, skillName);
      await this.stageSkillDefinition(def, targetDir, skillName);
      skillHashes[skillName] = await this.computeSkillHash(targetDir);
    }

    if (destination.codexHomeDir) {
      await this.writeManifest(destination.codexHomeDir, skillNames);
    }

    warnings.push(...(await this.evaluateSizeGuardrails(destination.skillsDir, skillNames, runtimeProvider)));

    return {
      codexHomeDir: destination.codexHomeDir,
      skillsDir: destination.skillsDir,
      skillNames,
      warnings,
      runtimeProvider,
      skillHashes,
    };
  }

  private resolveDestination(
    workspacePath: string,
    runtimeProvider: RuntimeProvider
  ): { codexHomeDir?: string; skillsDir: string } {
    if (runtimeProvider === "codex") {
      const codexHomeDir = path.join(workspacePath, ".codex-home");
      return {
        codexHomeDir,
        skillsDir: path.join(codexHomeDir, "skills"),
      };
    }

    return {
      skillsDir: path.join(workspacePath, ".claude", "skills"),
    };
  }

  private async resolveCatalog(
    workspacePath: string,
    runtimeProvider: RuntimeProvider,
    skillsV2Enabled: boolean
  ): Promise<Record<string, SkillDefinition>> {
    const merged: Record<string, SkillDefinition> = {};

    if (skillsV2Enabled) {
      Object.assign(
        merged,
        this.platformConfig.defaults.skill_catalog ?? {},
        this.projectConfig.skill_catalog_overrides ?? {}
      );
      if (runtimeProvider === "codex") {
        Object.assign(
          merged,
          this.platformConfig.defaults.codex_skill_catalog ?? {},
          this.projectConfig.codex_skill_catalog_overrides ?? {}
        );
      }

      const sources = [
        ...(this.platformConfig.defaults.skill_sources ?? []),
        ...(this.projectConfig.skill_sources ?? []),
      ];
      for (const source of sources) {
        if (!this.runtimeMatches(source.runtime, runtimeProvider)) continue;
        const discovered = await this.resolveSkillSourceEntry(source);
        for (const [name, def] of Object.entries(discovered)) {
          if (!merged[name]) merged[name] = def;
        }
      }

      const repoDiscovered = await this.discoverRepoNativeSkills(workspacePath, runtimeProvider);
      for (const [name, def] of Object.entries(repoDiscovered)) {
        if (!merged[name]) merged[name] = def;
      }
    } else if (runtimeProvider === "codex") {
      Object.assign(
        merged,
        this.platformConfig.defaults.codex_skill_catalog ?? {},
        this.projectConfig.codex_skill_catalog_overrides ?? {}
      );
    }

    const filtered: Record<string, SkillDefinition> = {};
    for (const [name, def] of Object.entries(merged)) {
      if (this.runtimeMatches(def.runtime, runtimeProvider)) {
        filtered[name] = def;
      }
    }
    return filtered;
  }

  private async resolveSkillSourceEntry(
    source: SkillSource
  ): Promise<Record<string, SkillDefinition>> {
    if (source.type === "files") {
      return {
        [source.name]: {
          files: source.files,
          runtime: source.runtime,
        },
      };
    }

    const root = this.resolvePath(source.path);
    const recursive = source.recursive ?? false;
    const discovered: Record<string, SkillDefinition> = {};
    await this.walkFolderSource(root, recursive, discovered);
    return discovered;
  }

  private async walkFolderSource(
    root: string,
    recursive: boolean,
    out: Record<string, SkillDefinition>
  ): Promise<void> {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [] as Dirent[]);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(root, entry.name);
      const skillFile = path.join(skillDir, "SKILL.md");
      const hasSkill = await fs.access(skillFile).then(() => true).catch(() => false);
      if (hasSkill) {
        out[entry.name] = { path: skillDir };
      }
      if (recursive && !hasSkill) {
        await this.walkFolderSource(skillDir, true, out);
      }
    }
  }

  private async discoverRepoNativeSkills(
    workspacePath: string,
    runtimeProvider: RuntimeProvider
  ): Promise<Record<string, SkillDefinition>> {
    const baseDir =
      runtimeProvider === "codex"
        ? path.join(workspacePath, ".agents", "skills")
        : path.join(workspacePath, ".claude", "skills");

    const entries = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const discovered: Record<string, SkillDefinition> = {};
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(baseDir, entry.name);
      const hasSkillFile = await fs
        .access(path.join(skillDir, "SKILL.md"))
        .then(() => true)
        .catch(() => false);
      if (!hasSkillFile) continue;
      discovered[entry.name] = { path: skillDir, runtime: runtimeProvider };
    }
    return discovered;
  }

  private async stageSkillDefinition(
    def: SkillDefinition,
    targetDir: string,
    skillName: string
  ): Promise<void> {
    if (def.path) {
      const sourceDir = this.resolvePath(def.path);
      await this.validateSkillDir(sourceDir, skillName);
      if (path.resolve(sourceDir) === path.resolve(targetDir)) {
        return;
      }
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.cp(sourceDir, targetDir, { recursive: true });
      return;
    }

    if (!def.files || def.files.length === 0) {
      throw new Error(
        `Skill "${skillName}" must define either path or files[]`
      );
    }

    const hasSkillFile = def.files.some((filePath) => path.basename(filePath) === "SKILL.md");
    if (!hasSkillFile) {
      throw new Error(`Skill "${skillName}" files[] must include SKILL.md`);
    }

    await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(targetDir, { recursive: true });
    for (const configuredPath of def.files) {
      const sourcePath = this.resolvePath(configuredPath);
      await fs.access(sourcePath).catch(() => {
        throw new Error(`Skill "${skillName}" file not found: ${configuredPath}`);
      });
      const targetPath = path.join(targetDir, path.basename(sourcePath));
      await fs.copyFile(sourcePath, targetPath);
    }
  }

  private evaluateCountGuardrails(
    skillNames: string[],
    runtimeProvider: RuntimeProvider
  ): string[] {
    const warnings: string[] = [];
    const guardrails = this.resolveGuardrails();
    const warnThreshold = guardrails.warn_skills_per_agent ?? 4;
    const maxThreshold = guardrails.max_skills_per_agent ?? 6;
    if (skillNames.length > warnThreshold) {
      warnings.push(
        `Skill count ${skillNames.length} exceeds recommended threshold ${warnThreshold} for ${runtimeProvider}`
      );
    }

    if (skillNames.length > maxThreshold) {
      const message =
        `Skill count ${skillNames.length} exceeds max threshold ${maxThreshold} for ${runtimeProvider}`;
      if ((guardrails.mode ?? "warn") === "error") {
        throw new Error(message);
      }
      warnings.push(message);
    }

    return warnings;
  }

  private async evaluateSizeGuardrails(
    skillsDir: string,
    skillNames: string[],
    runtimeProvider: RuntimeProvider
  ): Promise<string[]> {
    const warnings: string[] = [];
    const maxChars = this.resolveGuardrails().max_total_skill_chars_per_agent;
    if (!maxChars || maxChars <= 0) return warnings;

    let total = 0;
    for (const skillName of skillNames) {
      const skillPath = path.join(skillsDir, skillName, "SKILL.md");
      const content = await fs.readFile(skillPath, "utf-8").catch(() => "");
      total += content.length;
    }

    if (total > maxChars) {
      const message =
        `Total skill size ${total} chars exceeds max_total_skill_chars_per_agent=${maxChars} for ${runtimeProvider}`;
      if ((this.resolveGuardrails().mode ?? "warn") === "error") {
        throw new Error(message);
      }
      warnings.push(message);
    }
    return warnings;
  }

  private async computeSkillHash(skillDir: string): Promise<string> {
    const files = await fs.readdir(skillDir, { withFileTypes: true }).catch(() => [] as Dirent[]);
    const hashedEntries: Array<{ name: string; content: string }> = [];
    for (const entry of files) {
      if (!entry.isFile()) continue;
      const filePath = path.join(skillDir, entry.name);
      const content = await fs.readFile(filePath, "utf-8").catch(() => "");
      hashedEntries.push({ name: entry.name, content });
    }
    hashedEntries.sort((a, b) => a.name.localeCompare(b.name));
    const digest = createHash("sha256");
    for (const entry of hashedEntries) {
      digest.update(entry.name);
      digest.update("\n");
      digest.update(entry.content);
      digest.update("\n---\n");
    }
    return digest.digest("hex").slice(0, 16);
  }

  private resolveGuardrails(): SkillGuardrails {
    return {
      warn_skills_per_agent:
        this.projectConfig.skill_guardrails?.warn_skills_per_agent ??
        this.platformConfig.defaults.skill_guardrails?.warn_skills_per_agent,
      max_skills_per_agent:
        this.projectConfig.skill_guardrails?.max_skills_per_agent ??
        this.platformConfig.defaults.skill_guardrails?.max_skills_per_agent,
      max_total_skill_chars_per_agent:
        this.projectConfig.skill_guardrails?.max_total_skill_chars_per_agent ??
        this.platformConfig.defaults.skill_guardrails?.max_total_skill_chars_per_agent,
      mode:
        this.projectConfig.skill_guardrails?.mode ??
        this.platformConfig.defaults.skill_guardrails?.mode ??
        "warn",
    };
  }

  private runtimeMatches(
    targetRuntime: RuntimeProvider | "all" | undefined,
    runtimeProvider: RuntimeProvider
  ): boolean {
    if (!targetRuntime || targetRuntime === "all") return true;
    return targetRuntime === runtimeProvider;
  }

  private dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
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

  private resolvePath(configuredPath: string): string {
    if (path.isAbsolute(configuredPath)) return configuredPath;
    return path.resolve(this.projectRoot, configuredPath);
  }

  private async validateSkillDir(dir: string, skillName: string): Promise<void> {
    await fs.access(dir).catch(() => {
      throw new Error(`Skill "${skillName}" path not found: ${dir}`);
    });
    await fs.access(path.join(dir, "SKILL.md")).catch(() => {
      throw new Error(
        `Skill "${skillName}" at ${dir} is missing SKILL.md`
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

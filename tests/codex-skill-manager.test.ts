import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { CodexSkillManager } from "../src/service/runtime/codex-skill-manager.js";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

describe("CodexSkillManager", () => {
  it("resolveForAgent respects enabled toggle and per-agent mappings", () => {
    const managerDisabled = new CodexSkillManager(
      makePlatformConfig(),
      makeProjectConfig(),
      process.cwd()
    );
    expect(managerDisabled.resolveForAgent("developer")).toEqual({
      enabled: false,
      skillNames: [],
    });

    const managerEnabled = new CodexSkillManager(
      makePlatformConfig({
        defaults: {
          ...makePlatformConfig().defaults,
          codex_skills_enabled: true,
          codex_skills_per_agent: {
            developer: ["ui-engineering-principles"],
          },
        },
      }),
      makeProjectConfig(),
      process.cwd()
    );
    expect(managerEnabled.resolveForAgent("developer")).toEqual({
      enabled: true,
      skillNames: ["ui-engineering-principles"],
    });
  });

  it("resolves code-review skills for code-review agent", () => {
    const manager = new CodexSkillManager(
      makePlatformConfig({
        defaults: {
          ...makePlatformConfig().defaults,
          codex_skills_enabled: true,
          codex_skills_per_agent: {
            "code-review": ["code-quality", "error-handling", "performance-review", "testing-standards", "architecture-alignment"],
          },
        },
      }),
      makeProjectConfig(),
      process.cwd()
    );
    const result = manager.resolveForAgent("code-review");
    expect(result.enabled).toBe(true);
    expect(result.skillNames).toEqual([
      "code-quality",
      "error-handling",
      "performance-review",
      "testing-standards",
      "architecture-alignment",
    ]);
  });

  it("stages code-review skills into codex home", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cr-skills-"));

    // Create skill source directories
    const skillNames = ["code-quality", "error-handling", "performance-review"];
    for (const name of skillNames) {
      const skillSource = path.join(tmpDir, "repo-skills", name);
      await fs.mkdir(skillSource, { recursive: true });
      await fs.writeFile(path.join(skillSource, "SKILL.md"), `# ${name}`, "utf-8");
    }

    const workspace = path.join(tmpDir, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const catalog: Record<string, { path: string }> = {};
    for (const name of skillNames) {
      catalog[name] = { path: path.join(tmpDir, "repo-skills", name) };
    }

    const manager = new CodexSkillManager(
      makePlatformConfig({
        defaults: {
          ...makePlatformConfig().defaults,
          codex_skills_enabled: true,
          codex_skill_catalog: catalog,
        },
      }),
      makeProjectConfig(),
      process.cwd()
    );

    const staged = await manager.stageSkills(workspace, skillNames);
    expect(staged.skillNames).toEqual(skillNames);

    // Verify files were copied
    for (const name of skillNames) {
      await expect(
        fs.access(path.join(workspace, ".codex-home", "skills", name, "SKILL.md"))
      ).resolves.toBeUndefined();
    }
  });

  it("stageSkills copies skill directories and writes manifest", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-skills-test-"));
    const skillSource = path.join(tmpDir, "repo-skills", "web-design-guidelines");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "# Skill", "utf-8");
    await fs.writeFile(path.join(skillSource, "README.md"), "data", "utf-8");

    const workspace = path.join(tmpDir, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const manager = new CodexSkillManager(
      makePlatformConfig({
        defaults: {
          ...makePlatformConfig().defaults,
          codex_skills_enabled: true,
          codex_skill_catalog: {
            "web-design-guidelines": {
              path: skillSource,
            },
          },
        },
      }),
      makeProjectConfig(),
      process.cwd()
    );

    const staged = await manager.stageSkills(workspace, ["web-design-guidelines"]);
    expect(staged.skillNames).toEqual(["web-design-guidelines"]);

    await expect(
      fs.access(
        path.join(
          workspace,
          ".codex-home",
          "skills",
          "web-design-guidelines",
          "SKILL.md"
        )
      )
    ).resolves.toBeUndefined();
    await expect(
      fs.access(path.join(workspace, ".codex-home", "skills", ".manifest.json"))
    ).resolves.toBeUndefined();
  });
});

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

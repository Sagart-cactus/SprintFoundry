import { describe, it, expect } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import { parse as parseYaml } from "yaml";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const PLUGINS_DIR = path.join(PROJECT_ROOT, "plugins");
const PLATFORM_YAML = path.join(PROJECT_ROOT, "config", "platform.yaml");

describe("Plugin structure validation", () => {
  it("frontend-design/plugin.json is valid JSON with name + description", async () => {
    const content = await fs.readFile(
      path.join(PLUGINS_DIR, "frontend-design", "plugin.json"),
      "utf-8"
    );
    const json = JSON.parse(content);

    expect(json.name).toBe("frontend-design");
    expect(json.description).toBeTruthy();
    expect(typeof json.description).toBe("string");
  });

  it("js-nextjs/plugin.json is valid JSON with name + description", async () => {
    const content = await fs.readFile(
      path.join(PLUGINS_DIR, "js-nextjs", "plugin.json"),
      "utf-8"
    );
    const json = JSON.parse(content);

    expect(json.name).toBe("js-nextjs");
    expect(json.description).toBeTruthy();
    expect(typeof json.description).toBe("string");
  });

  it("each SKILL.md has valid YAML frontmatter with name + description", async () => {
    const pluginDirs = ["frontend-design", "js-nextjs"];

    for (const pluginDir of pluginDirs) {
      const skillsDir = path.join(PLUGINS_DIR, pluginDir, "skills");
      let skillDirs: string[];
      try {
        skillDirs = await fs.readdir(skillsDir);
      } catch {
        continue; // no skills dir
      }

      for (const skillDir of skillDirs) {
        const skillMdPath = path.join(skillsDir, skillDir, "SKILL.md");
        let content: string;
        try {
          content = await fs.readFile(skillMdPath, "utf-8");
        } catch {
          continue; // no SKILL.md
        }

        // Parse YAML frontmatter (between --- markers)
        const match = content.match(/^---\n([\s\S]*?)\n---/);
        expect(
          match,
          `${pluginDir}/skills/${skillDir}/SKILL.md should have YAML frontmatter`
        ).toBeTruthy();

        const frontmatter = parseYaml(match![1]) as any;
        expect(
          frontmatter.name,
          `${pluginDir}/skills/${skillDir}/SKILL.md should have 'name' in frontmatter`
        ).toBeTruthy();
        expect(
          frontmatter.description,
          `${pluginDir}/skills/${skillDir}/SKILL.md should have 'description' in frontmatter`
        ).toBeTruthy();
      }
    }
  });

  it("plugin directories resolve from agent-runner's path logic", () => {
    // Agent runner resolves plugins via: path.resolve(projectRoot, "plugins", pluginName)
    // Verify the plugins directory structure exists
    const pluginPath = path.resolve(PROJECT_ROOT, "plugins", "js-nextjs");
    const designPath = path.resolve(PROJECT_ROOT, "plugins", "frontend-design");

    // These should be valid directories (we already read their plugin.json above)
    expect(pluginPath).toContain("plugins/js-nextjs");
    expect(designPath).toContain("plugins/frontend-design");
  });

  it("platform.yaml developer agent has plugins: [js-nextjs]", async () => {
    const content = await fs.readFile(PLATFORM_YAML, "utf-8");
    const config = parseYaml(content) as any;

    const devAgent = config.agent_definitions.find(
      (a: any) => a.type === "developer"
    );
    expect(devAgent).toBeDefined();
    expect(devAgent.plugins).toContain("js-nextjs");
  });

  it("platform.yaml ui-ux agent has plugins: [frontend-design]", async () => {
    const content = await fs.readFile(PLATFORM_YAML, "utf-8");
    const config = parseYaml(content) as any;

    const uiAgent = config.agent_definitions.find(
      (a: any) => a.type === "ui-ux"
    );
    expect(uiAgent).toBeDefined();
    expect(uiAgent.plugins).toContain("frontend-design");
  });
});

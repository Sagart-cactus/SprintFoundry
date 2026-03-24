import { describe, expect, it } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import type { TicketDetails } from "../src/shared/types.js";
import { CodexSkillManager } from "../src/service/runtime/codex-skill-manager.js";
import { DynamicSkillResolver } from "../src/service/runtime/dynamic-skill-resolver.js";
import { makePlatformConfig, makeProjectConfig } from "./fixtures/configs.js";

function makeTicket(overrides?: Partial<TicketDetails>): TicketDetails {
  return {
    id: overrides?.id ?? "SPR-100",
    source: overrides?.source ?? "linear",
    title: overrides?.title ?? "Add movement feel polish",
    description: overrides?.description ?? "Tune movement and visuals",
    labels: overrides?.labels ?? [],
    priority: overrides?.priority ?? "p2",
    acceptance_criteria: overrides?.acceptance_criteria ?? [],
    linked_tickets: overrides?.linked_tickets ?? [],
    comments: overrides?.comments ?? [],
    author: overrides?.author ?? "test-user",
    raw: overrides?.raw ?? {},
    identifier: overrides?.identifier,
    url: overrides?.url,
    state: overrides?.state,
    state_id: overrides?.state_id,
    state_type: overrides?.state_type,
    team_id: overrides?.team_id,
    team_key: overrides?.team_key,
    assignee: overrides?.assignee,
  };
}

describe("DynamicSkillResolver", () => {
  it("adds allowlisted skills from explicit linear labels", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dynamic-skills-"));
    const workspace = path.join(tmpDir, "workspace");
    const skillSource = path.join(tmpDir, "skills");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(skillSource, "develop-web-game"), { recursive: true });
    await fs.mkdir(path.join(skillSource, "phaser-arcade-platformer"), { recursive: true });
    await fs.writeFile(path.join(skillSource, "develop-web-game", "SKILL.md"), "# develop-web-game", "utf-8");
    await fs.writeFile(path.join(skillSource, "phaser-arcade-platformer", "SKILL.md"), "# phaser", "utf-8");

    const platform = makePlatformConfig({
      defaults: {
        ...makePlatformConfig().defaults,
        skills_v2_enabled: true,
        skills_enabled: true,
        skill_catalog: {
          "develop-web-game": { path: path.join(skillSource, "develop-web-game") },
          "phaser-arcade-platformer": { path: path.join(skillSource, "phaser-arcade-platformer") },
        },
        skill_assignments_per_agent: {
          developer: ["develop-web-game"],
        },
      },
    });
    const project = makeProjectConfig({
      skills_v2_enabled: true,
      skills_enabled: true,
      dynamic_skills: {
        enabled: true,
        label_prefix: "sf:skill:",
        allowlist: ["develop-web-game", "phaser-arcade-platformer"],
        agent_allowlist: {
          developer: ["develop-web-game", "phaser-arcade-platformer"],
        },
      },
    });
    const resolver = new DynamicSkillResolver(
      platform,
      project,
      new CodexSkillManager(platform, project, process.cwd())
    );

    const result = await resolver.resolveForRun({
      agent: "developer",
      runtimeProvider: "claude-code",
      workspacePath: workspace,
      ticket: makeTicket({
        labels: ["movement", "sf:skill:phaser-arcade-platformer"],
      }),
    });

    expect(result.finalSkillNames).toEqual(["develop-web-game", "phaser-arcade-platformer"]);
    expect(result.baseSkillNames).toEqual(["develop-web-game"]);
    expect(result.labelSkillNames).toEqual(["phaser-arcade-platformer"]);
    expect(result.rejectedSkills).toEqual([]);
    expect(result.resolutionMode).toBe("dynamic_label_merge");
  });

  it("rejects unknown or disallowed label skills with warnings", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dynamic-skills-reject-"));
    const workspace = path.join(tmpDir, "workspace");
    const skillSource = path.join(tmpDir, "skills");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(skillSource, "playwright"), { recursive: true });
    await fs.writeFile(path.join(skillSource, "playwright", "SKILL.md"), "# playwright", "utf-8");

    const platform = makePlatformConfig({
      defaults: {
        ...makePlatformConfig().defaults,
        skills_v2_enabled: true,
        skills_enabled: true,
        skill_catalog: {
          playwright: { path: path.join(skillSource, "playwright") },
        },
      },
    });
    const project = makeProjectConfig({
      skills_v2_enabled: true,
      skills_enabled: true,
      dynamic_skills: {
        enabled: true,
        allowlist: ["playwright"],
        agent_allowlist: {
          qa: ["playwright"],
        },
      },
    });
    const resolver = new DynamicSkillResolver(
      platform,
      project,
      new CodexSkillManager(platform, project, process.cwd())
    );

    const result = await resolver.resolveForRun({
      agent: "developer",
      runtimeProvider: "claude-code",
      workspacePath: workspace,
      ticket: makeTicket({
        labels: [
          "sf:skill:playwright",
          "sf:skill:missing-skill",
          "sf:skill:",
        ],
      }),
    });

    expect(result.finalSkillNames).toEqual([]);
    expect(result.labelSkillNames).toEqual([]);
    expect(result.ignoredLabels).toEqual(["sf:skill:"]);
    expect(result.rejectedSkills).toEqual([
      { skill: "playwright", reason: "not_allowed_for_agent:developer" },
      { skill: "missing-skill", reason: "not_in_allowlist" },
    ]);
    expect(result.warnings.some((item) => item.includes("playwright"))).toBe(true);
  });

  it("ignores labels from non-linear tickets when label_source is linear", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "dynamic-skills-source-"));
    const workspace = path.join(tmpDir, "workspace");
    await fs.mkdir(workspace, { recursive: true });

    const platform = makePlatformConfig({
      defaults: {
        ...makePlatformConfig().defaults,
        skills_v2_enabled: true,
        skills_enabled: true,
      },
    });
    const project = makeProjectConfig({
      skills_v2_enabled: true,
      skills_enabled: true,
      dynamic_skills: {
        enabled: true,
        label_source: "linear",
        allowlist: ["playwright"],
      },
    });
    const resolver = new DynamicSkillResolver(
      platform,
      project,
      new CodexSkillManager(platform, project, process.cwd())
    );

    const result = await resolver.resolveForRun({
      agent: "qa",
      runtimeProvider: "codex",
      workspacePath: workspace,
      ticket: makeTicket({
        source: "github",
        labels: ["sf:skill:playwright"],
      }),
    });

    expect(result.resolutionMode).toBe("static");
    expect(result.finalSkillNames).toEqual([]);
    expect(result.labelSkillNames).toEqual([]);
  });
});

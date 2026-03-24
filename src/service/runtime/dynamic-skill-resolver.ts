import type {
  AgentType,
  DynamicSkillsConfig,
  PlatformConfig,
  ProjectConfig,
  RuntimeProvider,
  TicketDetails,
} from "../../shared/types.js";
import { CodexSkillManager } from "./codex-skill-manager.js";

export interface RejectedDynamicSkill {
  skill: string;
  reason: string;
}

export interface DynamicSkillResolution {
  enabled: boolean;
  finalSkillNames: string[];
  baseSkillNames: string[];
  labelSkillNames: string[];
  ignoredLabels: string[];
  rejectedSkills: RejectedDynamicSkill[];
  warnings: string[];
  resolutionMode: "static" | "dynamic_label_merge";
}

const DEFAULT_LABEL_PREFIX = "sf:skill:";

export class DynamicSkillResolver {
  constructor(
    private readonly platformConfig: PlatformConfig,
    private readonly projectConfig: ProjectConfig,
    private readonly skillManager: CodexSkillManager
  ) {}

  async resolveForRun(params: {
    agent: AgentType;
    runtimeProvider: RuntimeProvider;
    ticket?: TicketDetails;
    workspacePath: string;
  }): Promise<DynamicSkillResolution> {
    const base = this.skillManager.resolveForAgent(params.agent, params.runtimeProvider);
    const config = this.projectConfig.dynamic_skills;
    if (!this.isDynamicEnabled(config, params.ticket)) {
      return {
        enabled: base.enabled,
        finalSkillNames: base.skillNames,
        baseSkillNames: base.skillNames,
        labelSkillNames: [],
        ignoredLabels: [],
        rejectedSkills: [],
        warnings: [...base.warnings],
        resolutionMode: "static",
      };
    }

    const prefix = this.resolveLabelPrefix(config);
    const labels = params.ticket?.labels ?? [];
    const ignoredLabels: string[] = [];
    const requestedSkills: string[] = [];

    for (const rawLabel of labels) {
      const normalized = String(rawLabel ?? "").trim();
      if (!normalized) continue;
      const lower = normalized.toLowerCase();
      if (!lower.startsWith(prefix)) continue;
      const skill = normalized.slice(prefix.length).trim();
      if (!skill) {
        ignoredLabels.push(normalized);
        continue;
      }
      requestedSkills.push(skill);
    }

    const catalog = await this.skillManager.resolveCatalogForRuntime(
      params.workspacePath,
      params.runtimeProvider
    );
    const availableSkills = new Set(Object.keys(catalog));
    const allowlist = this.normalizeSet(config?.allowlist);
    const denylist = this.normalizeSet(config?.denylist);
    const hasAgentScopedAllowlist = Object.keys(config?.agent_allowlist ?? {}).length > 0;
    const agentAllowlist = this.normalizeSet(config?.agent_allowlist?.[params.agent]);

    const accepted: string[] = [];
    const rejectedSkills: RejectedDynamicSkill[] = [];

    for (const skill of requestedSkills) {
      const normalizedSkill = skill.trim();
      const lowered = normalizedSkill.toLowerCase();
      if (!normalizedSkill) continue;
      if (allowlist.size > 0 && !allowlist.has(lowered)) {
        rejectedSkills.push({ skill: normalizedSkill, reason: "not_in_allowlist" });
        continue;
      }
      if (denylist.has(lowered)) {
        rejectedSkills.push({ skill: normalizedSkill, reason: "in_denylist" });
        continue;
      }
      if (hasAgentScopedAllowlist && !agentAllowlist.has(lowered)) {
        rejectedSkills.push({ skill: normalizedSkill, reason: `not_allowed_for_agent:${params.agent}` });
        continue;
      }
      if (!availableSkills.has(normalizedSkill)) {
        rejectedSkills.push({ skill: normalizedSkill, reason: `not_defined_for_runtime:${params.runtimeProvider}` });
        continue;
      }
      accepted.push(normalizedSkill);
    }

    const finalSkillNames = this.dedupe([...base.skillNames, ...accepted]);
    const warnings = [...base.warnings];
    for (const ignored of ignoredLabels) {
      warnings.push(`Ignored dynamic skill label "${ignored}" because it did not declare a skill name`);
    }
    for (const rejected of rejectedSkills) {
      warnings.push(`Rejected dynamic skill "${rejected.skill}": ${rejected.reason}`);
    }

    return {
      enabled: base.enabled || finalSkillNames.length > 0,
      finalSkillNames,
      baseSkillNames: base.skillNames,
      labelSkillNames: this.dedupe(accepted),
      ignoredLabels,
      rejectedSkills,
      warnings,
      resolutionMode: accepted.length > 0 || rejectedSkills.length > 0 || ignoredLabels.length > 0
        ? "dynamic_label_merge"
        : "static",
    };
  }

  private isDynamicEnabled(
    config: DynamicSkillsConfig | undefined,
    ticket: TicketDetails | undefined
  ): boolean {
    if (!config?.enabled) return false;
    if (config.allow_ticket_labels === false) return false;
    if (!ticket) return false;
    if ((config.label_source ?? "linear") === "linear" && ticket.source !== "linear") {
      return false;
    }
    return true;
  }

  private resolveLabelPrefix(config: DynamicSkillsConfig | undefined): string {
    return (config?.label_prefix ?? DEFAULT_LABEL_PREFIX).trim().toLowerCase();
  }

  private normalizeSet(values: string[] | undefined): Set<string> {
    return new Set((values ?? []).map((value) => value.trim().toLowerCase()).filter(Boolean));
  }

  private dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
      const normalized = value.trim();
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      out.push(normalized);
    }
    return out;
  }
}

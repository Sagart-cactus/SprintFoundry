// ============================================================
// SprintFoundry — Plan Validator
// Enforces platform + project rules on the orchestrator agent's plan
// ============================================================

import type {
  ExecutionPlan,
  PlanStep,
  HumanGate,
  TicketDetails,
  PlatformConfig,
  ProjectConfig,
  PlatformRule,
  ProjectRule,
  AgentType,
  AgentRole,
  AgentDefinition,
} from "../shared/types.js";

// Canonical ordering by role (used for inserting agents in correct position)
const ROLE_ORDER: AgentRole[] = [
  "product", "architect", "ui-ux", "developer", "code-review", "qa", "security", "devops",
];

export class PlanValidator {
  private allRules: (PlatformRule | ProjectRule)[];
  private agentDefs: AgentDefinition[];

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig
  ) {
    this.allRules = [
      ...platformConfig.rules,
      ...projectConfig.rules,
    ];
    this.agentDefs = platformConfig.agent_definitions;
  }

  validate(plan: ExecutionPlan, ticket: TicketDetails): ExecutionPlan {
    const validated: ExecutionPlan = structuredClone(plan);
    const injectedSteps: PlanStep[] = [];
    const injectedGates: HumanGate[] = [];

    for (const rule of this.allRules) {
      if (!this.evaluateCondition(rule.condition, ticket, plan)) continue;

      switch (rule.action.type) {
        case "require_agent":
          this.enforceRequiredAgent(validated, rule.action.agent, injectedSteps);
          break;
        case "require_role":
          this.enforceRequiredRole(validated, rule.action.role, injectedSteps);
          break;
        case "require_human_gate":
          this.enforceHumanGate(validated, rule.action.after_agent, injectedGates);
          break;
        // set_model and set_budget are handled at execution time, not in plan
      }
    }

    // Insert injected steps and gates
    if (injectedSteps.length > 0) {
      this.insertSteps(validated, injectedSteps);
    }
    for (const gate of injectedGates) {
      if (!validated.human_gates.some((g) => g.after_step === gate.after_step)) {
        validated.human_gates.push(gate);
      }
    }

    // Remap any hallucinated agent IDs to the nearest known agent
    this.remapUnknownAgents(validated);

    // Final validation: ensure plan is coherent
    this.validateDependencies(validated);
    this.validateNoDuplicateSteps(validated);

    return validated;
  }

  // ---- Agent Remap (hallucination guard) ----

  /**
   * If the orchestrator LLM outputs an agent ID that doesn't exist in
   * platform.yaml (e.g. "js-developer"), remap it to the closest known agent:
   *   1. Try stripping a leading "<stack>-" prefix (js-developer → developer)
   *   2. Try matching by role keyword in the ID (anything ending in "-qa" → qa role)
   *   3. If the project catalog limits agents, prefer catalog members
   *
   * Steps whose agent cannot be resolved are removed with a warning.
   */
  private remapUnknownAgents(plan: ExecutionPlan): void {
    const knownIds = new Set(this.agentDefs.map((d) => d.type));
    const catalog = this.projectConfig.agents;

    plan.steps = plan.steps.filter((step) => {
      if (knownIds.has(step.agent)) return true;

      // Attempt prefix-strip remap: "js-developer" → "developer", "ts-qa" → "qa"
      const parts = step.agent.split("-");
      for (let i = 1; i < parts.length; i++) {
        const candidate = parts.slice(i).join("-");
        if (knownIds.has(candidate)) {
          console.warn(
            `[plan-validator] Unknown agent "${step.agent}" remapped to "${candidate}"`
          );
          step.agent = candidate as AgentType;
          return true;
        }
      }

      // Attempt role-match: find any agent whose role keyword appears in the ID
      const matchByRole = this.agentDefs.find((d) =>
        step.agent.includes(d.role) &&
        (!catalog || catalog.length === 0 || catalog.includes(d.type))
      );
      if (matchByRole) {
        console.warn(
          `[plan-validator] Unknown agent "${step.agent}" remapped to "${matchByRole.type}" via role match`
        );
        step.agent = matchByRole.type as AgentType;
        return true;
      }

      console.warn(
        `[plan-validator] Dropping step ${step.step_number}: unknown agent "${step.agent}" (not in platform.yaml)`
      );
      return false;
    });

    // Re-number steps after potential removals
    plan.steps.forEach((s, i) => { s.step_number = i + 1; });
  }

  // ---- Role Lookup ----

  private getRoleForAgent(agentId: string): AgentRole | undefined {
    const def = this.agentDefs.find((d) => d.type === agentId);
    return def?.role;
  }

  private resolveModelForAgent(agentId: string): string {
    return (
      this.projectConfig.model_overrides?.[agentId]?.model ??
      this.platformConfig.defaults.model_per_agent[agentId]?.model ??
      this.platformConfig.defaults.model_per_agent.developer?.model ??
      ""
    );
  }

  private findAgentByRole(role: AgentRole): AgentDefinition | undefined {
    // Prefer agents in the project's catalog if configured
    const catalog = this.projectConfig.agents;
    if (catalog && catalog.length > 0) {
      const match = this.agentDefs.find(
        (d) => d.role === role && catalog.includes(d.type)
      );
      if (match) return match;
    }
    // Fallback: any agent with this role
    return this.agentDefs.find((d) => d.role === role);
  }

  // ---- Rule Condition Evaluation ----

  private evaluateCondition(
    condition: PlatformRule["condition"],
    ticket: TicketDetails,
    plan: ExecutionPlan
  ): boolean {
    switch (condition.type) {
      case "always":
        return true;

      case "classification_is":
        return condition.values.includes(plan.classification);

      case "label_contains":
        return ticket.labels.some((l) =>
          l.toLowerCase().includes(condition.value.toLowerCase())
        );

      case "file_path_matches":
        return this.matchesPlanPaths(plan, condition.pattern);

      case "priority_is":
        return condition.values.includes(ticket.priority);

      default:
        return false;
    }
  }

  // ---- Rule Enforcement ----

  private enforceRequiredAgent(
    plan: ExecutionPlan,
    agent: AgentType,
    injected: PlanStep[]
  ) {
    const hasAgent = plan.steps.some((s) => s.agent === agent);
    if (hasAgent) return; // already in plan

    // Determine where to insert based on agent's role
    const insertAfter = this.getInsertionPoint(plan, agent);
    const stepNumber = this.getNextStepNumber(plan, injected);

    injected.push({
      step_number: stepNumber,
      agent,
      model: this.resolveModelForAgent(agent),
      task: `[AUTO-INJECTED BY RULE] Run ${agent} agent scan/review`,
      context_inputs: [{ type: "ticket" }],
      depends_on: insertAfter ? [insertAfter] : [],
      estimated_complexity: "medium",
    });
  }

  private enforceRequiredRole(
    plan: ExecutionPlan,
    role: AgentRole,
    injected: PlanStep[]
  ) {
    // Check if any agent with this role is already in the plan
    const hasRole = plan.steps.some((s) => this.getRoleForAgent(s.agent) === role);
    if (hasRole) return;

    // Also check already-injected steps
    const hasRoleInInjected = injected.some((s) => this.getRoleForAgent(s.agent) === role);
    if (hasRoleInInjected) return;

    // Find an agent with this role from the project's catalog
    const agentDef = this.findAgentByRole(role);
    if (!agentDef) return; // no agent available for this role

    const insertAfter = this.getInsertionPoint(plan, agentDef.type);
    const stepNumber = this.getNextStepNumber(plan, injected);

    injected.push({
      step_number: stepNumber,
      agent: agentDef.type,
      model: this.resolveModelForAgent(agentDef.type),
      task: `[AUTO-INJECTED BY RULE] Run ${agentDef.name} (role: ${role})`,
      context_inputs: [{ type: "ticket" }],
      depends_on: insertAfter ? [insertAfter] : [],
      estimated_complexity: "medium",
    });
  }

  private enforceHumanGate(
    plan: ExecutionPlan,
    afterAgent: AgentType,
    injected: HumanGate[]
  ) {
    // Find the last step of the specified agent type
    let agentSteps = plan.steps.filter((s) => s.agent === afterAgent);

    // Fallback: match by role when exact agent ID not found
    if (agentSteps.length === 0) {
      const targetRole = this.getRoleForAgent(afterAgent);
      if (targetRole) {
        agentSteps = plan.steps.filter(
          (s) => this.getRoleForAgent(s.agent) === targetRole
        );
      }
    }

    if (agentSteps.length === 0) return;

    const lastStep = agentSteps[agentSteps.length - 1];
    injected.push({
      after_step: lastStep.step_number,
      reason: `[RULE] Human review required after ${afterAgent} agent`,
      required: true,
    });
  }

  // ---- Helpers ----

  private getInsertionPoint(plan: ExecutionPlan, agent: AgentType): number | null {
    const agentRole = this.getRoleForAgent(agent);
    const agentIndex = agentRole ? ROLE_ORDER.indexOf(agentRole) : -1;

    // Find the last step of any agent whose role comes before this one in the order
    for (let i = agentIndex - 1; i >= 0; i--) {
      const priorSteps = plan.steps.filter((s) => {
        const stepRole = this.getRoleForAgent(s.agent);
        return stepRole === ROLE_ORDER[i];
      });
      if (priorSteps.length > 0) {
        return priorSteps[priorSteps.length - 1].step_number;
      }
    }

    // If no prior agent found, return the last step
    return plan.steps.length > 0
      ? plan.steps[plan.steps.length - 1].step_number
      : null;
  }

  private getNextStepNumber(plan: ExecutionPlan, injected: PlanStep[]): number {
    const allSteps = [...plan.steps, ...injected];
    return Math.max(0, ...allSteps.map((s) => s.step_number)) + 1;
  }

  private insertSteps(plan: ExecutionPlan, newSteps: PlanStep[]) {
    plan.steps.push(...newSteps);
    // Re-sort by step number
    plan.steps.sort((a, b) => a.step_number - b.step_number);
  }

  private validateDependencies(plan: ExecutionPlan) {
    const stepNumbers = new Set(plan.steps.map((s) => s.step_number));
    for (const step of plan.steps) {
      for (const dep of step.depends_on) {
        if (!stepNumbers.has(dep)) {
          throw new Error(
            `Plan validation error: step ${step.step_number} depends on non-existent step ${dep}`
          );
        }
      }
    }
  }

  private validateNoDuplicateSteps(plan: ExecutionPlan) {
    const seen = new Set<number>();
    for (const step of plan.steps) {
      if (seen.has(step.step_number)) {
        throw new Error(
          `Plan validation error: duplicate step number ${step.step_number}`
        );
      }
      seen.add(step.step_number);
    }
  }

  private matchesPlanPaths(plan: ExecutionPlan, pattern: string): boolean {
    const candidatePaths = plan.steps.flatMap((step) =>
      step.context_inputs.flatMap((input) => {
        if (input.type === "file") return [this.normalizePath(input.path)];
        if (input.type === "directory") {
          const normalized = this.normalizePath(input.path);
          return [normalized, `${normalized}/`];
        }
        return [];
      })
    );
    if (candidatePaths.length === 0) return false;

    const regex = this.globLikePatternToRegex(pattern);
    return candidatePaths.some((candidate) => regex.test(candidate));
  }

  private normalizePath(p: string): string {
    return p.replace(/\\/g, "/").replace(/^\.\/+/, "");
  }

  private globLikePatternToRegex(pattern: string): RegExp {
    const normalized = this.normalizePath(pattern);
    const escaped = normalized.replace(/[.+^${}\[\]\\]/g, "\\$&");
    const regexBody = escaped
      .replace(/\*\*/g, "___DOUBLE_STAR___")
      .replace(/\*/g, "[^/]*")
      .replace(/___DOUBLE_STAR___/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${regexBody}$`);
  }
}

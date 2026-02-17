import * as fs from "fs/promises";
import * as path from "path";
import type {
  AgentDefinition,
  AgentResult,
  ExecutionPlan,
  PlanStep,
  PlatformConfig,
  PlatformRule,
  ProjectConfig,
  ProjectRule,
  StepExecution,
  TicketDetails,
} from "../../shared/types.js";
import type { PlannerRuntime } from "./types.js";
import { runProcess } from "./process-utils.js";

/**
 * PlannerRuntime that uses the Claude Code CLI (`claude -p`) in local_process mode.
 * Mirrors CodexPlannerRuntime but for the claude-code provider.
 * Does NOT require an API key — relies on the local Claude Code auth.
 */
export class ClaudeCodePlannerRuntime implements PlannerRuntime {
  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig
  ) {}

  async generatePlan(
    ticket: TicketDetails,
    agentDefinitions: AgentDefinition[],
    rules: (PlatformRule | ProjectRule)[],
    workspacePath: string
  ): Promise<ExecutionPlan> {
    const filteredAgents = this.filterAgents(agentDefinitions);
    const taskPath = path.join(workspacePath, ".planner-task.md");
    const outputPath = path.join(workspacePath, ".planner-plan.raw.txt");

    // Build the full prompt (system + user combined for -p mode)
    const prompt = this.buildPrompt(ticket, filteredAgents, rules);
    await fs.writeFile(taskPath, prompt, "utf-8");

    const apiKey = this.resolveApiKey();
    const model = this.resolveModel();

    console.log(`[planner] Calling Claude Code CLI for plan generation (model: ${model})...`);
    console.log(`[planner] Task file written to: ${taskPath}`);

    await runProcess("claude", [
      "-p",
      `Read .planner-task.md and return ONLY the JSON execution plan. No markdown fences, no explanation.`,
      "--output-format", "text",
      "--dangerously-skip-permissions",
    ], {
      cwd: workspacePath,
      env: {
        ...process.env,
        ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
        ...(model ? { ANTHROPIC_MODEL: model } : {}),
      },
      timeoutMs: this.platformConfig.defaults.timeouts.agent_timeout_minutes * 60 * 1000,
      parseTokensFromStdout: false,
      outputFiles: {
        stdoutPath: outputPath,
        stderrPath: path.join(workspacePath, ".planner-runtime.stderr.log"),
      },
    });

    console.log(`[planner] Claude Code CLI completed. Reading plan output...`);
    const planRaw = await fs.readFile(outputPath, "utf-8");
    console.log(`[planner] Raw plan output (${planRaw.length} chars): ${planRaw.slice(0, 200)}...`);
    const cleaned = planRaw.replace(/```json\n?|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    const steps = (parsed.steps as PlanStep[]).map((step) => ({
      ...step,
      model: this.resolveModelForAgent(step.agent),
    }));

    return {
      plan_id: `plan-${Date.now()}`,
      ticket_id: ticket.id,
      classification: parsed.classification,
      reasoning: parsed.reasoning,
      steps,
      parallel_groups: parsed.parallel_groups ?? [],
      human_gates: parsed.human_gates ?? [],
    };
  }

  async planRework(
    ticket: TicketDetails,
    failedStep: PlanStep,
    failureResult: AgentResult,
    workspacePath: string,
    runSteps: StepExecution[] = [],
    reworkAttempt: number = 1,
    previousReworkResults: AgentResult[] = []
  ): Promise<{ steps: PlanStep[] }> {
    const filteredAgents = this.filterAgents(this.platformConfig.agent_definitions);
    const taskPath = path.join(workspacePath, ".planner-rework-task.md");
    const outputPath = path.join(workspacePath, ".planner-rework.raw.txt");

    const completedStepsSummary = runSteps
      .filter((s) => s.status === "completed" && s.result)
      .map((s) => `- Step ${s.step_number} (${s.agent}): ${s.result!.summary}`)
      .join("\n");

    const reworkHistory = previousReworkResults.length > 0
      ? `\n## Previous Rework Attempts\n${previousReworkResults.map((r, i) =>
          `### Attempt ${i + 1}\nStatus: ${r.status}\nSummary: ${r.summary}\nIssues: ${r.issues.join("; ")}`
        ).join("\n\n")}`
      : "";

    const prompt = `You are the orchestrator for SprintFoundry. A step has failed and you need to plan minimal rework steps.

## Available Agents
${filteredAgents.map((a) => `- ${a.name} (id: "${a.type}", role: "${a.role}"): ${a.capabilities.slice(0, 3).join(", ")}`).join("\n")}

## Completed Steps
${completedStepsSummary || "(none)"}

## Failed Step
Step ${failedStep.step_number} (${failedStep.agent}): ${failedStep.task}
Status: ${failureResult.status}
Reason: ${failureResult.rework_reason ?? "unknown"}
Issues: ${failureResult.issues.join("; ")}

## Rework Attempt ${reworkAttempt} of ${this.platformConfig.defaults.max_rework_cycles}
${reworkHistory}

Return ONLY a valid JSON array of 1-2 rework steps. No markdown fences.
Each step: { "step_number": 900+N, "agent": "id", "model": "string", "task": "description", "context_inputs": [{"type":"ticket"},{"type":"step_output","step_number":N}], "depends_on": [], "estimated_complexity": "medium" }`;

    await fs.writeFile(taskPath, prompt, "utf-8");

    const apiKey = this.resolveApiKey();
    const model = this.resolveModel();

    try {
      await runProcess("claude", [
        "-p",
        `Read .planner-rework-task.md and return ONLY the JSON array. No markdown fences.`,
        "--output-format", "text",
        "--dangerously-skip-permissions",
      ], {
        cwd: workspacePath,
        env: {
          ...process.env,
          ...(apiKey ? { ANTHROPIC_API_KEY: apiKey } : {}),
          ...(model ? { ANTHROPIC_MODEL: model } : {}),
        },
        timeoutMs: this.platformConfig.defaults.timeouts.agent_timeout_minutes * 60 * 1000,
        parseTokensFromStdout: false,
        outputFiles: {
          stdoutPath: outputPath,
          stderrPath: path.join(workspacePath, ".planner-rework.stderr.log"),
        },
      });

      const raw = await fs.readFile(outputPath, "utf-8");
      const cleaned = raw.replace(/```json\n?|```/g, "").trim();
      const steps = JSON.parse(cleaned) as PlanStep[];
      return { steps };
    } catch {
      // Fallback: just re-run the failed step's target agent
      return {
        steps: [
          {
            step_number: 900 + failedStep.step_number,
            agent: failureResult.rework_target ?? failedStep.agent,
            model: this.resolveModelForAgent(failureResult.rework_target ?? failedStep.agent),
            task: `Fix issue from step ${failedStep.step_number}: ${failureResult.rework_reason ?? failureResult.issues.join("; ")}`,
            context_inputs: [
              { type: "ticket" },
              { type: "step_output", step_number: failedStep.step_number },
            ],
            depends_on: [],
            estimated_complexity: "medium",
          },
        ],
      };
    }
  }

  private filterAgents(agentDefinitions: AgentDefinition[]): AgentDefinition[] {
    const catalog = this.projectConfig.agents;
    if (!catalog || catalog.length === 0) return agentDefinitions;
    return agentDefinitions.filter((a) => catalog.includes(a.type));
  }

  private resolveApiKey(): string {
    const keys = this.projectConfig.api_keys;
    const key = keys.anthropic;
    // For local_process mode, key is optional — Claude Code CLI handles auth
    return typeof key === "string" ? key : "";
  }

  private resolveModel(): string {
    return (
      this.projectConfig.model_overrides?.orchestrator?.model ??
      this.platformConfig.defaults.model_per_agent.orchestrator?.model ??
      this.platformConfig.defaults.model_per_agent.developer?.model ??
      "claude-sonnet-4-5-20250929"
    );
  }

  private resolveModelForAgent(agentId: string): string {
    return (
      this.projectConfig.model_overrides?.[agentId]?.model ??
      this.platformConfig.defaults.model_per_agent[agentId]?.model ??
      this.platformConfig.defaults.model_per_agent.developer?.model ??
      ""
    );
  }

  private buildPrompt(
    ticket: TicketDetails,
    agentDefinitions: AgentDefinition[],
    rules: (PlatformRule | ProjectRule)[]
  ): string {
    return `You are the orchestrator for SprintFoundry, an AI-powered software development platform.
Your job is to analyze incoming tickets and create execution plans that assign work to specialized agents.

## Available Agents

${agentDefinitions.map((a) => `### ${a.name} (id: "${a.type}", role: "${a.role}"${a.stack ? `, stack: "${a.stack}"` : ""}${a.plugins?.length ? `, plugins: [${a.plugins.join(", ")}]` : ""})
${a.description}
Capabilities: ${a.capabilities.join(", ")}
Outputs: ${a.output_artifacts.join(", ")}
Requires: ${a.required_inputs.join(", ")}
`).join("\n")}

## Platform Rules (you must respect these)

${rules.map((r) => `- ${r.description}`).join("\n")}

## Your Output Format

You must return a JSON execution plan. Return ONLY valid JSON, no markdown fences, no explanation before or after.

Schema:
{
  "classification": "new_feature | bug_fix | ui_change | refactor | infrastructure | security_fix | documentation | product_question",
  "reasoning": "1-3 sentences explaining your classification and plan rationale",
  "steps": [
    {
      "step_number": 1,
      "agent": "agent_id",
      "model": "string",
      "task": "detailed natural language task description for the agent",
      "context_inputs": [
        { "type": "ticket" },
        { "type": "file", "path": "src/relevant/file.ts" },
        { "type": "step_output", "step_number": 1 }
      ],
      "depends_on": [],
      "estimated_complexity": "low | medium | high"
    }
  ],
  "parallel_groups": [[2, 3]],
  "human_gates": [
    { "after_step": 1, "reason": "Review product spec before coding", "required": true }
  ]
}
Set "model" for each step to the agent model that should run that step.

## Planning Guidelines

1. Keep plans minimal. Don't add agents that aren't needed.
2. Bug fixes typically need: developer → qa. That's it.
3. New features MAY need: product → developer → qa. Only add product agent if the ticket is genuinely vague.
4. Architecture agent is only needed for significant new infrastructure or non-obvious technical decisions.
5. UI/UX agent is only needed for visual design work, not for every frontend change.
6. Security agent is needed for auth, payments, PII handling, and when labels indicate security concerns.
7. Always specify which files/directories are relevant as context_inputs. Don't just say "the codebase".
8. Task descriptions should be specific and actionable, not vague.
9. Mark steps that can run in parallel in parallel_groups.
10. Add human_gates sparingly — only when the decision is significant enough to warrant pausing.
11. Use the agent IDs exactly as listed above (e.g. "go-developer" not "developer" for Go projects).

## Ticket

ID: ${ticket.id}
Source: ${ticket.source}
Title: ${ticket.title}
Priority: ${ticket.priority}
Labels: ${ticket.labels.join(", ") || "none"}

### Description
${ticket.description}

### Acceptance Criteria
${ticket.acceptance_criteria.length > 0
  ? ticket.acceptance_criteria.map((c) => `- ${c}`).join("\n")
  : "None specified"}

## Task
Analyze this ticket and return an execution plan as JSON.`;
  }
}

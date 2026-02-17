// ============================================================
// SprintFoundry — Orchestrator Agent
// The "soft core" — uses Claude to classify tickets and generate plans
// ============================================================

import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs/promises";
import * as path from "path";
import type {
  TicketDetails,
  ExecutionPlan,
  PlanStep,
  StepExecution,
  AgentDefinition,
  PlatformRule,
  ProjectRule,
  PlatformConfig,
  ProjectConfig,
  AgentResult,
} from "../shared/types.js";

export class OrchestratorAgent {
  private client: Anthropic;
  private model: string;

  constructor(
    private platformConfig: PlatformConfig,
    private projectConfig: ProjectConfig
  ) {
    const apiKey = this.resolveApiKey();
    // If key is empty, let the SDK resolve from ANTHROPIC_API_KEY env var
    this.client = apiKey ? new Anthropic({ apiKey }) : new Anthropic();
    this.model =
      projectConfig.model_overrides?.orchestrator?.model ??
      platformConfig.defaults.model_per_agent.orchestrator?.model ??
      platformConfig.defaults.model_per_agent.developer?.model ??
      "claude-sonnet-4-5-20250929";
  }

  // ---- Generate Execution Plan ----

  async generatePlan(
    ticket: TicketDetails,
    agentDefinitions: AgentDefinition[],
    rules: (PlatformRule | ProjectRule)[],
    workspacePath: string
  ): Promise<ExecutionPlan> {
    // Filter agents to project's catalog if configured
    const filteredAgents = this.filterAgents(agentDefinitions);

    // Gather repo context (file tree, key files)
    const repoContext = await this.gatherRepoContext(workspacePath);

    const systemPrompt = this.buildSystemPrompt(filteredAgents, rules);
    const userPrompt = this.buildUserPrompt(ticket, repoContext);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });

    // Parse the plan from Claude's response
    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    return this.parsePlan(content, ticket.id);
  }

  // ---- Plan Rework ----

  async planRework(
    ticket: TicketDetails,
    failedStep: PlanStep,
    failureResult: AgentResult,
    workspacePath: string,
    runSteps: StepExecution[] = [],
    reworkAttempt: number = 1,
    previousReworkResults: AgentResult[] = []
  ): Promise<{ steps: PlanStep[] }> {
    // Gather context the orchestrator needs for informed rework decisions
    const repoContext = await this.gatherRepoContext(workspacePath);
    const filteredAgents = this.filterAgents(this.platformConfig.agent_definitions);

    // Build system prompt with agent definitions (was missing before)
    const systemPrompt = this.buildReworkSystemPrompt(filteredAgents);

    // Build comprehensive user prompt with all available context
    const completedStepsSummary = runSteps
      .filter((s) => s.status === "completed" && s.result)
      .map((s) => `- Step ${s.step_number} (${s.agent}): ${s.result!.summary}`)
      .join("\n");

    const failedStepArtifacts = failureResult.artifacts_created.length > 0
      ? `\nArtifacts from failed step: ${failureResult.artifacts_created.join(", ")}`
      : "";

    const reworkHistory = previousReworkResults.length > 0
      ? `\n## Previous Rework Attempts\n${previousReworkResults.map((r, i) =>
          `### Attempt ${i + 1}\nStatus: ${r.status}\nSummary: ${r.summary}\nIssues: ${r.issues.join("; ")}`
        ).join("\n\n")}`
      : "";

    const prompt = `
A step in the execution plan has failed and needs rework.

## Original Ticket
Title: ${ticket.title}
Description: ${ticket.description}

## Completed Steps
${completedStepsSummary || "(none)"}

## Failed Step
Step ${failedStep.step_number} (${failedStep.agent}): ${failedStep.task}

## Failure Details
Status: ${failureResult.status}
Reason: ${failureResult.rework_reason ?? "unknown"}
Issues: ${failureResult.issues.join("; ")}${failedStepArtifacts}

## Rework Attempt
This is rework attempt ${reworkAttempt} of ${this.platformConfig.defaults.max_rework_cycles}.
${reworkHistory}

## Repository Context
${repoContext}

## Your Task
Generate 1-2 rework steps to fix the issue before retrying the failed step.
Return a JSON array of steps in the same format as the execution plan.
Focus on the minimal set of actions needed to resolve the issue.
Consider what went wrong in previous attempts (if any) and try a different approach.

Return ONLY valid JSON, no markdown fences.
`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }],
    });

    const content = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    try {
      const cleaned = content.replace(/```json\n?|```/g, "").trim();
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

  // ---- Agent Filtering ----

  private filterAgents(agentDefinitions: AgentDefinition[]): AgentDefinition[] {
    const catalog = this.projectConfig.agents;
    if (!catalog || catalog.length === 0) return agentDefinitions;
    return agentDefinitions.filter((a) => catalog.includes(a.type));
  }

  // ---- System Prompts ----

  private buildSystemPrompt(
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
2. Bug fixes typically need: developer \u2192 qa. That's it.
3. New features MAY need: product \u2192 developer \u2192 qa. Only add product agent if the ticket is genuinely vague.
4. Architecture agent is only needed for significant new infrastructure or non-obvious technical decisions.
5. UI/UX agent is only needed for visual design work, not for every frontend change.
6. Security agent is needed for auth, payments, PII handling, and when labels indicate security concerns.
7. **Code review agent** sits between developer and QA: developer \u2192 code-review \u2192 qa. Include it for:
   - P0 tickets (mandatory — platform rule enforces this)
   - Complex features or large refactors
   - Tickets labeled "complex" (suggested by platform rule)
   - Skip it for simple bug fixes or documentation-only changes.
8. Always specify which files/directories are relevant as context_inputs. Don't just say "the codebase".
9. Task descriptions should be specific and actionable, not vague.
10. Mark steps that can run in parallel in parallel_groups.
11. Add human_gates sparingly \u2014 only when the decision is significant enough to warrant pausing.
12. Use the agent IDs exactly as listed above (e.g. "go-developer" not "developer" for Go projects).`;
  }

  private buildReworkSystemPrompt(agentDefinitions: AgentDefinition[]): string {
    return `You are the orchestrator for SprintFoundry. A step in the execution plan has failed and you need to plan minimal rework steps.

## Available Agents

${agentDefinitions.map((a) => `- ${a.name} (id: "${a.type}", role: "${a.role}"): ${a.capabilities.slice(0, 3).join(", ")}`).join("\n")}

## Rules
- Return ONLY a valid JSON array of rework steps (no markdown fences).
- Keep rework minimal: 1-2 steps maximum.
- Each step must have: step_number, agent, model, task, context_inputs, depends_on, estimated_complexity.
- Use step_number 900+ for rework steps to avoid collisions.
- If previous rework attempts failed, try a different approach.`;
  }

  // ---- User Prompt ----

  private buildUserPrompt(ticket: TicketDetails, repoContext: string): string {
    return `## Ticket

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

### Comments
${ticket.comments.length > 0
  ? ticket.comments.join("\n---\n")
  : "None"}

## Repository Context
${repoContext}

## Task
Analyze this ticket and return an execution plan as JSON.`;
  }

  // ---- Repo Context Gathering ----

  private async gatherRepoContext(workspacePath: string): Promise<string> {
    const sections: string[] = [];

    // Get file tree (top 2 levels)
    try {
      const { execSync } = await import("child_process");
      const tree = execSync(
        'find . -maxdepth 3 -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/.next/*" | head -100',
        { cwd: workspacePath, encoding: "utf-8" }
      );
      sections.push("### File Structure (top 3 levels)");
      sections.push("```");
      sections.push(tree.trim());
      sections.push("```");
    } catch {
      sections.push("File structure: unavailable");
    }

    // Read package.json if it exists
    try {
      const pkg = await fs.readFile(
        path.join(workspacePath, "package.json"),
        "utf-8"
      );
      const parsed = JSON.parse(pkg);
      sections.push("### Tech Stack (from package.json)");
      sections.push(`Dependencies: ${Object.keys(parsed.dependencies ?? {}).join(", ")}`);
      sections.push(`Dev Dependencies: ${Object.keys(parsed.devDependencies ?? {}).join(", ")}`);
    } catch {
      // No package.json
    }

    // Read go.mod if it exists
    try {
      const gomod = await fs.readFile(
        path.join(workspacePath, "go.mod"),
        "utf-8"
      );
      sections.push("### Tech Stack (from go.mod)");
      const moduleMatch = gomod.match(/^module\s+(.+)$/m);
      if (moduleMatch) sections.push(`Module: ${moduleMatch[1]}`);
      const goMatch = gomod.match(/^go\s+(.+)$/m);
      if (goMatch) sections.push(`Go version: ${goMatch[1]}`);
    } catch {
      // No go.mod
    }

    // Read existing artifacts if any
    try {
      const artifactsDir = path.join(workspacePath, "artifacts");
      const files = await fs.readdir(artifactsDir).catch(() => []);
      if (files.length > 0) {
        sections.push("### Existing Artifacts");
        sections.push(files.map((f) => `- artifacts/${f}`).join("\n"));
      }
    } catch {
      // No artifacts
    }

    return sections.join("\n\n");
  }

  // ---- Response Parsing ----

  private parsePlan(content: string, ticketId: string): ExecutionPlan {
    // Strip any markdown code fences
    const cleaned = content.replace(/```json\n?|```/g, "").trim();

    try {
      const parsed = JSON.parse(cleaned);
      const steps = (parsed.steps as PlanStep[]).map((step) => ({
        ...step,
        model: this.resolveModelForAgent(step.agent),
      }));

      return {
        plan_id: `plan-${Date.now()}`,
        ticket_id: ticketId,
        classification: parsed.classification,
        reasoning: parsed.reasoning,
        steps,
        parallel_groups: parsed.parallel_groups ?? [],
        human_gates: parsed.human_gates ?? [],
      };
    } catch (error) {
      throw new Error(
        `Failed to parse orchestrator agent plan: ${error}\n\nRaw output:\n${content.slice(0, 1000)}`
      );
    }
  }

  // ---- Helpers ----

  private resolveApiKey(): string {
    const keys = this.projectConfig.api_keys;
    const provider =
      this.projectConfig.model_overrides?.orchestrator?.provider ?? "anthropic";
    const key = keys[provider as keyof typeof keys];
    // Return empty string if no key configured — the Anthropic SDK will
    // fall back to ANTHROPIC_API_KEY env var automatically
    return typeof key === "string" ? key : "";
  }

  private resolveModelForAgent(agentId: string): string {
    return (
      this.projectConfig.model_overrides?.[agentId]?.model ??
      this.platformConfig.defaults.model_per_agent[agentId]?.model ??
      this.platformConfig.defaults.model_per_agent.developer?.model ??
      ""
    );
  }
}

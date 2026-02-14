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

export class CodexPlannerRuntime implements PlannerRuntime {
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
    const taskPath = path.join(workspacePath, ".planner-task.md");
    const outputPath = path.join(workspacePath, ".planner-plan.raw.txt");

    const prompt = `Create an execution plan JSON for SprintFoundry.
Ticket ID: ${ticket.id}
Title: ${ticket.title}
Description: ${ticket.description}
Priority: ${ticket.priority}
Labels: ${ticket.labels.join(", ") || "none"}
Available agents: ${agentDefinitions.map((a) => `${a.type} (${a.role})`).join(", ")}
Rules: ${rules.map((r) => r.description).join("; ")}

Return ONLY valid JSON with schema:
{
  "classification": "new_feature|bug_fix|ui_change|refactor|infrastructure|security_fix|documentation|product_question",
  "reasoning": "string",
  "steps": [{ "step_number": 1, "agent": "developer", "model": "string", "task": "string", "context_inputs": [{"type":"ticket"}], "depends_on": [], "estimated_complexity": "low|medium|high" }],
  "parallel_groups": [],
  "human_gates": []
}
Set "model" for each step to the agent model that should run that step.`;
    await fs.writeFile(taskPath, prompt, "utf-8");

    const runtime = this.resolvePlannerRuntime();
    const apiKey = this.resolveOpenAiKey(runtime.mode);
    const runtimeArgs = runtime.args ?? [];
    const hasSandboxFlag = runtimeArgs.includes("--sandbox") || runtimeArgs.includes("-s");
    await runProcess(runtime.command ?? "codex", [
      ...runtimeArgs,
      "exec",
      "Read .planner-task.md and return only the JSON plan with no markdown fences.",
      "--json",
      "--output-last-message",
      ".planner-plan.raw.txt",
      ...(hasSandboxFlag ? [] : ["--sandbox", "workspace-write"]),
    ], {
      cwd: workspacePath,
      env: {
        ...process.env,
        ...(apiKey ? { OPENAI_API_KEY: apiKey } : {}),
        ...(runtime.env ?? {}),
      },
      timeoutMs: this.platformConfig.defaults.timeouts.agent_timeout_minutes * 60 * 1000,
      parseTokensFromStdout: false,
      outputFiles: {
        stdoutPath: path.join(workspacePath, ".planner-runtime.stdout.log"),
        stderrPath: path.join(workspacePath, ".planner-runtime.stderr.log"),
      },
    });

    const planRaw = await fs.readFile(outputPath, "utf-8");
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
    _ticket: TicketDetails,
    failedStep: PlanStep,
    failureResult: AgentResult,
    _workspacePath: string,
    _runSteps: StepExecution[] = [],
    _reworkAttempt: number = 1,
    _previousReworkResults: AgentResult[] = []
  ): Promise<{ steps: PlanStep[] }> {
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

  private resolvePlannerRuntime() {
    return (
      this.projectConfig.planner_runtime_override ??
      this.platformConfig.defaults.planner_runtime ?? {
        provider: "codex" as const,
        mode: "local_process" as const,
      }
    );
  }

  private resolveOpenAiKey(mode: string): string {
    const key = this.projectConfig.api_keys.openai;
    if (!key && mode !== "local_process") {
      throw new Error("No OpenAI API key configured for codex planner");
    }
    return key ?? "";
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

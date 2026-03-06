import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
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

    // Seed Codex auth state for local_process runs when only an API key is available.
    if (apiKey) {
      await writeCodexConfigToml(apiKey);
    }
    const runtimeArgs = runtime.args ?? [];
    const hasSandboxFlag = runtimeArgs.includes("--sandbox") || runtimeArgs.includes("-s");
    const hasBypassFlag = runtimeArgs.includes("--dangerously-bypass-approvals-and-sandbox");
    const plannerModel = this.resolvePlannerModel();
    const reasoningEffort = this.resolveModelReasoningEffort(
      runtime.model_reasoning_effort,
      plannerModel
    );
    const hasReasoningEffortArg = runtimeArgs.some(
      (arg) => arg.includes("model_reasoning_effort")
    );
    const hasModelArg = runtimeArgs.some((arg) => arg.includes("model="));
    await runProcess(runtime.command ?? "codex", [
      ...runtimeArgs,
      "exec",
      "--skip-git-repo-check",
      ...(runtime.model && !hasModelArg
        ? ["--config", `model="${runtime.model}"`]
        : []),
      ...(reasoningEffort && !hasReasoningEffortArg
        ? ["--config", `model_reasoning_effort=\"${reasoningEffort}\"`]
        : []),
      "Read .planner-task.md and return only the JSON plan with no markdown fences.",
      "--json",
      "--output-last-message",
      ".planner-plan.raw.txt",
      ...(hasSandboxFlag || hasBypassFlag ? [] : ["--sandbox", "workspace-write"]),
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
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { steps?: unknown }).steps)) {
      const hint = cleaned.slice(0, 500).replace(/\s+/g, " ");
      throw new Error(
        `Planner returned invalid JSON schema (missing steps array). Raw output starts with: ${hint}`
      );
    }
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

  private resolvePlannerModel(): string {
    return (
      this.projectConfig.model_overrides?.orchestrator?.model ??
      this.platformConfig.defaults.model_per_agent.orchestrator?.model ??
      this.platformConfig.defaults.model_per_agent.developer?.model ??
      ""
    );
  }

  private resolveModelReasoningEffort(
    effort: ReturnType<CodexPlannerRuntime["resolvePlannerRuntime"]>["model_reasoning_effort"] | undefined,
    model: string
  ): ReturnType<CodexPlannerRuntime["resolvePlannerRuntime"]>["model_reasoning_effort"] | undefined {
    if (!effort) return undefined;
    return /codex/i.test(model) ? effort : undefined;
  }
}

type CodexAuthState = {
  OPENAI_API_KEY?: string | null;
  [key: string]: unknown;
};

/**
 * Seed Codex CLI auth state before spawning a local process.
 * Keep both files for compatibility:
 * - ~/.codex/config.toml (legacy key path)
 * - ~/.codex/auth.json with OPENAI_API_KEY (current CLI key path)
 */
export async function writeCodexConfigToml(apiKey: string): Promise<void> {
  const configDir = path.join(os.homedir(), ".codex");
  const configPath = path.join(configDir, "config.toml");
  const authPath = path.join(configDir, "auth.json");
  await fs.mkdir(configDir, { recursive: true });
  const content = `[openai]\napi_key = "${apiKey}"\n`;
  await fs.writeFile(configPath, content, { encoding: "utf-8", mode: 0o600 });

  const existingAuth = await fs
    .readFile(authPath, "utf-8")
    .then((raw) => JSON.parse(raw) as CodexAuthState)
    .catch(() => ({} as CodexAuthState));
  const nextAuth: CodexAuthState = {
    ...existingAuth,
    OPENAI_API_KEY: apiKey,
  };
  await fs.writeFile(authPath, `${JSON.stringify(nextAuth, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
}

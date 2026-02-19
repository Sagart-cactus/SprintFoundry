import type {
  AgentDefinition,
  AgentResult,
  AgentType,
  ExecutionPlan,
  ModelConfig,
  PlanStep,
  PlatformRule,
  ProjectRule,
  RuntimeConfig,
  TicketDetails,
  ContextInput,
  AgentCliFlags,
  ContainerResources,
  StepExecution,
} from "../../shared/types.js";

export interface RuntimeStepContext {
  stepNumber: number;
  stepAttempt: number;
  agent: AgentType;
  task: string;
  context_inputs: ContextInput[];
  workspacePath: string;
  modelConfig: ModelConfig;
  apiKey: string;
  timeoutMinutes: number;
  tokenBudget: number;
  previousStepResults: {
    step_number: number;
    agent: AgentType;
    result: AgentResult;
  }[];
  plugins?: string[];
  cliFlags?: AgentCliFlags;
  containerResources?: ContainerResources;
  runtime: RuntimeConfig;
  containerImage?: string;
  codexHomeDir?: string;
  codexSkillNames?: string[];
}

export interface RuntimeStepResult {
  tokens_used: number;
  runtime_id: string;
  cost_usd?: number;
  usage?: Record<string, number>;
}

export interface AgentRuntime {
  runStep(config: RuntimeStepContext): Promise<RuntimeStepResult>;
}

export interface PlannerRuntime {
  generatePlan(
    ticket: TicketDetails,
    agentDefinitions: AgentDefinition[],
    rules: (PlatformRule | ProjectRule)[],
    workspacePath: string
  ): Promise<ExecutionPlan>;

  planRework(
    ticket: TicketDetails,
    failedStep: PlanStep,
    failureResult: AgentResult,
    workspacePath: string,
    runSteps?: StepExecution[],
    reworkAttempt?: number,
    previousReworkResults?: AgentResult[]
  ): Promise<{ steps: PlanStep[] }>;
}

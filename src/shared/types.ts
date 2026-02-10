// ============================================================
// AgentSDLC — Core Type Definitions
// ============================================================

// ----- Agent Types -----

// Agent IDs are now free-form strings (e.g. "developer", "go-developer", "go-qa")
export type AgentType = string;

// AgentRole preserves ordering logic for plan validation and rule enforcement
export type AgentRole =
  | "orchestrator"
  | "product"
  | "architect"
  | "developer"
  | "qa"
  | "security"
  | "ui-ux"
  | "devops";

export type TaskSource = "linear" | "github" | "jira" | "prompt";

// ----- Ticket / Task -----

export interface TicketDetails {
  id: string;
  source: TaskSource;
  title: string;
  description: string;
  labels: string[];
  priority: "p0" | "p1" | "p2" | "p3";
  acceptance_criteria: string[];
  linked_tickets: string[];
  comments: string[];
  author: string;
  assignee?: string;
  raw: Record<string, unknown>; // original payload from source
}

// ----- Plan (produced by orchestrator agent) -----

export interface ExecutionPlan {
  plan_id: string;
  ticket_id: string;
  classification: TaskClassification;
  reasoning: string;
  steps: PlanStep[];
  parallel_groups: number[][]; // groups of step numbers that can run in parallel
  human_gates: HumanGate[];
}

export type TaskClassification =
  | "new_feature"
  | "bug_fix"
  | "ui_change"
  | "refactor"
  | "infrastructure"
  | "security_fix"
  | "documentation"
  | "product_question";

export interface PlanStep {
  step_number: number;
  agent: AgentType;
  task: string; // natural language task description
  context_inputs: ContextInput[];
  depends_on: number[]; // step numbers this depends on
  estimated_complexity: "low" | "medium" | "high";
}

export type ContextInput =
  | { type: "ticket"; } // the original ticket details
  | { type: "file"; path: string } // specific file from repo
  | { type: "directory"; path: string } // directory from repo
  | { type: "step_output"; step_number: number } // output from a previous step
  | { type: "artifact"; name: string }; // named artifact from workspace

export interface HumanGate {
  after_step: number;
  reason: string;
  required: boolean; // false = can be auto-approved if confidence is high
}

// ----- Configuration -----

export interface AgentCliFlags {
  max_budget_usd?: number;       // --max-budget-usd
  output_format?: string;        // --output-format (default: "json")
  skip_permissions?: boolean;    // --dangerously-skip-permissions (default: true)
}

export interface ContainerResources {
  memory?: string;   // default: "4g"
  cpus?: string;     // default: "2"
  network?: string;  // default: "bridge"
}

export interface PlatformConfig {
  defaults: {
    model_per_agent: Record<string, ModelConfig>;
    budgets: BudgetConfig;
    timeouts: TimeoutConfig;
    max_rework_cycles: number;
    agent_cli_flags?: AgentCliFlags;
    container_resources?: ContainerResources;
  };
  rules: PlatformRule[];
  agent_definitions: AgentDefinition[];
  events_dir?: string;
}

export interface ProjectConfig {
  project_id: string;
  name: string;
  repo: RepoConfig;
  api_keys: ApiKeyConfig;
  model_overrides?: Partial<Record<string, ModelConfig>>;
  budget_overrides?: Partial<BudgetConfig>;
  rules: ProjectRule[];
  integrations: IntegrationConfig;
  branch_strategy: BranchStrategy;
  stack?: string;       // e.g. "js", "go", "python"
  agents?: string[];    // agent IDs this project uses (filters the catalog)
}

export interface ModelConfig {
  provider: "anthropic" | "openai" | "google" | "custom";
  model: string; // e.g. "claude-sonnet-4-5-20250929"
  max_tokens?: number;
}

export interface ApiKeyConfig {
  anthropic?: string;
  openai?: string;
  google?: string;
  custom?: { provider: string; key: string }[];
}

export interface BudgetConfig {
  per_agent_tokens: number; // max tokens per single agent run
  per_task_total_tokens: number; // max tokens across all agents for one task
  per_task_max_cost_usd: number; // hard cost cap
}

export interface TimeoutConfig {
  agent_timeout_minutes: number; // max time for a single agent run
  task_timeout_minutes: number; // max time for entire task
  human_gate_timeout_hours: number; // auto-escalate if human doesn't respond
}

export interface RepoConfig {
  url: string; // git clone URL
  default_branch: string;
  ssh_key_path?: string;
  token?: string; // GitHub/GitLab token for HTTPS clone
}

export interface BranchStrategy {
  prefix: string; // e.g. "feat/", "fix/"
  include_ticket_id: boolean;
  naming: "kebab-case" | "snake_case";
}

export interface IntegrationConfig {
  ticket_source: {
    type: TaskSource;
    config: Record<string, string>; // API tokens, workspace IDs etc.
  };
  notifications?: {
    type: "slack" | "email" | "webhook";
    config: Record<string, string>;
  };
}

// ----- Rules -----

export interface PlatformRule {
  id: string;
  description: string;
  condition: RuleCondition;
  action: RuleAction;
  enforced: boolean; // true = service enforces, false = suggestion to orchestrator
}

export interface ProjectRule {
  id: string;
  description: string;
  condition: RuleCondition;
  action: RuleAction;
}

export type RuleCondition =
  | { type: "always" }
  | { type: "classification_is"; values: TaskClassification[] }
  | { type: "label_contains"; value: string }
  | { type: "file_path_matches"; pattern: string }
  | { type: "priority_is"; values: string[] };

export type RuleAction =
  | { type: "require_agent"; agent: AgentType }
  | { type: "require_role"; role: AgentRole }
  | { type: "require_human_gate"; after_agent: AgentType }
  | { type: "set_model"; agent: AgentType; model: ModelConfig }
  | { type: "set_budget"; budget: Partial<BudgetConfig> };

// ----- Agent Definitions -----

export interface AgentDefinition {
  type: AgentType;
  name: string;
  role: AgentRole;
  description: string; // sent to orchestrator so it knows what's available
  container_image: string;
  capabilities: string[];
  output_artifacts: string[]; // what files/artifacts this agent produces
  required_inputs: string[]; // what this agent needs to function
  stack?: string;            // e.g. "go", "js" — for stack-specific variants
  plugins?: string[];        // plugin directory names (resolved to plugins/<name>)
}

// ----- Execution State -----

export type RunStatus =
  | "pending"
  | "planning"
  | "executing"
  | "waiting_human_review"
  | "rework"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "needs_rework"
  | "skipped";

export interface TaskRun {
  run_id: string;
  project_id: string;
  ticket: TicketDetails;
  plan: ExecutionPlan | null;
  validated_plan: ExecutionPlan | null; // plan after service validation
  status: RunStatus;
  steps: StepExecution[];
  total_tokens_used: number;
  total_cost_usd: number;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  pr_url: string | null;
  error: string | null;
}

export interface StepExecution {
  step_number: number;
  agent: AgentType;
  status: StepStatus;
  container_id: string | null;
  tokens_used: number;
  cost_usd: number;
  started_at: Date | null;
  completed_at: Date | null;
  result: AgentResult | null;
  rework_count: number;
}

export interface AgentResult {
  status: "complete" | "needs_rework" | "blocked" | "failed";
  summary: string;
  artifacts_created: string[]; // file paths
  artifacts_modified: string[]; // file paths
  issues: string[];
  rework_reason?: string;
  rework_target?: AgentType;
  metadata: Record<string, unknown>;
}

// ----- Human Review -----

export interface HumanReview {
  review_id: string;
  run_id: string;
  after_step: number;
  status: "pending" | "approved" | "rejected";
  summary: string; // what was done so far
  artifacts_to_review: string[];
  reviewer_feedback?: string;
  decided_at?: Date;
}

// ----- Events (audit log) -----

export type EventType =
  | "task.created"
  | "task.plan_generated"
  | "task.plan_validated"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "step.started"
  | "step.completed"
  | "step.failed"
  | "step.rework_triggered"
  | "agent.spawned"
  | "agent.exited"
  | "agent.token_limit_warning"
  | "agent.token_limit_exceeded"
  | "human_gate.requested"
  | "human_gate.approved"
  | "human_gate.rejected"
  | "pr.created"
  | "ticket.updated";

export interface TaskEvent {
  event_id: string;
  run_id: string;
  event_type: EventType;
  timestamp: Date;
  data: Record<string, unknown>;
}

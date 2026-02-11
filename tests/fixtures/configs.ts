import type {
  PlatformConfig,
  ProjectConfig,
  AgentDefinition,
  PlatformRule,
  ModelConfig,
} from "../../src/shared/types.js";

export function makePlatformConfig(
  overrides?: Partial<PlatformConfig>
): PlatformConfig {
  return {
    defaults: {
      model_per_agent: {
        orchestrator: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
        developer: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
        qa: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
        security: { provider: "anthropic", model: "claude-sonnet-4-5-20250929" },
      },
      budgets: {
        per_agent_tokens: 500_000,
        per_task_total_tokens: 3_000_000,
        per_task_max_cost_usd: 25,
      },
      timeouts: {
        agent_timeout_minutes: 30,
        task_timeout_minutes: 180,
        human_gate_timeout_hours: 48,
      },
      max_rework_cycles: 3,
      agent_cli_flags: {
        max_budget_usd: 5,
        output_format: "json",
        skip_permissions: true,
      },
      container_resources: {
        memory: "4g",
        cpus: "2",
        network: "bridge",
      },
      runtime_per_agent: {
        orchestrator: { provider: "claude-code", mode: "local_process" },
        developer: { provider: "claude-code", mode: "local_process" },
        qa: { provider: "claude-code", mode: "local_process" },
        security: { provider: "claude-code", mode: "local_process" },
      },
      planner_runtime: { provider: "claude-code", mode: "local_process" },
      ...overrides?.defaults,
    },
    rules: overrides?.rules ?? defaultPlatformRules(),
    agent_definitions: overrides?.agent_definitions ?? defaultAgentDefinitions(),
    events_dir: overrides?.events_dir,
  };
}

export function makeProjectConfig(
  overrides?: Partial<ProjectConfig>
): ProjectConfig {
  return {
    project_id: overrides?.project_id ?? "test-project",
    name: overrides?.name ?? "Test Project",
    repo: overrides?.repo ?? {
      url: "https://github.com/test/repo.git",
      default_branch: "main",
      token: "ghp_test123",
    },
    api_keys: overrides?.api_keys ?? {
      anthropic: "sk-ant-test-key",
    },
    model_overrides: overrides?.model_overrides,
    budget_overrides: overrides?.budget_overrides,
    rules: overrides?.rules ?? [],
    integrations: overrides?.integrations ?? {
      ticket_source: {
        type: "github",
        config: {
          token: "ghp_test123",
          owner: "test-org",
          repo: "test-repo",
        },
      },
    },
    branch_strategy: overrides?.branch_strategy ?? {
      prefix: "feat/",
      include_ticket_id: true,
      naming: "kebab-case",
    },
    stack: overrides?.stack,
    agents: overrides?.agents,
    runtime_overrides: overrides?.runtime_overrides,
    planner_runtime_override: overrides?.planner_runtime_override,
  };
}

export function defaultAgentDefinitions(): AgentDefinition[] {
  return [
    {
      type: "product",
      name: "Product Agent",
      role: "product",
      description: "Analyzes tickets, writes specs",
      container_image: "agentsdlc/agent-product:latest",
      capabilities: ["Analyze tickets", "Write specs"],
      output_artifacts: ["artifacts/product-spec.md"],
      required_inputs: ["ticket_details"],
    },
    {
      type: "architect",
      name: "Architecture Agent",
      role: "architect",
      description: "System design, API contracts",
      container_image: "agentsdlc/agent-architect:latest",
      capabilities: ["Design architecture", "Create data models"],
      output_artifacts: ["artifacts/architecture.md"],
      required_inputs: ["ticket_details"],
    },
    {
      type: "developer",
      name: "Developer Agent",
      role: "developer",
      stack: "js",
      plugins: ["js-nextjs"],
      description: "Writes production code",
      container_image: "agentsdlc/agent-developer:latest",
      capabilities: ["Write TypeScript code", "Build React components"],
      output_artifacts: ["src/"],
      required_inputs: ["ticket_details"],
    },
    {
      type: "go-developer",
      name: "Go Developer Agent",
      role: "developer",
      stack: "go",
      description: "Writes production Go code",
      container_image: "agentsdlc/agent-go-developer:latest",
      capabilities: ["Write Go code", "Build HTTP servers"],
      output_artifacts: ["**/*.go"],
      required_inputs: ["ticket_details"],
    },
    {
      type: "qa",
      name: "QA Agent",
      role: "qa",
      stack: "js",
      description: "Writes and runs tests",
      container_image: "agentsdlc/agent-qa:latest",
      capabilities: ["Write unit tests", "Run test suites"],
      output_artifacts: ["tests/", "artifacts/test-report.json"],
      required_inputs: ["ticket_details", "source code"],
    },
    {
      type: "go-qa",
      name: "Go QA Agent",
      role: "qa",
      stack: "go",
      description: "Writes and runs Go tests",
      container_image: "agentsdlc/agent-go-qa:latest",
      capabilities: ["Write Go tests", "Run benchmarks"],
      output_artifacts: ["**/*_test.go"],
      required_inputs: ["ticket_details", "source code"],
    },
    {
      type: "security",
      name: "Security Agent",
      role: "security",
      description: "Scans for vulnerabilities",
      container_image: "agentsdlc/agent-security:latest",
      capabilities: ["Static analysis", "Dependency checking"],
      output_artifacts: ["artifacts/security-report.json"],
      required_inputs: ["source code"],
    },
    {
      type: "ui-ux",
      name: "UI/UX Agent",
      role: "ui-ux",
      plugins: ["frontend-design"],
      description: "Designs user interfaces",
      container_image: "agentsdlc/agent-ui-ux:latest",
      capabilities: ["Create wireframes", "Design components"],
      output_artifacts: ["artifacts/ui-specs/"],
      required_inputs: ["ticket_details"],
    },
    {
      type: "devops",
      name: "DevOps Agent",
      role: "devops",
      description: "CI/CD, infrastructure",
      container_image: "agentsdlc/agent-devops:latest",
      capabilities: ["Create CI/CD pipelines", "Write Dockerfiles"],
      output_artifacts: ["infra/"],
      required_inputs: ["architecture docs"],
    },
  ];
}

export function defaultPlatformRules(): PlatformRule[] {
  return [
    {
      id: "always-qa-after-code",
      description: "A QA-role agent must always run after code changes",
      condition: { type: "always" },
      action: { type: "require_role", role: "qa" },
      enforced: true,
    },
    {
      id: "security-on-auth",
      description: "Security agent must run when ticket touches auth",
      condition: { type: "label_contains", value: "security" },
      action: { type: "require_agent", agent: "security" },
      enforced: true,
    },
    {
      id: "security-on-auth-files",
      description: "Security agent must run when auth files modified",
      condition: { type: "file_path_matches", pattern: "src/(auth|payments)/**" },
      action: { type: "require_agent", agent: "security" },
      enforced: true,
    },
    {
      id: "human-gate-p0",
      description: "P0 features require human approval",
      condition: { type: "priority_is", values: ["p0"] },
      action: { type: "require_human_gate", after_agent: "qa" },
      enforced: true,
    },
  ];
}

export function makeModelConfig(
  overrides?: Partial<ModelConfig>
): ModelConfig {
  return {
    provider: overrides?.provider ?? "anthropic",
    model: overrides?.model ?? "claude-sonnet-4-5-20250929",
    ...overrides,
  };
}

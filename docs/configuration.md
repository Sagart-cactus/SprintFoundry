# Configuration Reference

SprintFoundry uses a two-file config system:

- `config/platform.yaml` — system-wide defaults, rules, and agent definitions (ships with the tool)
- `config/project.yaml` — your project settings, credentials, and overrides

Loader: `src/service/config-loader.ts`

## File Selection

When `--project <name>` is passed, the loader tries (in order):

1. `config/<name>.yaml`
2. `config/project-<name>.yaml`

Without `--project`, it requires `config/project.yaml`.

## Environment Variable Interpolation

All `${VAR_NAME}` tokens in YAML are substituted from `process.env` before parsing.

```yaml
api_keys:
  anthropic: ${SPRINTFOUNDRY_ANTHROPIC_KEY}
integrations:
  ticket_source:
    config:
      token: ${GITHUB_TOKEN}
```

---

## Project Config (`project.yaml`)

### Required Fields

```yaml
project_id: my-app          # Unique identifier for this project
name: My App                # Human-readable display name

repo:
  url: git@github.com:org/repo.git   # SSH or HTTPS clone URL
  default_branch: main               # Branch to base work on
  ssh_key_path: ~/.ssh/id_ed25519    # Optional: path to SSH private key
  token: ${GITHUB_TOKEN}             # Optional: token for HTTPS clone

api_keys:
  anthropic: ${SPRINTFOUNDRY_ANTHROPIC_KEY}   # Required for claude-code runtime
  openai: ${SPRINTFOUNDRY_OPENAI_KEY}         # Required for codex runtime
  google: ${SPRINTFOUNDRY_GOOGLE_KEY}         # Optional

integrations:
  ticket_source:
    type: github             # linear | github | jira | prompt
    config:
      token: ${GITHUB_TOKEN}
      owner: myorg
      repo: myapp

branch_strategy:
  prefix: feat/              # Branch name prefix (e.g., "feat/", "fix/")
  include_ticket_id: true    # true → feat/lin-423-csv-export
  naming: kebab-case         # kebab-case | snake_case

rules: []                    # Project-specific rules (see Rules section)
```

### Optional Fields

#### `stack`
Informational tag describing the primary tech stack. Used by agents to apply appropriate patterns.
```yaml
stack: js     # js | go | python | (any string)
```

#### `agents`
Filter which agents from the platform catalog are available for this project.
```yaml
agents:
  - developer
  - qa
  - code-review
  - security
```

#### `model_overrides`
Override the model used for specific agents.
```yaml
model_overrides:
  developer:
    provider: anthropic
    model: claude-sonnet-4-5-20250929
  architect:
    provider: anthropic
    model: claude-opus-4-5-20250929
    max_tokens: 16000
```

**`ModelConfig` fields:**

| Field | Type | Description |
|-------|------|-------------|
| `provider` | `anthropic \| openai \| google \| custom` | Model provider |
| `model` | string | Model ID (e.g., `claude-sonnet-4-5-20250929`) |
| `max_tokens` | number | Optional token cap for responses |

#### `budget_overrides`
Override token and cost limits.
```yaml
budget_overrides:
  per_agent_tokens: 800000       # Max tokens per single agent run
  per_task_total_tokens: 5000000 # Max tokens across all agents for one task
  per_task_max_cost_usd: 50.00   # Hard cost cap per task
  max_rework_cycles: 5           # Max rework iterations before giving up
```

#### `runtime_overrides`
Override the runtime provider and mode per agent.
```yaml
runtime_overrides:
  developer:
    provider: claude-code        # claude-code | codex
    mode: local_sdk              # local_process | local_sdk | container | remote
  go-developer:
    provider: codex
    mode: local_process
    model_reasoning_effort: high # minimal | low | medium | high | xhigh (codex only)
```

**Runtime Modes:**

| Mode | Provider | Auth Required | Description |
|------|----------|---------------|-------------|
| `local_process` | `claude-code` | Claude Code subscription or API key | Spawns `claude` CLI subprocess |
| `local_sdk` | `claude-code` | API key (no subscription) | Uses Claude Agent SDK directly |
| `local_process` | `codex` | API key | Spawns `codex exec` CLI subprocess |
| `local_sdk` | `codex` | API key | Uses Codex SDK with streamed turns |
| `container` | `claude-code` | API key + Docker | Runs agent in Docker container (deprecated) |

#### `planner_runtime_override`
Override the runtime used for the orchestrator/planning step.
```yaml
planner_runtime_override:
  provider: codex
  mode: local_process
  model_reasoning_effort: xhigh
```

#### `guardrails`
Block dangerous commands or restrict file access for SDK runtimes.
```yaml
guardrails:
  deny_commands:
    - "rm\\s+-rf"          # Regex patterns (case-insensitive)
    - "git\\s+push"
  allow_paths:
    - "src/**"             # Glob patterns relative to workspace root
    - "tests/**"           # If set, ONLY these paths are writable
  deny_paths:
    - "src/secrets/**"     # Always block these, even if allow_paths is set
    - ".env*"
```

> Guardrails apply to `local_sdk` mode only (both `claude-code` and `codex`). They fire before tool calls are executed.

#### `codex_skills_enabled`
Enable Codex skill staging for this project.
```yaml
codex_skills_enabled: true
```

#### `codex_skill_catalog_overrides`
Add or override skills in the catalog for this project.
```yaml
codex_skill_catalog_overrides:
  web-design-guidelines:
    path: vendor/skills/web-design-guidelines   # Must contain SKILL.md
```

#### `codex_skills_overrides`
Override which skills are assigned to each agent.
```yaml
codex_skills_overrides:
  ui-ux:
    - web-design-guidelines
    - design-system
  developer:
    - code-quality
    - error-handling
```

---

## Platform Config (`platform.yaml`)

Platform config ships with SprintFoundry and sets system-wide defaults. You do not edit this directly — use project config overrides instead.

### `defaults.model_per_agent`
Default models for each agent role.

| Agent | Default Model |
|-------|--------------|
| orchestrator | claude-sonnet-4-5-20250929 |
| product | claude-sonnet-4-5-20250929 |
| architect | claude-sonnet-4-5-20250929 |
| developer | claude-sonnet-4-5-20250929 |
| code-review | claude-sonnet-4-5-20250929 |
| qa | claude-sonnet-4-5-20250929 |
| security | claude-sonnet-4-5-20250929 |
| ui-ux | claude-sonnet-4-5-20250929 |
| devops | claude-sonnet-4-5-20250929 |

### `defaults.budgets`

| Field | Default | Description |
|-------|---------|-------------|
| `per_agent_tokens` | 500,000 | Max tokens per single agent run |
| `per_task_total_tokens` | 3,000,000 | Max tokens across all agents for one task |
| `per_task_max_cost_usd` | $25.00 | Hard cost cap per task |

### `defaults.timeouts`

| Field | Default | Description |
|-------|---------|-------------|
| `agent_timeout_minutes` | 30 | Max wall time for a single agent run |
| `task_timeout_minutes` | 180 (3h) | Max wall time for an entire task |
| `human_gate_timeout_hours` | 48 | Auto-escalate if no human response after this |

### `defaults.agent_cli_flags`

| Field | Default | Description |
|-------|---------|-------------|
| `max_budget_usd` | 5.00 | Per-agent cost cap passed as `--max-budget-usd` |
| `output_format` | json | Output format for CLI subprocess |
| `skip_permissions` | true | Pass `--dangerously-skip-permissions` for autonomous operation |

### `defaults.container_resources`

| Field | Default | Description |
|-------|---------|-------------|
| `memory` | 4g | Docker memory limit |
| `cpus` | 2 | Docker CPU limit |
| `network` | bridge | Docker network mode |

### `defaults.runtime_per_agent`
All agents default to `claude-code / local_process`.

### `defaults.codex_skill_catalog`

Built-in skills available out of the box:

| Skill | Path | Description |
|-------|------|-------------|
| `code-quality` | plugins/code-review/skills/code-quality | Readability, naming, DRY, type safety |
| `error-handling` | plugins/code-review/skills/error-handling | Error propagation, swallowed errors, HTTP status codes |
| `performance-review` | plugins/code-review/skills/performance-review | N+1 queries, re-renders, memory leaks, bundle size |
| `testing-standards` | plugins/code-review/skills/testing-standards | Test quality, assertions, edge cases, mock boundaries |
| `architecture-alignment` | plugins/code-review/skills/architecture-alignment | ADR compliance, API contract conformance |

### `defaults.codex_skills_per_agent`

| Agent | Default Skills |
|-------|---------------|
| `code-review` | code-quality, error-handling, performance-review, testing-standards, architecture-alignment |
| `developer` | code-quality, error-handling, performance-review |
| `go-developer` | code-quality, error-handling, performance-review |

---

## Rules

Rules let you enforce agent requirements and budget overrides based on ticket properties.

### Platform Rules (built-in, always active)

| Rule ID | Condition | Action | Enforced |
|---------|-----------|--------|----------|
| `always-qa-after-code` | always | require role `qa` | ✅ |
| `security-on-auth` | label contains `security` | require agent `security` | ✅ |
| `security-on-auth-files` | file path matches `src/(auth\|payments\|billing)/**` | require agent `security` | ✅ |
| `code-review-on-p0` | priority is `p0` | require role `code-review` | ✅ |
| `human-gate-p0` | priority is `p0` | require human gate after `qa` | ✅ |
| `code-review-on-complex` | label contains `complex` | require role `code-review` | suggestion only |
| `spike-lightweight` | label contains `type:spike` | set budget (2M tokens, $10, 1 rework) | ✅ |

### Project Rules (in `project.yaml`)

```yaml
rules:
  - id: security-on-payments
    description: "Always run security agent on payment code changes"
    condition:
      type: file_path_matches
      pattern: "src/payments/**"
    action:
      type: require_agent
      agent: security

  - id: architect-on-new-features
    description: "Run architect for new features"
    condition:
      type: classification_is
      values: [new_feature]
    action:
      type: require_role
      role: architect
```

### Rule Condition Types

| Type | Fields | Description |
|------|--------|-------------|
| `always` | — | Matches every task |
| `classification_is` | `values: TaskClassification[]` | Matches ticket classification |
| `label_contains` | `value: string` | Ticket label substring match |
| `file_path_matches` | `pattern: string` | Files changed match glob pattern |
| `priority_is` | `values: string[]` | Ticket priority (`p0`–`p3`) |

**`TaskClassification` values:** `new_feature`, `bug_fix`, `ui_change`, `refactor`, `infrastructure`, `security_fix`, `documentation`, `product_question`

### Rule Action Types

| Type | Fields | Description |
|------|--------|-------------|
| `require_agent` | `agent: string` | Inject a specific agent by ID |
| `require_role` | `role: AgentRole` | Inject an agent by role |
| `require_human_gate` | `after_agent: string` | Pause for human review after agent completes |
| `set_model` | `agent: string`, `model: ModelConfig` | Override model for a specific agent |
| `set_budget` | `budget: Partial<BudgetConfig>` | Override budget for this task |

---

## Runtime Selection Precedence

Per-step runtime resolves in this order:

1. `project.runtime_overrides[agent_id]`
2. `platform.defaults.runtime_per_agent[agent_id]`
3. `platform.defaults.runtime_per_agent[agent_role]`
4. Fallback: `claude-code / local_process` (or `container` if `SPRINTFOUNDRY_USE_CONTAINERS=true`)

Planner runtime resolves via:

1. `project.planner_runtime_override`
2. `platform.defaults.planner_runtime`
3. Fallback: `claude-code / local_process`

---

## Ticket Source Integrations

### GitHub Issues
```yaml
integrations:
  ticket_source:
    type: github
    config:
      token: ${GITHUB_TOKEN}
      owner: myorg
      repo: myapp
```

### Linear
```yaml
integrations:
  ticket_source:
    type: linear
    config:
      api_key: ${LINEAR_API_KEY}
      team_id: TEAM-ID
```

### Jira
```yaml
integrations:
  ticket_source:
    type: jira
    config:
      host: https://myorg.atlassian.net
      email: user@myorg.com
      api_token: ${JIRA_API_TOKEN}
      project_key: MYAPP
```

### Direct Prompt
```bash
sprintfoundry run --source prompt --prompt "Add dark mode toggle to settings page"
```

---

## Notifications

```yaml
integrations:
  notifications:
    type: slack
    config:
      webhook_url: ${SLACK_WEBHOOK_URL}
      channel: "#dev-agents"
```

Supported types: `slack`, `email`, `webhook`

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SPRINTFOUNDRY_ANTHROPIC_KEY` | Anthropic API key (BYOK) |
| `SPRINTFOUNDRY_OPENAI_KEY` | OpenAI API key for codex runtime |
| `SPRINTFOUNDRY_GOOGLE_KEY` | Google API key |
| `GITHUB_TOKEN` | GitHub token for ticket fetch and PR creation |
| `LINEAR_API_KEY` | Linear API key |
| `JIRA_API_TOKEN` | Jira API token |
| `SLACK_WEBHOOK_URL` | Slack webhook for notifications |
| `SPRINTFOUNDRY_USE_CONTAINERS` | Set to `true` to force container runtime mode |
| `SPRINTFOUNDRY_RUNS_ROOT` | Override run workspace root directory |
| `MONITOR_PORT` | Monitor server port (default: 4310) |
| `SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK` | Set to `1` to enable Codex 401 retry without CODEX_HOME |

---

## Full Annotated Example

```yaml
project_id: my-app
name: My App

stack: js
agents: [developer, qa, code-review, security]

repo:
  url: git@github.com:myorg/my-app.git
  default_branch: main

api_keys:
  anthropic: ${SPRINTFOUNDRY_ANTHROPIC_KEY}

model_overrides:
  developer:
    provider: anthropic
    model: claude-sonnet-4-5-20250929
  security:
    provider: anthropic
    model: claude-opus-4-5-20250929

budget_overrides:
  per_agent_tokens: 600000
  per_task_max_cost_usd: 30.00

runtime_overrides:
  developer:
    provider: claude-code
    mode: local_sdk
  qa:
    provider: claude-code
    mode: local_sdk

guardrails:
  deny_commands:
    - "rm\\s+-rf"
    - "git\\s+push\\s+--force"
  allow_paths:
    - "src/**"
    - "tests/**"
    - "public/**"

codex_skills_enabled: false

branch_strategy:
  prefix: feat/
  include_ticket_id: true
  naming: kebab-case

integrations:
  ticket_source:
    type: github
    config:
      token: ${GITHUB_TOKEN}
      owner: myorg
      repo: my-app
  notifications:
    type: slack
    config:
      webhook_url: ${SLACK_WEBHOOK_URL}

rules:
  - id: security-on-payments
    description: "Always run security agent on payment code changes"
    condition:
      type: file_path_matches
      pattern: "src/payments/**"
    action:
      type: require_agent
      agent: security
```

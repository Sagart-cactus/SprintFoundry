# Configuration Reference

Configuration is loaded from:

- `config/platform.yaml` (required)
- `config/project.yaml` (default) or `--project <name>` lookup

Loader: `src/service/config-loader.ts`

## File Selection

When `--project <name>` is provided, loader tries in order:

1. `config/<name>.yaml`
2. `config/project-<name>.yaml`

Without `--project`, it requires:
- `config/project.yaml`

## Environment Interpolation

All `${VAR_NAME}` tokens in YAML are replaced from process env before parsing.

Example:
```yaml
api_keys:
  anthropic: ${SPRINTFOUNDRY_ANTHROPIC_KEY}
```

## Platform Defaults (`platform.yaml`)

Important sections:

- `defaults.model_per_agent`
- `defaults.budgets`
- `defaults.timeouts`
- `defaults.runtime_per_agent`
- `defaults.planner_runtime`
- `defaults.codex_skills_*`
- `rules` (enforceable platform rules)
- `agent_definitions`
- `events_dir`

## Project Config (`project.yaml`)

Important sections:

- `project_id`, `name`
- `repo.url`, `repo.default_branch`, optional auth fields
- `api_keys` (BYOK keys)
- `model_overrides`
- `budget_overrides`
- `runtime_overrides`
- `planner_runtime_override`
- `branch_strategy`
- `integrations.ticket_source`
- `integrations.notifications`
- `rules`

## Runtime Selection Precedence

Per-step runtime resolves in this order:

1. `project.runtime_overrides[agent]`
2. `platform.defaults.runtime_per_agent[agent|role]`
3. fallback (`claude-code` + `local_process`, unless env-based container override)

Planner runtime resolves via:

1. `project.planner_runtime_override`
2. `platform.defaults.planner_runtime`
3. fallback `claude-code/local_process`

## API Key Resolution

API keys may come from:

- `project.api_keys.*` values
- interpolated env values in project config
- provider SDK fallback env (for Anthropic SDK path)

Keep credentials out of source control.

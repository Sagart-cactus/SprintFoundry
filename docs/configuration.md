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
- `defaults.guardrails`
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
- `guardrails`
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

## Codex CLI 401 Fallback (Local Process)

Codex local-process steps can run with a workspace-scoped `CODEX_HOME` (for staged skills and config). In some local CLI auth states this may return:

- `401 Unauthorized: Missing bearer or basic authentication in header`

Fallback behavior is available but disabled by default:

- Set `SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK=1` to enable it.
- When enabled, runtime retries once without `CODEX_HOME` only if:
  - process exits non-zero, and
  - stderr contains the exact trusted 401 signature above.
- No retry is triggered from stdout text.

## Guardrails (SDK Modes)

Guardrails apply to SDK runtimes (`codex` and `claude-code` in `local_sdk` mode). They block
command executions and file changes before they are applied.

Configuration lives at:

- `platform.defaults.guardrails`
- `project.guardrails` (overrides platform defaults)

Supported keys:

- `deny_commands`: list of regex patterns (case-insensitive) matched against command strings.
- `allow_paths`: list of glob-like patterns (workspace-relative) that must match file paths.
- `deny_paths`: list of glob-like patterns (workspace-relative) that block file paths.

Examples:

```yaml
defaults:
  guardrails:
    deny_commands:
      - "rm\\s+-rf"
    allow_paths:
      - "src/**"
    deny_paths:
      - "src/secrets/**"
```

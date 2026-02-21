# SprintFoundry Documentation

Multi-agent orchestration platform for AI-powered software development. Takes tickets from Linear, GitHub, or Jira and orchestrates specialized AI agents to deliver tested, reviewed code as pull requests.

## Contents

| Document | Description |
|----------|-------------|
| [configuration.md](./configuration.md) | Full project config schema — all fields, defaults, and examples |
| [agents.md](./agents.md) | All agent types, roles, capabilities, plugins, and output artifacts |
| [architecture.md](./architecture.md) | System design, two-layer model, filesystem message bus |
| [monitor.md](./monitor.md) | Run monitor — setup, data sources, API |
| [operations.md](./operations.md) | Running tasks, human gates, rework cycles |
| [decisions.md](./decisions.md) | Architecture decision records |

## Quick Start

```bash
# Install
npm install -g sprintfoundry
# or
brew tap Sagart-cactus/tap && brew install sprintfoundry

# Configure
cp config/project.example.yaml config/project.yaml
# Edit config/project.yaml with your repo, API keys, and integrations

# Validate your config
sprintfoundry validate

# Run on a GitHub issue
sprintfoundry run --source github --ticket 42

# Run on a Linear ticket
sprintfoundry run --source linear --ticket LIN-423

# Run with a direct prompt
sprintfoundry run --source prompt --prompt "Add CSV export to the reports page"
```

## CLI Reference

### `sprintfoundry run`

Execute a task from a ticket or prompt.

```
sprintfoundry run --source <source> [options]

  --source <source>    linear | github | jira | prompt  (required)
  --ticket <id>        Ticket ID — required for linear, github, jira
  --prompt <text>      Task description — required for source=prompt
  --config <dir>       Config directory (default: config)
  --project <name>     Load <name>.yaml or project-<name>.yaml from config dir
```

### `sprintfoundry validate`

Validate project configuration and print a summary.

```
sprintfoundry validate [--config <dir>] [--project <name>]
```

### `sprintfoundry review`

Submit a human gate decision (approve or reject a paused run).

```
sprintfoundry review --workspace <path> --review-id <id> --decision <decision> [--feedback <text>]

  --workspace <path>     Workspace path for the run
  --review-id <id>       Review ID shown in the monitor
  --decision <decision>  approved | rejected
  --feedback <text>      Optional reviewer notes passed to the next agent
```

### `sprintfoundry project create`

Interactively scaffold a new project config file.

```
sprintfoundry project create [--config <dir>]
```

## Repo Map

```
src/index.ts                       CLI entrypoint
src/service/                       Orchestration, planning, runtime adapters, integrations
src/shared/types.ts                Core config and runtime type system
src/agents/<type>/CLAUDE.md        Agent instructions for claude-code runtime
src/agents-codex/<type>/CODEX.md   Agent instructions for codex runtime
monitor/                           Monitor server and static UI
config/                            platform.yaml + project config templates
plugins/                           Optional skill/plugin catalogs
tests/                             Unit tests for service, runtime, config
```

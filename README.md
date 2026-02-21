# SprintFoundry

SprintFoundry is a multi-agent software delivery orchestrator. It takes tickets from GitHub, Linear, or Jira, plans and executes work across a team of specialized AI agents (Product, Architect, Developer, QA, Security, UI/UX, DevOps), and delivers tested, reviewed code as pull requests.

## How It Works

```
Ticket → Orchestrator Agent → Execution Plan → Agent Steps → PR
```

- A **planner** (Claude) reads the ticket, classifies the work, and returns a structured execution plan
- A **validator** enforces platform rules (mandatory QA, human gates, dependency order)
- Each step runs a **specialized agent** (Claude Code or Codex) in its own workspace
- Agents communicate via the filesystem — each reads prior artifacts and writes its own outputs
- A **monitor UI** shows live progress, per-step results, and token usage

## Installation

**Homebrew (recommended):**

```bash
brew tap Sagart-cactus/tap
brew install sprintfoundry
```

**npm:**

```bash
npm install -g sprintfoundry
```

**From source:**

```bash
git clone https://github.com/Sagart-cactus/SprintFoundry.git
cd SprintFoundry
pnpm install
pnpm build
```

## Quick Start

```bash
# Copy and fill in your config
cp config/project.example.yaml config/project.yaml

# Validate your config
sprintfoundry validate --project my-project

# Run on a GitHub issue
sprintfoundry run --project my-project --source github --ticket 42

# Run on a Linear ticket
sprintfoundry run --project my-project --source linear --ticket LIN-423

# Run with a direct prompt
sprintfoundry run --project my-project --source prompt --prompt "Add CSV export to reports"
```

From source, replace `sprintfoundry` with `pnpm dev --`.

## Monitor

```bash
pnpm monitor
# Open http://127.0.0.1:4310/
```

The monitor shows all runs, live step progress, agent output, token usage, and cost.

## CLI Reference

```
sprintfoundry <command> [options]

Commands:
  run       Execute an end-to-end task
  validate  Validate platform and project configuration
  review    Submit a human review decision for a pending gate

Options (run):
  --project <name>      Project config name (matches config/<name>.yaml)
  --source <source>     Ticket source: github | linear | jira | prompt
  --ticket <id>         Ticket ID (for github/linear/jira sources)
  --prompt <text>       Task description (for prompt source)
  --dry-run             Plan only, do not execute steps
  --step <n>            Resume from a specific step number
  --workspace <path>    Use an existing workspace directory

Options (review):
  --workspace <path>    Path to the run workspace
  --review-id <id>      Review gate ID (from monitor or workspace)
  --decision <d>        approved | rejected | changes_requested
  --comment <text>      Optional review comment
```

## Configuration

SprintFoundry uses a two-layer config system:

- **`config/platform.yaml`** — system-wide defaults (models, budgets, timeouts, rules, agent definitions)
- **`config/<project>.yaml`** — per-project settings (repo, API keys, model overrides, runtime mode, integrations)

Minimal project config:

```yaml
project_id: my-project
name: My Project
stack: js

repo:
  url: git@github.com:org/repo.git
  default_branch: main

api_keys:
  anthropic: ${ANTHROPIC_API_KEY}

integrations:
  ticket_source:
    type: github
    config:
      token: ${GITHUB_TOKEN}
      owner: org
      repo: repo
```

See [docs/configuration.md](docs/configuration.md) for the full reference.

## Runtime Modes

Each agent runs in one of four modes, configured per-agent in your project config:

| Provider | Mode | Description |
|---|---|---|
| `claude-code` | `local_sdk` | Claude Agent SDK in-process (fastest, no subprocess) |
| `claude-code` | `local_process` | `claude` CLI as a subprocess |
| `claude-code` | `container` | Claude Code in a Docker container |
| `codex` | `local_sdk` | Codex SDK in-process |
| `codex` | `local_process` | `codex` CLI as a subprocess |

```yaml
# config/my-project.yaml
runtime_overrides:
  developer:
    provider: claude-code
    mode: local_sdk
  qa:
    provider: codex
    mode: local_process
```

## Agents

| Agent | Role |
|---|---|
| `product` | Analyzes tickets, writes specs and user stories |
| `architect` | Designs systems, writes ADRs and API contracts |
| `developer` | Implements features, writes tests |
| `go-developer` | Go-specific implementation |
| `qa` | Writes and runs tests, validates quality |
| `go-qa` | Go-specific QA |
| `security` | Vulnerability scanning, auth review |
| `ui-ux` | Component specs, wireframes, design tokens |
| `devops` | CI/CD, Dockerfiles, infrastructure |
| `code-review` | Code review, style and correctness |

See [docs/agents.md](docs/agents.md) for full agent details, plugins, and Codex skills.

## Repo Structure

```
src/
  service/           # Orchestration service, agent runner, runtimes
    runtime/         # claude-code and codex runtime adapters
  agents/            # Agent CLAUDE.md instruction files
  shared/types.ts    # All shared TypeScript types
monitor/             # Monitor server and web UI
config/              # Platform and project YAML configs
containers/          # Agent container Dockerfiles
plugins/             # Optional skill catalogs
tests/               # Unit and integration tests
docs/                # Full documentation
```

## Documentation

- [docs/README.md](docs/README.md) — documentation index and overview
- [docs/configuration.md](docs/configuration.md) — full configuration reference
- [docs/agents.md](docs/agents.md) — agent types, roles, and plugins
- [docs/architecture.md](docs/architecture.md) — system architecture and flow
- [docs/monitor.md](docs/monitor.md) — monitor routes and API
- [docs/operations.md](docs/operations.md) — runbook and troubleshooting
- [docs/decisions.md](docs/decisions.md) — architecture decision log

## License

MIT

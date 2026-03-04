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
- A **monitor UI** shows live progress, per-step results, streaming agent output, and token usage

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

# Check all dependencies are installed and configured
sprintfoundry doctor

# Validate your config
sprintfoundry validate --project my-project

# Run on a GitHub issue
sprintfoundry run --project my-project --source github --ticket 42

# Run on a Linear ticket
sprintfoundry run --project my-project --source linear --ticket LIN-423

# Run with a direct prompt
sprintfoundry run --project my-project --source prompt --prompt "Add CSV export to reports"

# Run a single agent directly (skip SDLC orchestration)
sprintfoundry run --project my-project --source prompt --prompt "Review auth logic" --agent security

# Run a custom agent defined in a YAML file
sprintfoundry run --project my-project --source prompt --prompt "..." --agent my-agent --agent-file agents/my-agent.yaml
```

From source, replace `sprintfoundry` with `pnpm dev --`.

## Monitor

```bash
# From npm/brew install:
sprintfoundry monitor

# From source:
pnpm monitor
```

Open http://127.0.0.1:4310/

The monitor shows all runs, live step progress, streaming agent output (tool calls, file edits, commands), token usage, and cost.

## Local Distributed Testing

Use this mode when you want event ingestion + monitor backed by Postgres/Redis.

1. Create local env values:

```bash
cp .env.distributed.example .env.distributed
set -a
source .env.distributed
set +a
```

`docker-compose.distributed.yml` uses `SPRINTFOUNDRY_COMPOSE_DATABASE_URL` and
`SPRINTFOUNDRY_COMPOSE_REDIS_URL` for container-to-container networking (`postgres`/`redis`).
`SPRINTFOUNDRY_DATABASE_URL` and `SPRINTFOUNDRY_REDIS_URL` remain host-oriented defaults.

2. Start distributed services:

```bash
docker compose -f docker-compose.distributed.yml up -d --build
```

This stack runs:
- `postgres` (`postgres:16-alpine`) on `5432`
- `redis` (`redis:7-alpine`) on `6379`
- `migrate` one-shot init job (`migrations/001_create_event_tables.sql`)
- `event-api` on `3001` (health: `GET /health`)
- `monitor` on `4310`

3. Verify services:

```bash
docker compose -f docker-compose.distributed.yml ps
curl http://localhost:3001/health
open http://localhost:4310
```

4. Run SprintFoundry with sink enabled:

```bash
pnpm dev -- run --project my-project --source prompt --prompt "test distributed mode"
```

5. Stop services:

```bash
docker compose -f docker-compose.distributed.yml down
```

Use `docker compose -f docker-compose.distributed.yml down -v` to also remove the Postgres named volume.

## CLI Reference

```
sprintfoundry <command> [options]

Commands:
  run              Execute an end-to-end task
  validate         Validate platform and project configuration
  review           Submit a human review decision for a pending gate
  monitor          Start the monitor web UI
  doctor           Check all system dependencies and configuration
  project create   Interactively create a new project configuration
  agent create     Interactively create a new custom agent definition

Options (run):
  --project <name>        Project config name (matches config/<name>.yaml)
  --source <source>       Ticket source: github | linear | jira | prompt
  --ticket <id>           Ticket ID (for github/linear/jira sources)
  --prompt <text>         Task description (for prompt source)
  --dry-run               Plan only, do not execute steps
  --agent <agent>         Run a single agent directly, bypassing SDLC orchestration
  --agent-file <path>     Path to a YAML/JSON file defining a custom agent inline

Options (monitor):
  --port <port>           Port to listen on (default: 4310)

Options (review):
  --workspace <path>      Path to the run workspace
  --review-id <id>        Review gate ID (from monitor or workspace)
  --decision <d>          approved | rejected
  --feedback <text>       Optional review comment

Options (doctor):
  --project <name>        Project to load for runtime-aware checks
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

You can also define **custom agents** via YAML and run them with `--agent-file`, or create one interactively with `sprintfoundry agent create`.

See [docs/agents.md](docs/agents.md) for full agent details, plugins, and Codex skills.

## Stack Detection

SprintFoundry automatically detects the project stack (Node.js, Go, Python, etc.) once at the start of each run and shares the result with all agents via `.agent-context/stack.json`. This eliminates redundant detection work across agents and keeps context consistent throughout the pipeline.

You can also pin the stack explicitly in your project config:

```yaml
stack: js   # skip auto-detection
```

## Doctor

`sprintfoundry doctor` checks all system dependencies before you run:

- Node.js version (>=20 required)
- Git, npm availability
- Monitor assets
- Runs-root writability
- Claude CLI / Codex CLI presence (based on your runtime config)
- Docker daemon (if container mode is configured)
- Anthropic / OpenAI API keys (based on your runtime config)
- GitHub token (if GitHub is the ticket source)

```bash
sprintfoundry doctor --project my-project
```

## CI/CD

SprintFoundry ships with GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`) — runs on every PR and push to `main`: typecheck, build, unit tests
- **Release** (`.github/workflows/release.yml`) — triggers on `v*` tags: builds, publishes to npm, creates a GitHub release with auto-generated release notes

## Repo Structure

```
src/
  service/           # Orchestration service, agent runner, runtimes
    runtime/         # claude-code and codex runtime adapters
  agents/            # Agent CLAUDE.md instruction files (Claude Code)
  agents-codex/      # Agent CODEX.md instruction files (Codex)
  commands/          # CLI sub-commands (project create, agent create)
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

SprintFoundry is licensed under the Apache License 2.0.
See the LICENSE file for details.

Copyright (c) 2026 Sagar Trivedi.

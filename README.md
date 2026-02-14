# SprintFoundry (AgentSDLC)

SprintFoundry is a multi-agent software delivery orchestrator. It ingests tickets/prompts, plans work across specialized agents, executes steps using runtime adapters (Claude Code/Codex), and tracks execution with a file-backed monitor.

## Quick Start

```bash
pnpm install
cp config/project.example.yaml config/project.yaml
pnpm dev -- validate
pnpm dev -- run --source prompt --prompt "Add CSV export to reports"
```

Start monitor:

```bash
npm run monitor
# then open http://127.0.0.1:4310/v3
```

## CLI

Entry point: `src/index.ts`

- `run` — execute an end-to-end task
- `validate` — validate config
- `review` — write a human review decision for pending gate

Examples:

```bash
pnpm dev -- run --source linear --ticket LIN-123
pnpm dev -- run --project mixed-smoke --source prompt --prompt "..."
pnpm dev -- review --workspace <workspace> --review-id <id> --decision approved
```

## Runtime

- Planner runtime selected by `planner_runtime_override` / platform default
- Step runtime selected per agent by project/platform runtime configs
- Supported providers: `claude-code`, `codex`

Execution is CLI/process driven (`claude`, `codex`) with optional container mode.

## Documentation

- `docs/README.md` — docs index
- `docs/architecture.md` — system architecture and flow
- `docs/configuration.md` — configuration reference
- `docs/operations.md` — runbook and troubleshooting
- `docs/monitor.md` — monitor routes and API
- `docs/decisions.md` — architecture decisions

## Repo Structure

- `src/` — orchestration service, runtime adapters, shared types
- `monitor/` — monitor server and static UIs (`/`, `/v2`, `/v3`)
- `config/` — platform and project config
- `containers/` — agent container images
- `plugins/` — optional plugin/skill catalogs
- `tests/` — unit tests

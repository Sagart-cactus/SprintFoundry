# Operations Runbook

## Prerequisites

- Node.js >= 20
- pnpm or npm
- Local CLI auth for runtime tools used (`claude`, `codex`) when in local process mode
- Docker (only when using container runtime mode)

## Install

```bash
pnpm install
```

## Validate Config

```bash
pnpm dev -- validate
```

## Run a Task

Prompt source:

```bash
pnpm dev -- run --source prompt --prompt "Add export to reports page"
```

Ticket source:

```bash
pnpm dev -- run --source linear --ticket LIN-123
pnpm dev -- run --source github --ticket 42
pnpm dev -- run --source jira --ticket PROJ-99
```

Project-specific config:

```bash
pnpm dev -- run --project mixed-smoke --source prompt --prompt "..."
```

## Human Review Decision

```bash
pnpm dev -- review --workspace <run_workspace_path> --review-id <review-id> --decision approved
```

## Monitor

Start monitor server:

```bash
npm run monitor
# or
MONITOR_PORT=4311 npm run monitor
```

UI routes:

- `http://127.0.0.1:4310/` (legacy)
- `http://127.0.0.1:4310/v2`
- `http://127.0.0.1:4310/v3`

## Tests

```bash
npm test
npm run typecheck
npm run typecheck:tests
```

## Troubleshooting

Port already in use for monitor:
- start with a different `MONITOR_PORT`

No runs visible in monitor:
- verify runs root path defaults to `${TMPDIR}/sprintfoundry`
- check `.events.jsonl` exists in run workspace

Planner/runtime failures:
- inspect planner logs:
  - `.planner-runtime.stdout.log`
  - `.planner-runtime.stderr.log`
- inspect agent logs:
  - `.codex-runtime*.log`
  - `.claude-runtime*.log`

Git auth failures:
- verify `project.repo` auth settings and token/SSH key

## Cleanup

Run workspaces are created under:
- `${TMPDIR}/sprintfoundry/<project_id>/run-*`

Safe to remove old run directories when no active runs depend on them.

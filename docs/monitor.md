# Monitor Guide

Monitor server: `monitor/server.mjs`

## Purpose

Provides a lightweight read-only dashboard over run workspaces by reading event/log artifacts from disk.

## Start

```bash
npm run monitor
# optional
MONITOR_PORT=4311 npm run monitor
```

## Data Source

Run root path:

- env override: `AGENTSDLC_RUNS_ROOT`
- default: `${os.tmpdir()}/agentsdlc`

Project/run folders are discovered under that root.

## UI Versions

- `/` -> legacy monitor (`monitor/public`)
- `/v2` -> card + detail redesign (`monitor/public-v2`)
- `/v3` -> latest board/detail observability UI (`monitor/public-v3`)

## API Endpoints

- `GET /api/runs`
  - list run summaries across projects
- `GET /api/run?project=<id>&run=<id>`
  - run summary + plan + `step_models`
- `GET /api/events?project=<id>&run=<id>&limit=<n>`
  - per-run event stream
- `GET /api/log?project=<id>&run=<id>&kind=<kind>&lines=<n>`
  - text logs by kind
- `GET /api/files?project=<id>&run=<id>&root=<path>`
  - recursive file listing under run workspace

Log `kind` values:

- `planner_stdout`
- `planner_stderr`
- `agent_stdout`
- `agent_stderr`
- `agent_result`

## Model Detection in UI

Monitor infers per-step model names from runtime debug files in run workspace:

- `.codex-runtime.step-<n>.attempt-<m>.debug.json`
- `.claude-runtime.step-<n>.attempt-<m>.debug.json`
- generic `.codex-runtime.debug.json` / `.claude-runtime.debug.json` with `step_number`

## Notes

- Monitor is file-backed and eventually consistent with run writes.
- UI auto-refresh is periodic; user expansion state should be preserved where implemented.

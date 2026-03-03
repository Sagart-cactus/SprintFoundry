# Monitor Guide

Monitor server: `monitor/server.mjs`

## Purpose

Provides a lightweight dashboard over run workspaces by reading event/log artifacts from disk, with optional write actions for review decisions and run resumes.

## Start

```bash
npm run monitor
# optional
MONITOR_PORT=4311 npm run monitor
# optional split-port mode (monitor + dedicated webhook ingress)
MONITOR_PORT=4310 SPRINTFOUNDRY_WEBHOOK_PORT=4410 npm run monitor
# optional API auth tokens (recommended for shared/cloud setups)
SPRINTFOUNDRY_MONITOR_API_TOKEN='replace-me' npm run monitor
```

By default, monitor API routes require authentication (`SPRINTFOUNDRY_MONITOR_AUTH_REQUIRED=1`).
Use `Authorization: Bearer <token>` with `SPRINTFOUNDRY_MONITOR_API_TOKEN`.
For browser UI, append `?token=<token>` once; the UI stores it and forwards auth for API + SSE calls.

## Data Source

Run root path:

- env override: `SPRINTFOUNDRY_RUNS_ROOT`
- default: `${os.tmpdir()}/sprintfoundry`

Project/run folders are discovered under that root.

## UI

- `/` -> v3 board/detail observability UI (`monitor/public-v3`)
- `/v3` -> same as `/` (legacy alias, kept for convenience)
- `/v2` -> removed; returns 404

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
- `POST /api/run/resume`
  - queue a resume command for a failed/cancelled run (`project`, `run`, optional `step`, optional `prompt`)
- `POST /api/webhooks/github`
  - GitHub autoexecute ingress (when enabled)
- `POST /api/webhooks/linear`
  - Linear autoexecute ingress (when enabled)

Auth behavior:

- All non-webhook `/api/*` endpoints require monitor API auth token.
- Write actions (`POST /api/review/decide`, `POST /api/run/resume`) require `SPRINTFOUNDRY_MONITOR_WRITE_TOKEN` when configured.
- Webhook endpoints use provider signatures (`x-hub-signature-256`, `linear-signature`) instead of bearer auth.

When `SPRINTFOUNDRY_WEBHOOK_PORT` is set to a different port from `MONITOR_PORT`, webhook routes move to the dedicated webhook server and return `404` on monitor port.

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
- Board/detail UI supports resume badges and direct resume actions for failed/cancelled runs and failed steps.

# Operations Runbook

## Prerequisites

- Node.js >= 20
- pnpm or npm
- Local CLI auth for runtime tools used (`claude`, `codex`) when in local process mode
- Docker (only when using the Docker execution backend)

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

## Resume Failed Run

Resume from latest failed step:

```bash
pnpm dev -- resume <run-id>
```

Resume from a specific failed step with additional operator guidance:

```bash
pnpm dev -- resume <run-id> --step 2 --prompt "Focus on flaky tests and stabilize snapshots."
```

## Hand-Off A Completed Kind Run To Local

Completed runs are not resumed with `sprintfoundry resume`. Instead, hand off
the workspace to a local directory and continue with the runtime session id.

Helper script for the validated kind PVC flow:

```bash
./scripts/handoff-kind-run-to-local.sh --run-id sf-whole-run-codex-e2e-234956
```

By default, this mirrors the pod layout under the hand-off destination
(`.../workspace/...` and `.../workspace/home/.codex`), rewrites the imported
Codex store to that local mirrored path, and launches
`codex resume <session_id>` against that imported store.

Restore and immediately execute a local Codex continuation:

```bash
./scripts/handoff-kind-run-to-local.sh \
  --run-id sf-whole-run-codex-e2e-234956 \
  --prompt "Read README.md for context, then create validation/local-check.txt containing exactly: resumed locally."
```

The script:

- mounts PVC `sf-run-ws-<run-id>` in a temporary inspector pod
- copies the run workspace to a local mirrored path under the destination
- copies the pod's Codex store from `/workspace/home/.codex`
- rewrites imported Codex cwd/session paths to the local mirrored destination
- reads `.sprintfoundry/sessions.json` to find the saved `session_id`
- launches `codex resume <session_id>` against the imported `CODEX_HOME` by default
- or runs `codex exec resume <session_id> <prompt>` against the imported `CODEX_HOME` when `--prompt` is provided
- falls back to a fresh local interactive `codex` session only if the pod-local Codex store is unavailable

If you only want the workspace copy and the printed command, add `--print-only`.

For failed/cancelled runs, keep using `pnpm dev -- resume <run-id>`.

## Monitor

Start monitor server:

```bash
npm run monitor
# or
MONITOR_PORT=4311 npm run monitor
# split monitor/webhook ports
MONITOR_PORT=4310 SPRINTFOUNDRY_WEBHOOK_PORT=4410 npm run monitor
```

UI routes:

- `http://127.0.0.1:4310/`
- `http://127.0.0.1:4310/v3`

Webhook routes:

- `POST http://127.0.0.1:4310/api/webhooks/github`
- `POST http://127.0.0.1:4310/api/webhooks/linear`
- in split mode (`SPRINTFOUNDRY_WEBHOOK_PORT` set): use webhook port instead of monitor port

## Local Distributed Dev Loop

Run Postgres/Redis in Docker and run `dispatch`, `event-api`, and `monitor` from local code:

```bash
# one-time
pnpm install

# start infra only
pnpm infra:up
pnpm infra:migrate

# or start infra + event-api + dispatch + monitor together
pnpm dev:distributed
```

Default local endpoints/tokens in this mode:

- Event API: `http://127.0.0.1:3001` (`Authorization: Bearer dev-internal-token`)
- Dispatch API: `http://127.0.0.1:4320` (`Authorization: Bearer dev-dispatch-write`)
- Monitor UI: `http://127.0.0.1:4310/?token=dev-monitor-read`

Queue a prompt run through dispatch:

```bash
curl -X POST http://127.0.0.1:4320/api/dispatch/run \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-dispatch-write' \
  -d '{"project_id":"live-gaps-worktree","source":"prompt","prompt":"Create a tiny test artifact"}'
```

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
- for `codex --json` planner runs, API/auth failures are emitted in `.planner-runtime.stdout.log` as JSON `{"type":"error"}` events
- inspect agent logs:
  - `.codex-runtime*.log`
  - `.claude-runtime*.log`

Git auth failures:
- verify `project.repo` auth settings and token/SSH key

Codex CLI 401 when using staged `CODEX_HOME`:
- current behavior keeps a guarded single retry path (simplification to "no retry" was rejected)
- retry is disabled by default; opt in with `SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK=1`
- retry only triggers when stderr includes:
  - `401 Unauthorized: Missing bearer or basic authentication in header`
- retry runs once without `CODEX_HOME` and writes retry logs:
  - `.codex-runtime.step-<n>.attempt-<m>.retry.stdout.log`
  - `.codex-runtime.step-<n>.attempt-<m>.retry.stderr.log`

## Cleanup

Run workspaces are created under:
- `${TMPDIR}/sprintfoundry/<project_id>/run-*`

Safe to remove old run directories when no active runs depend on them.

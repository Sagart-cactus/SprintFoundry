#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export SPRINTFOUNDRY_DATABASE_URL="${SPRINTFOUNDRY_DATABASE_URL:-postgres://sf:sf@127.0.0.1:5432/sprintfoundry}"
export SPRINTFOUNDRY_REDIS_URL="${SPRINTFOUNDRY_REDIS_URL:-redis://127.0.0.1:6379}"
export SPRINTFOUNDRY_INTERNAL_API_TOKEN="${SPRINTFOUNDRY_INTERNAL_API_TOKEN:-dev-internal-token}"
export SPRINTFOUNDRY_EVENT_SINK_URL="${SPRINTFOUNDRY_EVENT_SINK_URL:-http://127.0.0.1:3001/events}"

export SPRINTFOUNDRY_DISPATCH_READ_TOKEN="${SPRINTFOUNDRY_DISPATCH_READ_TOKEN:-dev-dispatch-read}"
export SPRINTFOUNDRY_DISPATCH_WRITE_TOKEN="${SPRINTFOUNDRY_DISPATCH_WRITE_TOKEN:-dev-dispatch-write}"
export SPRINTFOUNDRY_MONITOR_API_TOKEN="${SPRINTFOUNDRY_MONITOR_API_TOKEN:-dev-monitor-read}"
export SPRINTFOUNDRY_MONITOR_WRITE_TOKEN="${SPRINTFOUNDRY_MONITOR_WRITE_TOKEN:-dev-monitor-write}"
export SPRINTFOUNDRY_MONITOR_AUTH_REQUIRED="${SPRINTFOUNDRY_MONITOR_AUTH_REQUIRED:-1}"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  for pid in "${PIDS[@]:-}"; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
    fi
  done
  wait || true
  exit "${exit_code}"
}

trap cleanup EXIT INT TERM

cd "${ROOT_DIR}"

echo "[dev] starting infra (postgres + redis)"
./scripts/dev-infra.sh up
./scripts/dev-infra.sh migrate

echo "[dev] environment"
echo "  DB:        ${SPRINTFOUNDRY_DATABASE_URL}"
echo "  Redis:     ${SPRINTFOUNDRY_REDIS_URL}"
echo "  Event API: http://127.0.0.1:3001 (token: ${SPRINTFOUNDRY_INTERNAL_API_TOKEN})"
echo "  Dispatch:  http://127.0.0.1:4320 (write token: ${SPRINTFOUNDRY_DISPATCH_WRITE_TOKEN})"
echo "  Monitor:   http://127.0.0.1:4310/?token=${SPRINTFOUNDRY_MONITOR_API_TOKEN}"
echo ""

PIDS=()

pnpm event-api &
PIDS+=($!)

pnpm dev -- dispatch --host 127.0.0.1 --port 4320 --config config &
PIDS+=($!)

MONITOR_PORT=4310 pnpm monitor &
PIDS+=($!)

echo "[dev] started event-api, dispatch, monitor from local code"
echo "[dev] press Ctrl+C to stop all three services"

# Portable replacement for `wait -n` (not available in older bash versions).
while true; do
  for pid in "${PIDS[@]}"; do
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      wait "${pid}" || true
      exit 1
    fi
  done
  sleep 1
done

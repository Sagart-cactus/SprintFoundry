#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${ROOT_DIR}/docker-compose.infra.yml"

POSTGRES_USER="${SPRINTFOUNDRY_POSTGRES_USER:-sf}"
POSTGRES_DB="${SPRINTFOUNDRY_POSTGRES_DB:-sprintfoundry}"

usage() {
  cat <<'EOF'
Usage: ./scripts/dev-infra.sh <command>

Commands:
  up       Start postgres + redis and wait until healthy
  down     Stop infra containers
  reset    Stop infra and remove volumes
  status   Show infra container status
  logs     Tail infra logs
  migrate  Apply SQL migrations to postgres
EOF
}

wait_for_health() {
  echo "[infra] waiting for postgres..."
  for _ in $(seq 1 60); do
    if docker compose -f "${COMPOSE_FILE}" exec -T postgres \
      pg_isready -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" >/dev/null 2>&1; then
      echo "[infra] postgres is ready"
      break
    fi
    sleep 1
  done

  echo "[infra] waiting for redis..."
  for _ in $(seq 1 60); do
    if [ "$(docker compose -f "${COMPOSE_FILE}" exec -T redis redis-cli ping 2>/dev/null || true)" = "PONG" ]; then
      echo "[infra] redis is ready"
      break
    fi
    sleep 1
  done
}

migrate() {
  echo "[infra] applying migrations/001_create_event_tables.sql"
  docker compose -f "${COMPOSE_FILE}" exec -T postgres \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" \
    < "${ROOT_DIR}/migrations/001_create_event_tables.sql"
  echo "[infra] migrations complete"
}

cmd="${1:-}"
case "${cmd}" in
  up)
    docker compose -f "${COMPOSE_FILE}" up -d
    wait_for_health
    ;;
  down)
    docker compose -f "${COMPOSE_FILE}" down
    ;;
  reset)
    docker compose -f "${COMPOSE_FILE}" down -v
    ;;
  status)
    docker compose -f "${COMPOSE_FILE}" ps
    ;;
  logs)
    docker compose -f "${COMPOSE_FILE}" logs -f
    ;;
  migrate)
    migrate
    ;;
  *)
    usage
    exit 1
    ;;
esac

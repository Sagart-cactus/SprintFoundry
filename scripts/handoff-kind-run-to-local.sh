#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/handoff-kind-run-to-local.sh --run-id <id> [options]

Hand off a completed whole-run workspace from a kind-backed PVC to a local
directory, import the pod's Codex store, and continue it locally.

Default behavior:
  import `/workspace/home/.codex` from the pod and launch
  `codex resume <session_id>` against that imported store

With `--prompt`:
  run `codex exec resume <session_id> <prompt>` against the imported store
  as a non-interactive continuation

Options:
  --run-id <id>          SprintFoundry run id to restore from the PVC
  --namespace <name>     Kubernetes namespace containing the PVC
                         Default: sf-whole-run-e2e
  --destination <path>   Local destination directory
                         Default: mktemp-created directory under /tmp
  --image <ref>          Container image to use for the temporary PVC inspector pod
                         Default: first image already present in the namespace that matches
                                  'sprintfoundry-runner'
  --session-id <id>      Override the session id instead of reading .sprintfoundry/sessions.json
  --prompt <text>        If provided, run `codex exec resume <session_id> <prompt>`
  --json                 Pass --json through to `codex exec resume`
  --print-only           Only print the continuation command, do not launch Codex
  --keep-pod             Keep the temporary inspector pod instead of deleting it on exit
  -h, --help             Show this help

Examples:
  ./scripts/handoff-kind-run-to-local.sh --run-id sf-whole-run-codex-e2e-234956

  ./scripts/handoff-kind-run-to-local.sh \
    --run-id sf-whole-run-codex-e2e-234956 \
    --prompt "Read README.md for context, then create validation/local-check.txt containing exactly: resumed locally."
EOF
}

RUN_ID=""
NAMESPACE="sf-whole-run-e2e"
DESTINATION=""
IMAGE=""
SESSION_ID_OVERRIDE=""
PROMPT=""
JSON_MODE=0
PRINT_ONLY=0
KEEP_POD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --namespace)
      NAMESPACE="${2:-}"
      shift 2
      ;;
    --destination)
      DESTINATION="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --session-id)
      SESSION_ID_OVERRIDE="${2:-}"
      shift 2
      ;;
    --prompt)
      PROMPT="${2:-}"
      shift 2
      ;;
    --json)
      JSON_MODE=1
      shift
      ;;
    --print-only)
      PRINT_ONLY=1
      shift
      ;;
    --keep-pod)
      KEEP_POD=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$RUN_ID" ]]; then
  echo "--run-id is required." >&2
  usage
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required." >&2
  exit 1
fi

if [[ "$PRINT_ONLY" -eq 0 ]] && ! command -v codex >/dev/null 2>&1; then
  echo "codex is required unless --print-only is used." >&2
  exit 1
fi

if [[ -z "$DESTINATION" ]]; then
  DESTINATION="$(mktemp -d "/tmp/${RUN_ID}-localresume.XXXXXX")"
fi

PVC_NAME="sf-run-ws-${RUN_ID}"
POD_NAME="sf-handoff-inspect-${RUN_ID}"
POD_NAME="${POD_NAME:0:63}"
POD_NAME="${POD_NAME%-}"

cleanup() {
  local exit_code=$?
  if [[ "$KEEP_POD" -eq 0 ]]; then
    kubectl -n "$NAMESPACE" delete pod "$POD_NAME" --ignore-not-found=true >/dev/null 2>&1 || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

if ! kubectl -n "$NAMESPACE" get pvc "$PVC_NAME" >/dev/null 2>&1; then
  echo "PVC not found: ${NAMESPACE}/${PVC_NAME}" >&2
  exit 1
fi

resolve_image() {
  if [[ -n "$IMAGE" ]]; then
    printf '%s\n' "$IMAGE"
    return 0
  fi

  local detected
  detected="$(kubectl -n "$NAMESPACE" get pods -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.image}{"\n"}{end}{end}' \
    | grep 'sprintfoundry-runner' \
    | head -n 1 || true)"

  if [[ -z "$detected" ]]; then
    detected="$(kubectl -n "$NAMESPACE" get pods -o jsonpath='{range .items[*]}{range .spec.containers[*]}{.image}{"\n"}{end}{end}' \
      | grep 'sprintfoundry-runner' \
      | head -n 1 || true)"
  fi

  if [[ -z "$detected" ]]; then
    echo "Unable to auto-detect a runner image in namespace ${NAMESPACE}. Pass --image explicitly." >&2
    exit 1
  fi

  printf '%s\n' "$detected"
}

IMAGE="$(resolve_image)"

echo "[handoff-kind] namespace: ${NAMESPACE}"
echo "[handoff-kind] pvc: ${PVC_NAME}"
echo "[handoff-kind] image: ${IMAGE}"
echo "[handoff-kind] destination: ${DESTINATION}"

kubectl -n "$NAMESPACE" delete pod "$POD_NAME" --ignore-not-found=true >/dev/null 2>&1 || true
kubectl -n "$NAMESPACE" run "$POD_NAME" \
  --restart=Never \
  --image="$IMAGE" \
  --overrides="$(cat <<EOF
{"apiVersion":"v1","spec":{"containers":[{"name":"shell","image":"$IMAGE","command":["sleep","600"],"volumeMounts":[{"name":"workspace","mountPath":"/workspace"}]}],"volumes":[{"name":"workspace","persistentVolumeClaim":{"claimName":"$PVC_NAME"}}]}}
EOF
)" \
  --command -- sleep 600 >/dev/null

kubectl -n "$NAMESPACE" wait --for=condition=Ready "pod/${POD_NAME}" --timeout=60s >/dev/null

WORKSPACE_PATH="$(
  kubectl -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc \
    "find /workspace/sprintfoundry -mindepth 2 -maxdepth 2 -type d -name '$RUN_ID' | head -n 1"
)"

if [[ -z "$WORKSPACE_PATH" ]]; then
  echo "Unable to locate workspace path for run ${RUN_ID} on the PVC." >&2
  exit 1
fi

echo "[handoff-kind] workspace: ${WORKSPACE_PATH}"

if [[ -e "$DESTINATION" ]] && [[ -n "$(find "$DESTINATION" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]]; then
  echo "Destination is not empty: ${DESTINATION}" >&2
  exit 1
fi

mkdir -p "$DESTINATION"
WORKSPACE_SUFFIX="${WORKSPACE_PATH#/workspace/}"
LOCAL_WORKSPACE_ROOT="${DESTINATION}/workspace"
LOCAL_WORKSPACE="${LOCAL_WORKSPACE_ROOT}/${WORKSPACE_SUFFIX}"

mkdir -p "$(dirname "$LOCAL_WORKSPACE")"
kubectl -n "$NAMESPACE" cp "${POD_NAME}:${WORKSPACE_PATH}" "$LOCAL_WORKSPACE"

IMPORTED_CODEX_ROOT="${DESTINATION}/workspace/home"
IMPORTED_CODEX_HOME="${IMPORTED_CODEX_ROOT}/.codex"

if kubectl -n "$NAMESPACE" exec "$POD_NAME" -- sh -lc 'test -d /workspace/home/.codex'; then
  mkdir -p "$(dirname "$IMPORTED_CODEX_HOME")"
  kubectl -n "$NAMESPACE" cp "${POD_NAME}:/workspace/home/.codex" "$IMPORTED_CODEX_HOME"
  if [[ ! -f "${IMPORTED_CODEX_HOME}/state_5.sqlite" ]] && [[ -f "${IMPORTED_CODEX_ROOT}/state_5.sqlite" ]]; then
    IMPORTED_CODEX_HOME="${IMPORTED_CODEX_ROOT}"
  fi
else
  echo "[handoff-kind] warning: pod Codex store /workspace/home/.codex not found; interactive resume may not be available."
fi

SESSIONS_FILE="${LOCAL_WORKSPACE}/.sprintfoundry/sessions.json"
if [[ ! -f "$SESSIONS_FILE" ]]; then
  echo "Missing sessions file in restored workspace: ${SESSIONS_FILE}" >&2
  exit 1
fi

SESSION_ID="$SESSION_ID_OVERRIDE"
if [[ -z "$SESSION_ID" ]]; then
  SESSION_ID="$(
    node -e '
const fs = require("fs");
const file = process.argv[1];
const runId = process.argv[2];
const raw = JSON.parse(fs.readFileSync(file, "utf8"));
const match = (raw.sessions || []).find((entry) => entry.run_id === runId && entry.session_id);
if (!match) process.exit(1);
process.stdout.write(String(match.session_id));
' "$SESSIONS_FILE" "$RUN_ID"
  )" || {
    echo "Unable to extract session id for run ${RUN_ID} from ${SESSIONS_FILE}" >&2
    exit 1
  }
fi

echo "[handoff-kind] local workspace: ${LOCAL_WORKSPACE}"
echo "[handoff-kind] session id: ${SESSION_ID}"
if [[ -n "$IMPORTED_CODEX_HOME" ]] && [[ -d "$IMPORTED_CODEX_HOME" ]]; then
  IMPORTED_SESSION_PATH="$(find "${IMPORTED_CODEX_HOME}/sessions" -type f -name "*${SESSION_ID}*.jsonl" | head -n 1 || true)"
  if [[ -n "$IMPORTED_SESSION_PATH" ]]; then
    node -e '
const fs = require("fs");
const [file, oldWorkspace, newWorkspace, oldCodexHome, newCodexHome] = process.argv.slice(1);
let text = fs.readFileSync(file, "utf8");
text = text.split(oldWorkspace).join(newWorkspace);
text = text.split(oldCodexHome).join(newCodexHome);
fs.writeFileSync(file, text);
' "$IMPORTED_SESSION_PATH" "$WORKSPACE_PATH" "$LOCAL_WORKSPACE" "/workspace/home/.codex" "$IMPORTED_CODEX_HOME"

    sql_escape() {
      printf "%s" "$1" | sed "s/'/''/g"
    }

    ESCAPED_WORKSPACE_PATH="$(sql_escape "$LOCAL_WORKSPACE")"
    ESCAPED_ROLLOUT_PATH="$(sql_escape "$IMPORTED_SESSION_PATH")"
    ESCAPED_SESSION_ID="$(sql_escape "$SESSION_ID")"
    sqlite3 "${IMPORTED_CODEX_HOME}/state_5.sqlite" \
      "UPDATE threads SET cwd='${ESCAPED_WORKSPACE_PATH}', rollout_path='${ESCAPED_ROLLOUT_PATH}' WHERE id='${ESCAPED_SESSION_ID}';"
  fi

  IMPORTED_CONFIG_PATH="${IMPORTED_CODEX_HOME}/config.toml"
  if [[ -f "$IMPORTED_CONFIG_PATH" ]] && ! grep -Fq "[projects.\"${LOCAL_WORKSPACE}\"]" "$IMPORTED_CONFIG_PATH"; then
    printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$LOCAL_WORKSPACE" >> "$IMPORTED_CONFIG_PATH"
  fi

  echo "[handoff-kind] imported CODEX_HOME: ${IMPORTED_CODEX_HOME}"
fi

if [[ -n "$PROMPT" ]]; then
  if [[ -n "$IMPORTED_CODEX_HOME" ]] && [[ -d "$IMPORTED_CODEX_HOME" ]]; then
    RESUME_CMD=(
      env
      "CODEX_HOME=${IMPORTED_CODEX_HOME}"
      codex exec resume
      "$SESSION_ID"
      "$PROMPT"
    )
  else
    RESUME_CMD=(
      codex exec resume
      "$SESSION_ID"
      "$PROMPT"
    )
  fi

  if [[ "$JSON_MODE" -eq 1 ]]; then
    RESUME_CMD+=(--json)
  fi

  RESUME_CMD+=(--dangerously-bypass-approvals-and-sandbox)

  echo "[handoff-kind] command:"
  printf 'cd %q && ' "$LOCAL_WORKSPACE"
  printf '%q ' "${RESUME_CMD[@]}"
  printf '\n'

  if [[ "$PRINT_ONLY" -eq 1 ]]; then
    echo "[handoff-kind] --print-only set, not launching Codex."
    exit 0
  fi

  (
    cd "$LOCAL_WORKSPACE"
    "${RESUME_CMD[@]}"
  )
else
  if [[ -n "$IMPORTED_CODEX_HOME" ]] && [[ -d "$IMPORTED_CODEX_HOME" ]]; then
    INTERACTIVE_CMD=(
      env
      "CODEX_HOME=${IMPORTED_CODEX_HOME}"
      codex resume
      "$SESSION_ID"
      --dangerously-bypass-approvals-and-sandbox
    )

    echo "[handoff-kind] command:"
    printf 'cd %q && ' "$LOCAL_WORKSPACE"
    printf '%q ' "${INTERACTIVE_CMD[@]}"
    printf '\n'

    if [[ "$PRINT_ONLY" -eq 1 ]]; then
      echo "[handoff-kind] --print-only set, not launching Codex."
      exit 0
    fi

    echo "[handoff-kind] Launching interactive Codex resume against imported store..."
    cd "$LOCAL_WORKSPACE"
    exec "${INTERACTIVE_CMD[@]}"
  fi

  HANDOFF_PROMPT=$(cat <<EOF
This workspace was handed off from a completed SprintFoundry Kubernetes run.

Run ID: ${RUN_ID}
Original runtime session ID: ${SESSION_ID}

Read README.md, .sprintfoundry/run-state.json, and .sprintfoundry/sessions.json for context, then continue interactively from this restored local workspace.
EOF
)

  FALLBACK_CMD=(
    codex
    --dangerously-bypass-approvals-and-sandbox
    "$HANDOFF_PROMPT"
  )

  echo "[handoff-kind] imported Codex store unavailable; falling back to a fresh local interactive session."
  echo "[handoff-kind] command:"
  printf 'cd %q && ' "$LOCAL_WORKSPACE"
  printf '%q ' "${FALLBACK_CMD[@]}"
  printf '\n'

  if [[ "$PRINT_ONLY" -eq 1 ]]; then
    echo "[handoff-kind] --print-only set, not launching Codex."
    exit 0
  fi

  echo "[handoff-kind] Launching fallback interactive Codex session in restored workspace..."
  cd "$LOCAL_WORKSPACE"
  exec "${FALLBACK_CMD[@]}"
fi

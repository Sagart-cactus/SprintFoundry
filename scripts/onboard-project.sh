#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<USAGE
Usage: $(basename "$0") --project-id <id> --config-file <path> [--dry-run]

Onboard a SprintFoundry project namespace in Kubernetes by rendering templates,
applying manifests, and verifying namespace/secret/configmap resources.
USAGE
}

PROJECT_ID=""
CONFIG_FILE=""
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project-id)
      PROJECT_ID="${2:-}"
      shift 2
      ;;
    --config-file)
      CONFIG_FILE="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
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

if [[ -z "$PROJECT_ID" || -z "$CONFIG_FILE" ]]; then
  echo "Both --project-id and --config-file are required." >&2
  usage
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "Config file not found: $CONFIG_FILE" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE_DIR="$SCRIPT_DIR/../k8s/project-template"
if [[ ! -d "$TEMPLATE_DIR" ]]; then
  echo "Template directory not found: $TEMPLATE_DIR" >&2
  exit 1
fi

PROJECT_NAMESPACE="sprintfoundry-project-${PROJECT_ID}"
WORK_DIR="$(mktemp -d -t sf-onboard-${PROJECT_ID}-XXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

render_template() {
  local input="$1"
  local output="$2"

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      __PROJECT_CONFIG_CONTENT__)
        sed 's/^/    /' "$CONFIG_FILE"
        ;;
      *)
        line="${line//__PROJECT_ID__/$PROJECT_ID}"
        line="${line//__PROJECT_NAMESPACE__/$PROJECT_NAMESPACE}"
        echo "$line"
        ;;
    esac
  done < "$input" > "$output"
}

for file in namespace.yaml external-secret.yaml configmap-project.yaml resource-quota.yaml kustomization.yaml; do
  render_template "$TEMPLATE_DIR/$file" "$WORK_DIR/$file"
done

echo "[onboard] Rendered manifests in: $WORK_DIR"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[onboard] Dry-run: rendering kustomize output only"
  kubectl kustomize "$WORK_DIR" >/dev/null
  echo "[onboard] Dry-run successful"
  exit 0
fi

echo "[onboard] Applying manifests..."
kubectl apply -k "$WORK_DIR"

echo "[onboard] Verifying namespace..."
kubectl get namespace "$PROJECT_NAMESPACE" >/dev/null

echo "[onboard] Verifying configmap..."
kubectl -n "$PROJECT_NAMESPACE" get configmap project-config >/dev/null

echo "[onboard] Waiting for ExternalSecret target Secret sync..."
for _ in $(seq 1 24); do
  if kubectl -n "$PROJECT_NAMESPACE" get secret project-runtime-secrets >/dev/null 2>&1; then
    echo "[onboard] Secret synced: project-runtime-secrets"
    exit 0
  fi
  sleep 5
done

echo "[onboard] Secret sync check failed: project-runtime-secrets not found after 120s" >&2
echo "[onboard] Verify ExternalSecrets operator and ClusterSecretStore configuration." >&2
exit 1

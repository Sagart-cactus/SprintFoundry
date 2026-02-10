#!/usr/bin/env bash
set -euo pipefail

# AgentSDLC — Shared Agent Entrypoint
# Reads config from env vars and runs Claude Code on the task.

echo "[agentsdlc] Starting ${AGENT_TYPE:-unknown} agent..."

# Ensure CLAUDE.md is in the workspace root
if [ -f /workspace/CLAUDE.md ]; then
  echo "[agentsdlc] CLAUDE.md found in workspace"
else
  echo "[agentsdlc] ERROR: No CLAUDE.md found in /workspace"
  exit 1
fi

# Ensure task file exists
if [ ! -f /workspace/.agent-task.md ]; then
  echo "[agentsdlc] ERROR: No .agent-task.md found in /workspace"
  exit 1
fi

TASK=$(cat /workspace/.agent-task.md)

# ---- Build CLI args from env vars ----

CLI_ARGS=(-p "$TASK")

# Output format (default: json)
OUTPUT_FORMAT="${AGENT_OUTPUT_FORMAT:-json}"
CLI_ARGS+=(--output-format "$OUTPUT_FORMAT")

# Skip permissions (default: true for autonomous container operation)
SKIP_PERMISSIONS="${AGENT_SKIP_PERMISSIONS:-true}"
if [ "$SKIP_PERMISSIONS" = "true" ]; then
  CLI_ARGS+=(--dangerously-skip-permissions)
fi

# Budget control (replaces invalid --max-turns)
MAX_BUDGET="${AGENT_MAX_BUDGET:-}"
if [ -n "$MAX_BUDGET" ]; then
  CLI_ARGS+=(--max-budget-usd "$MAX_BUDGET")
fi

# Plugin directories (colon-separated)
PLUGIN_DIRS="${AGENT_PLUGIN_DIRS:-}"
if [ -n "$PLUGIN_DIRS" ]; then
  IFS=':' read -ra DIRS <<< "$PLUGIN_DIRS"
  for dir in "${DIRS[@]}"; do
    if [ -d "$dir" ]; then
      CLI_ARGS+=(--plugin-dir "$dir")
      echo "[agentsdlc] Plugin: $dir"
    else
      echo "[agentsdlc] WARNING: Plugin directory not found: $dir"
    fi
  done
fi

echo "[agentsdlc] Running Claude Code..."

# Run Claude Code with the dynamically built args
claude "${CLI_ARGS[@]}"

echo "[agentsdlc] Agent complete."

# Verify result file was produced
if [ -f /workspace/.agent-result.json ]; then
  echo "[agentsdlc] Result:"
  cat /workspace/.agent-result.json | jq .status
else
  echo "[agentsdlc] WARNING: Agent did not produce .agent-result.json"
  # Create a failure result so the orchestrator knows what happened
  cat > /workspace/.agent-result.json << 'RESULT'
{
  "status": "failed",
  "summary": "Agent exited without producing a result file",
  "artifacts_created": [],
  "artifacts_modified": [],
  "issues": ["No .agent-result.json was written by the agent"],
  "metadata": {}
}
RESULT
fi

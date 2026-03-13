#!/bin/sh
# SprintFoundry entrypoint
# Writes ~/.codex/config.toml from env vars before starting Node.js.
# Also exports OPENAI_API_KEY for processes that read it from the environment.

OPENAI_KEY="${SPRINTFOUNDRY_OPENAI_KEY:-${OPENAI_API_KEY:-}}"

if [ -n "$OPENAI_KEY" ]; then
  # Seed Codex auth/config files for CLI local_process mode.
  mkdir -p "$HOME/.codex"
  {
    echo '[openai]'
    echo "api_key = \"$OPENAI_KEY\""
  } > "$HOME/.codex/config.toml"
  chmod 600 "$HOME/.codex/config.toml"
  echo "[entrypoint] wrote ~/.codex/config.toml ($(wc -c < "$HOME/.codex/config.toml") bytes)" >&2
  printf '{\n  "OPENAI_API_KEY": "%s"\n}\n' "$OPENAI_KEY" > "$HOME/.codex/auth.json"
  chmod 600 "$HOME/.codex/auth.json"
  echo "[entrypoint] wrote ~/.codex/auth.json ($(wc -c < "$HOME/.codex/auth.json") bytes)" >&2
  # Also export OPENAI_API_KEY so codex can find it via environment
  export OPENAI_API_KEY="$OPENAI_KEY"
else
  echo "[entrypoint] WARNING: no OpenAI key found (SPRINTFOUNDRY_OPENAI_KEY / OPENAI_API_KEY)" >&2
fi

exec node dist/index.js "$@"

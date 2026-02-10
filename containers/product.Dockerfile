# AgentSDLC — Product Agent
# Minimal image. Mostly writes markdown — no heavy tooling needed.

FROM agentsdlc/agent-base:latest

# No additional tools needed — base image with Claude Code is sufficient.
# Product agent reads tickets and writes markdown specs.

WORKDIR /workspace

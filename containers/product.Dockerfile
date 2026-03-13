# SprintFoundry — Product Agent
# Minimal image. Mostly writes markdown — no heavy tooling needed.

ARG BASE_IMAGE=sprintfoundry/agent-base:latest
FROM ${BASE_IMAGE}

# No additional tools needed — base image with Claude Code is sufficient.
# Product agent reads tickets and writes markdown specs.

WORKDIR /workspace

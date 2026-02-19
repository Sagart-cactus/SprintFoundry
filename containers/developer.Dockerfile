# SprintFoundry — Developer Agent
# Full-stack development environment with Node.js, TypeScript, and common tools.

FROM sprintfoundry/agent-base:latest

USER root

# Install pnpm and development tools
RUN npm install -g pnpm typescript ts-node tsx prettier eslint

# Install additional system tools for development
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

USER agent
WORKDIR /workspace

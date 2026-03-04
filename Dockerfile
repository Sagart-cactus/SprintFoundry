FROM node:22-slim

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

# System tools required by SprintFoundry agent/runtime workflows.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    jq \
    curl \
    openssh-client \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Runtime CLIs used by local_process mode in run pods.
RUN corepack enable \
    && npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /opt/sprintfoundry

# Install production dependencies only.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Runtime payload required in the unified image.
COPY dist ./dist
COPY src/agents ./src/agents
COPY src/agents-codex ./src/agents-codex
COPY plugins ./plugins
COPY config/platform.yaml ./config/platform.yaml
COPY monitor ./monitor

# Non-root runtime user and writable workspace mount point.
RUN useradd --create-home --shell /bin/bash runner \
    && mkdir -p /workspace \
    && chown -R runner:runner /workspace /opt/sprintfoundry

USER runner
WORKDIR /opt/sprintfoundry

ENTRYPOINT ["node", "dist/index.js"]

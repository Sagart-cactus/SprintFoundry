# AgentSDLC — Base Agent Image
# All agent containers inherit from this image.
# Provides Claude Code CLI, Node.js, and common utilities.

FROM node:22-slim AS base

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user for agent execution
RUN useradd -m -s /bin/bash agent

# Set up workspace directory
RUN mkdir -p /workspace && chown agent:agent /workspace

# Copy shared entrypoint
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /workspace
USER agent

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

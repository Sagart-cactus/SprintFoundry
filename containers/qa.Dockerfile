# AgentSDLC — QA Agent
# Testing environment with vitest, playwright, and browser dependencies.

FROM agentsdlc/agent-base:latest

USER root

# Install testing frameworks
RUN npm install -g pnpm vitest

# Install Playwright system dependencies (Chromium)
RUN npx playwright install-deps chromium
RUN npx playwright install chromium

# Install additional test utilities
RUN npm install -g tsx

USER agent
WORKDIR /workspace

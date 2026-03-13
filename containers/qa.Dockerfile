# SprintFoundry — QA Agent
# Testing environment with vitest, playwright, and browser dependencies.

ARG BASE_IMAGE=sprintfoundry/agent-base:latest
FROM ${BASE_IMAGE}

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

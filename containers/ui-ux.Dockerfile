# SprintFoundry — UI/UX Agent
# Frontend design tooling for component specs and previews.

ARG BASE_IMAGE=sprintfoundry/agent-base:latest
FROM ${BASE_IMAGE}

USER root

# Install frontend tooling for generating previews
RUN npm install -g pnpm typescript tsx

# Install Playwright for visual testing/screenshots
RUN npx playwright install-deps chromium
RUN npx playwright install chromium

USER agent
WORKDIR /workspace

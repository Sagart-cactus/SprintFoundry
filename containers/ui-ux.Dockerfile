# AgentSDLC — UI/UX Agent
# Frontend design tooling for component specs and previews.

FROM agentsdlc/agent-base:latest

USER root

# Install frontend tooling for generating previews
RUN npm install -g pnpm typescript tsx

# Install Playwright for visual testing/screenshots
RUN npx playwright install-deps chromium
RUN npx playwright install chromium

USER agent
WORKDIR /workspace

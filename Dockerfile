# syntax=docker/dockerfile:1.7

# ─── Stage 1: builder ─────────────────────────────────────────────────────────
FROM node:22-slim AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable

WORKDIR /build
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=sf-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
COPY scripts/copy-assets.mjs ./scripts/copy-assets.mjs
# Compile TS → dist/, then copy src/agents/ and src/agents-codex/ into dist/
RUN pnpm exec tsc && node scripts/copy-assets.mjs

# ─── Stage 2: runner ──────────────────────────────────────────────────────────
FROM node:22-slim AS runner

ENV NODE_ENV=production \
    PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH

RUN apt-get update && apt-get install -y --no-install-recommends \
    git jq curl gh openssh-client ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Both CLIs: claude-code for claude agents, codex for codex agents
RUN --mount=type=cache,id=sf-npm,target=/root/.npm \
    corepack enable \
    && npm install -g @anthropic-ai/claude-code @openai/codex

WORKDIR /opt/sprintfoundry
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=sf-pnpm,target=/pnpm/store \
    pnpm install --prod --frozen-lockfile

# dist/ from builder (includes dist/agents/ and dist/agents-codex/ via copy-assets.mjs)
COPY --from=builder /build/dist ./dist

COPY plugins ./plugins
COPY config/platform.yaml ./config/platform.yaml
COPY monitor ./monitor
COPY scripts/entrypoint.sh ./entrypoint.sh

RUN useradd --create-home --shell /bin/bash runner \
    && mkdir -p /workspace \
    && chown -R runner:runner /workspace /opt/sprintfoundry \
    && chmod +x /opt/sprintfoundry/entrypoint.sh

USER runner
WORKDIR /opt/sprintfoundry
ENTRYPOINT ["/opt/sprintfoundry/entrypoint.sh"]

# AgentSDLC

A multi-agent orchestration platform for end-to-end AI-powered software development. Takes tickets from Linear/GitHub/Jira and orchestrates specialized AI agents (Product, Architecture, Developer, QA, Security, UI/UX) to deliver tested, reviewed code as pull requests.

## Architecture Summary

The system has two layers:

**Hard shell (Orchestration Service)** — A Node.js/TypeScript service that enforces guardrails. It owns credentials, budgets, timeouts, mandatory rules, container lifecycle, and structured logging. It never makes judgment calls about what to build or how to classify a ticket.

**Soft core (Orchestrator Agent)** — A Claude API call that reads the ticket, classifies the work, decides which agents to invoke, what context each needs, and how to handle rework. It returns a structured JSON execution plan. It never sees API keys or makes infrastructure decisions.

Agents are Claude Code instances running in Docker containers. Each has a purpose-built `CLAUDE.md` (its "brain"), pre-installed tools, and access to a shared workspace volume. The filesystem is the message bus — agents read artifacts from previous steps and write their own outputs. No event queues, no RAG pipelines.

## What's Been Built

### Core service layer (`src/service/`)
- `orchestration-service.ts` — Main entry point. Fetches tickets, calls orchestrator agent for plan, validates plan against rules, executes steps sequentially/parallel, handles rework loops, creates PRs, updates tickets.
- `plan-validator.ts` — Enforces platform + project rules on the orchestrator agent's plan. Injects mandatory agents (e.g., QA after dev) and human gates. Validates dependency coherence.
- `agent-runner.ts` — Spawns agents as either local Claude Code processes or Docker containers. Prepares workspace (copies CLAUDE.md, writes task file, gathers context), enforces timeouts, reads `.agent-result.json` on completion.
- `orchestrator-agent.ts` — Calls Claude API with ticket details, repo context, agent definitions, and rules. Parses the returned JSON execution plan. Also handles rework planning.

### Shared types (`src/shared/types.ts`)
Complete type definitions for: tickets, execution plans, agent configs, platform/project config, run state, step execution, agent results, human reviews, events.

### Configuration (`config/`)
- `platform.yaml` — System-wide defaults: models per agent, budgets, timeouts, mandatory rules, agent definitions with capabilities/outputs.
- `project.example.yaml` — User-facing template: repo URL, BYOK API keys, model overrides, budget overrides, branch strategy, integrations, project-specific rules.

### Agent instructions (`src/agents/`)
- `developer/CLAUDE.md` — Full instructions for the developer agent
- `qa/CLAUDE.md` — Full instructions for the QA agent

## What Needs to Be Built

### Priority 1: Project setup
- `package.json` with dependencies (anthropic SDK, yaml parser, docker API client, commander for CLI)
- `tsconfig.json`
- `src/index.ts` — CLI entry point using commander
- `.env.example`

### Priority 2: Remaining agent CLAUDE.md files
- `src/agents/product/CLAUDE.md` — Product analysis, specs, user stories
- `src/agents/architect/CLAUDE.md` — System design, API contracts, data models, ADRs
- `src/agents/security/CLAUDE.md` — Vulnerability scanning, auth review, dependency audit
- `src/agents/ui-ux/CLAUDE.md` — Wireframes, component specs, design system
- `src/agents/devops/CLAUDE.md` — CI/CD, Dockerfiles, IaC
- `src/agents/orchestrator/CLAUDE.md` — (optional) if we move to container-based orchestrator

### Priority 3: Service stubs
These are imported by `orchestration-service.ts` but not yet implemented:
- `src/service/event-store.ts` — Stores TaskEvent records (start with in-memory, then Postgres)
- `src/service/workspace-manager.ts` — Creates/cleans up workspace directories per run
- `src/service/git-manager.ts` — Clone repo, create branch, commit, push, create PR via GitHub API
- `src/service/ticket-fetcher.ts` — Fetch ticket details from Linear/GitHub/Jira APIs
- `src/service/notification-service.ts` — Send notifications via Slack webhook/email

### Priority 4: Dockerfiles
- `containers/base.Dockerfile` — Base image with Claude Code installed
- `containers/developer.Dockerfile` — Node.js, pnpm, TypeScript, linters
- `containers/qa.Dockerfile` — Node.js, vitest, playwright with browser deps
- `containers/security.Dockerfile` — Snyk, TruffleHog, Trivy
- `containers/product.Dockerfile` — Minimal (mostly writes markdown)
- `containers/architect.Dockerfile` — Diagramming tools (mermaid-cli, plantuml)
- `containers/ui-ux.Dockerfile` — Node.js, design tooling
- Each Dockerfile should have an `entrypoint.sh` that copies CLAUDE.md into workspace and runs `claude -p`

### Priority 5: MCP servers
- `src/mcp-servers/agent-spawn/` — MCP server for spawning sub-agents (if moving to agent-based orchestration)
- `src/mcp-servers/project-state/` — MCP server for reading/writing project state

## Key Technical Decisions

See `docs/decisions.md` for the full decision log with rationale.

Summary of critical decisions:
1. Hybrid orchestration (service shell + agent core) over pure service or pure agent
2. Filesystem as message bus over event queues or API-based context passing
3. Claude Code as agent runtime over custom agent framework or OpenHands SDK
4. BYOK model — users bring their own API keys
5. Config layering: platform defaults → project config → per-task plan
6. Agents never see credentials — service injects at container spawn time

## Code Patterns

- All types in `src/shared/types.ts` — import from there, don't redefine
- Agent CLAUDE.md files follow a consistent structure: role → before you start → process → rules → output format
- Every agent must write `.agent-result.json` on completion with status, summary, artifacts, and issues
- Agents communicate via `artifacts/` directory and `artifacts/handoff/` subdirectory
- Configuration uses YAML with environment variable interpolation (`${ENV_VAR}`)
- Service methods are async, errors propagate to `orchestration-service.ts` which handles logging and notifications

## Running the Project

```bash
# Install
pnpm install

# Configure
cp config/project.example.yaml config/project.yaml
# Edit config/project.yaml with your repo, API keys, etc.

# Run on a Linear ticket
pnpm dev -- --source linear --ticket LIN-423

# Run on a GitHub issue
pnpm dev -- --source github --ticket 42

# Run with a direct prompt
pnpm dev -- --prompt "Add CSV export to the reports page"

# Run in container mode (requires Docker)
AGENTSDLC_USE_CONTAINERS=true pnpm dev -- --source linear --ticket LIN-423
```
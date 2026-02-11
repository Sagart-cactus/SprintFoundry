# AgentSDLC

An AI-powered multi-agent orchestration platform for end-to-end software development.

AgentSDLC takes tickets from your project management tools (Linear, GitHub Issues, Jira) and orchestrates specialized AI agents — Product, Architecture, Developer, QA, Security, UI/UX — to deliver tested, reviewed code as pull requests.

## Runtime Portability

Agent execution is runtime-driven and can be mixed per agent:

- `claude-code` runtime
- `codex` runtime

Planning remains on the orchestrator runtime.

Runtime selection precedence:

1. `project.runtime_overrides[agent]`
2. `platform.defaults.runtime_per_agent[agent or role]`
3. legacy fallback (`claude-code`, local process unless `AGENTSDLC_USE_CONTAINERS=true`)

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                        Sources                                │
│  Linear │ GitHub Issues │ Jira │ Direct Prompt                │
└────────────────────────┬─────────────────────────────────────┘
                         │
┌────────────────────────▼─────────────────────────────────────┐
│                 Orchestration Service                         │
│                                                               │
│  ┌─────────────┐ ┌──────────────┐ ┌───────────────────────┐ │
│  │ Task Ingress│ │ Plan Validator│ │ Execution Engine      │ │
│  │ (fetch +    │ │ (enforce     │ │ (spawn agents,        │ │
│  │  normalize) │ │  rules)      │ │  track state,         │ │
│  └──────┬──────┘ └──────▲───────┘ │  handle rework)       │ │
│         │               │         └───────────┬───────────┘ │
│         │               │                     │              │
│  ┌──────▼───────────────┴──────┐              │              │
│  │   Orchestrator Agent        │              │              │
│  │   (Claude — classifies,     │              │              │
│  │    plans, routes)           │              │              │
│  └─────────────────────────────┘              │              │
│                                               │              │
│  ┌────────────────────────────────────────────┘              │
│  │  Project Config   │  Platform Config                      │
│  │  (repo, BYOK,     │  (defaults, agent                     │
│  │   model prefs)    │   definitions)                        │
│  └────────────────────────────────────────────────────────── │
└──────────────────────────────────────────────────────────────┘
                         │
          ┌──────────────┼──────────────┐
          │              │              │
   ┌──────▼──────┐ ┌────▼─────┐ ┌─────▼──────┐
   │  Developer  │ │   QA     │ │  Security  │  ... (Product, UI/UX, etc.)
   │  Agent      │ │  Agent   │ │  Agent     │
   │  Container  │ │ Container│ │  Container │
   │             │ │          │ │            │
   │ CLAUDE.md   │ │ CLAUDE.md│ │ CLAUDE.md  │
   │ tools/deps  │ │ tools    │ │ scanners   │
   │ workspace   │ │ workspace│ │ workspace  │
   └─────────────┘ └──────────┘ └────────────┘
          │              │              │
          └──────────────┼──────────────┘
                         │
                  Shared Workspace
                  (git repo volume)
```

## Key Design Principles

1. **Guardrails in the service, intelligence in the agent** — The orchestration service enforces rules (budgets, mandatory steps, timeouts). The orchestrator agent makes judgment calls (classification, planning, context routing).

2. **Agents never see credentials** — API keys, tokens, and BYOK config live in the service layer. Agents receive a mounted workspace and a task description.

3. **Filesystem is the message bus** — Agents communicate through the shared workspace. Each agent reads predecessor artifacts and writes its own outputs.

4. **BYOK (Bring Your Own Key)** — Users provide their own API keys. The platform supports multiple LLM providers per agent type.

## Quick Start

```bash
# Install dependencies
pnpm install

# Configure your project
cp config/project.example.yaml config/project.yaml
# Edit with your repo, API keys, preferences

# Run on a ticket
pnpm dev -- --source linear --ticket LIN-423

# Or run with a direct prompt
pnpm dev -- --prompt "Add CSV export to the reports page"
```

## Project Structure

```
agentsdlc/
├── src/
│   ├── service/          # Orchestration service (hard shell)
│   ├── agents/           # Agent definitions (CLAUDE.md + Dockerfiles)
│   ├── agents-codex/     # Codex-specific agent profiles (CODEX.md)
│   ├── service/runtime/  # Runtime adapters + factories
│   ├── mcp-servers/      # Custom MCP servers
│   ├── integrations/     # Linear, GitHub, Jira connectors
│   └── shared/           # Shared types, utilities
├── config/               # Configuration templates
├── containers/           # Dockerfiles for agent containers
└── docs/                 # Documentation
```

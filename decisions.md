# Architecture Decision Record — SprintFoundry

This document captures every significant design decision made during the architecture phase, including the alternatives considered, reasoning, and tradeoffs.

---

## ADR-001: Multi-Agent Orchestration Over Single Agent

**Status:** Accepted  
**Date:** 2026-02-10

### Context
We need an AI system that can handle end-to-end software development from ticket to PR. The question is whether one powerful agent handles everything, or multiple specialized agents collaborate.

### Decision
Use multiple specialized agents (Product, Architect, Developer, QA, Security, UI/UX), each with its own container, tools, and instructions.

### Alternatives Considered
- **Single agent (like Lovable/Bolt):** One Claude instance generates everything in one conversation. Faster for prototypes but loses quality as complexity grows — no separation of concerns, no independent QA, no security review.
- **Single agent with multiple personas (prompt switching):** One agent switches hats mid-conversation. Loses context between phases, can't enforce real isolation.

### Rationale
Real software teams have specialized roles for a reason. A QA engineer who didn't write the code catches different bugs than the author. A security reviewer brings a different lens. Specialized agents with focused CLAUDE.md instructions produce better output in their domain than a generalist trying to do everything. Containers provide genuine isolation — the QA agent literally cannot modify source code outside its instructions.

### Tradeoffs
- More complex orchestration
- Higher total token cost (multiple agents vs one)
- Need to solve inter-agent context passing

---

## ADR-002: Hybrid Orchestration (Service Shell + Agent Core)

**Status:** Accepted  
**Date:** 2026-02-10

### Context
The orchestration layer needs to both make intelligent decisions (ticket classification, agent selection, context routing) and enforce hard constraints (budgets, mandatory steps, timeouts). We evaluated four approaches.

### Decision
Hybrid approach: a traditional code service (the "hard shell") wraps an LLM-powered orchestrator agent (the "soft core").

### Alternatives Considered

| Approach | Predictability | Flexibility | Reliability | Dev Speed |
|---|---|---|---|---|
| Pure orchestration service (code-only) | ★★★★★ | ★★☆☆☆ | ★★★★★ | ★★☆☆☆ |
| Pure orchestrator agent (LLM-only) | ★★☆☆☆ | ★★★★★ | ★★★☆☆ | ★★★★★ |
| DAG-based (Airflow/Prefect) | ★★★★☆ | ★★☆☆☆ | ★★★★☆ | ★★★☆☆ |
| Event-driven (message queue) | ★★★☆☆ | ★★★★☆ | ★★★☆☆ | ★★★☆☆ |

### Rationale
Real tickets are messy. A purely code-based state machine can't handle "this is half bug-fix, half feature, with a UI change" — you'd need increasingly complex branching logic. But a purely LLM-based orchestrator can't guarantee "QA always runs after dev" or enforce token budgets — those are rules, not judgment calls.

The hybrid gives us:
- **Agent intelligence** for classification, planning, context routing, rework decisions
- **Service reliability** for budgets, timeouts, mandatory steps, audit logging, credential management

### Tradeoffs
- Two systems to maintain instead of one
- Orchestrator agent adds ~20% token overhead
- Need clear boundaries on what the service decides vs what the agent decides

### Boundary Definition
**Service decides:** credentials, budgets, timeouts, mandatory rules, container lifecycle, structured logging, PR creation, ticket updates.  
**Agent decides:** ticket classification, which agents to invoke, task descriptions, context routing, execution order, rework strategy, human gate placement.

---

## ADR-003: Filesystem as Message Bus

**Status:** Accepted  
**Date:** 2026-02-10

### Context
Agents need to share context — the developer agent needs the product spec, the QA agent needs the source code and acceptance criteria, the security agent needs the architecture doc.

### Decision
All agents mount the same workspace volume. They read predecessor artifacts from the filesystem and write their own output files. The `artifacts/` directory and `artifacts/handoff/` subdirectory are the communication channel.

### Alternatives Considered
- **Event queue (Redis/SQS):** Agents publish/subscribe to events. More decoupled but adds infrastructure complexity and makes debugging harder (have to trace events vs just looking at files).
- **API-based context passing:** Service gathers context and passes it as API parameters to each agent. Clean but requires the service to understand what each agent needs — defeats the purpose of agent intelligence.
- **RAG pipeline:** Vector database with project artifacts. Overkill for a single project context. Adds latency and retrieval uncertainty.

### Rationale
Files are the simplest, most debuggable form of inter-agent communication. When something goes wrong, you look at the workspace directory. Every artifact is a file you can read. There's no event store to query, no vector DB to debug. Claude Code already works natively with filesystems. And git gives you versioning for free.

### Tradeoffs
- No real-time streaming of partial results between agents
- Parallel agents writing to the same volume need directory-level separation
- Large codebases may exceed context windows (agents need to be selective about what they read)

### Conventions
- Each agent writes to well-known paths (defined in its CLAUDE.md)
- Handoff docs go in `artifacts/handoff/{from}-to-{to}.md`
- Agent results always go in `.agent-result.json`
- Previous step outputs are staged in `.agent-context/` by the service

---

## ADR-004: Claude Code as Agent Runtime

**Status:** Accepted  
**Date:** 2026-02-10

### Context
Each agent needs to: reason about a task, read/write files, execute shell commands (npm install, run tests, etc.), and iterate on errors. We need an agent runtime.

### Decision
Use Claude Code (`claude -p "task" --dangerously-skip-permissions`) as the agent runtime inside Docker containers. Each agent is a Claude Code instance with a specialized CLAUDE.md.

### Alternatives Considered
- **Custom agent loop (direct API + tool use):** Call Claude API directly, parse tool calls, execute them, loop. Full control but you're rebuilding what Claude Code already does — file editing, terminal access, error recovery, multi-step reasoning.
- **OpenHands SDK:** Open-source agent SDK with containerized execution, MCP support, event-sourced state. More mature infrastructure but adds a dependency and may diverge from our needs.
- **LangChain/CrewAI agents:** General-purpose agent frameworks. Not optimized for software development tasks. Would need heavy customization.

### Rationale
Claude Code already handles the entire agentic loop — tool use, file editing, terminal execution, iterative debugging, error recovery. Building our own would duplicate all of this. The CLAUDE.md file is a natural, readable way to define agent behavior. Container isolation is handled by Docker, not the agent framework.

### Tradeoffs
- Dependency on Claude Code CLI behavior and flags
- `--dangerously-skip-permissions` is required for autonomous operation (must run in containers, never on bare metal)
- Token usage tracking from Claude Code output may need parsing
- If Claude Code changes its CLI interface, agents break

### Future Consideration
OpenHands SDK remains a potential migration target. Its MIT-licensed core (SDK, agent-server, Docker images) provides similar containerized execution with better observability. The `enterprise/` directory requires a paid license but we wouldn't need it. If we outgrow Claude Code's CLI-based approach, OpenHands SDK is the natural graduation path. Our agent CLAUDE.md files and orchestration service would remain unchanged — only the runner layer would swap.

---

## ADR-005: BYOK (Bring Your Own Key) Model

**Status:** Accepted  
**Date:** 2026-02-10

### Context
The platform needs LLM API access. We could provide API keys (and bill users), or let users bring their own.

### Decision
BYOK. Users provide their own Anthropic/OpenAI/etc. API keys in project config.

### Rationale
- Simpler billing model — we don't need to proxy or mark up API costs
- Users have full control over their spend
- No vendor lock-in concerns for users
- We don't need to handle API key security at scale (users manage their own)
- Users can use their own enterprise agreements with providers

### Tradeoffs
- Harder to offer a "just works" free trial
- Users see raw API costs, which can be confusing
- Can't optimize costs across users (batching, caching)
- Each user needs their own API account setup

---

## ADR-006: Three-Layer Configuration

**Status:** Accepted  
**Date:** 2026-02-10

### Context
Configuration needs to cover: what models to use, what budgets to enforce, what rules to follow, what integrations to connect. Different stakeholders control different levels.

### Decision
Three layers, each overriding the previous:

1. **Platform config** (`config/platform.yaml`) — System-wide defaults maintained by us. Default models, default budgets, mandatory rules, agent definitions.
2. **Project config** (`config/project.yaml`) — Per-project settings maintained by the user. Repo URL, API keys, model overrides, budget overrides, project-specific rules, integrations.
3. **Execution plan** (generated per task by orchestrator agent) — Per-task decisions. Which agents, what order, what context, where to put human gates.

### Rationale
Separation of concerns. Platform maintainers set safe defaults and mandatory rules. Project owners configure their specific environment and preferences. The orchestrator agent makes per-task tactical decisions within those constraints.

Critically: **credentials and budgets never appear in the plan**. The orchestrator agent decides "run the developer agent with this task." The service looks up the model, API key, and budget from layers 1+2 and injects them at container spawn time. The LLM never sees API keys.

---

## ADR-007: Agents Never See Credentials

**Status:** Accepted  
**Date:** 2026-02-10

### Context
Agent containers need API keys to call Claude. They also operate on codebases that may contain secrets.

### Decision
API keys are injected as environment variables at container spawn time by the orchestration service. The orchestrator agent's plan never contains credentials. Agent CLAUDE.md files never reference specific keys.

### Rationale
Security principle of least privilege. The orchestrator agent is an LLM — even though it's our LLM, its outputs shouldn't contain secrets. If a plan is logged, persisted, or displayed in a dashboard, it should be safe to read. Container-level injection means keys exist only in the runtime environment, not in any artifact.

---

## ADR-008: Scope Limited to Web Applications

**Status:** Accepted  
**Date:** 2026-02-10

### Context
The platform could theoretically support any kind of software (mobile, embedded, data pipelines, etc.). Broader scope means more agent types, more container configurations, more edge cases.

### Decision
V1 targets web applications only. Specifically: TypeScript/JavaScript, React/Next.js frontend, Node.js backend, PostgreSQL database, deployed to platforms like Vercel/Railway.

### Rationale
Focus. The agent CLAUDE.md files, container tooling, and default configurations are all optimized for this stack. Expanding to other platforms is a future iteration — the architecture supports it (add new agent definitions, new container images) but we don't attempt it yet.

---

## ADR-009: How This Differs From Existing Products

**Status:** Informational  
**Date:** 2026-02-10

### Landscape Analysis

| Product | What it does | What it doesn't do |
|---|---|---|
| **Devin** | Single AI engineer, takes tickets from Linear/Slack/Jira, writes code, creates PRs | No specialized agents, no separate QA/security review, no product analysis |
| **Cosine/Genie** | Multi-agent code generation, decomposes tickets into subtasks | Code-focused multi-agent only, no product/UX/security specialization |
| **OpenHands** | Open-source agent SDK, containerized execution, MCP support | Infrastructure toolkit, not a product-level SDLC orchestration |
| **Lovable/Bolt/v0** | Idea to prototype fast | No QA, no security, no architecture decisions, breaks on complex projects |
| **CrewAI/AutoGen** | General multi-agent orchestration frameworks | Not software-dev-specific, no built-in SDLC knowledge |
| **Claude Code/Cursor** | AI coding assistants | Single agent, developer-focused, no orchestration |

### Our Unique Position
We combine: (1) specialized role-based agents with domain expertise baked into CLAUDE.md files, (2) purpose-built SDLC orchestration with rules and human gates, (3) ticket source integration for real workflow fit, and (4) the hybrid service+agent architecture that balances reliability with flexibility. Nobody has stitched all four together.

---

## ADR-010: Human Review Gates Strategy

**Status:** Accepted  
**Date:** 2026-02-10

### Context
Full autonomy end-to-end will produce garbage without checkpoints. But too many gates slow everything down and defeat the purpose.

### Decision
Configurable gates with sensible defaults:
- **Mandatory** (enforced by service): P0 features always get human review after QA
- **Rule-based** (project config): e.g., "always review API changes"
- **Agent-suggested** (in plan): orchestrator agent can recommend gates for complex decisions
- **Auto-approve path**: for low-risk, well-tested changes, the system can skip optional gates

### Rationale
The target user (technical PM / small dev team) wants to operate like a tech lead — they make strategic calls, AI handles execution. Mandatory gates protect against catastrophic mistakes. Optional gates let the user tune the autonomy level to their comfort.

---

## ADR-011: Rework Loop Design

**Status:** Accepted  
**Date:** 2026-02-10

### Context
QA finds bugs. Security finds vulnerabilities. These need to route back to the developer agent with the right context.

### Decision
- When an agent returns `status: "needs_rework"`, the service increments a rework counter
- The service asks the orchestrator agent to plan the rework (it may route to a different agent than the one that failed)
- The service enforces a maximum rework cycle count (default: 3)
- If max rework exceeded, the service escalates to human with full context

### Rationale
Rework is where most autonomous systems fail — they either loop forever or give up too early. The circuit breaker (max 3 cycles) prevents infinite loops. The orchestrator agent deciding the rework strategy (not hardcoded) allows for nuanced handling — sometimes QA failure means the dev agent needs to fix code, sometimes it means the spec was wrong and the product agent needs to clarify.

---

## ADR-012: Cost Model and Estimation

**Status:** Accepted  
**Date:** 2026-02-10

### Context
A full task run involves multiple agent invocations, each consuming tokens.

### Estimated Cost Per Task
- Simple bug fix (developer + QA): ~700K tokens → ~$2-4
- Standard feature (developer + QA + maybe product): ~1.5M tokens → ~$5-10
- Complex feature (product + architect + developer + QA + security): ~2.5M tokens → ~$10-20
- Using Opus for any agent multiplies that agent's cost by ~5x

### Decision
Default budget of $25/task, configurable per project. Service tracks cumulative token usage and cost across all agents in a run. Hard stop if budget exceeded.

### Rationale
Cost predictability is important for BYOK users. Better to fail a task than silently spend $100 on a rework loop.

---

## ADR-013: Keep Guarded Codex CLI 401 Retry for `CODEX_HOME`

**Status:** Accepted  
**Date:** 2026-02-20

### Context
When Codex runs in `local_process` mode with workspace-scoped `CODEX_HOME`, some local auth states emit `401 Unauthorized: Missing bearer or basic authentication in header`. We needed to decide whether to keep the existing retry path or simplify by removing it.

### Decision
Keep the retry path with strict guardrails:
- Disabled by default; only enabled via `SPRINTFOUNDRY_ENABLE_CODEX_HOME_AUTH_FALLBACK=1`
- Trigger only when process exits non-zero and stderr includes the trusted auth-header 401 signature
- Retry exactly once without `CODEX_HOME`

### Alternatives Considered
- **Simplify to no retry:** cleaner code, but causes avoidable step failures for known local CLI auth edge cases.
- **Broaden retry trigger:** easier recovery, but increases spoofing and false-positive risk.

### Rationale
The guarded retry preserves operational compatibility for staged `CODEX_HOME` workflows while limiting security and behavior risk. Restricting the signal to stderr (not stdout) prevents model-output spoofing from influencing environment mutation. One retry keeps behavior bounded and predictable.

### Tradeoffs
- Additional implementation/test complexity in runtime security path
- Recovery behavior is opt-in, so users must know the flag for affected environments

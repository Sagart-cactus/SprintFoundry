# Architecture

## Overview

SprintFoundry is a service-orchestrated multi-agent execution system:

1. Fetches/normalizes a task from `linear`, `github`, `jira`, or `prompt`
2. Creates a per-run workspace
3. Clones the configured Git repository and creates a branch
4. Generates an execution plan via planner runtime
5. Validates/enforces rules on the plan
6. Executes steps (sequential or parallel groups)
7. Handles rework loops and optional human review gates
8. Emits events/logs and optionally creates a PR

Primary entrypoint: `src/service/orchestration-service.ts`

## Core Components

- `OrchestrationService` (`src/service/orchestration-service.ts`)
  - Main state machine for a run
  - Emits structured events
  - Manages step execution, rework, and review gates
- `PlannerRuntime` (`src/service/runtime/types.ts`)
  - Selected by `PlannerFactory`
  - Implementations:
    - `ClaudeCodePlannerRuntime` (Claude CLI local mode)
    - `CodexPlannerRuntime` (Codex CLI local mode)
    - `OrchestratorAgent` (Anthropic SDK mode for non-local planner runtime)
- `PlanValidator` (`src/service/plan-validator.ts`)
  - Enforces platform/project rules
  - Injects required agents/gates
- `AgentRunner` (`src/service/agent-runner.ts`)
  - Prepares workspace context
  - Selects and runs runtime implementation per step
- `RuntimeFactory` (`src/service/runtime/runtime-factory.ts`)
  - `claude-code` -> `ClaudeCodeRuntime`
  - `codex` -> `CodexRuntime`
- Integrations
  - `TicketFetcher` (`src/service/ticket-fetcher.ts`)
  - `GitManager` (`src/service/git-manager.ts`)
  - `NotificationService` (`src/service/notification-service.ts`)
  - `EventStore` (`src/service/event-store.ts`)

## Execution Data Model

Defined in `src/shared/types.ts`:

- `TaskRun` — lifecycle and aggregate state for one run
- `ExecutionPlan` / `PlanStep` — planner output + enforced plan
- `StepExecution` / `AgentResult` — per-step outcome
- `TaskEvent` — append-only event log rows

Run IDs are generated as:
- `run-${Date.now()}-${random}`

Workspace path pattern:
- `${os.tmpdir()}/sprintfoundry/<project_id>/<run_id>`

## Runtime Model

Step execution is process/CLI-driven, not SDK-driven:

- Codex runtime: `codex exec ... --json`
- Claude runtime: `claude -p ... --output-format json`
- Optional container execution for `claude-code` runtime mode

Each step writes runtime debug/log artifacts in workspace, including per-step files such as:
- `.codex-runtime.step-<n>.attempt-<m>.debug.json`
- `.claude-runtime.step-<n>.attempt-<m>.debug.json`

## Event and Log Persistence

- Global event log (optional): `<events_dir>/events.jsonl`
- Per-run event log: `<workspace>/.events.jsonl`
- Planner and runtime stdout/stderr persisted in run workspace

Monitor server reads these files directly (`monitor/server.mjs`).

## Concurrency Characteristics

- Parallelism is supported within a single run via `parallel_groups`
- Multiple runs can execute concurrently because each run uses an isolated workspace
- Branch naming collisions are still possible if two runs target the same ticket and branch strategy resolves to same name

# SprintFoundry vs Agent-Orchestrator: Comparison Summary

**Date**: 2026-02-27
**Compared against**: [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator)
**Full analysis**: [comparison-agent-orchestrator.md](./comparison-agent-orchestrator.md)

## Overview

SprintFoundry and agent-orchestrator solve related but fundamentally different problems in AI-powered software development:

- **SprintFoundry** orchestrates a **pipeline of specialized agents** (product → architect → developer → code-review → QA → security) to take a single ticket end-to-end through the entire SDLC.
- **Agent-orchestrator** manages a **fleet of parallel generic agents**, each working independently on separate issues with sophisticated session lifecycle management, CI/review reactions, and a real-time dashboard.

They are complementary rather than competing — SprintFoundry excels at deep, multi-step orchestration while agent-orchestrator excels at breadth, parallelism, and operational visibility.

---

## What SprintFoundry Does Better

### 1. Multi-Agent SDLC Pipeline
SprintFoundry runs a full software development pipeline: product analysis → architecture design → development → code review → QA testing → security audit. Each step has defined inputs, outputs, and dependencies. Agent-orchestrator has **no pipeline concept** — agents work independently on single issues.

### 2. AI-Generated Execution Plans with Validation
SprintFoundry's orchestrator agent generates a structured JSON execution plan for each ticket. The `PlanValidator` then enforces platform and project rules — injecting mandatory agents (e.g., QA always after dev), adding human review gates, remapping hallucinated agent IDs to real ones, and validating dependency coherence. Agent-orchestrator has **no plan generation or validation**.

### 3. 10 Specialized Agent Roles
Each agent has a detailed 200-300 line `CLAUDE.md` with role-specific instructions, required inputs/outputs, and domain expertise:
- Product, Architect, Developer, QA, Security, UI/UX, Code Review, DevOps, Go Developer, Go QA
- Agent-orchestrator uses only generic coding agents — no specialization.

### 4. Rule Engine
Platform and project rules with conditions (`classification_is`, `file_path_matches`, `priority_is`) and actions (`require_agent`, `require_human_gate`, `set_budget`). Agent-orchestrator has **no rule system**.

### 5. Rework Loops
Failed steps trigger `planRework()` which generates targeted fix plans using failure context and step history (max 2 cycles per step). Agent-orchestrator can only send a text message to an agent on CI failure.

### 6. Filesystem Message Bus
Structured artifact passing between agents via `.agent-context/`, `artifacts/`, and `artifacts/handoff/`. Agents read context from previous steps and write outputs for downstream consumers. Agent-orchestrator agents have **no inter-agent communication**.

### 7. Human Review Gates
Platform rules can inject mandatory human approval gates at specific pipeline stages. Agent-orchestrator has **no human-in-the-loop gates**.

### 8. Budget/Cost Enforcement
Per-agent token limits and per-task cost caps (USD) enforced at the service level. Agent-orchestrator parses costs from JSONL but has **zero enforcement**.

### 9. Quality Gates
Auto-runs lint/typecheck/test after developer steps, triggers rework on failure. Agent-orchestrator has **no quality validation**.

### 10. Checkpoint Commits
Each pipeline step auto-commits to git (excluding artifacts), creating a traceable history. Agent-orchestrator has **no checkpoint mechanism**.

---

## What Agent-Orchestrator Does Better

### 1. Plugin Architecture
8 swappable plugin slots with clean TypeScript interfaces. Every abstraction is swappable via `PluginModule` exports. SprintFoundry uses hardcoded service classes.

### 2. Session Management
Full session CRUD: spawn, list, get, kill, cleanup, send messages, restore crashed sessions. Persistent flat-file metadata survives restarts. SprintFoundry runs are fire-and-forget.

### 3. Reaction Engine
Auto-handles CI failures (send to agent), review comments (send to agent), auto-merge. Configurable retries + escalation. SprintFoundry creates a PR and stops.

### 4. Activity Detection
JSONL-based + terminal-based detection distinguishes active/ready/idle/waiting_input/blocked/exited. SprintFoundry treats agents as black boxes.

### 5. Git Worktree Isolation
Each session gets a lightweight git worktree (no full clone). SprintFoundry creates full temporary directories per run.

### 6. Web Dashboard
Next.js 15 with SSE streaming, session cards, CI/PR/review badges, attention zones, embedded terminal, one-click actions. SprintFoundry has a basic HTML monitor.

### 7. Notification Routing
Priority-based (urgent/action/warning/info) routing to multiple channels (desktop, slack, webhook). SprintFoundry's notification service is a skeleton.

### 8. Multi-Agent Runtime Support
4 AI coding tools via plugin interfaces: Claude Code, Codex, Aider, OpenCode. SprintFoundry supports Claude Code and Codex via hardcoded factory.

### 9. Testing Infrastructure
3,288 test cases across unit, integration, and e2e tests. SprintFoundry has minimal test coverage.

### 10. Metadata Auto-Update Hooks
PostToolUse hook auto-updates session metadata when agents run `gh pr create` or `git checkout -b`. SprintFoundry has no agent-level hooks.

---

## Improvement Roadmap

### Phase 1: Plugin Architecture
Replace hardcoded service classes with swappable plugins for workspace, tracker, SCM, and notifier. Create `PluginRegistry` for discovery and loading. Extract current implementations as default plugins.

### Phase 2: Session Management + Activity Detection
Add flat-file session persistence, CLI commands for listing/inspecting sessions, and JSONL-based activity detection. Make runs observable and interactive.

### Phase 3: Reaction Engine + Notifications
Add a lifecycle manager that monitors PRs post-creation. Trigger rework loops on CI failures and review comments. Route notifications by priority to multiple channels.

### Phase 4: Worktree Isolation + Parallel Execution
Replace full-clone workspace with git worktrees. Enable true parallel agent execution within a pipeline (agents with no dependencies run concurrently).

### Phase 5: Dashboard Upgrade
Add SSE streaming to the monitor. Real-time step updates, activity indicators, and session management from the browser.

### Phase 6: Test Infrastructure
Create test helpers (session factories, event factories, mock plugins). Target integration tests for new subsystems.

---

## Key Insight

The most impactful improvements are in **operational visibility** (session management, activity detection, dashboard) and **post-PR automation** (reaction engine, CI/review handling). These are areas where agent-orchestrator is significantly ahead, and where SprintFoundry users would benefit most.

SprintFoundry's core strengths — pipeline orchestration, plan validation, specialized agents, rework loops, and filesystem message bus — are unique differentiators that agent-orchestrator doesn't have. These should be preserved unchanged.

The ideal SprintFoundry would combine: **deep pipeline orchestration** (SprintFoundry's current strength) with **operational visibility and automated post-PR lifecycle** (agent-orchestrator's current strength).

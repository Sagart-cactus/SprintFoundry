# SprintFoundry vs Agent-Orchestrator: Detailed Comparison & Implementation Roadmap

**Date**: 2026-02-27
**Compared against**: [ComposioHQ/agent-orchestrator](https://github.com/ComposioHQ/agent-orchestrator) (MIT, 61 merged PRs, 3,288 tests)

---

## Overview

SprintFoundry and agent-orchestrator solve related but fundamentally different problems in AI-powered software development:

- **SprintFoundry** orchestrates a **pipeline of specialized agents** (product → architect → developer → code-review → QA → security) to take a single ticket end-to-end through the entire SDLC. Think: "one ticket, many agents in sequence."
- **Agent-orchestrator** manages a **fleet of parallel generic agents**, each working independently on separate issues with sophisticated session lifecycle management, CI/review reactions, and a real-time dashboard. Think: "many tickets, one agent each, in parallel."

They are complementary rather than competing — SprintFoundry excels at deep, multi-step orchestration while agent-orchestrator excels at breadth, parallelism, and operational visibility.

---

## What SprintFoundry Does Better

### 1. Multi-Agent SDLC Pipeline

SprintFoundry runs a full software development pipeline with DAG-based step dependencies:

```
product → architect → developer → code-review → QA → security
                          ↓ (failure)
                     rework loop
```

Each step has defined inputs, outputs, and dependencies in a structured `ExecutionPlan`:

```typescript
// src/shared/types.ts
interface PlanStep {
  step_number: number;
  agent: AgentType;           // "developer", "qa", "security", etc.
  task: string;               // natural language task description
  context_inputs: ContextInput[];  // ticket, files, step outputs, artifacts
  depends_on: number[];       // step numbers this depends on
  estimated_complexity: "low" | "medium" | "high";
}
```

The execution engine in `src/service/orchestration-service.ts:executePlan()` (line ~269) walks the DAG, respects dependencies, and handles parallel groups.

**Agent-orchestrator has no pipeline concept** — agents work independently on single issues. There's no way to chain agent → code-review → QA.

### 2. AI-Generated Execution Plans with Validation

SprintFoundry's orchestrator agent generates a structured JSON plan:

1. `PlannerRuntime.generatePlan()` (`src/service/runtime/`) calls Claude API with ticket details, agent catalog, and rules
2. `PlanValidator.validate()` (`src/service/plan-validator.ts`) enforces rules:
   - Injects mandatory agents (e.g., QA always after developer)
   - Adds human review gates when rules require them
   - Remaps hallucinated agent IDs to real agents via fuzzy matching
   - Validates dependency coherence

**Agent-orchestrator has no plan generation or validation.** The user manually decides what to work on.

### 3. 10 Specialized Agent Roles

Each agent has a detailed 200-300 line `CLAUDE.md` with role-specific instructions:

| Agent | Role | CLAUDE.md Location |
|-------|------|-------------------|
| developer | Full-stack implementation | `src/agents/developer/CLAUDE.md` |
| qa | Test writing & validation | `src/agents/qa/CLAUDE.md` |
| product | Product analysis & specs | `src/agents/product/CLAUDE.md` |
| architect | System design & ADRs | `src/agents/architect/CLAUDE.md` |
| security | Vulnerability scanning | `src/agents/security/CLAUDE.md` |
| ui-ux | Wireframes & component specs | `src/agents/ui-ux/CLAUDE.md` |
| code-review | Code quality review | `src/agents/code-review/CLAUDE.md` |
| devops | CI/CD & infrastructure | `src/agents/devops/CLAUDE.md` |
| go-developer | Go-specific development | `src/agents/go-developer/CLAUDE.md` |
| go-qa | Go-specific testing | `src/agents/go-qa/CLAUDE.md` |

Agent definitions in `config/platform.yaml` specify capabilities, required inputs, and output artifacts:

```yaml
agent_definitions:
  - type: developer
    name: Developer Agent
    role: developer
    capabilities: [code_generation, refactoring, testing, debugging]
    output_artifacts: [source_code, unit_tests]
    required_inputs: [ticket, architecture_spec]
```

**Agent-orchestrator uses only generic coding agents** (Claude Code, Codex, Aider, OpenCode) — no specialization.

### 4. Rule Engine

Platform and project rules with conditions and actions:

```yaml
# config/platform.yaml
rules:
  - id: mandatory-qa
    description: QA must run after any developer step
    condition: { type: always }
    action: { type: require_role, role: qa }
    enforced: true

  - id: security-on-auth
    description: Security review for auth-related changes
    condition: { type: file_path_matches, pattern: "**/auth/**" }
    action: { type: require_agent, agent: security }
    enforced: true

  - id: human-gate-on-p0
    description: Human review for P0 tickets
    condition: { type: priority_is, values: [p0] }
    action: { type: require_human_gate, after_agent: developer }
    enforced: true
```

Rule conditions (`src/shared/types.ts`):
- `always` — applies to every plan
- `classification_is` — matches task classification (new_feature, bug_fix, etc.)
- `label_contains` — matches ticket labels
- `file_path_matches` — matches file paths in the changeset
- `priority_is` — matches ticket priority

Rule actions:
- `require_agent` — inject a specific agent into the plan
- `require_role` — inject any agent with the specified role
- `require_human_gate` — add a mandatory human approval gate
- `set_model` — override model for a specific agent
- `set_budget` — override budget limits

**Agent-orchestrator has no rule system.**

### 5. Rework Loops

Failed steps trigger `planRework()` which generates targeted fix plans:

```typescript
// src/service/orchestration-service.ts (simplified)
if (result.status === "needs_rework" && reworkCount < maxReworkCycles) {
  const reworkPlan = await this.plannerRuntime.planRework(
    failedStep,       // which step failed
    result,           // the failure details
    stepHistory,      // what was already done
    workspacePath     // current state of the code
  );
  // Execute the rework plan (may involve different agents)
}
```

**Agent-orchestrator can only send a text message to an agent on CI failure** — no structured rework planning.

### 6. Filesystem Message Bus

Structured artifact passing between agents:

```
workspace/
  .agent-context/
    stack.json          # detected project stack (shared by all agents)
    ticket.json         # original ticket details
  artifacts/
    architecture.md     # architect agent output
    api-contracts.yaml  # architect agent output
    handoff/
      dev-to-qa.md     # developer → QA handoff notes
```

Each agent reads context from previous steps and writes outputs for downstream consumers. The `AgentRunner` prepares the workspace with:
- CLAUDE.md (agent instructions)
- Task file (what to do)
- Context inputs (artifacts from previous steps)

**Agent-orchestrator agents have no inter-agent communication.**

### 7. Human Review Gates

Rules can inject mandatory human approval gates:

```typescript
// src/shared/types.ts
interface HumanGate {
  after_step: number;
  reason: string;
  required: boolean; // false = can be auto-approved if confidence is high
}

interface HumanReview {
  review_id: string;
  run_id: string;
  after_step: number;
  status: "pending" | "approved" | "rejected";
  summary: string;
  artifacts_to_review: string[];
  reviewer_feedback?: string;
}
```

**Agent-orchestrator has no human-in-the-loop gates.**

### 8. Budget/Cost Enforcement

Per-agent token limits and per-task cost caps enforced at the service level:

```yaml
# config/platform.yaml
defaults:
  budgets:
    per_agent_tokens: 100000
    per_task_total_tokens: 500000
    per_task_max_cost_usd: 25.00
```

The `AgentRunner` passes `--max-budget-usd` to Claude Code and tracks `tokens_used` / `cost_usd` per step. The `OrchestrationService` sums totals and aborts if limits are exceeded.

**Agent-orchestrator has cost parsing from JSONL but zero enforcement.**

### 9. Quality Gates

Auto-runs lint/typecheck/test after developer steps. See `src/service/orchestration-service.ts:runQualityGates()`:

```typescript
// Runs after developer agent completes
const qualityResult = await this.runQualityGates(workspacePath, stack);
if (!qualityResult.passed) {
  // Trigger rework with quality failure context
}
```

**Agent-orchestrator has no quality validation.**

### 10. Checkpoint Commits

Each pipeline step auto-commits to git (excluding `.agent-context/` and `artifacts/`):

```typescript
// After each step succeeds
await this.git.commitStepChanges(workspacePath, stepNumber, agentType);
// Creates commit: "step-3: developer — Implement CSV export feature"
```

**Agent-orchestrator has no checkpoint mechanism.**

---

## What Agent-Orchestrator Does Better

### 1. Plugin Architecture

**The gap**: SprintFoundry uses hardcoded service classes:
```typescript
// src/service/orchestration-service.ts
constructor(platformConfig, projectConfig) {
  this.workspace = new WorkspaceManager(projectConfig);        // hardcoded
  this.tickets = new TicketFetcher(projectConfig.integrations); // hardcoded
  this.git = new GitManager(projectConfig.repo, ...);           // hardcoded
  this.notifications = new NotificationService(...);            // hardcoded
}
```

**Agent-orchestrator's approach**: 8 swappable plugin slots with clean TypeScript interfaces:

```typescript
// packages/core/src/types.ts (1087 lines)
interface PluginManifest {
  name: string;        // "tmux", "claude-code", "github"
  slot: PluginSlot;    // "runtime" | "agent" | "workspace" | "tracker" | "scm" | "notifier" | "terminal"
  description: string;
  version: string;
}

interface PluginModule<T = unknown> {
  manifest: PluginManifest;
  create(config?: Record<string, unknown>): T;
}

// Each slot has a clean interface, e.g.:
interface Workspace {
  readonly name: string;
  create(config: WorkspaceCreateConfig): Promise<WorkspaceInfo>;
  destroy(workspacePath: string): Promise<void>;
  list(projectId: string): Promise<WorkspaceInfo[]>;
  postCreate?(info: WorkspaceInfo, project: ProjectConfig): Promise<void>;
  exists?(workspacePath: string): Promise<boolean>;
  restore?(config: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo>;
}

interface Tracker {
  readonly name: string;
  getIssue(identifier: string, project: ProjectConfig): Promise<Issue>;
  isCompleted(identifier: string, project: ProjectConfig): Promise<boolean>;
  branchName(identifier: string, project: ProjectConfig): string;
  generatePrompt(identifier: string, project: ProjectConfig): Promise<string>;
  listIssues?(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]>;
  updateIssue?(identifier: string, update: IssueUpdate, project: ProjectConfig): Promise<void>;
}

interface SCM {
  readonly name: string;
  detectPR(session: Session, project: ProjectConfig): Promise<PRInfo | null>;
  getPRState(pr: PRInfo): Promise<PRState>;
  mergePR(pr: PRInfo, method?: MergeMethod): Promise<void>;
  getCIChecks(pr: PRInfo): Promise<CICheck[]>;
  getCISummary(pr: PRInfo): Promise<CIStatus>;
  getReviews(pr: PRInfo): Promise<Review[]>;
  getReviewDecision(pr: PRInfo): Promise<ReviewDecision>;
  getPendingComments(pr: PRInfo): Promise<ReviewComment[]>;
  getMergeability(pr: PRInfo): Promise<MergeReadiness>;
}

interface Notifier {
  readonly name: string;
  notify(event: OrchestratorEvent): Promise<void>;
  notifyWithActions?(event: OrchestratorEvent, actions: NotifyAction[]): Promise<void>;
  post?(message: string, context?: NotifyContext): Promise<string | null>;
}
```

Each plugin exports a standard shape:
```typescript
// packages/plugins/workspace-worktree/src/index.ts
export const manifest = {
  name: "worktree",
  slot: "workspace" as const,
  description: "Workspace plugin: git worktrees",
  version: "0.1.0",
};

export function create(): Workspace { /* ... */ }

export default { manifest, create } satisfies PluginModule<Workspace>;
```

Plugin discovery uses a `PluginRegistry`:
```typescript
interface PluginRegistry {
  register(plugin: PluginModule, config?: Record<string, unknown>): void;
  get<T>(slot: PluginSlot, name: string): T | null;
  list(slot: PluginSlot): PluginManifest[];
  loadBuiltins(config?: OrchestratorConfig): Promise<void>;
}
```

**Key reference files to study:**
- `packages/core/src/types.ts` — all 7 plugin interfaces
- `packages/core/src/plugin-registry.ts` — registry implementation
- `packages/plugins/workspace-worktree/src/index.ts` — worktree plugin
- `packages/plugins/tracker-github/src/index.ts` — GitHub tracker
- `packages/plugins/scm-github/src/index.ts` — SCM with CI/review/merge
- `packages/plugins/notifier-slack/src/index.ts` — Slack notifications

### 2. Session Management

**The gap**: SprintFoundry's `handleTask()` is fire-and-forget. No way to:
- List running/completed runs
- Inspect a run's current step
- Send a message to a running agent
- Resume a crashed run
- Clean up old workspaces

**Agent-orchestrator's approach**: Full session CRUD with flat-file persistence.

Session metadata persisted as key=value files:
```
# ~/.agent-orchestrator/{hash}-{projectId}/sessions/{sessionName}
project=integrator
issue=INT-100
branch=feat/INT-100
status=working
worktree=/Users/foo/.agent-orchestrator/a3b4c5d6e7f8-integrator/worktrees/int-1
createdAt=2026-02-17T10:30:00Z
pr=https://github.com/org/repo/pull/42
agent=claude-code
runtimeHandle={"id":"int-1","runtimeName":"tmux","data":{}}
```

Session manager interface:
```typescript
// packages/core/src/types.ts
interface SessionManager {
  spawn(config: SessionSpawnConfig): Promise<Session>;
  restore(sessionId: SessionId): Promise<Session>;
  list(projectId?: string): Promise<Session[]>;
  get(sessionId: SessionId): Promise<Session | null>;
  kill(sessionId: SessionId): Promise<void>;
  cleanup(projectId?: string, options?: { dryRun?: boolean }): Promise<CleanupResult>;
  send(sessionId: SessionId, message: string): Promise<void>;
}
```

Metadata read/write in `packages/core/src/metadata.ts`:
- `readMetadataRaw()` — parse key=value file to Record
- `writeMetadata()` — serialize and write
- `updateMetadata()` — merge updates (read → merge → write)
- `deleteMetadata()` — remove with optional archiving
- `reserveSessionId()` — atomic O_EXCL creation to prevent collisions
- `listMetadata()` — list all session files
- `readArchivedMetadataRaw()` — read from archive/ directory for restore

**Key reference files:**
- `packages/core/src/session-manager.ts` — 1110 lines, full CRUD
- `packages/core/src/metadata.ts` — 275 lines, flat-file persistence
- `packages/core/src/paths.ts` — hash-based directory structure

### 3. Reaction Engine

**The gap**: SprintFoundry creates a PR and stops. No automated response to CI failures, review comments, or merge readiness.

**Agent-orchestrator's approach**: A `LifecycleManager` with polling-based state machine and reaction engine.

Session status lifecycle:
```
spawning → working → pr_open → review_pending → approved → mergeable → merged
                        ↓                ↓
                    ci_failed      changes_requested
                        ↓                ↓
                  (reaction: fix)  (reaction: fix)
```

Reaction configuration:
```yaml
# agent-orchestrator.yaml
reactions:
  ci-failed:
    auto: true
    action: send-to-agent    # sends CI logs to the agent
    retries: 2               # try 2 times before escalating
    escalateAfter: 3         # escalate to human after 3 failures
  changes-requested:
    auto: true
    action: send-to-agent    # sends review comments to agent
    escalateAfter: 30m       # escalate after 30 minutes
  approved-and-green:
    auto: false              # flip to true for auto-merge
    action: notify
  agent-stuck:
    auto: true
    action: notify
    threshold: 10m           # stuck = no activity for 10 min
```

Lifecycle manager polling loop (`packages/core/src/lifecycle-manager.ts`):
```typescript
async function pollAll(): Promise<void> {
  const sessions = await sessionManager.list();
  for (const session of activeSessions) {
    const newStatus = await determineStatus(session); // polls SCM, runtime, agent
    if (newStatus !== oldStatus) {
      // State transition detected
      const eventType = statusToEventType(oldStatus, newStatus);
      const reactionKey = eventToReactionKey(eventType);
      if (reactionConfig.auto) {
        await executeReaction(sessionId, projectId, reactionKey, reactionConfig);
      }
    }
  }
}
```

The `determineStatus()` function checks:
1. Is runtime alive? (tmux session exists?)
2. Is agent process running? (ps check)
3. Has a PR been created? (SCM.detectPR)
4. What's the PR state? (open/merged/closed)
5. Is CI passing? (SCM.getCISummary)
6. What's the review decision? (SCM.getReviewDecision)
7. Is the PR mergeable? (SCM.getMergeability)

Notification routing by priority:
```yaml
notification_routing:
  urgent: [slack, desktop]    # stuck, needs_input, errored
  action: [slack]             # approved, merge ready
  warning: [webhook]          # CI failure, changes requested
  info: [webhook]             # session started, working
```

**Key reference files:**
- `packages/core/src/lifecycle-manager.ts` — 607 lines, full state machine + reactions
- `packages/core/src/types.ts` lines 697-787 — Event types, ReactionConfig
- `packages/plugins/scm-github/src/index.ts` — CI/review/merge implementation
- `packages/plugins/notifier-slack/src/index.ts` — Slack notifications

### 4. Activity Detection

**The gap**: SprintFoundry treats agents as black boxes during execution. No visibility into whether an agent is thinking, writing code, waiting for permission, stuck, or has exited.

**Agent-orchestrator's approach**: Reads Claude Code's internal JSONL session files.

```typescript
// packages/plugins/agent-claude-code/src/index.ts

// Convert workspace path to Claude's project directory
function toClaudeProjectPath(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/");
  return normalized.replace(/:/g, "").replace(/[/.]/g, "-");
}
// e.g. /Users/dev/.worktrees/ao → Users-dev--worktrees-ao
// Claude stores sessions at ~/.claude/projects/{encoded-path}/

// Find most recently modified .jsonl session file
async function findLatestSessionFile(projectDir: string): Promise<string | null> {
  const entries = await readdir(projectDir);
  const jsonlFiles = entries.filter(f => f.endsWith(".jsonl") && !f.startsWith("agent-"));
  // Sort by mtime descending, return newest
}

// Parse only the tail of large JSONL files (can be 100MB+)
async function parseJsonlFileTail(filePath: string, maxBytes = 131_072): Promise<JsonlLine[]> {
  const { size } = await stat(filePath);
  const offset = Math.max(0, size - maxBytes);
  // Read only last 128KB via file handle (not full file into memory)
  // Skip potentially truncated first line when reading from offset > 0
}

// Activity detection via JSONL last entry type
async getActivityState(session: Session): Promise<ActivityDetection | null> {
  const entry = await readLastJsonlEntry(sessionFile);
  switch (entry.lastType) {
    case "user":
    case "tool_use":
    case "progress":
      return { state: ageMs > threshold ? "idle" : "active" };
    case "assistant":
    case "summary":
    case "result":
      return { state: ageMs > threshold ? "idle" : "ready" };
    case "permission_request":
      return { state: "waiting_input" };
    case "error":
      return { state: "blocked" };
  }
}
```

Also extracts session summary and cost from JSONL:
```typescript
function extractSummary(lines: JsonlLine[]): { summary: string; isFallback: boolean } | null {
  // Last "summary" type entry, or fallback to first user message truncated to 120 chars
}

function extractCost(lines: JsonlLine[]): CostEstimate | undefined {
  // Aggregate inputTokens, outputTokens, costUSD from usage events
  // Estimates cost using Sonnet pricing when no direct cost data available
}
```

**Activity states**: `active` | `ready` | `idle` | `waiting_input` | `blocked` | `exited`

**Key reference files:**
- `packages/plugins/agent-claude-code/src/index.ts` — lines 196-383 (JSONL helpers), lines 646-703 (getActivityState)
- `packages/core/src/types.ts` — ActivityState, ActivityDetection types

### 5. Git Worktree Isolation

**The gap**: SprintFoundry's `WorkspaceManager` creates temp directories and does full `git clone`. Heavyweight and slow for parallel execution.

**Agent-orchestrator's approach**: Git worktrees — lightweight, shared `.git` directory.

```typescript
// packages/plugins/workspace-worktree/src/index.ts
async create(config: WorkspaceCreateConfig): Promise<WorkspaceInfo> {
  const worktreePath = join(worktreeBaseDir, config.sessionId);
  // Create branch from default branch
  await execFileAsync("git", ["-C", config.project.path, "branch", config.branch, config.project.defaultBranch]);
  // Create worktree at the path, checking out the branch
  await execFileAsync("git", ["-C", config.project.path, "worktree", "add", worktreePath, config.branch]);
  return { path: worktreePath, branch: config.branch, sessionId: config.sessionId, projectId: config.projectId };
}

async destroy(workspacePath: string): Promise<void> {
  await execFileAsync("git", ["worktree", "remove", workspacePath, "--force"]);
}

async restore(config: WorkspaceCreateConfig, workspacePath: string): Promise<WorkspaceInfo> {
  // Recreate worktree for an existing branch (after crash recovery)
  await execFileAsync("git", ["-C", config.project.path, "worktree", "add", workspacePath, config.branch]);
}
```

Worktrees are stored under `~/.agent-orchestrator/{hash}-{projectId}/worktrees/{sessionName}/`:
```
~/.agent-orchestrator/a3b4c5d6e7f8-integrator/
  sessions/
    int-1
    int-2
  worktrees/
    int-1/    ← lightweight worktree (shares .git)
    int-2/
```

**Benefits over full clone:**
- Nearly instant creation (no network, no copying .git)
- Shared git object store (saves disk)
- Easy cleanup (`git worktree remove`)
- Can have multiple worktrees from same repo simultaneously

**Key reference files:**
- `packages/plugins/workspace-worktree/src/index.ts` — worktree plugin
- `packages/plugins/workspace-clone/src/index.ts` — clone-based alternative
- `ARCHITECTURE.md` — directory structure and hash-based namespacing

### 6. Web Dashboard

**The gap**: SprintFoundry's monitor (`monitor/`) is basic vanilla HTML/JS that reads JSONL files with manual refresh. No real-time updates.

**Agent-orchestrator's approach**: Next.js 15 (App Router) + Tailwind dashboard.

Dashboard components:
```
packages/web/
  src/
    components/
      Dashboard.tsx       — Main layout with session grid
      SessionCard.tsx     — Per-session card with status, activity, PR
      SessionDetail.tsx   — Deep session view
      ActivityDot.tsx     — Animated activity indicator (green=active, yellow=idle, red=blocked)
      CIBadge.tsx         — CI status badges
      PRStatus.tsx        — PR state with links
      AttentionZone.tsx   — Groups sessions by urgency (needs response, merge ready, working, done)
      Terminal.tsx         — Embedded terminal (via WebSocket)
      DirectTerminal.tsx  — Direct tmux terminal access
    app/
      api/
        sessions/route.ts          — GET list sessions
        sessions/[id]/route.ts     — GET session details
        sessions/[id]/send/route.ts — POST send message to agent
        sessions/[id]/kill/route.ts — POST kill session
        sessions/[id]/restore/route.ts — POST restore session
        events/route.ts            — SSE event stream
        spawn/route.ts             — POST spawn new session
        prs/[id]/merge/route.ts    — POST merge PR
```

Real-time updates via Server-Sent Events:
```typescript
// packages/web/src/app/api/events/route.ts
export async function GET() {
  const stream = new ReadableStream({
    async start(controller) {
      // Poll lifecycle manager for state changes
      // Push SSE events to client
    }
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
}
```

**Key reference files:**
- `packages/web/src/components/Dashboard.tsx` — main dashboard
- `packages/web/src/components/SessionCard.tsx` — session card component
- `packages/web/src/app/api/events/route.ts` — SSE streaming
- `packages/web/server/terminal-websocket.ts` — terminal WebSocket

### 7. Notification Routing

**The gap**: SprintFoundry's `NotificationService` (`src/service/notification-service.ts`) is a skeleton.

**Agent-orchestrator's approach**: Priority-based routing with multiple notifier plugins.

Event priority levels: `urgent` | `action` | `warning` | `info`

Priority inference from event type:
```typescript
function inferPriority(type: EventType): EventPriority {
  if (type.includes("stuck") || type.includes("needs_input") || type.includes("errored")) return "urgent";
  if (type.includes("approved") || type.includes("ready") || type.includes("merged")) return "action";
  if (type.includes("fail") || type.includes("changes_requested")) return "warning";
  return "info";
}
```

Notifier plugins available:
- **Desktop** (`packages/plugins/notifier-desktop/src/index.ts`) — native OS notifications
- **Slack** (`packages/plugins/notifier-slack/src/index.ts`) — Slack webhook with rich formatting
- **Webhook** (`packages/plugins/notifier-webhook/src/index.ts`) — generic HTTP webhook
- **Composio** (`packages/plugins/notifier-composio/src/index.ts`) — Composio integration

Configuration:
```yaml
notifiers:
  slack:
    plugin: slack
    webhookUrl: ${SLACK_WEBHOOK_URL}
    channel: "#agent-updates"
  webhook:
    plugin: webhook
    url: ${WEBHOOK_URL}

notification_routing:
  urgent: [slack, desktop]
  action: [slack]
  warning: [webhook]
  info: [webhook]
```

### 8. Multi-Agent Runtime Support

**The gap**: SprintFoundry's `RuntimeFactory` (`src/service/runtime/runtime-factory.ts`) uses a switch statement to select between Claude Code and Codex.

**Agent-orchestrator's approach**: Agent plugins that implement a common interface.

```typescript
// packages/core/src/types.ts
interface Agent {
  readonly name: string;
  readonly processName: string;
  getLaunchCommand(config: AgentLaunchConfig): string;
  getEnvironment(config: AgentLaunchConfig): Record<string, string>;
  detectActivity(terminalOutput: string): ActivityState;
  getActivityState(session: Session): Promise<ActivityDetection | null>;
  isProcessRunning(handle: RuntimeHandle): Promise<boolean>;
  getSessionInfo(session: Session): Promise<AgentSessionInfo | null>;
  getRestoreCommand?(session: Session, project: ProjectConfig): Promise<string | null>;
  setupWorkspaceHooks?(workspacePath: string, config: WorkspaceHooksConfig): Promise<void>;
}
```

Four agent plugins:
- `packages/plugins/agent-claude-code/src/index.ts` — 786 lines
- `packages/plugins/agent-codex/src/index.ts`
- `packages/plugins/agent-aider/src/index.ts`
- `packages/plugins/agent-opencode/src/index.ts`

### 9. Testing Infrastructure

**The gap**: SprintFoundry has ~25 test files with minimal coverage.

**Agent-orchestrator**: 3,288 test cases across:
- Unit tests co-located with source (`*.test.ts`)
- Integration tests (`packages/integration-tests/src/`)
- E2E tests (`packages/web/e2e/`)
- Component tests (`packages/web/src/__tests__/components.test.tsx`)

Test helpers:
```
packages/integration-tests/src/helpers/
  session-factory.ts    — create mock sessions
  event-factory.ts      — create mock events
  polling.ts            — wait-for helpers
  tmux.ts               — tmux session management for tests
```

### 10. Metadata Auto-Update Hooks

**The gap**: SprintFoundry has no agent-level hooks for tracking state changes.

**Agent-orchestrator's approach**: Installs a Claude Code PostToolUse hook (`packages/plugins/agent-claude-code/src/index.ts` lines 31-167) that auto-updates session metadata:

```bash
# The hook script (.claude/metadata-updater.sh) detects:
# - gh pr create → extracts PR URL → updates metadata "pr" field
# - git checkout -b → extracts branch → updates metadata "branch" field
# - gh pr merge → updates metadata "status" to "merged"
```

Hook is installed via Claude Code's `.claude/settings.json`:
```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Bash",
      "hooks": [{
        "type": "command",
        "command": "/path/to/.claude/metadata-updater.sh",
        "timeout": 5000
      }]
    }]
  }
}
```

---

## Detailed Implementation Roadmap

### Phase 1: Plugin Architecture

**Goal**: Replace hardcoded service classes with swappable plugins for workspace, tracker, SCM, and notifier. Keep pipeline orchestration, plan validation, and agent running as core (non-pluggable) — these are SprintFoundry's differentiators.

**New files to create:**

#### `src/shared/plugin-types.ts` — Plugin interfaces

Define 4 pluggable interfaces (adapted from agent-orchestrator's patterns but tailored to SprintFoundry's needs):

```typescript
// Workspace plugin — manages code isolation
interface WorkspacePlugin {
  readonly name: string;
  create(runId: string, repoConfig: RepoConfig, branchStrategy: BranchStrategy, ticket: TicketDetails): Promise<WorkspaceInfo>;
  destroy(workspacePath: string): Promise<void>;
  commitStepChanges(workspacePath: string, stepNumber: number, agent: AgentType, message: string): Promise<void>;
  createPullRequest(workspacePath: string, run: TaskRun): Promise<string>;
  exists?(workspacePath: string): Promise<boolean>;
  restore?(workspacePath: string, branch: string): Promise<WorkspaceInfo>;
}

// Tracker plugin — ticket source integration
interface TrackerPlugin {
  readonly name: string;
  fetch(ticketId: string): Promise<TicketDetails>;
  updateStatus(ticket: TicketDetails, status: string, prUrl?: string): Promise<void>;
  isCompleted?(ticketId: string): Promise<boolean>;
}

// SCM plugin — post-PR lifecycle (NEW capability)
interface SCMPlugin {
  readonly name: string;
  detectPR(branch: string, repo: RepoConfig): Promise<PRInfo | null>;
  getPRState(pr: PRInfo): Promise<"open" | "merged" | "closed">;
  getCISummary(pr: PRInfo): Promise<"pending" | "passing" | "failing" | "none">;
  getReviewDecision(pr: PRInfo): Promise<"approved" | "changes_requested" | "pending" | "none">;
  getPendingComments(pr: PRInfo): Promise<ReviewComment[]>;
  getMergeability(pr: PRInfo): Promise<MergeReadiness>;
  mergePR(pr: PRInfo, method?: "merge" | "squash" | "rebase"): Promise<void>;
}

// Notifier plugin — notifications
interface NotifierPlugin {
  readonly name: string;
  notify(event: TaskEvent, priority: EventPriority): Promise<void>;
  notifyWithActions?(event: TaskEvent, actions: NotifyAction[]): Promise<void>;
}
```

#### `src/service/plugin-registry.ts` — Plugin discovery and loading

```typescript
interface PluginRegistry {
  register<T>(slot: PluginSlot, plugin: PluginModule<T>): void;
  get<T>(slot: PluginSlot, name: string): T | null;
  list(slot: PluginSlot): PluginManifest[];
  loadBuiltins(): void;
}
```

#### Plugin implementations (extract from existing code):

| New file | Extracted from | Purpose |
|----------|---------------|---------|
| `src/plugins/workspace-tmpdir/index.ts` | `src/service/workspace-manager.ts` + `src/service/git-manager.ts` | Current behavior: temp dir + full clone |
| `src/plugins/workspace-worktree/index.ts` | Port from agent-orchestrator | Git worktree isolation |
| `src/plugins/tracker-github/index.ts` | `src/service/ticket-fetcher.ts` (GitHub path) | GitHub Issues |
| `src/plugins/tracker-linear/index.ts` | `src/service/ticket-fetcher.ts` (Linear path) | Linear tickets |
| `src/plugins/tracker-jira/index.ts` | `src/service/ticket-fetcher.ts` (Jira path) | Jira tickets |
| `src/plugins/scm-github/index.ts` | New (reference `packages/plugins/scm-github/src/index.ts` from AO) | GitHub PR lifecycle, CI, reviews |
| `src/plugins/notifier-slack/index.ts` | `src/service/notification-service.ts` (Slack path) | Slack webhook |
| `src/plugins/notifier-webhook/index.ts` | New | Generic HTTP webhook |
| `src/plugins/notifier-desktop/index.ts` | New | OS native notifications |

**Files to modify:**

| File | Changes |
|------|---------|
| `src/service/orchestration-service.ts` | Constructor accepts `PluginRegistry`. Replace `this.workspace = new WorkspaceManager()` with `registry.get("workspace", config.workspace)`. Same for tracker, git, notifications. |
| `src/shared/types.ts` | Add `PluginManifest`, `PluginModule`, `PluginSlot`, `PRInfo`, `ReviewComment`, `MergeReadiness`, `EventPriority` types |
| `src/index.ts` | Initialize `PluginRegistry`, register builtins, pass to `OrchestrationService` |
| `config/platform.yaml` | Add `defaults.workspace: tmpdir`, `defaults.notifiers: [webhook]`, `defaults.scm: github` |

**What stays untouched**: `PlanValidator`, `AgentRunner`, all `CLAUDE.md` files, `RuntimeFactory`, `CodexSkillManager`, the planner runtime system.

---

### Phase 2: Session Management + Activity Detection

**Goal**: Make SprintFoundry runs observable and interactive. Persist run state for crash recovery and CLI introspection.

**New files to create:**

#### `src/service/session-manager.ts` — Run session persistence

```typescript
// Flat-file persistence modeled on agent-orchestrator's packages/core/src/metadata.ts
// Key differences from AO:
// - SprintFoundry sessions track pipeline steps, not just agent sessions
// - Session metadata includes: plan, current_step, completed_steps, total_cost, etc.

interface RunSessionMetadata {
  run_id: string;
  project_id: string;
  ticket_id: string;
  ticket_source: TaskSource;
  status: RunStatus;
  current_step: number;
  total_steps: number;
  plan_classification: string;
  workspace_path: string;
  branch: string;
  pr_url?: string;
  total_tokens: number;
  total_cost_usd: number;
  created_at: string;
  updated_at: string;
  error?: string;
}

// Stored at ~/.sprintfoundry/sessions/{run_id}
// Format: key=value (same as agent-orchestrator)

class SessionManager {
  persist(run: TaskRun): void;          // write/update flat file
  get(runId: string): TaskRun | null;   // read from flat file
  list(): TaskRun[];                     // list all sessions
  archive(runId: string): void;          // move to archive/
  getActivity(runId: string): ActivityState; // check agent activity
}
```

#### `src/service/activity-detector.ts` — Agent activity detection

Port from agent-orchestrator's `packages/plugins/agent-claude-code/src/index.ts`:

```typescript
// Key functions to port:
export function toClaudeProjectPath(workspacePath: string): string;
export async function findLatestSessionFile(projectDir: string): Promise<string | null>;
export async function parseJsonlFileTail(filePath: string, maxBytes?: number): Promise<JsonlLine[]>;
export async function getActivityState(workspacePath: string, thresholdMs?: number): Promise<ActivityDetection | null>;
export async function getSessionInfo(workspacePath: string): Promise<{ summary: string | null; cost: CostEstimate | null }>;
```

Activity states: `active` | `ready` | `idle` | `waiting_input` | `blocked` | `exited`

**Files to modify:**

| File | Changes |
|------|---------|
| `src/service/orchestration-service.ts` | Call `sessionManager.persist(run)` at every status transition (planning, executing, step started, step completed, etc.) |
| `src/index.ts` | Add CLI commands: `sessions` (list all), `session <id>` (show details + activity), `cancel <id>` |
| `src/shared/types.ts` | Add `ActivityState`, `ActivityDetection` types |

---

### Phase 3: Reaction Engine + Notifications

**Goal**: Close the biggest operational gap — after PR creation, automatically handle CI failures and review comments using SprintFoundry's rework loops (not just text messages like AO).

**New files to create:**

#### `src/service/lifecycle-manager.ts` — Post-PR state machine + reaction engine

```typescript
// Modeled on packages/core/src/lifecycle-manager.ts from AO
// Key SprintFoundry-specific enhancement: reactions trigger planRework(), not just text messages

interface LifecycleManager {
  start(intervalMs?: number): void;    // start polling loop (default 30s)
  stop(): void;
  check(runId: string): Promise<void>; // force-check one run
}

// The polling loop:
async function pollAll(): Promise<void> {
  const runs = sessionManager.list().filter(r => r.status === "completed" && r.pr_url);
  for (const run of runs) {
    const prInfo = await scmPlugin.detectPR(run.branch, project.repo);
    if (!prInfo) continue;

    const prState = await scmPlugin.getPRState(prInfo);
    if (prState === "merged") { /* mark done, clean up */ continue; }

    const ciStatus = await scmPlugin.getCISummary(prInfo);
    if (ciStatus === "failing") {
      // SprintFoundry-specific: trigger full rework loop
      const failureContext = await scmPlugin.getCIChecks(prInfo);
      const reworkPlan = await plannerRuntime.planRework(lastStep, failureResult, stepHistory, workspacePath);
      await executePlan(run, reworkPlan, workspacePath);
    }

    const reviewDecision = await scmPlugin.getReviewDecision(prInfo);
    if (reviewDecision === "changes_requested") {
      const comments = await scmPlugin.getPendingComments(prInfo);
      // Trigger rework with review comment context
    }

    if (reviewDecision === "approved" && ciStatus === "passing") {
      const mergeability = await scmPlugin.getMergeability(prInfo);
      if (mergeability.mergeable) {
        await notificationRouter.notify("merge.ready", run, "action");
      }
    }
  }
}
```

#### `src/service/notification-router.ts` — Priority-based routing

```typescript
class NotificationRouter {
  constructor(
    private plugins: Map<string, NotifierPlugin>,
    private routing: Record<EventPriority, string[]>
  ) {}

  async notify(eventType: string, run: TaskRun, priority: EventPriority): Promise<void> {
    const notifierNames = this.routing[priority] ?? [];
    await Promise.allSettled(
      notifierNames.map(name => this.plugins.get(name)?.notify(event, priority))
    );
  }
}
```

**Files to modify:**

| File | Changes |
|------|---------|
| `config/platform.yaml` | Add `reactions` and `notification_routing` config sections |
| `src/service/orchestration-service.ts` | Start `LifecycleManager` after PR creation. Pass plannerRuntime to lifecycle manager for rework triggers. |
| `src/shared/types.ts` | Add `ReactionConfig`, `EventPriority`, `PRInfo`, `CICheck`, `CIStatus`, `ReviewDecision`, `ReviewComment`, `MergeReadiness` types |
| `src/index.ts` | Start lifecycle manager in background when service starts |

**Reaction configuration for platform.yaml:**
```yaml
reactions:
  ci-failed:
    auto: true
    action: trigger-rework    # SprintFoundry-specific: full rework pipeline
    retries: 2
    escalateAfter: 3
  changes-requested:
    auto: true
    action: trigger-rework    # Uses planRework() with review comment context
    retries: 1
    escalateAfter: 30m
  approved-and-green:
    auto: false
    action: notify
    priority: action
  agent-stuck:
    auto: true
    action: notify
    priority: urgent
    threshold: 10m

notification_routing:
  urgent: [slack, desktop]
  action: [slack]
  warning: [webhook]
  info: [webhook]
```

**Key differentiator over agent-orchestrator**: AO's reaction to CI failure is "send text message to running agent." SprintFoundry's reaction is `trigger-rework` which invokes the full rework planning pipeline (`plannerRuntime.planRework()`) with structured failure context, step history, and workspace state.

---

### Phase 4: Worktree Isolation + Parallel Execution

**Goal**: Replace full-clone workspace with git worktrees. Enable true parallel agent execution within a pipeline.

**Implementation details:**

#### `src/plugins/workspace-worktree/index.ts`

Port the worktree plugin from agent-orchestrator (`packages/plugins/workspace-worktree/src/index.ts`), adapted for SprintFoundry's needs:

```typescript
// Key differences from AO's worktree plugin:
// 1. SprintFoundry needs a single worktree per run (not per-session)
// 2. Must support checkpoint commits (commitStepChanges)
// 3. Must handle the .agent-context/ and artifacts/ directories

class WorktreeWorkspacePlugin implements WorkspacePlugin {
  async create(runId: string, repoConfig: RepoConfig, branchStrategy: BranchStrategy, ticket: TicketDetails): Promise<WorkspaceInfo> {
    // The repo must already be cloned locally at repoConfig.local_path
    const branch = generateBranchName(branchStrategy, ticket);
    const worktreePath = join(WORKTREE_BASE, runId);

    await execFileAsync("git", ["-C", repoConfig.local_path, "branch", branch, repoConfig.default_branch]);
    await execFileAsync("git", ["-C", repoConfig.local_path, "worktree", "add", worktreePath, branch]);

    return { path: worktreePath, branch };
  }
}
```

#### Enable parallel execution in `orchestration-service.ts`

The existing `executePlan()` already identifies `parallel_groups` in the plan. Currently it runs them sequentially. Change to:

```typescript
// Current (sequential)
for (const step of parallelGroup) {
  await this.executeStep(run, step, workspacePath);
}

// New (parallel) — each step gets its own sub-worktree
const results = await Promise.allSettled(
  parallelGroup.map(async (step) => {
    const subWorktree = await this.workspace.createSubWorktree(workspacePath, step.step_number);
    const result = await this.executeStep(run, step, subWorktree);
    await this.workspace.mergeSubWorktree(workspacePath, subWorktree);
    return result;
  })
);
```

**Files to modify:**

| File | Changes |
|------|---------|
| `src/service/orchestration-service.ts` | Replace sequential parallel group loop with `Promise.allSettled` using sub-worktrees |
| `config/project.example.yaml` | Add `workspace: worktree` option with docs |
| `config/platform.yaml` | Add `defaults.workspace: tmpdir` |

**Prerequisite**: Phase 1 (plugin architecture) must be done first.

---

### Phase 5: Dashboard Upgrade — SSE Event Streaming

**Goal**: Upgrade the monitor from poll-based JSONL reading to real-time SSE streaming with richer UI.

**Files to modify:**

#### `monitor/server.mjs` — Add SSE endpoint

```javascript
// New endpoint: /api/events/stream
app.get("/api/events/stream", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // Watch the events JSONL file for changes
  const watcher = fs.watch(eventsFile, () => {
    const newEvents = readNewEvents(lastOffset);
    for (const event of newEvents) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  });

  req.on("close", () => watcher.close());
});
```

#### `monitor/public-v3/app.js` — Consume SSE

```javascript
// Replace polling with SSE
const eventSource = new EventSource("/api/events/stream");
eventSource.onmessage = (event) => {
  const data = JSON.parse(event.data);
  updateUI(data);
};
```

#### New dashboard features to add:

1. **Activity indicators** — Green dot (active), yellow dot (idle), red dot (blocked), pulsing (waiting_input)
2. **Step progress bar** — Shows completed/running/pending steps in the pipeline
3. **Cost tracker** — Running total with budget visualization
4. **Session controls** — Cancel button, view logs, send message

**New components needed:**
- `monitor/public-v3/components/activity-dot.js` — Activity state indicator
- `monitor/public-v3/components/step-progress.js` — Pipeline step tracker
- `monitor/public-v3/components/cost-badge.js` — Cost display with budget %

---

### Phase 6: Test Infrastructure

**Goal**: Build comprehensive tests for the new subsystems.

**New files to create:**

#### Test helpers (model on agent-orchestrator's `packages/integration-tests/src/helpers/`)

| File | Purpose |
|------|---------|
| `tests/helpers/session-factory.ts` | Create mock `TaskRun` objects with realistic data |
| `tests/helpers/event-factory.ts` | Create mock `TaskEvent` objects |
| `tests/helpers/plugin-mocks.ts` | Mock implementations of all 4 plugin interfaces |
| `tests/helpers/fixture-workspace.ts` | Create temporary git repos for workspace testing |

#### Integration tests

| File | Tests |
|------|-------|
| `tests/integration/plugin-registry.test.ts` | Register/get/list plugins, slot conflicts, missing plugins |
| `tests/integration/session-manager.test.ts` | Persist/read/list/archive sessions, flat-file format, crash recovery |
| `tests/integration/lifecycle-manager.test.ts` | State transitions, reaction triggers, escalation, notification routing |
| `tests/integration/activity-detector.test.ts` | JSONL parsing, activity state detection, cost extraction |
| `tests/integration/workspace-worktree.test.ts` | Create/destroy/restore worktrees, parallel sub-worktrees |
| `tests/integration/notification-router.test.ts` | Priority routing, multi-channel, failure handling |
| `tests/integration/scm-github.test.ts` | PR detection, CI status, review decision, merge readiness |

#### Unit tests for new modules

| File | Tests |
|------|-------|
| `tests/unit/metadata.test.ts` | Parse/serialize key=value format, update merge, atomic reserve |
| `tests/unit/notification-router.test.ts` | Priority inference, routing config |
| `tests/unit/activity-detector.test.ts` | JSONL tail parsing, activity state classification |

---

## Summary Table: What To Build, Where To Look

| SprintFoundry Gap | Agent-Orchestrator Reference | Priority |
|---|---|---|
| Hardcoded services | `packages/core/src/types.ts` (plugin interfaces), `packages/core/src/plugin-registry.ts` | Phase 1 |
| Fire-and-forget runs | `packages/core/src/session-manager.ts`, `packages/core/src/metadata.ts` | Phase 2 |
| Black-box agents | `packages/plugins/agent-claude-code/src/index.ts` (lines 196-703) | Phase 2 |
| No post-PR automation | `packages/core/src/lifecycle-manager.ts` | Phase 3 |
| Skeleton notifications | `packages/plugins/notifier-slack/src/index.ts`, `packages/plugins/notifier-webhook/src/index.ts` | Phase 3 |
| Heavy workspace clone | `packages/plugins/workspace-worktree/src/index.ts`, `ARCHITECTURE.md` | Phase 4 |
| Polling-based monitor | `packages/web/src/app/api/events/route.ts`, `packages/web/src/components/` | Phase 5 |
| Minimal testing | `packages/integration-tests/src/helpers/`, all `*.test.ts` files | Phase 6 |

---

## Files That Must NOT Be Changed

These are SprintFoundry's core differentiators. They stay untouched:

| File | Why |
|------|-----|
| `src/service/plan-validator.ts` | Rule engine with mandatory agent injection — AO has nothing like this |
| `src/service/runtime/` (entire directory) | Planner runtime abstraction (Claude API + Codex) — AO doesn't generate plans |
| `src/service/agent-runner.ts` | Agent spawning with CLAUDE.md prep, result reading — SprintFoundry-specific |
| `src/agents/*/CLAUDE.md` (all 10 files) | Specialized agent instructions — AO uses generic agents |
| `config/platform.yaml` rules section | Platform and project rule definitions — unique to SprintFoundry |
| `src/service/runtime-session-store.ts` | Runtime session/resume tracking for rework |
| The `.agent-context/` / `artifacts/` / `.agent-result.json` pattern | Filesystem message bus between agents |

---

## Key Insight

The ideal SprintFoundry combines:
- **Deep pipeline orchestration** (SprintFoundry's current strength): specialized agents, execution plans, rule validation, rework loops, human gates, quality gates
- **Operational visibility and automation** (agent-orchestrator's current strength): plugin architecture, session management, activity detection, reaction engine, real-time dashboard, priority-based notifications

SprintFoundry's pipeline orchestration is something agent-orchestrator simply cannot do — it would require a fundamental redesign of their architecture. But agent-orchestrator's operational features (session management, reactions, activity detection) are additive improvements that enhance SprintFoundry without changing its core design.

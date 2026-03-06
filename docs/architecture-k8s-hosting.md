# SprintFoundry Kubernetes Hosting Architecture

> Reference architecture for hosting SprintFoundry at scale (1000s of runs, 100s of projects).
> See GitHub issues labeled `epic:k8s-hosting` for the phased implementation plan.
> This document is the architecture reference for issues #65 through #78.

Scope checklist in this document:
- Dual-mode design principle
- Platform recommendation
- Container image strategy
- Run pod model
- Run lifecycle
- Workspace and storage
- Credential management
- Event/log pipeline
- Custom skill injection
- Single-step agent runs
- Webhook architecture
- Scaling and scheduling
- Network architecture
- What changes vs preserved
- Migration path
- Cost model

---

## 0. Core Design Principle: Dual-Mode (Local + K8s)

SprintFoundry must work out of the box in both local development and Kubernetes deployment. **No code forks, no separate builds.** The same binary, same image, same config schema.

### The Switch: One Environment Variable

```
SPRINTFOUNDRY_EVENT_SINK_URL  (unset = local mode, set = distributed mode)
```

When unset, everything works exactly as today — JSONL files, local sessions, filesystem-based monitor, CLI-triggered runs. When set, the system additionally streams events/state to a central API.

### Dual-Mode Behavior By Component

| Component | Local (default) | Distributed (`EVENT_SINK_URL` set) |
|-----------|----------------|-------------------------------------|
| **EventStore** | JSONL to workspace | JSONL + HTTP POST to central API |
| **SessionManager** | `~/.sprintfoundry/sessions/*.json` | Local file + POST to central API |
| **Monitor** | Reads workspace files (existing `server.mjs`) | Reads from Postgres + Redis SSE |
| **Triggers** | CLI only (`sprintfoundry run`) | CLI + Dispatch Controller API + webhooks → K8s Jobs |
| **Credentials** | Shell env vars / `.env` | K8s Secrets (arrive as same env vars) |
| **Skills** | Local `plugins/` directory | Baked in image + ConfigMap mounts (same resolution logic) |
| **Workspace** | tmpdir or worktree on local disk | EmptyDir in pod (same tmpdir strategy) |
| **Agent execution** | `local_process` (child process) | Same `local_process` inside run pod |

### What Is Identical In Both Modes

These components have **zero awareness** of where they're running:
- `OrchestrationService.handleTask()` — same flow
- `AgentRunner` + all runtimes (claude-code, codex) — same process spawning
- `PlanValidator` — same rule enforcement
- `CodexSkillManager` — same skill resolution, staging, guardrails
- Agent CLAUDE.md files — same instructions
- Filesystem message bus (`artifacts/`, `.agent-result.json`) — same within workspace
- Git operations (clone, branch, commit, push, PR) — same
- Budget enforcement — same
- OpenTelemetry metrics — same (OTLP exporter doesn't care about destination)

### Implementation Rule

Every change must preserve local-mode compatibility. If `SPRINTFOUNDRY_EVENT_SINK_URL` is not set and no Postgres/Redis is running, the system must behave exactly as the current codebase does today. No regressions.

---

## 1. Recommended Platform: Kubernetes (Jobs)

SprintFoundry runs are batch workloads: start, execute 3-8 agent steps over 5-60 minutes, terminate. K8s Jobs are purpose-built for this.

| Platform | Verdict | Key Trade-off |
|----------|---------|---------------|
| **Kubernetes** | **Recommended** | Best Job abstraction, auto-scaling (Karpenter), native secrets, namespace isolation per project |
| ECS Fargate | Viable alternative | Simpler ops, but 1000-task default limit, no native Job abstraction, EFS-only volumes (slow) |
| VMs | Not recommended at scale | No auto-scaling, manual scheduling, hard to isolate runs |

**Why K8s wins for 1000s of runs**: Karpenter provisions spot nodes in seconds. Namespace ResourceQuotas give natural multi-tenancy. ExternalSecrets Operator handles BYOK credential rotation. The Job TTL controller cleans up completed runs automatically.

---

## 2. Container Image Strategy

### Single unified image: `sprintfoundry-runner`

```
node:22-slim
├── System: git, jq, curl, openssh-client
├── Runtimes: claude-code CLI, codex CLI
├── SprintFoundry: compiled dist/, agents/, plugins/, platform.yaml
└── ENTRYPOINT: node dist/index.js
```

**What's baked in vs. injected at runtime:**

| Baked into image | Injected at runtime (env/volume) |
|------------------|----------------------------------|
| Node.js, git, Claude CLI, Codex CLI | API keys (K8s Secrets) |
| SprintFoundry compiled code + all agent CLAUDE.md files | Project config YAML (ConfigMap) |
| Platform config defaults, standard plugins | Git SSH keys / tokens |
| | Custom agent definitions (ConfigMap, optional) |

### Why one image, not per-agent images

The current `containers/developer.Dockerfile`, `containers/qa.Dockerfile` etc. become unnecessary. The orchestration service already selects the right CLAUDE.md per agent and configures the runtime — it doesn't need different images. Agent-specific tooling (linters, test runners) gets installed by the agent in the workspace or already exists in the cloned repo. This simplifies CI (one image to build/scan/push) and cache efficiency.

**Exception**: If specific agents need heavy pre-installed tooling (Playwright browsers for QA, Trivy for security), create 2-3 variant images max, selected via `runtimeConfig.image` override.

---

## 3. Run Architecture: "Run Pod" Model

Each run gets **a single K8s Job (pod)** that runs the entire orchestration + all agent steps internally.

### Why not one pod per agent step?

SprintFoundry's filesystem-as-message-bus architecture requires all agents to share a workspace (`artifacts/`, `.agent-result.json`, `.agent-context/`). Separate pods per step would need a shared PersistentVolume (adds latency, scheduling constraints, I/O contention). The orchestration service is lightweight (just API calls + subprocess management) — no benefit to keeping it separate. Pod scheduling overhead (30-60s) per step would double run time.

### Three Long-Lived Components + Ephemeral Run Pods

```
┌─────────────────────────────────────────────────────────┐
│                    Kubernetes Cluster                     │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Dispatch    │  │   Monitor    │  │  Event API   │  │
│  │  Controller   │  │  Dashboard   │  │  (Ingestion) │  │
│  │ (Deployment)  │  │ (Deployment) │  │ (Deployment) │  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  │
│         │                  │                  │          │
│         │          ┌───────┴────────┐         │          │
│         │          │   Postgres     │─────────┘          │
│         │          │   + Redis      │                    │
│         │          └────────────────┘                    │
│         │                                                │
│         ▼ creates K8s Jobs                               │
│  ┌─────────────────────────────────────────────┐        │
│  │          Run Pods (K8s Jobs)                  │        │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │        │
│  │  │ Run-A   │ │ Run-B   │ │ Run-C   │ ...   │        │
│  │  │(project1)│ │(project2)│ │(project1)│       │        │
│  │  └─────────┘ └─────────┘ └─────────┘       │        │
│  │  (ephemeral, auto-scaled via Karpenter)      │        │
│  └─────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### Run Lifecycle (Trigger → PR)

```
1. Trigger arrives (webhook, API call, or CLI)
         │
2. Dispatch Controller
   ├─ Validates request, deduplicates (existing autoexecute logic)
   ├─ Checks project quota (max concurrent runs per project)
   ├─ Checks project budget (daily/monthly spend tracked in Postgres)
   ├─ Enqueues to Redis queue: sprintfoundry:dispatch:{project_id}
         │
3. Queue Consumer (in Dispatch Controller)
   ├─ Pops from queue when under quota
   ├─ Creates K8s Job manifest:
   │   ├─ Image: sprintfoundry-runner:latest
   │   ├─ Env: run_id, ticket_id, project_id, SPRINTFOUNDRY_EVENT_SINK_URL
   │   ├─ Secret mount: project credentials (API keys, git tokens)
   │   ├─ ConfigMap mount: project config YAML
   │   ├─ Volume: EmptyDir for workspace (10Gi limit)
   │   └─ Resources: 500m CPU request, 2 CPU limit, 1Gi/4Gi memory
   └─ Submits Job to K8s API in project namespace
         │
4. Run Pod starts
   ├─ sprintfoundry run --source {source} --ticket {id} --config /config/project.yaml
   ├─ Git clone into EmptyDir workspace (shallow clone, ~10-30s)
   ├─ Orchestrator LLM generates plan (unchanged)
   ├─ Plan validated against rules (unchanged)
   ├─ Steps execute sequentially/parallel as local_process (unchanged)
   ├─ Events emitted to central store via HTTP POST (NEW)
   ├─ Agent artifacts flow via filesystem within pod (unchanged)
         │
5. Run completes
   ├─ PR created via GitHub API (unchanged)
   ├─ Debug artifacts uploaded to S3 (NEW)
   ├─ Final event emitted: task.completed / task.failed
   └─ Pod terminates, Job marked complete, K8s TTL cleans up
```

---

## 4. Workspace & Storage

### EmptyDir (ephemeral per pod)

```yaml
volumes:
  - name: workspace
    emptyDir:
      sizeLimit: 10Gi
```

- Each run gets a pod-local EmptyDir volume
- Use **tmpdir** workspace strategy (full shallow clone), not worktree — worktree needs a persistent bare clone which adds scheduling constraints
- Clone time: 10-30s for most repos with `--depth 50` (already in GitManager)
- Parallel steps: use sub-worktrees within the pod's EmptyDir (existing logic in `executePlan()` works unchanged)
- Artifact passing between agents: filesystem bus (`artifacts/`, `.agent-result.json`) works unchanged within the pod

### Post-Run Artifact Retention

After run completes and before pod exits, upload to S3:
- `.sprintfoundry/step-results/` (per-step execution snapshots)
- Runtime logs (`.claude-runtime.*.log`, `.codex-runtime.*.log`)
- `artifacts/` directory (agent outputs)

The PR itself is the durable record of code changes. Events/results are in Postgres.

---

## 5. Credential Management

### ExternalSecrets Operator → AWS Secrets Manager (or Vault)

```
AWS Secrets Manager / Vault
         │
ExternalSecrets Operator (K8s controller)
         │
K8s Secret (per project namespace)
         │
Run Pod env vars
```

### Per-Project Secrets

Each project stores keys at `sprintfoundry/projects/{project_id}/`:
- `ANTHROPIC_API_KEY` — for Claude Code agents
- `OPENAI_API_KEY` — for Codex agents
- `GITHUB_TOKEN` — for PR creation, repo access
- `GIT_SSH_KEY` — for private repo cloning
- Webhook secrets, notification tokens, etc.

### How BYOK maps

The current model (`project.yaml` has `api_keys.anthropic: ${ANTHROPIC_API_KEY}`) maps cleanly:
1. Project's API keys stored in secrets backend
2. ExternalSecrets syncs to K8s Secret in project namespace
3. Dispatch Controller mounts Secret as env vars on run pod
4. Existing env var interpolation in config-loader resolves them

**No code changes needed to AgentRunner** — API keys already flow as env vars (`ANTHROPIC_API_KEY: config.apiKey` at `agent-runner.ts:487`).

---

## 6. Event/Log Pipeline (Most Significant Change)

### The Problem

The current monitor reads JSONL files, session JSON, runtime logs, and step results directly from workspace directories on the local filesystem. With ephemeral run pods on different nodes, these filesystem paths don't exist on the monitor's host.

### The Solution: Central Event Store

#### 6a. Database Schema (Postgres)

```sql
-- runs table
runs:           run_id, project_id, ticket_id, status, plan (JSONB),
                total_tokens, total_cost_usd, pr_url, created_at, ...

-- events table
events:         event_id, run_id, event_type, timestamp, data (JSONB)
                [indexed by run_id + timestamp]

-- step results
step_results:   run_id, step_number, step_attempt, agent, status,
                result (JSONB), runtime_metadata (JSONB), tokens, cost

-- runtime logs
run_logs:       run_id, log_kind, step_number, content, created_at
```

#### 6b. Event Emission from Run Pods

Modify `EventStore` to support dual-write mode:

```
EventStore.store(event)
  ├─ Write to local JSONL (existing, for local dev compatibility)
  └─ POST to SPRINTFOUNDRY_EVENT_SINK_URL (new, for distributed mode)
```

When `SPRINTFOUNDRY_EVENT_SINK_URL` is not set, everything works exactly as today. **Backwards compatible.**

#### 6c. Internal Event Ingestion API

```
POST /api/internal/events        ← Run pods emit TaskEvents
POST /api/internal/runs          ← Run pods create/update run records
POST /api/internal/step-results  ← Run pods post step results
POST /api/internal/logs          ← Run pods stream log chunks
```

Authenticated via service account token injected into pods.

#### 6d. Real-Time SSE Streaming

```
Run Pod → HTTP POST → Event Ingestion API
                              │
                    ┌─────────┴─────────┐
                    │                   │
              Postgres (persist)   Redis Pub/Sub
                                        │
                              Monitor Server subscribes
                                        │
                              SSE → Browser
```

Replaces the current `watchFile()` approach in `server.mjs` with push-based pub/sub that works across machines.

#### 6e. Monitor Server Changes

| API Endpoint | Current Source | New Source |
|-------------|----------------|------------|
| `GET /api/runs` | Scan workspace directories | `SELECT * FROM runs` |
| `GET /api/events` | Read `.events.jsonl` | `SELECT * FROM events WHERE run_id = $1` |
| `GET /api/log` | Read `.claude-runtime.*.log` | `SELECT * FROM run_logs` |
| `GET /api/step-result` | Read `.agent-result.json` | `SELECT * FROM step_results` |
| `GET /api/events/stream` | `watchFile()` on JSONL | Redis Pub/Sub subscription |

Frontend (Vue app in `monitor/public-v3/`) needs minimal changes — same API shape, just backed by Postgres.

---

## 7. Custom Skill & Plugin Injection

### What's Baked Into the Image vs. Injected

| Skill Type | Strategy | How |
|-----------|----------|-----|
| **Standard plugins** (`plugins/code-review/`, `plugins/language-detection/`, etc.) | Baked into image | Copied at build time to `/opt/sprintfoundry/plugins/` |
| **Platform skill catalog** (skills defined in `platform.yaml`) | Baked into image | Part of the config layer in the image |
| **Project-specific skills** (custom skills via `skill_catalog_overrides` or `skill_sources`) | Injected at runtime | ConfigMap volume mount or OCI artifact init container |
| **Repo-native skills** (`.agents/skills/`, `.claude/skills/` in the target repo) | Auto-discovered after git clone | No change needed |

### Injecting Project-Specific Skills

**Option A (Recommended): ConfigMap volume mount** — mounted at `/opt/custom-skills/{skill-name}/`, project config references via `skill_sources`.

**Option B: OCI artifact registry** — for large skill sets, package as OCI artifact and pull via init container.

### Skills v2 Resolution (Unchanged)

The full skill resolution chain works identically inside the pod:
1. Platform `skill_catalog` (from baked-in `platform.yaml`)
2. Project `skill_catalog_overrides` (from ConfigMap-mounted `project.yaml`)
3. Platform + project `skill_sources` (paths resolve inside pod)
4. Repo-native skills (discovered from cloned workspace)
5. `skill_assignments` per agent (from merged config)
6. Guardrails evaluation (warn/error on count/size limits)

---

## 8. Single-Step Agent Runs (Direct Agent Mode)

SprintFoundry already supports single-agent runs via:
```bash
sprintfoundry run --source prompt --prompt "Review my code" --agent qa
sprintfoundry run --source github --ticket 42 --agent developer --agent-file custom-agent.yaml
```

Single-step runs are just regular runs with a smaller plan. The Dispatch Controller creates the same K8s Job. The run pod internally decides whether to call the orchestrator or skip to direct execution based on the `--agent` flag.

### Dispatch Controller API

```
POST /api/dispatch/run
{
  "project_id": "acme",
  "source": "github",
  "ticket_id": "42",
  "agent": "qa",                    // optional: single-agent mode
  "agent_file_inline": { ... },     // optional: inline agent definition
  "prompt": "Run security scan"     // optional: override task description
}
```

---

## 9. Webhook Architecture (Linear & GitHub)

### Current → New

| Aspect | Current (`monitor/server.mjs`) | New (Dispatch Controller) |
|--------|-------------------------------|---------------------------|
| **Execution** | Serial subprocess queue | Parallel K8s Jobs (limited by project quota) |
| **Dedup** | In-memory Map + disk JSON | Redis `SETNX` with TTL |
| **Concurrency** | One run at a time | Configurable per-project |
| **Scaling** | Single-machine bottleneck | Dispatch Controller scales horizontally |

### New Flow

```
GitHub/Linear → [Ingress] → [Dispatch Controller]
  ├── Verify signature (HMAC-SHA256)
  ├── Match to project config
  ├── Extract trigger
  ├── Dedupe check (Redis SETNX with TTL)
  └── Enqueue to Redis dispatch queue → [Queue Consumer] → K8s Job
```

Webhook verification logic extracted from `monitor/server.mjs` into shared `src/service/webhook-handler.ts`. Autoexecute config schema unchanged.

---

## 10. Scaling & Scheduling

### Queue-Based Dispatch

```
Triggers → Dispatch Controller → Redis Queue (per project) → Queue Consumer → K8s Job
```

Consumer checks: project quota, project budget, global capacity.

### Run Pod Resources

```yaml
resources:
  requests: { cpu: "500m", memory: "1Gi" }
  limits:   { cpu: "2", memory: "4Gi" }
```

### Auto-Scaling (Karpenter)

```yaml
NodePool: sprintfoundry-runs
  instances: m6i.large, m6i.xlarge, m6a.large (spot preferred)
  taints: sprintfoundry.io/run=NoSchedule
  limits: 500 vCPUs, 1000Gi memory
  consolidation: WhenUnderutilized
```

### Priority Queuing

P0 tickets get priority. Starvation prevention via aging — runs waiting >10min get promoted.

---

## 11. Network Architecture

```
Internet
    │
[Ingress / ALB]
    │
    ├── /dispatch/*  → Dispatch Controller (triggers, webhooks)
    ├── /monitor/*   → Monitor Dashboard (UI + API)
    └── /api/internal/* → Event Ingestion API (from run pods only)

Run Pods → outbound only:
    ├── Claude/OpenAI APIs (internet)
    ├── GitHub/GitLab (internet)
    ├── npm/Go registries (internet)
    └── Event Ingestion API (internal)
```

**Network policies**: Run pods have no ingress. Egress to internet + internal event API only. No pod-to-pod communication between runs. Full isolation.

---

## 12. What Changes From Current Architecture

### Must Change

| Component | Current | New | Why |
|-----------|---------|-----|-----|
| **EventStore** | JSONL files on disk | HTTP POST to central API + optional local JSONL | Ephemeral pods lose files on termination |
| **SessionManager** | `~/.sprintfoundry/sessions/*.json` | Postgres `runs` table via API | Monitor can't read remote filesystem |
| **Monitor data source** | Reads workspace files | Reads from Postgres + Redis SSE | Workspaces on ephemeral pod volumes |
| **Run triggering** | CLI only | CLI + HTTP API + webhooks via Dispatch Controller | Scale requires programmatic triggering |
| **Credential storage** | `.env` / shell env vars | K8s Secrets via ExternalSecrets Operator | Multi-tenant BYOK needs centralized secret management |
| **Log persistence** | `.claude-runtime.*.log` files | Streamed to central store via event API | Ephemeral pods lose logs |
| **Webhook execution** | Serial subprocess queue | Parallel K8s Jobs via Dispatch Controller + Redis queue | Serial queue can't handle 100s of projects |
| **Webhook dedup** | In-memory Map + disk JSON | Redis `SETNX` with TTL | Survives restarts, shared across replicas |
| **Custom skill injection** | Local filesystem paths | Baked into image + ConfigMap/OCI artifact mounts | Pod can't read host filesystem |

### Preserved (No Changes)

| Component | Why It Works As-Is |
|-----------|-------------------|
| `OrchestrationService` core flow | Runs unchanged inside pod |
| `AgentRunner` + runtime system | Agents still spawn as child processes |
| `PlanValidator`, `PlannerFactory` | No infrastructure dependency |
| Agent CLAUDE.md / CODEX.md files | Baked into image |
| Filesystem message bus | Works within pod's EmptyDir |
| Plugin system, skill system | Standard plugins baked in; custom via ConfigMap; repo-native auto-discovered |
| Single-step agent runs (`--agent`) | Same CLI flag, same logic |
| Autoexecute config schema | Same YAML, loaded from ConfigMap |
| Guardrails, budget enforcement | Runs in-process |
| Git operations | Git CLI works from pod |
| OpenTelemetry metrics | OTLP export from pod to collector DaemonSet |

---

## 13. Migration Path

### Phase 1: Current State (No changes)
CLI-driven, single-machine, file-based everything.

### Phase 2: Central Store (Code changes, same infra)
- Add `SPRINTFOUNDRY_EVENT_SINK_URL` to EventStore (dual-write: JSONL + HTTP)
- Add event ingestion API (Express routes)
- Modify monitor to read from Postgres instead of filesystem
- Add Redis pub/sub for SSE
- **Backwards compatible**: unset `EVENT_SINK_URL` = current behavior

### Phase 3: Kubernetes Deployment
- Build `sprintfoundry-runner` image
- Deploy Dispatch Controller, Monitor, Event API as Deployments
- Deploy managed Postgres (RDS) + Redis (ElastiCache)
- Configure ExternalSecrets, Karpenter, network policies

### Phase 4: Multi-Tenant Production
- Project onboarding API (create namespace, secrets, config)
- Per-project budget tracking and billing
- Grafana dashboards per project
- Run history archival (Postgres → S3 after 90 days)

---

## 14. Cost Model

### Compute is cheap; API credits dominate

| Component | Monthly Cost |
|-----------|-------------|
| Dispatch Controller (1x m6i.large) | ~$70 |
| Monitor (1x m6i.large) | ~$70 |
| Postgres (RDS db.r6g.large) | ~$180 |
| Redis (ElastiCache cache.r6g.large) | ~$130 |
| **Run pods (spot, variable)** | see below |

| Scale | Concurrent Runs | Monthly Runs | Compute Cost | API Cost (@$3/run) |
|-------|-----------------|-------------|-------------|-------------------|
| Small | 10 | 14K | ~$220 | ~$43K |
| Medium | 50 | 72K | ~$1,100 | ~$216K |
| Large | 200 | 288K | ~$4,300 | ~$864K |

**Takeaway**: The existing budget enforcement system (`max_budget_usd` per agent, `per_task_max_cost_usd`) is the primary cost control — not compute optimization.

---

## 15. Local Testing (Postgres + Redis + Monitor + Event API)

This section is the local verification path for the distributed architecture after #71.

### 15a. Start local distributed stack

```bash
docker compose -f docker-compose.distributed.yml up -d --build
```

Expected local endpoints:
- Event ingestion API: `http://localhost:3001`
- Monitor UI/API: `http://localhost:4310`
- Postgres: `localhost:5432`
- Redis: `localhost:6379`

### 15b. Set local env for run pods / local CLI dual-write

```bash
export SPRINTFOUNDRY_EVENT_SINK_URL=http://localhost:3001/api/internal
export SPRINTFOUNDRY_INTERNAL_API_TOKEN=dev-token
export SPRINTFOUNDRY_DATABASE_URL=postgres://sf:sf@localhost:5432/sprintfoundry
export SPRINTFOUNDRY_REDIS_URL=redis://localhost:6379
```

### 15c. Run SprintFoundry against a ticket/prompt

```bash
pnpm dev -- run --source prompt --prompt "Create a tiny docs-only change"
```

Verify:
- `runs`, `events`, `step_results`, and `run_logs` rows are created in Postgres.
- Monitor `/api/runs` returns the run.
- Monitor `/api/events/stream?run_id=<id>` streams updates.

### 15d. Core regression checks

```bash
export CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
export SF_TEST_MATRIX="$CODEX_HOME/skills/sprintfoundry-testing/scripts/run_sprintfoundry_test_matrix.sh"
export SF_MONITOR_SMOKE="$CODEX_HOME/skills/sprintfoundry-testing/scripts/check_monitor_auth_flow.sh"

"$SF_TEST_MATRIX" --repo "$(pwd)" --changed
"$SF_MONITOR_SMOKE" "$(pwd)"
```

---

## 16. Issue Traceability (#65-#78)

This section cross-links implementation scope to the issue plan.

| Issue | Theme | Primary implementation/doc touchpoints |
|------|-------|-----------------------------------------|
| [#65](https://github.com/Sagart-cactus/SprintFoundry/issues/65) | Event sink client | `src/service/event-sink-client.ts`, dual-write consumers in EventStore/SessionManager |
| [#66](https://github.com/Sagart-cactus/SprintFoundry/issues/66) | EventStore dual-write | `src/service/event-store.ts`, tests in `tests/event-store.test.ts` |
| [#67](https://github.com/Sagart-cactus/SprintFoundry/issues/67) | SessionManager dual-write | `src/service/session-manager.ts`, runtime session persistence integration |
| [#68](https://github.com/Sagart-cactus/SprintFoundry/issues/68) | Runtime log streaming | runtime log capture + ingestion routes in `src/service/event-ingestion-api.ts` |
| [#69](https://github.com/Sagart-cactus/SprintFoundry/issues/69) | Event ingestion API | `src/service/event-ingestion-api.ts`, `src/service/event-ingestion-server.ts` |
| [#70](https://github.com/Sagart-cactus/SprintFoundry/issues/70) | Monitor Postgres backend | `monitor/server.mjs` query path for runs/events/logs/step results |
| [#71](https://github.com/Sagart-cactus/SprintFoundry/issues/71) | Docker Compose stack | `docker-compose.distributed.yml`, `migrations/001_create_event_tables.sql` |
| [#72](https://github.com/Sagart-cactus/SprintFoundry/issues/72) | Extract webhook handlers | `src/service/webhook-handler.ts`, `tests/webhook-handler.test.ts` |
| [#73](https://github.com/Sagart-cactus/SprintFoundry/issues/73) | Dispatch controller | `src/service/dispatch-controller.ts`, CLI `sprintfoundry dispatch` |
| [#74](https://github.com/Sagart-cactus/SprintFoundry/issues/74) | Artifact upload to S3 | `src/service/artifact-uploader.ts`, orchestration finalization upload hook |
| [#75](https://github.com/Sagart-cactus/SprintFoundry/issues/75) | Unified Docker image | root `Dockerfile`, `.dockerignore`, CLI runtime passthrough |
| [#76](https://github.com/Sagart-cactus/SprintFoundry/issues/76) | K8s manifests (Kustomize) | `k8s/base/*`, `k8s/overlays/dev/*`, `k8s/README.md` |
| [#77](https://github.com/Sagart-cactus/SprintFoundry/issues/77) | ExternalSecrets + project setup | `k8s/project-template/*`, `scripts/onboard-project.sh` |
| [#78](https://github.com/Sagart-cactus/SprintFoundry/issues/78) | Architecture finalization | this document (`docs/architecture-k8s-hosting.md`) |

Document maintenance rule:
- When any issue in #65-#78 changes scope, update this file in the same PR before merge.

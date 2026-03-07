# SprintFoundry Kubernetes Multitenant Execution Plan

## Purpose

This document is a handoff brief for Codex to help evolve SprintFoundry from a strong multi-agent software delivery orchestrator into a Kubernetes-native, multitenant coding-agent execution platform.

The goal is **not** to replace SprintFoundry's current product identity.
The goal is to strengthen it:

- **Current product identity:** multi-agent software delivery orchestrator
- **Evolved platform identity:** Kubernetes-native execution and governance plane for safe, fast, observable, resumable coding-agent runs

## Grounding in the current codebase

Based on the latest `main` branch documentation:

- SprintFoundry is currently a **service-orchestrated multi-agent execution system**.
- It fetches a task, creates a per-run workspace, clones a repo, generates an execution plan, validates it, executes steps, handles rework/review, and emits events/logs.
- Primary entrypoint is `src/service/orchestration-service.ts`.
- Important components called out by the architecture docs include:
  - `OrchestrationService`
  - `AgentRunner`
  - `RuntimeFactory`
  - `PlannerRuntime`
  - `PlanValidator`
  - `TicketFetcher`
  - `GitManager`
  - `NotificationService`
  - `EventStore`
- Runs already have isolated workspaces.
- The monitor already shows runs, live step progress, streaming output, token usage, and cost.
- SprintFoundry already supports:
  - multiple runtime modes, including container mode
  - plugins and Codex skills
  - Postgres/Redis-backed distributed testing
  - sessions / lifecycle / worktree direction in recent release messaging

This plan builds on those strengths instead of changing the product from scratch.

---

## North star

### Product statement

SprintFoundry should become:

**The Kubernetes-native control plane for secure, observable, resumable coding-agent execution.**

### Design principles

1. **One run = one sandbox**
   - A run is the isolation boundary.
   - Steps should share the same sandbox unless explicitly split.

2. **State must survive failure**
   - A failed pod should not mean a lost session.
   - Run state, artifacts, patches, logs, and session metadata must be durable.

3. **Policy before flexibility**
   - Dynamic MCP/plugins/skills are useful only if they are governed by tenant-aware policy.

4. **Warm and reusable execution beats cold orchestration**
   - Kubernetes leadership here will come from warm pools, cached repo state, and fast resume.

5. **Multitenancy is a first-class architecture concern**
   - Secrets, network access, storage, runtime isolation, and budgets must all be tenant-scoped.

---

## What Codex should do first

Codex should treat this as a **platform refactor roadmap**, not a single PR.

Work in this order:

1. Define the target execution model and state model.
2. Introduce multitenant run identity and policy attachment concepts.
3. Build the Kubernetes execution substrate.
4. Add durable resume / import / export.
5. Add dynamic per-run MCP / plugin / skill attachment.
6. Improve observability and performance after the substrate is in place.

---

# Area 1: Sandboxed execution

## Goal

Make every SprintFoundry run equivalent to an isolated, resumable sandbox.

## Why this matters

Right now SprintFoundry already creates per-run workspaces and supports container execution, which is a strong base.
However, for multitenant hosted usage, workspace isolation alone is not enough.
We need Kubernetes to become the actual security and lifecycle boundary.

## Relevant external direction

The Kubernetes `agent-sandbox` project is highly aligned with this goal. It is explicitly intended for isolated, stateful, singleton workloads such as AI agent runtimes, and introduces:

- `Sandbox`
- `SandboxTemplate`
- `SandboxClaim`
- `SandboxWarmPool`

It also emphasizes stable identity, persistent storage, pause/resume lifecycle, strong isolation, and support for runtimes such as gVisor and Kata.

## Recommended target model

### Current model

- Orchestrator creates a per-run workspace.
- Steps execute in a workspace, using runtime adapters.
- Container mode exists but is not yet the full hosted execution substrate.

### Target model

- Every run gets a **Run Sandbox**.
- All steps for that run execute inside the same sandbox.
- The sandbox owns:
  - workspace volume
  - runtime binaries
  - staged repo state
  - step artifacts
  - per-run credentials projection
  - local MCP sidecars or localhost services
- The control plane schedules and manages the sandbox; it does not execute the run logic directly.

## Architecture changes

### Introduce a Kubernetes execution abstraction

Add a new execution layer that sits beneath `AgentRunner`.

Suggested interface:

```ts
interface ExecutionBackend {
  prepareRunEnvironment(run: TaskRun, plan: ExecutionPlan): Promise<RunEnvironmentHandle>
  executeStep(handle: RunEnvironmentHandle, step: PlanStep): Promise<AgentResult>
  pauseRun(handle: RunEnvironmentHandle): Promise<void>
  resumeRun(handle: RunEnvironmentHandle): Promise<void>
  teardownRun(handle: RunEnvironmentHandle): Promise<void>
}
```

### Add backend implementations

- `LocalExecutionBackend`
- `DockerExecutionBackend`
- `KubernetesPodExecutionBackend` as the first practical hosted backend
- `AgentSandboxExecutionBackend` as the strategic backend once the Kubernetes sandbox abstraction is adopted

### Add run-sandbox state to the data model

Extend `TaskRun` metadata with fields like:

- `tenant_id`
- `project_id`
- `sandbox_id`
- `execution_backend`
- `workspace_volume_ref`
- `network_profile`
- `secret_profile`
- `resume_token`
- `checkpoint_generation`

## Security baseline per run

Each run should eventually get all of the following:

- dedicated Kubernetes namespace or tenant partitioning policy
- dedicated service account
- short-lived projected credentials
- network policy
- egress allowlist
- read/write workspace volume
- runtimeClass selection
- CPU and memory quota
- object store prefix scoped to tenant and run

## Runtime isolation levels

Support three levels:

1. **Standard isolated**
   - regular container isolation
   - suitable for trusted internal workloads

2. **Hardened isolated**
   - gVisor runtime class
   - restricted egress
   - default for hosted multitenant workloads

3. **Strong isolated**
   - Kata Containers or equivalent
   - for enterprise or high-risk workloads

## Codex implementation tasks

### Phase 1

- Introduce `ExecutionBackend` abstraction.
- Refactor `AgentRunner` to call the backend instead of directly assuming local/container execution.
- Add `run_environment` metadata to `TaskRun`.
- Persist sandbox identity in the event store.

### Phase 2

- Build `KubernetesPodExecutionBackend`.
- Create one pod per run, not per step.
- Mount a PVC or ephemeral volume strategy for workspace persistence.
- Move step execution into remote exec or an in-sandbox runner process.

### Phase 3

- Add `AgentSandboxExecutionBackend` behind a feature flag.
- Model `SandboxTemplate` by runtime profile.
- Model `SandboxWarmPool` for hot capacity.

## Success metrics

- 100 percent of hosted runs execute in an isolated backend
- no cross-run filesystem access
- no static long-lived secrets inside the sandbox image
- sandbox identity visible in every run trace

---

# Area 2: Blazing-fast execution

## Goal

Reduce time-to-first-token and total run latency for hosted Kubernetes execution.

## Key insight

The biggest latency win will not come from micro-optimizing orchestration code.
It will come from reducing cold-start overhead:

- image pull time
- repo clone time
- package/tool bootstrap time
- sandbox provisioning time
- remote model/runtime initialization

## Recommended latency model

Track these separate intervals:

1. request received -> run accepted
2. run accepted -> sandbox allocated
3. sandbox allocated -> repo ready
4. repo ready -> first step start
5. first step start -> first tool call
6. first tool call -> first diff
7. total run duration

## Architecture changes

### One sandbox per run

Do not create a fresh pod for each step.
Keep the same sandbox warm for the full run.

### Warm pools

Maintain pre-warmed execution capacity for common profiles:

- claude-code TypeScript profile
- codex TypeScript profile
- Go profile
- fullstack Node profile

### Repo acceleration

Introduce staged repo bootstrapping:

- bare mirror cache
- worktree-based checkout
- shallow fetch where acceptable
- object-store snapshot or PVC snapshot for hot projects

### Toolchain acceleration

Use layered images and host-local cache strategies for:

- npm / pnpm
- pip / uv
- go build cache
- language server / agent helper assets

### Scheduler awareness

Use dedicated node pools for agent workloads with:

- pre-pulled common images
- fast local SSD where useful
- runtimeClass tuned per pool
- autoscaling based on warm-pool pressure

## Codex implementation tasks

### Phase 1

- Add queue-to-ready and ready-to-first-step metrics.
- Benchmark current run startup path.
- Add explicit timing spans around clone, bootstrap, planner, and step execution.

### Phase 2

- Introduce run-scoped persistent workspace backing.
- Implement repo mirror + worktree strategy.
- Pre-bake common toolchains into runner images.

### Phase 3

- Add warm sandbox pool manager.
- Add profile-based pool sizing.
- Add admission logic that tries warm allocation before cold provisioning.

## Success metrics

- warm-pool hit rate above 70 percent for common profiles
- queue-to-ready under 5 seconds for warm runs
- queue-to-ready under 20 seconds for cold runs
- repo-ready latency reduced by at least 50 percent versus naive fresh clone path

---

# Area 3: Observability for tokens, cost, latency, and platform health

## Goal

Make SprintFoundry the most observable coding-agent orchestrator on Kubernetes.

## Why this matters

SprintFoundry already surfaces token usage and cost in the monitor.
That is a good start, but hosted multitenant execution needs a much richer observability model.

## Observability layers

### 1. Control plane observability

Track:

- runs submitted
- queue depth
- scheduling latency
- warm-pool hit rate
- sandbox provisioning failures
- resume failures
- secret projection failures
- MCP attach failures
- step dispatch latency

### 2. Run plane observability

Track:

- tokens in / out / cached by model and step
- cost per step, per run, per tenant
- retry count and retry reason
- step duration
- tool invocation counts
- shell command counts
- artifact upload size and count
- diff size
- sandbox CPU, memory, fs, network usage

### 3. Business and product observability

Track:

- successful PR rate
- mean time to first diff
- mean time to tested PR
- cost per successful run
- cost per PR by tenant
- success rate by runtime profile
- success rate by agent type

## Canonical tracing dimensions

Every event, metric, and log should carry these where applicable:

- `tenant_id`
- `project_id`
- `run_id`
- `session_id`
- `sandbox_id`
- `step_id`
- `agent_type`
- `provider`
- `runtime_mode`
- `model`
- `ticket_source`

## Storage model recommendation

Separate:

- durable run state in Postgres
- time-series metrics in Prometheus or OTEL backend
- traces in OTEL collector backend
- raw logs and artifacts in object storage

## UI recommendations

Extend the monitor with:

- run critical path timeline
- cost waterfall by step
- token waterfall by step and model
- warm vs cold start indicator
- sandbox health panel
- resume checkpoints panel
- MCP attachment panel
- secret access audit panel

## Codex implementation tasks

### Phase 1

- Define canonical run labels and tracing attributes.
- Add timing spans around all major orchestration phases.
- Normalize token and cost reporting across runtimes.
- Add Prometheus metrics for queue depth, provisioning, step duration, and resume.

### Phase 2

- Add per-run resource usage sampling from Kubernetes.
- Add cost attribution pipeline per tenant / project / run.
- Add structured audit events for secret use and MCP attachment.

### Phase 3

- Add monitor dashboards for cost, latency, and warm-pool efficiency.
- Add SLOs and alerting for hosted platform health.

## Success metrics

- all runs attributable by tenant and project
- step-level cost available for more than 95 percent of steps
- first-class dashboards for queue-to-ready, run duration, and cost per run
- secret and MCP attachment actions auditable for all hosted runs

---

# Area 4: Resume anywhere

## Goal

Allow a run to be resumed after failure, from another machine, or locally with high fidelity.

## Why this matters

Resume is one of the strongest differentiators for a coding-agent platform.
Users should not lose work because:

- a pod died
- a node drained
- a network session ended
- a human wants to continue locally

## Resume should mean two things

### A. Platform resume

The hosted platform restarts the same run inside the same or equivalent sandbox.

### B. Portable resume

The user exports the run and continues locally.

## Recommended model: portable session bundle

Introduce a durable session bundle that contains:

- run metadata
- execution plan
- current step state
- full event log
- artifact manifest
- repo origin and base commit
- working diff / patch set
- branch metadata
- runtime metadata
- plugin / skill / MCP attachment manifest
- non-secret credential references
- sandbox identity and checkpoint metadata

Never export secret values.
Only export references or claims that can be re-resolved.

## Checkpoint strategy

Checkpoint at least at:

- after planning
- before each step starts
- after each step ends
- before human review gate
- after human review gate
- before teardown

Each checkpoint should be resumable from durable state.

## Local resume UX

Add commands like:

```bash
sprintfoundry session export --run <run-id> --output session-bundle.tar.zst
sprintfoundry session import --file session-bundle.tar.zst
sprintfoundry resume --run <run-id>
sprintfoundry resume --bundle session-bundle.tar.zst --local
```

## Architecture changes

### Decouple session state from workspace-only assumptions

Right now the architecture is still strongly workspace-centered.
Move toward:

- durable run state in Postgres
- workspace content checkpointed to object storage or persistent volume snapshots
- event log as the source of truth for run progression

### Separate execution identity from machine identity

A run should not be bound to one pod or one laptop.
It should be bound to a session ID and checkpoint lineage.

## Codex implementation tasks

### Phase 1

- Define `SessionBundle` schema.
- Persist enough metadata to reconstruct run state from durable storage.
- Add checkpoint records to the event store.

### Phase 2

- Implement `session export`.
- Implement `session import`.
- Implement resume from latest checkpoint.

### Phase 3

- Add portable local resume using exported workspace + patch + manifest.
- Add resume compatibility checks for runtime and skill availability.

## Success metrics

- hosted run resumes successfully after pod failure
- exported session can be resumed locally for supported runtimes
- no secrets included in exported session bundle
- checkpoint restore time remains bounded and observable

---

# Area 5: Dynamic MCP, plugins, and skills per run

## Goal

Allow each run to dynamically attach the correct MCP servers, plugins, and skills, while keeping tenant boundaries strong.

## Why this matters

SprintFoundry already has a plugin system and Codex skill staging model.
That is a strong base.
The next step is to make attachments dynamic, run-scoped, policy-controlled, and safe for hosted multitenant use.

## Recommended model: Run Attachment Manifest

For every run, resolve a single manifest that defines:

```yaml
attachments:
  skills:
    - code-quality
    - k8s-platform
  plugins:
    - js-nextjs
    - code-review
  mcp_servers:
    - github
    - linear
    - internal-docs
  secret_refs:
    - tenant/github/token
    - tenant/linear/token
  allowed_tools:
    - read_file
    - write_file
    - shell
  network_profile: github-only
  storage_profile: standard
  budget_profile: medium
```

This manifest should be resolved before the run starts and made immutable for that run, except where an explicit human-approved mutation is allowed.

## Policy model

Create a policy layer that decides:

- which plugins a tenant can use
- which skills a tenant can use
- which MCP servers can be attached
- which secrets may be projected into the run
- whether an MCP server runs:
  - outside the sandbox
  - as a sidecar
  - as a localhost in-sandbox process

## Preferred hosted architecture

### Skills

- packaged and versioned
- staged into the sandbox at run start
- content-hash pinned for reproducibility

### Plugins

- packaged as signed bundles or trusted catalogs
- resolved by version and hash
- read-only mount inside the sandbox

### MCP servers

Support two execution styles:

1. **Shared managed MCP**
   - platform-managed service
   - tenant auth injected per connection
   - good for GitHub, Linear, Jira, docs APIs

2. **Run-scoped MCP sidecar**
   - launched alongside the run sandbox
   - strongest isolation
   - best for tenant-specific custom servers

## Secret handling requirements

- no static secrets in config files or images
- fetch secrets just in time
- inject them with the smallest possible scope
- rotate short-lived credentials where possible
- record secret reference usage in audit logs
- scrub secret values from logs, artifacts, and session exports

## Codex implementation tasks

### Phase 1

- Define `RunAttachmentManifest` types.
- Add resolution phase before execution starts.
- Normalize current plugin and Codex skill loading into the manifest flow.

### Phase 2

- Introduce policy engine for tenant-scoped attachment approval.
- Add support for MCP attachment descriptors.
- Add audit events for attachment resolution and secret projection.

### Phase 3

- Implement run-scoped sidecar MCP support in Kubernetes backend.
- Add signed plugin bundle resolution.
- Add version pinning and reproducibility checks.

## Success metrics

- every hosted run has an immutable attachment manifest
- secret projections are scoped to run and tenant
- attachment audit trail exists for all runs
- MCP failures are isolated without cross-tenant impact

---

# Cross-cutting multitenancy requirements

Codex should treat these as mandatory across all five areas.

## Tenant identity and ownership

Add first-class tenant metadata to core models.
A run is not just a run.
It belongs to:

- tenant
- project
- user
- environment

## Storage isolation

All artifacts, checkpoints, logs, and session bundles must be partitioned by:

- tenant
- project
- run

## Budget and quota controls

Add tenant-aware controls for:

- max concurrent runs
- max tokens per run
- max spend per day
- max runtime duration
- allowed runtime profiles
- allowed MCP attachments

## Egress control

Each tenant should have a defined egress posture.
Examples:

- GitHub only
- GitHub + Jira + package registries
- full internet
- internal-only

## Auditability

All critical actions must be auditable:

- secret resolution
- plugin attach
- skill attach
- MCP attach
- human approval
- resume / export / import
- sandbox creation / deletion

---

# Proposed implementation roadmap

## Milestone 1: Execution abstraction and identity

Deliverables:

- `ExecutionBackend` abstraction
- run environment metadata
- tenant / project / sandbox identity plumbing
- canonical tracing labels

Outcome:

SprintFoundry is no longer hardwired to local or container-only execution assumptions.

## Milestone 2: Kubernetes run sandbox

Deliverables:

- `KubernetesPodExecutionBackend`
- one pod per run
- persistent workspace backing
- per-run service account and policy wiring

Outcome:

Hosted SprintFoundry has a real Kubernetes execution substrate.

## Milestone 3: Durable resume and session portability

Deliverables:

- checkpoints
- `SessionBundle`
- export / import / resume commands
- object-store backed workspace persistence

Outcome:

Runs survive failure and can move between hosted and local environments.

## Milestone 4: Dynamic attachment plane

Deliverables:

- `RunAttachmentManifest`
- policy engine
- tenant-scoped secret / skill / plugin / MCP resolution
- audit logging

Outcome:

SprintFoundry can safely support many users with different tools and credentials.

## Milestone 5: Warm-pool performance and advanced isolation

Deliverables:

- warm pools
- repo acceleration
- runtime profiles
- gVisor / Kata support
- optional `agent-sandbox` integration

Outcome:

SprintFoundry becomes fast enough and secure enough to credibly lead this category on Kubernetes.

---

# Suggested repo touchpoints for Codex

These are the most likely areas to inspect and evolve first.

## Existing architecture touchpoints

- `src/service/orchestration-service.ts`
- `src/service/agent-runner.ts`
- `src/service/runtime/`
- `src/service/plan-validator.ts`
- `src/service/event-store.ts`
- `src/shared/types.ts`
- `monitor/`
- `config/`
- `containers/`
- `k8s/`
- `plugins/`
- docs under `docs/`

## New packages or modules to consider

- `src/service/execution/`
- `src/service/session/`
- `src/service/attachments/`
- `src/service/policy/`
- `src/service/secrets/`
- `src/service/observability/`
- `src/service/k8s/`

---

# What not to do

1. Do not make Kubernetes the only execution mode.
   - Local execution remains critical for developer adoption.

2. Do not create a pod per step unless isolation requirements truly demand it.
   - It will hurt latency and session continuity.

3. Do not treat plugins, skills, or MCP attachments as ad hoc runtime flags.
   - Resolve them into a policy-checked manifest.

4. Do not put secret values into exported session bundles.

5. Do not bolt on observability last.
   - Multitenant hosted execution without strong attribution will become unmanageable.

---

# Suggested first Codex deliverable

Ask Codex to start with a design PR, not a feature PR.

## First PR scope

Produce:

1. a design doc for `ExecutionBackend`
2. proposed `TaskRun` / `SessionBundle` / `RunAttachmentManifest` type changes
3. a minimal `KubernetesPodExecutionBackend` skeleton
4. a migration plan from current runtime assumptions to backend-driven execution
5. a metrics plan for queue-to-ready, warm-pool, and resume

## Acceptance bar for that first PR

- no behavior regression for local mode
- new abstractions compile cleanly
- architecture docs updated
- clear follow-up issue list produced

---

# References

## SprintFoundry

- Repository: https://github.com/Sagart-cactus/SprintFoundry
- Architecture doc: https://raw.githubusercontent.com/Sagart-cactus/SprintFoundry/main/docs/architecture.md
- Agents doc: https://raw.githubusercontent.com/Sagart-cactus/SprintFoundry/main/docs/agents.md
- Configuration doc: https://raw.githubusercontent.com/Sagart-cactus/SprintFoundry/main/docs/configuration.md

## Kubernetes agent sandbox

- Repository: https://github.com/kubernetes-sigs/agent-sandbox
- README: https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/main/README.md

---

# Short prompt you can hand to Codex

```text
You are working in SprintFoundry.
Read this document fully before changing code.

Your goal is to evolve SprintFoundry toward a Kubernetes-native, multitenant execution platform for coding agents while preserving current local developer workflows.

Start with architecture and interfaces, not full implementation.

Focus first on:
1. ExecutionBackend abstraction
2. TaskRun identity changes for tenant/project/sandbox/session
3. SessionBundle schema for resume/export/import
4. RunAttachmentManifest schema for plugins/skills/MCP/secrets
5. Minimal KubernetesPodExecutionBackend scaffold
6. Metrics plan for queue-to-ready, cost attribution, and resume

Constraints:
- do not break existing local mode
- do not remove current plugin or Codex skill support
- do not introduce static secrets into images or bundles
- do not create a pod per step unless explicitly justified

Expected output:
- design doc
- interface changes
- skeletal implementation where useful
- issue breakdown for follow-up milestones
```

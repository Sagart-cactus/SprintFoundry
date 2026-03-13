# Agent Sandbox Whole-Run Migration Plan

Date: 2026-03-13
Status: Proposed

## Goal

Move SprintFoundry to a single Kubernetes hosting model for dispatched runs:

- one dispatched run creates one Agent Sandbox workload
- that sandbox executes the entire SprintFoundry run
- all agent steps execute locally inside that sandbox
- no nested per-step `k8s-pod` backend
- no separate outer Kubernetes `Job` hosting path long-term

This keeps the current product direction intact:

- single-step generic agent remains the default execution shape
- multi-step runs still work, but the whole run stays inside one sandbox
- Kubernetes isolation happens once per run, not once per step

This aligns the platform around one clear model:

- `dispatch` chooses where a run is hosted
- the hosted run executes its steps with the `local` backend

## Why This Is Better

Pros:

- one run = one Kubernetes runtime object
- clearer state ownership for workspace, runtime logs, sessions, and artifacts
- easier resume/snapshot/export design because state stays in one sandbox
- removes nested K8s orchestration and the resulting ambiguity in `execution_backend`
- aligns better with Agent Sandbox’s intended use case of isolated, stateful, singleton AI runtimes

Cons:

- this is a control-plane migration, not a small backend swap
- current `agent-sandbox` support is only a scaffold and does not execute steps yet
- lifecycle semantics currently provided by `Job` must be rebuilt around Sandbox/SandboxClaim state
- operational tooling, monitoring, and validation need to move off Job-oriented assumptions

## Upstream Alignment

Official Agent Sandbox documentation positions the project around isolated, stateful, singleton workloads and exposes:

- `Sandbox` as the core CRD
- `SandboxTemplate`
- `SandboxClaim`
- `SandboxWarmPool`

The docs also show the core API under `agents.x-k8s.io/v1alpha1`.

References:

- https://agent-sandbox.sigs.k8s.io/docs/getting_started/
- https://github.com/kubernetes-sigs/agent-sandbox

## Current State In This Repo

### Whole-run Kubernetes path

Today dispatch creates:

- one Kubernetes `Job`
- one PVC
- a runner container that executes SprintFoundry inside that pod

Relevant code:

- `src/service/dispatch-controller.ts`

### Per-step K8s sandbox path

The current `k8s-pod` backend is a different model:

- SprintFoundry itself creates pods, PVCs, service accounts, and network policies
- it is nested under the run rather than being the run host

Relevant code:

- `src/service/execution/k8s-pod-backend.ts`

### Current Agent Sandbox integration

The existing `agent-sandbox` backend is only a claim lifecycle scaffold:

- it creates a `SandboxClaim`
- waits for a binding
- records the sandbox identity
- does not execute the run or any step

Relevant code:

- `src/service/execution/agent-sandbox-backend.ts`

Important current mismatch:

- the repo config defaults still use `agent-sandbox.dev/v1alpha1`
- the upstream docs show `agents.x-k8s.io/v1alpha1`

That should be treated as a migration item, not assumed to be correct.

## Target Architecture

### New mental model

Separate:

- where the run is hosted
- how steps execute inside that host

Recommended model:

- `hosting_mode`: `local` | `docker` | `k8s-agent-sandbox`
- `execution_backend`: `local` | `docker` | `agent-sandbox` only if it truly remains a step backend

For the Kubernetes target state in this plan:

- `hosting_mode = k8s-agent-sandbox`
- `execution_backend = local`

That means:

1. dispatcher receives a run
2. dispatcher creates a `SandboxClaim`
3. the claim binds to a `Sandbox`
4. the sandbox pod starts SprintFoundry runner
5. runner executes the entire run inside that sandbox
6. all steps execute locally in that sandbox
7. on terminal state, workspace is snapshotted/exported and the sandbox is cleaned up

### What lives inside the sandbox

The sandbox becomes the whole-run host and owns:

- cloned repo workspace
- `.sprintfoundry/run-state.json`
- `.events.jsonl`
- `.sprintfoundry/sessions.json`
- step results
- runtime logs
- artifacts
- workspace-scoped runtime state such as `.codex-home`

## Migration Principles

1. Do not keep two Kubernetes outer-hosting models indefinitely.
2. Do not keep `k8s-pod` as a hidden fallback after cutover.
3. Keep step execution local inside the sandbox.
4. Preserve the PVC/snapshot/export plan as the persistence layer.
5. Introduce new metadata for hosting mode rather than overloading `execution_backend`.

## Phased Migration

### Phase 0: Untangle Concepts

Objective:

- stop overloading `execution_backend` with both outer-hosting and inner-step-execution meaning

Changes:

- add a separate run metadata field such as `hosting_mode`
- keep `execution_backend` for step execution only
- emit `hosting_mode` in session metadata and lifecycle events

Files likely touched:

- `src/shared/types.ts`
- `src/service/orchestration-service.ts`
- `src/service/session-manager.ts`
- `src/service/event-ingestion-api.ts`
- monitor APIs/UI that display backend data

### Phase 1: Make Agent Sandbox A Real Whole-Run Host

Objective:

- make Agent Sandbox host the entire run, not individual steps

Changes:

- replace the current scaffolded `AgentSandboxExecutionBackend` with a run-hosting integration
- create `SandboxClaim` manifests that reference a SprintFoundry runner template
- configure the sandbox pod to run `node dist/index.js run ...`
- mount persistent workspace storage into the sandbox
- pass `SPRINTFOUNDRY_RUN_SANDBOX_MODE=k8s-whole-run`
- force `SPRINTFOUNDRY_EXECUTION_BACKEND=local`

Files likely touched:

- `src/service/execution/agent-sandbox-backend.ts`
- `src/service/execution/factory.ts`
- `src/index.ts`
- platform config and Kubernetes manifests/templates

### Phase 2: Move Dispatch From Jobs To SandboxClaims

Objective:

- make dispatch create Agent Sandbox resources instead of Jobs

Changes:

- replace `buildK8sJobManifest()` path with `buildSandboxClaimManifest()`
- stop generating per-run runner Jobs for the steady-state path
- attach project config, secret profiles, network policy references, and storage through sandbox template or claim parameters

Files likely touched:

- `src/service/dispatch-controller.ts`
- Kubernetes RBAC and namespace manifests
- configmap/secret generation paths

### Phase 3: Define Sandbox Lifecycle And Completion Semantics

Objective:

- recover the operational semantics currently inherited from Kubernetes Jobs

Needed behavior:

- run starts
- sandbox becomes ready
- runner exits with success/failure
- workspace snapshot/export can run
- sandbox is deleted or retained according to policy
- terminal status is visible to monitor/event sink

Changes:

- define how terminal run state is detected from sandbox state plus runner process exit
- define timeout, retry, and cancellation behavior
- define retention and cleanup rules

### Phase 4: Integrate Snapshot/Export

Objective:

- preserve whole-run workspace state after completion/failure/cancel for local restore

Changes:

- after terminal state, snapshot the sandbox workspace to S3 or other durable storage
- only delete persistent storage after snapshot success
- surface snapshot metadata in session and monitor views

This should reuse the PVC snapshot/export plan already documented in:

- `docs/k8s-whole-run-pvc-snapshot-plan-2026-03-13.md`

### Phase 5: Remove `k8s-pod`

Objective:

- delete the nested K8s step sandbox path completely

Changes:

- remove `k8s-pod` from `ExecutionBackendName`
- remove backend factory construction
- delete `src/service/execution/k8s-pod-backend.ts`
- delete `tests/k8s-pod-execution-backend.test.ts`
- update docs, configs, and validation reports

### Phase 6: Remove Legacy Whole-Run Job Hosting

Objective:

- ensure Agent Sandbox is the only Kubernetes run-hosting path

Changes:

- delete remaining dispatch Job manifest code used for run hosting
- keep only SandboxClaim/SandboxTemplate-based provisioning

This phase should happen only after the SandboxClaim path has already been validated in kind and staging.

## Concrete Code Changes By Area

### Type system and config

- `src/shared/types.ts`
  - add `hosting_mode`
  - stop treating `k8s-pod` as a supported long-term backend
- `config/platform.yaml`
  - update `k8s.agent_sandbox` defaults to match upstream API group/version
- project configs
  - remove `execution_backend_override: k8s-pod`

### Execution backend layer

- `src/service/execution/factory.ts`
  - stop resolving `k8s-pod`
  - fail fast if K8s whole-run hosting tries to resolve a non-local step backend
- `src/service/execution/agent-sandbox-backend.ts`
  - replace scaffold with whole-run hosting behavior
- delete `src/service/execution/k8s-pod-backend.ts`

### Dispatch layer

- `src/service/dispatch-controller.ts`
  - build SandboxClaim instead of Job
  - bind run labels/identity to sandbox resources
  - move PVC/storage handling into the sandbox model

### Orchestration/session/monitor

- `src/service/orchestration-service.ts`
  - emit hosting-mode-aware lifecycle events
- `src/service/session-manager.ts`
  - persist hosting metadata
- monitor server/UI
  - display sandbox hosting state and snapshot state

### Tests

Delete or rewrite:

- `tests/k8s-pod-execution-backend.test.ts`
- `tests/execution-backend-factory.test.ts`
- `tests/orchestration-service.test.ts`
- validation docs/tests that assume `k8s-pod` remains supported

Add:

- `tests/agent-sandbox-backend.test.ts` coverage for whole-run hosting behavior
- dispatch tests for SandboxClaim manifest generation
- kind validation for:
  - one run -> one SandboxClaim -> one Sandbox
  - local step execution inside sandbox
  - no nested K8s pod backend
  - snapshot/export after terminal state

## Risks And Mitigations

### Risk: Upstream API drift

The Agent Sandbox project is still moving.

Mitigation:

- pin to a tested release
- align repo defaults with the upstream documented API group/version
- add startup validation against installed CRDs

### Risk: Losing Job semantics

Jobs currently give completion, failure, backoff, and TTL for free.

Mitigation:

- define explicit run lifecycle rules around Sandbox/SandboxClaim state
- make snapshot/export and cleanup controller-driven

### Risk: Hidden nested backend regressions

Old configs may still try to resolve `k8s-pod`.

Mitigation:

- hard fail on `k8s-pod` once migration starts
- inject `SPRINTFOUNDRY_EXECUTION_BACKEND=local` inside hosted sandbox runs

### Risk: Workspace persistence mismatch

Persistent workspace handling must be native to the sandbox model.

Mitigation:

- test PVC binding and restore behavior early in kind
- keep snapshot/export as a first-class requirement, not a later add-on

## Recommended Rollout Order

1. Add `hosting_mode` and cleanly separate hosting from step backend.
2. Update platform defaults and CRD assumptions for Agent Sandbox.
3. Implement SandboxClaim-based whole-run hosting behind a feature flag.
4. Validate one run = one sandbox = local step execution in kind.
5. Integrate snapshot/export.
6. Remove `k8s-pod`.
7. Remove Job-based whole-run hosting.

## Recommendation

Proceed with this migration if the product goal is architectural simplicity and a single Kubernetes runtime model.

Do not implement Agent Sandbox as another nested execution backend alongside Job hosting and `k8s-pod`. That would keep the current ambiguity and complexity.

The clean version is:

- one Kubernetes hosting model: Agent Sandbox
- one step execution model inside it: local
- one persistence model: workspace storage plus snapshot/export

# Agent Sandbox Whole-Run Implementation Checklist

Date: 2026-03-14
Status: Proposed
Source: [agent-sandbox-whole-run-migration-plan-2026-03-13.md](./agent-sandbox-whole-run-migration-plan-2026-03-13.md)

## Goal

Replace the current Kubernetes whole-run `Job` host with Agent Sandbox hosting:

- one dispatched run creates one `SandboxClaim`
- one sandbox hosts the entire SprintFoundry run
- all steps execute with the `local` backend inside that sandbox
- no nested per-step `k8s-pod` backend
- workspace state remains durable and portable for local hand-off / restore

## Current Baseline

Current repo behavior:

- whole-run Kubernetes hosting is `Job` + PVC in `src/service/dispatch-controller.ts`
- whole-run mode already forces step execution to `local` in `src/service/execution/factory.ts`
- `agent-sandbox` exists only as a `SandboxClaim` scaffold and does not execute steps in `src/service/execution/agent-sandbox-backend.ts`

This plan keeps the current whole-run execution semantics and swaps the outer host from `Job` to Agent Sandbox.

## Delivery Rules

1. Keep `Job` hosting available behind the current path until SandboxClaim hosting passes kind validation.
2. Do not remove `k8s-pod` until SandboxClaim whole-run hosting is validated for both Codex and Claude.
3. Keep each PR independently reviewable and revertable.
4. Do not mix control-plane migration with unrelated UI/runtime cleanup.

## Preconditions

- [ ] Confirm the target Agent Sandbox CRDs and API group/version to support
  - expected target: `agents.x-k8s.io/v1alpha1`
- [ ] Install Agent Sandbox CRDs and controller in the kind validation cluster
- [ ] Define or import a SprintFoundry `SandboxTemplate`
- [ ] Decide how workspace PVCs are attached to sandbox workloads
- [ ] Decide whether snapshot/export remains PVC-based or becomes sandbox-volume-native

## PR 1: Separate Hosting From Step Backend

Objective:

- add `hosting_mode` so control-plane hosting is no longer overloaded into `execution_backend`

Files:

- `src/shared/types.ts`
- `src/service/orchestration-service.ts`
- `src/service/session-manager.ts`
- `src/service/event-ingestion-api.ts`
- `monitor/server.mjs`
- `monitor/public-v3/*`
- `monitor/v4/src/*`
- relevant tests under `tests/api`, `tests/*session*`, `tests/orchestration-service.test.ts`

Checklist:

- [ ] Add `hosting_mode: local | docker | k8s-job-whole-run | k8s-agent-sandbox`
- [ ] Persist `hosting_mode` in session metadata
- [ ] Emit `hosting_mode` in lifecycle events and DB-backed run records
- [ ] Display `hosting_mode` in monitor APIs and UI
- [ ] Keep `execution_backend` meaning step execution only

Validation:

- [ ] `npm run typecheck`
- [ ] `npx vitest run tests/api/monitor-routes.test.ts`
- [ ] `npx vitest run tests/orchestration-service.test.ts tests/session-manager.test.ts`

Exit criteria:

- [ ] monitor and session metadata distinguish host from step backend without behavior change

## PR 2: Normalize Agent Sandbox Platform Config

Objective:

- align config and startup assumptions with real Agent Sandbox APIs

Files:

- `config/platform.yaml`
- `src/shared/types.ts`
- `src/index.ts`
- Kubernetes manifests / Helm templates for sandbox config if needed

Checklist:

- [ ] Update default Agent Sandbox API group/version to upstream-compatible values
- [ ] Add startup validation for required CRDs
- [ ] Add a dedicated feature flag for SandboxClaim whole-run hosting
- [ ] Fail fast with a clear error when SandboxClaim hosting is enabled but CRDs are missing

Validation:

- [ ] config loading tests
- [ ] new startup validation tests

Exit criteria:

- [ ] environment fails safely instead of silently falling back

## PR 3: Make Agent Sandbox A Real Whole-Run Host

Objective:

- replace the current scaffold with run-host semantics

Files:

- `src/service/execution/agent-sandbox-backend.ts`
- `src/service/execution/factory.ts`
- `src/service/execution/backend.ts`
- `src/index.ts`
- `tests/agent-sandbox-backend.test.ts`
- `tests/execution-backend-factory.test.ts`

Checklist:

- [ ] Change `AgentSandboxExecutionBackend` from step executor scaffold to host lifecycle manager
- [ ] Ensure hosted sandbox runs always force `SPRINTFOUNDRY_EXECUTION_BACKEND=local`
- [ ] Pass whole-run env:
  - [ ] `SPRINTFOUNDRY_RUN_SANDBOX_MODE=k8s-whole-run`
  - [ ] `SPRINTFOUNDRY_RUNS_ROOT`
  - [ ] `SPRINTFOUNDRY_SESSIONS_DIR`
  - [ ] `HOME`
  - [ ] `CODEX_HOME`
- [ ] Persist claim name, sandbox name, template name, and host metadata on the run environment
- [ ] Keep `resumeRun()` semantics compatible with run recovery

Validation:

- [ ] `npx vitest run tests/agent-sandbox-backend.test.ts tests/execution-backend-factory.test.ts`

Exit criteria:

- [ ] Agent Sandbox host path is implemented without yet changing dispatch

## PR 4: Add SandboxClaim Dispatch Path Behind A Feature Flag

Objective:

- let dispatch create `SandboxClaim` resources instead of outer `Job` resources

Files:

- `src/service/dispatch-controller.ts`
- `tests/dispatch-controller.test.ts`
- `k8s/base/*`
- `helm/sprintfoundry/templates/*`

Checklist:

- [ ] Add `buildSandboxClaimManifest(...)` for run hosting
- [ ] Preserve run labels and identity on the claim
- [ ] Attach workspace storage and project config to the sandbox host model
- [ ] Keep `Job` path behind the old mode / feature gate during migration
- [ ] Ensure dispatch writes `hosting_mode=k8s-agent-sandbox`

Validation:

- [ ] `npx vitest run tests/dispatch-controller.test.ts`
- [ ] manifest / Helm rendering checks

Exit criteria:

- [ ] one feature flag cleanly switches host provisioning from Job to SandboxClaim

## PR 5: Sandbox Lifecycle And Completion Semantics

Objective:

- rebuild the operational semantics currently inherited from Jobs

Files:

- `src/service/dispatch-controller.ts`
- new controller/service module if needed
- `src/service/orchestration-service.ts`
- `monitor/server.mjs`
- monitor UI files
- new tests for lifecycle state transitions

Checklist:

- [ ] Define readiness semantics for sandbox-hosted runs
- [ ] Define terminal state detection for runner success/failure
- [ ] Define timeout and cancellation behavior
- [ ] Define cleanup / retention policy
- [ ] Surface sandbox lifecycle state in monitor

Validation:

- [ ] unit tests for lifecycle mapping
- [ ] monitor API tests for sandbox hosting metadata

Exit criteria:

- [ ] sandbox-hosted runs expose equivalent visibility to Job-hosted runs

## PR 6: Snapshot / Export Integration

Objective:

- preserve whole-run workspace state after terminal states and support local restore

Primary dependency:

- [k8s-whole-run-pvc-snapshot-plan-2026-03-13.md](./k8s-whole-run-pvc-snapshot-plan-2026-03-13.md)

Files:

- `src/service/run-snapshot-store.ts`
- `src/service/run-snapshot-export-service.ts`
- `src/service/k8s-run-snapshot-controller.ts`
- `src/service/session-manager.ts`
- `src/index.ts`
- monitor API/UI if snapshot metadata is shown

Checklist:

- [ ] Export sandbox-hosted run workspace after terminal states
- [ ] Persist durable snapshot metadata in session and event sink records
- [ ] Keep local hand-off / restore flow working
- [ ] Preserve runtime state needed for Codex and Claude continuation
- [ ] Add compatibility checks for missing runtime inputs on restore

Validation:

- [ ] targeted snapshot store/controller tests
- [ ] one completed sandbox-hosted run restore
- [ ] one failed sandbox-hosted run restore

Exit criteria:

- [ ] local restore works independently of the original sandbox lifetime

## PR 7: Provider Parity Validation

Objective:

- prove the sandbox-hosted whole-run model works for both Codex and Claude

Checklist:

- [ ] Codex kind validation:
  - [ ] one run -> one SandboxClaim -> one Sandbox
  - [ ] no nested `k8s-pod`
  - [ ] PR creation succeeds
  - [ ] hand-off / restore succeeds
- [ ] Claude kind validation:
  - [ ] one run -> one SandboxClaim -> one Sandbox
  - [ ] no nested `k8s-pod`
  - [ ] PR creation succeeds
  - [ ] resume/session metadata persists correctly
  - [ ] hand-off / restore succeeds

Files:

- validation docs under `docs/validation/`
- runtime tests:
  - `tests/codex-runtime-sdk.test.ts`
  - `tests/claude-code-runtime.test.ts`
  - `tests/orchestration-service.test.ts`

Exit criteria:

- [ ] Codex and Claude both have explicit whole-run validation reports

## PR 8: Remove `k8s-pod`

Objective:

- delete nested per-step Kubernetes sandboxing once sandbox whole-run hosting is proven

Files:

- `src/service/execution/factory.ts`
- `src/service/execution/k8s-pod-backend.ts`
- `tests/k8s-pod-execution-backend.test.ts`
- config examples and docs

Checklist:

- [ ] Remove `k8s-pod` from supported long-term backend names
- [ ] Fail fast on old configs that still request it
- [ ] Delete backend implementation and tests
- [ ] Update docs and examples

Exit criteria:

- [ ] no codepath can create nested per-step K8s pods

## PR 9: Remove Legacy Whole-Run Job Hosting

Objective:

- make Agent Sandbox the only Kubernetes whole-run host

Files:

- `src/service/dispatch-controller.ts`
- related Job-hosting manifests
- Helm templates and docs

Checklist:

- [ ] Delete steady-state run-hosting `Job` manifest path
- [ ] Keep only SandboxClaim/SandboxTemplate provisioning for K8s hosting
- [ ] Remove temporary migration flags after staging validation

Exit criteria:

- [ ] one Kubernetes hosting model remains

## Suggested Test Matrix

Fast path per PR:

- `npm run typecheck`
- targeted `vitest` suite for touched subsystem

Before enabling sandbox dispatch in kind:

- `tests/execution-backend-factory.test.ts`
- `tests/agent-sandbox-backend.test.ts`
- `tests/dispatch-controller.test.ts`
- `tests/orchestration-service.test.ts`
- `tests/api/monitor-routes.test.ts`

Before deleting `k8s-pod`:

- full orchestration/runtime/monitor profiles
- one live Codex sandbox-hosted run
- one live Claude sandbox-hosted run

## Recommended Sequence

1. PR 1: `hosting_mode`
2. PR 2: config + CRD validation
3. PR 3: agent-sandbox host implementation
4. PR 4: dispatch dual path behind flag
5. PR 5: lifecycle semantics
6. PR 6: snapshot/export
7. PR 7: Codex + Claude live validation
8. PR 8: remove `k8s-pod`
9. PR 9: remove Job hosting

## Hard Gates

- [ ] Do not cut over dispatch until SandboxClaim whole-run passes kind validation
- [ ] Do not remove `k8s-pod` until both Codex and Claude parity is proven
- [ ] Do not remove Job hosting until snapshot/export and local restore are validated in the sandbox path

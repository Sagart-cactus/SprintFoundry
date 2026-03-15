# Agent Sandbox Whole-Run Progress Report

Date: 2026-03-14
Branch: `feature/agent-sandbox-whole-run`
Status: In Progress, not complete

## Completed Commit Groups

1. `42e400f` — `PR1: separate hosting mode from step backend`
   - Added `hosting_mode` and persisted it through sessions, event sink payloads, DB-backed run records, and monitor APIs/UI.
   - Added SQL migration `migrations/002_add_runs_hosting_mode.sql`.
   - Added baseline note and implementation checklist docs.

2. `495b509` — `PR2: normalize agent sandbox platform config`
   - Added normalized Agent Sandbox platform defaults and a dedicated whole-run hosting feature flag.
   - Added startup validation for required Agent Sandbox CRDs.
   - Added config-loading and helper tests.

3. `3ca6727` — `PR3: turn agent sandbox into a whole-run host`
   - Changed `AgentSandboxExecutionBackend` from claim-only scaffold to claim lifecycle manager plus local step execution under whole-run host env.
   - Persisted host env and recovery metadata on the run environment handle.

4. `ffb90e8` — `PR4: add sandbox claim dispatch path`
   - Added a SandboxClaim dispatch path behind the whole-run hosting flag.
   - Dispatch now writes explicit `SPRINTFOUNDRY_HOSTING_MODE`.
   - Added dispatch-controller tests for the new claim path.

5. `a525ffc` — `PR2/4: align agent sandbox API groups with cluster`
   - Corrected Agent Sandbox API assumptions after installing the real controller in kind.
   - `SandboxClaim` and `SandboxTemplate` use `extensions.agents.x-k8s.io/v1alpha1`.
   - Core `Sandbox` remains under `agents.x-k8s.io/v1alpha1`.

## Validation Run So Far

PR1 validation:
- `npm run typecheck`
- `npx vitest run tests/unit/metadata.test.ts tests/session-manager.test.ts tests/event-sink-client.test.ts tests/integration/event-ingestion-api.test.ts tests/orchestration-service.test.ts tests/api/monitor-routes.test.ts --testNamePattern "Metadata|SessionManager|EventSinkClient|POST /runs|prepares and tears down one run environment per run|reuses a persisted run environment through resumeRun instead of recreating it|GET /api/runs|GET /api/run"`
- `cd monitor/v4 && npm run build`

PR2 validation:
- `npm run typecheck`
- `npx vitest run tests/agent-sandbox-platform.test.ts tests/config-loading.test.ts tests/agent-sandbox-backend.test.ts tests/execution-backend-factory.test.ts tests/dispatch-controller.test.ts`

PR3 validation:
- `npm run typecheck`
- `npx vitest run tests/agent-sandbox-backend.test.ts tests/execution-backend-factory.test.ts tests/orchestration-service.test.ts`

PR4 validation:
- `npm run typecheck`
- `npx vitest run tests/dispatch-controller.test.ts tests/execution-backend-factory.test.ts`

Live cluster verification after installing Agent Sandbox:
- `docker ps`
- `kubectl config current-context`
- `kind get clusters`
- `kubectl get crd | rg 'sandbox|agents.x-k8s.io|agent-sandbox'`
- `kubectl api-resources | rg 'sandbox'`
- `kubectl -n agent-sandbox-system rollout status statefulset/agent-sandbox-controller --timeout=120s`
- `kubectl explain sandboxtemplate.spec`
- `kubectl explain sandboxclaim.spec`
- `kubectl explain sandbox.spec`

## Live Cluster Changes Applied

Installed Agent Sandbox controller and CRDs into kind:

```bash
export VERSION=v0.1.0-rc.2
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/manifest.yaml
kubectl apply -f https://github.com/kubernetes-sigs/agent-sandbox/releases/download/${VERSION}/extensions.yaml
```

Observed live API resources:
- `sandboxes.agents.x-k8s.io/v1alpha1`
- `sandboxclaims.extensions.agents.x-k8s.io/v1alpha1`
- `sandboxtemplates.extensions.agents.x-k8s.io/v1alpha1`
- `sandboxwarmpools.extensions.agents.x-k8s.io/v1alpha1`

## What Is Still Not Complete

PR5 through PR9 remain open:
- sandbox lifecycle readiness/completion/cancellation semantics
- monitor visibility for sandbox lifecycle state
- snapshot/export integration for sandbox-hosted runs
- full Codex parity validation on sandbox-hosted runs
- full Claude parity validation on sandbox-hosted runs
- removal of `k8s-pod`
- removal of legacy Job-based whole-run hosting

Most importantly, the current SandboxClaim dispatch path is still incomplete for true end-to-end whole-run execution:
- it creates SandboxClaims behind the flag
- but it does not yet provision a real per-run `SandboxTemplate` with the SprintFoundry runner pod spec
- so it is not yet validated as a working replacement for the current Job host

## Current Technical Gap

The live CRD inspection shows the remaining missing step clearly:
- `SandboxTemplate.spec.podTemplate` is the real host-definition surface
- `SandboxClaim.spec` only references the template
- to finish the migration, dispatch must create or bind a SprintFoundry-specific `SandboxTemplate` carrying:
  - runner container image and command
  - whole-run env
  - project config and secret wiring
  - workspace PVC mount
  - resource limits and service account settings

Until that is implemented and validated, PR5+ cannot truthfully claim full whole-run Agent Sandbox hosting.

## Recommended Next Step

Implement the missing per-run `SandboxTemplate` provisioning path first, then validate one successful Codex run on kind before continuing with lifecycle cleanup and feature removals.

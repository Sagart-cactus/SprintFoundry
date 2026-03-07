---
title: "Build `KubernetesPodExecutionBackend` skeleton"
labels: [implementation, milestone-2, kubernetes]
milestone: "Milestone 2: Kubernetes run sandbox"
depends-on: ["#001", "#002"]
---

## Summary

Create `src/service/execution/k8s-pod-backend.ts` implementing `ExecutionBackend` using one Kubernetes Pod per run. Steps are dispatched into the running pod via the Kubernetes exec API. Wire to `DispatchController` so K8s mode is activated when `k8s_mode: true` in platform config.

## Background

The K8s multitenant plan requires every hosted run to execute inside a dedicated Kubernetes pod. One pod per run (not per step) preserves workspace state, enables session resume, and allows per-run security policies to be applied at the pod level.

## Implementation

| Method | Kubernetes operation |
|---|---|
| `prepareRunEnvironment` | Create a Pod from the job-template pattern; wait for `Running` phase |
| `executeStep` | K8s exec API (`ws-stream` exec into the running pod) |
| `pauseRun` | Log warning + no-op (deferred to future issue) |
| `resumeRun` | Log warning + no-op (deferred to future issue) |
| `teardownRun` | `deleteNamespacedPod` with `gracePeriodSeconds: 30` |

### Pod creation

- Base pod manifest on `k8s/base/job-template.yaml` (adapt from Job to Pod)
- Use `@kubernetes/client-node` for K8s API calls
- Pod name format: `sf-run-{run_id}` (truncated to 63 chars)
- `sandbox_id` = pod name

### `DispatchController` wiring

- When `k8s_mode: true` in platform config, inject `KubernetesPodExecutionBackend` into `AgentRunner`
- When K8s is not configured, `LocalExecutionBackend` remains the default (no regression)

### Notes

- PVC for workspace persistence is handled in issue #007
- Per-run service account is handled in issue #008

## Files to create

- `src/service/execution/k8s-pod-backend.ts`

## Files to modify

- `src/service/dispatch-controller.ts` — inject backend based on `k8s_mode` config

## Acceptance Criteria

- [ ] `KubernetesPodExecutionBackend` implements all 5 methods of `ExecutionBackend`
- [ ] `prepareRunEnvironment` creates exactly one Pod per run and waits for `Running` phase
- [ ] `executeStep` dispatches steps via K8s exec API (not new pod creation)
- [ ] `teardownRun` calls `deleteNamespacedPod`
- [ ] `DispatchController` uses this backend when `k8s_mode: true`
- [ ] `LocalExecutionBackend` remains default when K8s not configured
- [ ] `sandbox_id` = pod name, appears in `sandbox.created` event

## How to test

**Integration test** (using `kind` or `minikube`):
1. Set `k8s_mode: true` in platform config
2. Trigger a single-step run via `pnpm dev`
3. Assert a pod is created, step runs, pod deleted after teardown
4. Assert `.agent-result.json` is in the workspace volume

**Unit test** (mock `@kubernetes/client-node`):
- `prepareRunEnvironment` → calls `createNamespacedPod`
- `executeStep` → calls `connectGetNamespacedPodExec`
- `teardownRun` → calls `deleteNamespacedPod`

Run existing local tests to confirm no regression.

## Definition of Done

- `KubernetesPodExecutionBackend` compiles cleanly
- Integration test passes against a local `kind` cluster
- `DispatchController` wiring in place and documented
- No local mode regression
- Reviewed and merged

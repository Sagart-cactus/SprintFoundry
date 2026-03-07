---
title: "Per-run Kubernetes service account and RBAC"
labels: [security, milestone-2, kubernetes]
milestone: "Milestone 2: Kubernetes run sandbox"
depends-on: ["#006"]
---

## Summary

Create a dedicated Kubernetes `ServiceAccount` with minimal RBAC for each run. Agents should not run under the `default` service account, which may have broad permissions. Resources are cleaned up after teardown.

## Background

The K8s multitenant plan security baseline requires each run to have a "dedicated service account" with "short-lived projected credentials." This prevents one run from accessing Kubernetes resources belonging to another run or tenant.

## Changes

### `KubernetesPodExecutionBackend.prepareRunEnvironment`

1. Create `ServiceAccount` named `sf-run-{run_id}` in the run's namespace
2. Create `Role` granting read/write on `ConfigMaps` in the run's namespace only (no cluster-wide permissions)
3. Create `RoleBinding` binding the `ServiceAccount` to the `Role`
4. Reference the `ServiceAccount` in the pod spec (`spec.serviceAccountName`)
5. Store in `handle.metadata.service_account_ref`

### `KubernetesPodExecutionBackend.teardownRun`

Delete `ServiceAccount`, `Role`, and `RoleBinding` after pod deletion.

### `config/platform.yaml` additions

```yaml
k8s:
  run_namespace: sprintfoundry   # namespace for all runs
  # Future: namespace_per_tenant: false  (for stronger isolation)
```

### Tenancy model documentation

Document two models in code comments and `docs/decisions.md`:
1. **Label-based** (default): all runs in one namespace, labeled by `tenant_id` and `run_id`
2. **Namespace-based**: one namespace per tenant (stronger isolation, more overhead)

## Files to modify

- `src/service/execution/k8s-pod-backend.ts`
- `config/platform.yaml`
- `docs/decisions.md` (brief ADR note)

## Acceptance Criteria

- [ ] Each run pod references a dedicated `ServiceAccount` (not `default`)
- [ ] `Role` and `RoleBinding` created for each run and deleted on teardown
- [ ] Service account has NO cluster-wide permissions
- [ ] `service_account_ref` available in `RunEnvironmentHandle.metadata`
- [ ] Resources deleted in `teardownRun`
- [ ] `run_namespace` configurable in `platform.yaml`
- [ ] Tenancy models documented in `docs/decisions.md`

## How to test

**Integration test** (`kind`):
1. Start a run; while pod is running: `kubectl get sa,role,rolebinding -n sprintfoundry` — run-specific resources should exist
2. After run: resources should be deleted
3. `kubectl auth can-i create pods --as=system:serviceaccount:sprintfoundry:sf-run-{id}` — should return `no`

**Unit test** (mock K8s client):
- `prepareRunEnvironment` calls `createNamespacedServiceAccount`, `createNamespacedRole`, `createNamespacedRoleBinding` before `createNamespacedPod`

## Definition of Done

- Each run uses a dedicated minimal-permission service account
- Resources cleaned up after teardown
- Tenancy model documented
- Reviewed and merged

---
title: "Workspace persistence via PVC for Kubernetes runs"
labels: [implementation, milestone-2, kubernetes]
milestone: "Milestone 2: Kubernetes run sandbox"
depends-on: ["#006"]
---

## Summary

Replace the `emptyDir` workspace volume in K8s run pods with a `PersistentVolumeClaim` (PVC) so that workspace data survives pod restarts within the same run. Manage the PVC lifecycle alongside the pod.

## Background

K8s pods using `emptyDir` lose all workspace data if the pod is killed or evicted. The K8s multitenant plan requires workspace state to survive failure ("state must survive failure"). A PVC per run provides this durability.

## Changes

### `k8s/base/pvc-template.yaml` (new)

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: sf-workspace-${RUN_ID}
  namespace: ${NAMESPACE}
  labels:
    app: sprintfoundry
    run-id: ${RUN_ID}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: ${WORKSPACE_VOLUME_SIZE:-10Gi}
  storageClassName: ${WORKSPACE_STORAGE_CLASS:-""}  # empty = cluster default
```

### `KubernetesPodExecutionBackend.prepareRunEnvironment`

1. Create PVC `sf-workspace-{run_id}` before creating the pod
2. Pod spec `volumes` references the PVC (replacing `emptyDir`)
3. Set `handle.workspace_volume_ref = pvcName`

### `KubernetesPodExecutionBackend.teardownRun`

1. Delete the pod first
2. Delete the PVC after pod deletion
3. If PVC deletion fails: log error, do NOT throw (don't block teardown)

### `config/platform.yaml` additions

```yaml
k8s:
  workspace_storage_class: ""    # empty = cluster default StorageClass
  workspace_volume_size: "10Gi"  # configurable per-project
```

## Files to create

- `k8s/base/pvc-template.yaml`

## Files to modify

- `src/service/execution/k8s-pod-backend.ts`
- `k8s/base/job-template.yaml` (update volume pattern reference)
- `config/platform.yaml`

## Acceptance Criteria

- [ ] A PVC named `sf-workspace-{run_id}` is created before the pod starts
- [ ] The pod mounts the PVC at `/workspace`
- [ ] Simulated pod kill + restart: workspace files still present
- [ ] PVC deleted after `teardownRun` completes
- [ ] PVC deletion failure logs an error but does not throw
- [ ] `workspace_volume_ref` in `RunEnvironmentHandle` = PVC name
- [ ] `workspace_volume_ref` appears in `sandbox.created` event payload
- [ ] Storage class and size configurable in `platform.yaml`

## How to test

**Integration test** (`kind`):
1. Start a run that writes a file in step 1
2. Force-kill pod: `kubectl delete pod --grace-period=0 --force sf-run-{id}`
3. Confirm orchestrator restarts pod and file is still present
4. After run: `kubectl get pvc -n sprintfoundry` — PVC should be gone

**Unit test** (mock K8s client):
- `prepareRunEnvironment` calls `createNamespacedPersistentVolumeClaim` before `createNamespacedPod`
- `teardownRun` calls `deleteNamespacedPersistentVolumeClaim` after `deleteNamespacedPod`

## Definition of Done

- PVC created and mounted for every K8s run
- Workspace survives pod restart
- PVC cleaned up after teardown
- Storage class and size configurable
- Reviewed and merged

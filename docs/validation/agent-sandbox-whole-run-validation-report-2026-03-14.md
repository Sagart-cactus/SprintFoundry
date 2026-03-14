# Agent Sandbox Whole-Run Validation Report

Date: 2026-03-14

Branch: `feature/agent-sandbox-whole-run`

## Scope

This validation covered the integrated Agent Sandbox whole-run migration after:

- SandboxClaim dispatch replaced legacy whole-run Job hosting
- `k8s-pod` backend removal
- snapshot/export + restore integration
- cleanup/reconciliation semantics
- monitor/session metadata updates for `hosting_mode` and terminal workflow state

## Kind Environment

Cluster:

- kind cluster: `sf-e2e`
- control plane namespace: `sprintfoundry-system`
- historical whole-run namespace: `sf-whole-run-e2e`
- snapshot bucket: `sprintfoundry-run-snapshots`
- MinIO namespace: `sf-snapshot-e2e`

Required components present during validation:

- Agent Sandbox CRDs/controllers
- SprintFoundry `dispatch-controller`, `event-api`, `monitor`
- snapshot storage backed by MinIO

## Images

Validation used these successive runner images while fixing live issues:

- `sprintfoundry-runner:agent-sandbox-whole-run-20260314-1548`
- `sprintfoundry-runner:agent-sandbox-whole-run-20260314-1610`

Final validation was performed against:

- `sprintfoundry-runner:agent-sandbox-whole-run-20260314-1610`

## Commands Used

Representative commands used during final integrated validation:

```bash
npm run typecheck
npx vitest run \
  tests/agent-sandbox-platform.test.ts \
  tests/api/monitor-routes.test.ts \
  tests/dispatch-controller.test.ts \
  tests/execution-backend-factory.test.ts \
  tests/k8s-run-snapshot-controller.test.ts \
  tests/run-snapshot-store.test.ts \
  tests/session-manager.test.ts
npm run build
```

Snapshot reconcile:

```bash
kubectl -n sprintfoundry-system exec <dispatch-controller-pod> -- \
  node --input-type=module -e '... new K8sRunSnapshotController({ namespace }).reconcileOnce() ...'
```

Local restore:

```bash
SPRINTFOUNDRY_SNAPSHOT_BUCKET=sprintfoundry-run-snapshots \
SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT=http://127.0.0.1:19000 \
SPRINTFOUNDRY_SNAPSHOT_S3_REGION=us-east-1 \
SPRINTFOUNDRY_SNAPSHOT_S3_FORCE_PATH_STYLE=1 \
AWS_ACCESS_KEY_ID=minioadmin \
AWS_SECRET_ACCESS_KEY=minioadmin123 \
node dist/index.js restore <run-id> --config <config-dir> --project <project-id> --destination <dir>
```

## Integrated Validation Matrix

### Historical shared-namespace matrix

These runs were executed on the migrated code path and used as the main end-to-end parity matrix while iterating on cancellation, snapshot, restore, and cleanup:

- Codex success: `run-1773476384563-codexok3`
- Codex failed: `run-1773476387596-codexauthfail2`
- Codex cancelled: `run-1773476390579-codexcancel5`
- Claude success: `run-1773476393614-claudeok3`
- Claude failed: `run-1773476396597-claudeauthfail2`
- Claude cancelled: `run-1773476399656-claudecancel2`

Validated outcomes:

- one run created one sandbox host
- no nested `k8s-pod` step sandboxes were created
- `hosting_mode=k8s-agent-sandbox`
- terminal states persisted (`completed`, `failed`, `cancelled`)
- snapshots exported to MinIO
- local restore worked for successful Codex and Claude runs
- restored runtime home state was preserved for Codex and Claude

Restore validation examples:

- Codex restore: `run-1773476384563-codexok3` -> `/tmp/restore-codexok3`
- Claude restore: `run-1773476393614-claudeok3` -> `/tmp/restore-claudeok3`
- Failed Codex restore: `run-1773476387596-codexauthfail2` -> `/tmp/restore-codexauthfail2`

### Fresh per-project namespace validation on final image

These runs were launched after the final control-plane fixes on image `...-1610`:

- Codex explicit provider run: `run-1773479501423-6389cf32`
- Claude explicit provider run: `run-1773479501442-a2cf4834`

Observed provider/runtime evidence from runner logs:

- Codex:
  - `provider=openai`
  - `runtime=codex/local_process`
  - `hosting_mode=k8s-agent-sandbox`
  - run completed successfully
- Claude:
  - `provider=anthropic`
  - `runtime=claude-code/local_process`
  - `hosting_mode=k8s-agent-sandbox`
  - step failed under Claude runtime as expected for the invalid-model validation project

Post-terminal cleanup for both of these fresh runs was validated:

- snapshot exporter jobs completed
- sandbox claims/templates were released
- terminal pods were removed
- PVCs were deleted
- uploaded session records show:
  - `terminal_workflow_state=cleanup_completed`
  - `durable_snapshot.status=completed`

## Issues Found And Fixes Made

1. Snapshot cleanup candidates were lost after sandbox resources disappeared.

- Fix: include successful snapshot exporter jobs as reconciliation candidates so PVC cleanup can continue after claim/pod teardown.

2. Cleanup metadata update used the external S3 endpoint from inside the cluster.

- Fix: prefer `SPRINTFOUNDRY_SNAPSHOT_S3_ENDPOINT_IN_CLUSTER` in `RunSnapshotStore`.

3. Cleanup metadata was not backfilled when PVC deletion had already succeeded.

- Fix: make `cleanup_completed` idempotent and backfillable when PVC is already absent.

4. Session-backed monitor detail lost persisted `terminal_workflow_state`.

- Fix: carry matched session metadata into `loadRun()` and prefer persisted `cleanup_completed` over older cleanup-failure events.

5. Raw platform config still had `k8s.agent_sandbox.enabled: false`.

- Fix: enable Agent Sandbox in both `config/platform.yaml` and the Helm-rendered platform config.

6. Runner pods re-ran CRD validation inside an already-hosted sandbox and failed.

- Fix: skip CRD discovery validation when already executing inside `SPRINTFOUNDRY_HOSTING_MODE=k8s-agent-sandbox` + `SPRINTFOUNDRY_RUN_SANDBOX_MODE=k8s-whole-run`.

7. Legacy `k8s-pod` references still existed in execution backend selection.

- Fix: remove backend implementation and fail fast on old configs requesting `k8s-pod`.

8. Whole-run cleanup lacked cancellation event propagation.

- Fix: emit `task.cancelled`, persist `completed_at`, and treat cancelled runs as terminal for snapshot/export.

## Remaining Limitations

- Harness-created ad hoc validation runs that bypass the normal event-ingested dispatch path did not produce monitor DB cleanup events because the harness did not fully mirror the production event-sink wiring. Their durable uploaded session state did reach `cleanup_completed`, and their Kubernetes resources were cleaned up successfully.
- The older intentionally broken validation attempts in `sf-whole-run-codex-fail` and `sf-whole-run-claude-fail` left failed snapshot-export jobs in those namespaces. They do not block the validated final runs, but they remain as historical failed jobs.

## Conclusion

The integrated feature branch now runs whole-run Kubernetes hosting through Agent Sandbox/SandboxClaim, executes steps locally inside the sandbox, removes `k8s-pod`, exports durable snapshots, supports local restore, and cleans up terminal sandbox resources. Final validation covered both Codex and Claude runtime paths on a real kind cluster and confirmed durable `cleanup_completed` state on the final explicit-provider runs.

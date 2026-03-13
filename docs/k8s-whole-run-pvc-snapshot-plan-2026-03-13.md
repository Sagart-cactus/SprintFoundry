# K8s Whole-Run PVC Snapshot And Local Resume Plan

Date: 2026-03-13
Status: Proposed

## Goal

Persist enough whole-run K8s workspace state to durable storage after a run reaches a terminal state so the run can later be restored onto a developer machine and resumed with the local execution backend.

Target terminal states:

- completed
- failed
- cancelled / halted

Primary target:

- whole-run Kubernetes Job mode created by the dispatch controller
- one Job pod per run
- one PVC per run mounted at `/workspace`
- local step execution inside the runner pod

## Spike Result

Live kind spike completed on 2026-03-13:

- launched a whole-run direct-agent Codex job on `kind` in `sf-whole-run-e2e`
- copied the workspace from the PVC before the job completed
- resumed locally with `codex exec resume <session_id>` against the copied workspace
- verified the local resumed run could continue work in the copied workspace
- also tested the same `session_id` in an empty local directory

Observed result:

- workspace copy from PVC is sufficient to continue useful work locally
- provider-side `codex resume <session_id>` by itself did not recover meaningful prior task context in an empty directory
- the practical recovery mechanism is therefore **workspace restore first**, with runtime session resume treated as a best-effort accelerator rather than the source of truth

Implication:

- the durable storage design should optimize for restoring the run workspace and SprintFoundry/runtime metadata
- it should not assume Claude/Codex remote session state alone is enough for cross-machine recovery

## Current State

The current whole-run flow already puts the critical run state on the per-run PVC:

- the run workspace lives under `SPRINTFOUNDRY_RUNS_ROOT=/workspace`
- session metadata lives under `SPRINTFOUNDRY_SESSIONS_DIR=/workspace/.sprintfoundry/sessions`
- run state is written to `.sprintfoundry/run-state.json`
- runtime session resume records are written to `.sprintfoundry/sessions.json`
- step results, runtime logs, and `.events.jsonl` live in the workspace

Relevant code paths:

- dispatch whole-run Job env and PVC mount: `src/service/dispatch-controller.ts`
- workspace path resolution: `src/service/workspace-manager.ts`
- session persistence: `src/service/session-manager.ts`
- run state persistence and resume: `src/service/orchestration-service.ts`
- partial S3 artifact upload: `src/service/artifact-uploader.ts`

Important constraint:

- local resume currently requires a local `workspace_path` in the session file plus the workspace contents needed by `resumeTask()`
- `resumeTask()` currently allows failed and cancelled runs, and in-progress recovery when explicitly requested
- completed runs are restorable for inspection, but not currently resumable without changing resume semantics

## What Must Be Restored

For a local restore to work, the exported snapshot should include at minimum:

- the run workspace directory
- `.sprintfoundry/run-state.json`
- `.events.jsonl`
- `.sprintfoundry/sessions.json`
- `.sprintfoundry/step-results/**`
- `artifacts/**`
- the repo checkout, including `.git`
- runtime-scoped skill/config state stored inside the workspace such as `.codex-home/**` and `.claude/**`
- the run session file for that specific run from `/workspace/.sprintfoundry/sessions/<run_id>.json`

It should not blindly export the entire PVC. In whole-run mode the PVC also contains `/workspace/home`, and the repo checkout may contain embedded credentials in `.git/config` if the clone URL included a token.

## Recommended Design

### 1. Introduce A Run Snapshot Service

Add a dedicated service instead of overloading `ArtifactUploader`.

Suggested new component:

- `src/service/run-snapshot-store.ts`

Responsibilities:

- package a restorable run snapshot
- write a manifest describing what was exported
- upload archive + manifest to S3 or another durable backend
- download and restore a snapshot onto a local machine

Snapshot object layout:

- `s3://<bucket>/tenants/<tenant>/projects/<project>/runs/<run_id>/snapshot/manifest.json`
- `s3://<bucket>/tenants/<tenant>/projects/<project>/runs/<run_id>/snapshot/workspace.tar.zst`

Manifest fields:

- `run_id`
- `project_id`
- `tenant_id`
- `terminal_status`
- `export_reason`
- `created_at`
- `archive_key`
- `archive_sha256`
- `archive_size_bytes`
- `compression`
- `source_backend`
- `source_workspace_volume_ref`
- `restorable_paths`
- `excluded_paths`
- `sanitization_applied`
- `schema_version`

### 2. Export A Minimal Restorable Bundle

Export only the run-scoped paths needed for restore:

- `/workspace/sprintfoundry/<project_id>/<run_id>`
- `/workspace/.sprintfoundry/sessions/<run_id>.json`

Sanitize before archiving:

- remove `/workspace/home/**` by default
- scrub credentials from `.git/config`
- never include projected secrets mounts
- optionally redact known auth files if they were copied into the workspace

Reasoning:

- local resume uses a local machine's credentials, not the runner pod's home directory
- keeping the bundle run-scoped makes retention and restore much simpler
- exporting the full PVC increases leakage risk and size for little resume benefit

### 3. Trigger Export Outside The Runner Process

Recommended target design:

- create a one-shot exporter Job after the run reaches a terminal state
- mount the run PVC read-only into the exporter Job
- upload snapshot from that exporter Job
- only delete the PVC after snapshot success, or after retention timeout if snapshot is intentionally disabled

Why not rely on the runner process to upload on exit:

- clean completion would work
- abrupt failure, OOM, node loss, pod deletion, or forced halt would be unreliable

Why an exporter Job is better:

- it decouples snapshot success from runner process health
- it can run even after the main Job pod has already exited
- it gives a clean place to add retry and observability

Trigger options:

- preferred: a small K8s cleanup/snapshot controller that watches terminal run state and launches the exporter Job
- acceptable MVP: dispatch controller or another worker watches terminal Job state and creates the exporter Job before TTL GC removes the Job

### 4. Persist Snapshot Metadata In The Existing Session Model

Extend `RunSessionMetadata` with durable snapshot metadata.

Suggested shape:

```ts
durable_snapshot?: {
  status: "pending" | "uploading" | "completed" | "failed";
  backend: "s3";
  bucket: string;
  manifest_key: string;
  archive_key: string;
  archive_sha256: string;
  archive_size_bytes: number;
  terminal_status: "completed" | "failed" | "cancelled";
  exported_at: string;
  restore_hint?: string;
  error?: string | null;
}
```

This should be stored in:

- the local session file
- the event sink run record, when configured

Also add snapshot lifecycle events:

- `workspace.snapshot.started`
- `workspace.snapshot.completed`
- `workspace.snapshot.failed`
- `workspace.snapshot.restored`

### 5. Add A Local Restore Command

Add a dedicated restore/import command rather than making `resume` fetch from S3 implicitly.

Suggested CLI:

- `sprintfoundry restore --run <run_id>`

Flow:

1. read session metadata or query the event sink for snapshot pointers
2. download `manifest.json` and `workspace.tar.zst`
3. restore into the local runs root from `WorkspaceManager`
4. rewrite the local session file so `workspace_path` points to the restored local path
5. clear or replace cluster-only fields that are no longer valid locally
6. let the user run `sprintfoundry resume <run_id>`

On restore, rewrite run metadata as follows:

- set `workspace_path` to the local restored path
- keep `run_id`, `project_id`, step history, token usage, and event history
- set `workspace_volume_ref` to `null` in restored session metadata or preserve it only inside informational metadata
- replace `run_environment` with a local fallback handle before the resumed run persists again

### 6. Keep Completed-Run Restore Separate From Resume

Current behavior only resumes failed and cancelled runs.

Recommendation:

- keep that behavior for the first version
- allow completed snapshots to be restored for inspection, diffing, artifact retrieval, or manual replay
- if later needed, add an explicit "replay from step" workflow for completed runs instead of silently treating them as resumable

## Detailed Execution Flow

### Cluster-side export

1. whole-run Job reaches terminal state
2. controller sees terminal state and the run's `workspace_volume_ref`
3. controller creates exporter Job with:
   - PVC mounted read-only
   - snapshot destination bucket/prefix
   - run labels and run id
4. exporter:
   - copies the run-scoped session file and workspace into a staging dir
   - scrubs `.git/config` credentials
   - creates `manifest.json`
   - writes `workspace.tar.zst`
   - uploads both objects
5. exporter records success or failure into session metadata and events
6. after success, PVC deletion can proceed

### Local restore and resume

1. operator runs `sprintfoundry restore --run <run_id>`
2. local CLI downloads archive + manifest
3. local CLI restores workspace under the local runs root
4. local CLI writes `~/.sprintfoundry/sessions/<run_id>.json` with the restored `workspace_path`
5. operator runs `sprintfoundry resume <run_id>`
6. backend resolution remains `local` unless explicitly overridden

## Security And Data Hygiene

Required:

- encrypt snapshot objects at rest, preferably SSE-KMS
- store snapshots under per-tenant prefixes
- add a maximum archive size guardrail
- redact tokens from `.git/config`
- exclude `/workspace/home/**` unless a future provider proves it is required
- avoid restoring runner-pod-specific service-account state onto laptops

Recommended:

- write a sanitized copy into a temporary staging directory before tar creation
- record exactly which paths were included and excluded in the manifest
- make restore refuse unknown manifest schema versions

## Retention And Cleanup

Retention policy should be independent from PVC lifetime.

Recommended behavior:

- on snapshot success, PVC becomes eligible for deletion immediately
- on snapshot failure, keep the PVC and surface the failure in run metadata
- apply S3 lifecycle retention by prefix
- optionally retain completed snapshots for a shorter period than failed/cancelled ones

## Rollout Plan

### Phase 1: Snapshot format and local restore

- add `RunSnapshotStore`
- add archive manifest schema
- add local `restore` command
- manually test with a workspace copied from disk

### Phase 2: Cluster exporter Job

- add exporter image/command
- add controller logic to launch exporter Jobs for terminal whole-run runs
- persist snapshot metadata to session + event sink

### Phase 3: PVC cleanup coordination

- delete PVC only after successful snapshot export
- otherwise retain PVC for manual recovery

### Phase 4: Observability and policy

- add monitor-visible snapshot status
- add retention configuration
- add per-project enablement flags

## Suggested Config

Platform-level:

```yaml
durable_workspace_snapshots:
  enabled: true
  backend: s3
  bucket: sprintfoundry-run-snapshots
  prefix: tenants
  compression: zstd
  kms_key_id: alias/sprintfoundry-snapshots
  export_on:
    - completed
    - failed
    - cancelled
  retain_completed_days: 7
  retain_failed_days: 30
  max_archive_size_mb: 2048
  include_workspace_home: false
```

## Validation Plan

Unit tests:

- manifest creation
- archive allowlist / exclude rules
- `.git/config` sanitization
- session metadata updates
- local restore path rewrite

Integration tests:

- restore a failed whole-run snapshot and resume locally
- restore a cancelled whole-run snapshot and resume locally
- restore a completed whole-run snapshot for inspection
- exporter failure keeps PVC and marks snapshot failed

Kind / end-to-end:

- whole-run K8s Job writes to PVC
- terminal run triggers exporter Job
- snapshot appears in S3-compatible storage
- PVC is deleted only after successful export
- restored run resumes locally from the expected step

## Recommended First Implementation Cut

Build the first version around:

- run-scoped archive only, not full PVC export
- S3 as the only durable backend
- explicit local `restore` command
- exporter Job, not in-process upload
- no resume support for completed runs

That gets the system to a usable and reviewable state without coupling resume semantics, retention policy, and cluster cleanup into one large change.

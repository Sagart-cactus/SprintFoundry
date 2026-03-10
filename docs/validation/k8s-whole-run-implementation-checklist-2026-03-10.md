# K8s Whole-Run Implementation Checklist

Date: 2026-03-10
Branch: `codex/sandbox-validation-20260310`

## Goal

Replace nested K8s step sandboxes with a whole-run K8s pod model:

- one Kubernetes Job per run
- one PVC per run
- one runner pod owns the full run workspace
- Codex and Claude runtime home/state live on that PVC
- pod restart can recover and resume the same run

This task is complete only after a successful end-to-end validation on the kind cluster.

## Phase 1: Runner Pod And PVC Plumbing

- [x] Add explicit whole-run K8s mode flags for the runner pod
- [x] Create one PVC per run in dispatch K8s mode
- [x] Mount the PVC into the runner pod at `/workspace`
- [x] Replace `emptyDir` workspace use in the dispatch Job manifest
- [x] Set runner env for PVC-backed state:
  - [x] `SPRINTFOUNDRY_RUN_ID`
  - [x] `SPRINTFOUNDRY_RUN_SANDBOX_MODE=k8s-whole-run`
  - [x] `SPRINTFOUNDRY_RUNS_ROOT=/workspace`
  - [x] `SPRINTFOUNDRY_SESSIONS_DIR=/workspace/.sprintfoundry/sessions`
  - [x] `HOME=/workspace/home`
  - [x] `CODEX_HOME=/workspace/home/.codex`
- [x] Ensure PVC create is idempotent for retries/recovery

## Phase 2: Whole-Run Execution Semantics

- [x] Force K8s whole-run jobs to use local step execution inside the runner pod
- [x] Ensure K8s whole-run jobs do not create nested `k8s-pod` step sandboxes
- [x] Force whole-run K8s mode to use tmpdir workspace behavior, not worktree
- [x] Make workspace creation stable on the PVC across retries
- [x] Ensure dispatch-provided `run_id` becomes the actual SprintFoundry run ID

## Phase 3: Durable Runtime State And Recovery

- [x] Make `SessionManager` respect PVC-backed session storage via env override
- [x] Keep run state, events, runtime logs, and runtime session records on the PVC
- [x] Make Codex config/auth writes honor `CODEX_HOME`
- [x] Ensure Claude runtime uses the PVC-backed `HOME`
- [x] Support auto-resume when a runner pod restarts with the same `run_id`
- [x] Allow crash recovery from an `executing` run state
- [x] Mark in-flight steps interrupted during recovery and replay them

## Phase 4: Kind End-To-End Validation

- [x] Build or stage the updated runner code for kind
- [x] Provision config/secret inputs for a test project
- [x] Start a real whole-run Codex job on kind
- [x] Verify the runner Job creates a PVC-backed pod
- [x] Verify the run completes successfully end-to-end on kind
- [x] Verify the run commits, pushes, and creates a PR from inside the pod
- [x] Verify no nested step sandbox pod is created for normal K8s whole-run execution

## Phase 5: Automated Validation

- [x] Add or update unit tests for dispatch PVC/job manifests
- [x] Add or update tests for workspace/session env overrides
- [x] Add or update tests for execution backend resolution in K8s whole-run mode
- [x] Add or update tests for auto-resume/recovery behavior
- [x] Add or update tests for Codex whole-run sandbox behavior
- [x] Add or update tests for repo-local git identity in run pods
- [x] Run targeted profiles:
  - [x] runtime
  - [x] orchestration
  - [x] relevant dispatch/controller tests

## Phase 6: Recovery Validation On Kind

- [x] Start a real run and interrupt the first runner pod mid-step
- [x] Verify Kubernetes creates a replacement Job pod for the same run
- [x] Verify the resumed pod reuses the same PVC
- [x] Verify SprintFoundry detects existing run state and resumes
- [x] Verify interrupted step replay completes successfully
- [x] Verify the recovered run still pushes and creates a PR

## Exit Criteria

- [x] Code changes are implemented
- [x] Automated validation is green
- [x] Whole-run kind execution passes
- [x] Kind recovery/resume validation passes
- [x] Remaining limitations, if any, are documented

# K8s Whole-Run Validation Report

Date: 2026-03-10
Branch: `codex/sandbox-validation-20260310`

## Scope

This validation covered the whole-run Kubernetes execution model:

- one runner Job pod per run
- one PVC per run
- local step execution inside the runner pod
- PVC-backed runtime/session state
- pod restart recovery for an in-progress run

Validation used the real `kind-sf-e2e` cluster in namespace `sf-whole-run-e2e`.

## What Changed

- Dispatch K8s jobs now provision one PVC per run and mount it at `/workspace`.
- Whole-run runner pods set `SPRINTFOUNDRY_RUN_SANDBOX_MODE=k8s-whole-run`, `SPRINTFOUNDRY_RUNS_ROOT=/workspace`, `SPRINTFOUNDRY_SESSIONS_DIR=/workspace/.sprintfoundry/sessions`, `HOME=/workspace/home`, and `CODEX_HOME=/workspace/home/.codex`.
- Whole-run K8s mode forces local step execution so no nested `k8s-pod` sandbox is created.
- Codex config/auth writes now honor `CODEX_HOME`.
- Run/session persistence is PVC-backed and the CLI auto-resumes when the same `run_id` restarts.
- Codex local execution now bypasses its inner sandbox inside whole-run K8s pods.
- Git checkpoint/PR commits now ensure repo-local git identity inside runner pods.

## Automated Validation

Passed:

- `pnpm exec tsc --pretty false`
- `pnpm vitest run tests/dispatch-controller.test.ts tests/execution-backend-factory.test.ts tests/workspace-manager.test.ts tests/session-manager.test.ts tests/codex-planner-runtime.test.ts tests/orchestration-service.test.ts`
- `pnpm vitest run tests/codex-runtime-sdk.test.ts`
- `pnpm vitest run tests/codex-runtime-sdk.test.ts tests/git-manager.test.ts`
- `run_sprintfoundry_test_matrix.sh --profile runtime`
- `run_sprintfoundry_test_matrix.sh --profile orchestration`

Totals from the final matrix runs:

- `runtime`: 6 files, 75 tests passed
- `orchestration`: 5 files, 115 tests passed

## Kind Validation

### Successful whole-run execution

- Run ID: `sf-whole-run-codex-e2e-234956`
- Image: `sprintfoundry-runner:sandbox-20260308-222735-otelprop`
- PVC: `sf-run-ws-sf-whole-run-codex-e2e-234956`
- Result:
  - single runner pod completed on kind
  - execution backend resolved to `local`
  - no nested sandbox pod was created
  - branch pushed successfully
  - PR created successfully: `https://github.com/Sagart-cactus/sf-k8s-whole-run-20260310-11024/pull/1`

### Successful recovery after pod interruption

- Run ID: `sf-whole-run-recovery-e2e-235340`
- Image: `sprintfoundry-runner:sandbox-20260308-222735-otelprop`
- PVC: `sf-run-ws-sf-whole-run-recovery-e2e-235340`
- First pod: `sf-sf-whole-run-recovery-e2e-235340-j9vhq`
- Replacement pod: `sf-sf-whole-run-recovery-e2e-235340-km7zz`
- Result:
  - first pod was explicitly deleted mid-step
  - Job created a replacement pod for the same run
  - replacement pod detected existing run state and resumed:
    - `Detected existing run state for sf-whole-run-recovery-e2e-235340; attempting recovery/resume.`
    - `sandbox.resumed`
  - same PVC remained bound across the interruption
  - recovered run completed and created PR `https://github.com/Sagart-cactus/sf-k8s-whole-run-20260310-11024/pull/3`

## Failures Found And Resolved

Distinct failures during this effort: 5

1. Live `dist` mounted at `/opt/sprintfoundry-live/dist` broke Node module resolution.
- Symptom: `ERR_MODULE_NOT_FOUND` for `commander`
- Resolution: mount the live build over `/opt/sprintfoundry/dist` so runtime module resolution matches the image layout

2. Codex nested sandboxing failed inside the K8s run pod.
- Symptom: `Sandbox(LandlockRestrict)` blocked all file edits and shell commands
- Resolution: in whole-run K8s mode, default Codex to `--dangerously-bypass-approvals-and-sandbox` for CLI and `danger-full-access` for SDK

3. Git checkpoint commits failed in the runner pod.
- Symptom: `Author identity unknown`
- Resolution: ensure repo-local `user.name` and `user.email` before checkpoint, push, and PR commit paths

4. PR creation failed when validating against the stale `sprintfoundry-runner:latest` image.
- Symptom: fallback manual PR string because `gh` was not present in that image
- Resolution: switch kind validation to the newer loaded runner image `sprintfoundry-runner:sandbox-20260308-222735-otelprop` while keeping the new code mounted via hostPath

5. Initial recovery attempt did not actually interrupt the run.
- Symptom: the pod completed normally before recovery could be observed
- Resolution: explicitly delete the first runner pod resource early in the step so the Job controller creates a replacement pod and exercises resume logic

## Remaining Limitations

- The live kind validation in this report used actual Job/PVC manifests produced from the dispatch manifest builder, not the HTTP dispatch queue path. The local `redis` package in this workspace is still a stub and does not expose the list primitives needed for a live dispatch server queue loop.
- The `latest` runner image currently loaded in kind is stale. Validation succeeded by mounting the rebuilt `dist` into the pod and using a newer preloaded runner image that already contains `gh`, `git`, and `codex`.

## Conclusion

Whole-run K8s execution is validated on kind for:

- PVC-backed runner workspaces
- local step execution inside the runner pod
- Codex execution in the pod without nested sandbox failures
- repo commit/push/PR flow from inside the pod
- interrupted pod recovery using the same `run_id` and PVC

This work is certified as passing the intended whole-run kind validation and recovery checks.

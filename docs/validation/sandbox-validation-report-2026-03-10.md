# Sandbox Validation Report

Date: 2026-03-10
Branch: `codex/sandbox-validation-20260310`
Base feature branch: `codex/non-issues-changes-20260310`

## Summary

Sandbox validation is partially certified.

Coverage counts:

- 3 live backend scenarios executed
- 3 config `doctor` checks passed
- 3 config `validate` checks passed
- 4 automated validation groups passed (`typecheck`, `typecheck:tests`, runtime/monitor/orchestration profiles, backend-focused suite)

Failure counts:

- 5 distinct failures encountered during validation
- 4 resolved
- 1 unresolved product/runtime gap remains

Certified:

- orchestration-owned sandbox metadata and lifecycle emission
- `local` execution backend with a live Codex-driven run
- `docker` execution backend with a live container-backed run on its supported runtime path
- backend selection/factory behavior and most sandbox lifecycle codepaths through automated tests

Not yet certified:

- end-to-end `k8s-pod` step execution
- any live `docker` or `k8s-pod` run driven by `codex` runtime providers
- live `agent-sandbox` execution

## Environment

- Host: local macOS workspace
- Docker daemon: available and healthy (`29.0.1`)
- Kubernetes: `kind-sf-e2e` context, single-node cluster
- Credentials present: OpenAI and Anthropic

## Product Constraints Observed

- `docker` and `k8s-pod` execution backends currently reject `codex` runtime providers and only support `claude-code` step execution.
- `agent-sandbox` backend was not live-tested because the cluster does not expose the required CRDs.

## Automated Coverage

Executed successfully:

- `pnpm typecheck`
- `pnpm typecheck:tests`
- runtime profile: 6 files, 73 tests
- monitor profile: 3 files, 68 tests
- orchestration profile: 5 files, 113 tests
- backend-focused suite:
  - `tests/execution-backend.test.ts`
  - `tests/execution-backend-factory.test.ts`
  - `tests/docker-execution-backend.test.ts`
  - `tests/k8s-pod-execution-backend.test.ts`
  - `tests/agent-sandbox-backend.test.ts`
  - `tests/taskrun-types.test.ts`

Additional note:

- `pnpm test` executed without assertion failures in both default and serialized modes, but Vitest did not exit cleanly afterward under the local Node 25.6.1 environment. I treated that as a tooling stability issue, not as a passing certification signal.

## Live Runs

### 1. Local backend with Codex

Command shape:

- `run --config /tmp/.../config-local --source prompt --agent developer`

Result:

- passed
- run id: `run-1773079212969-yc21t9`
- backend: `local`
- runtime: `codex/local_process`

Evidence:

- `sandbox.created` emitted with `execution_backend=local`
- `step.completed` emitted with `runtime.provider=codex`
- `sandbox.destroyed` emitted with `reason=completed`
- artifact created: `sandbox-local.txt`

### 2. Docker backend live smoke

Command shape:

- `run --config /tmp/.../config-docker --source prompt --agent developer`

Result:

- passed
- run id: `run-1773079470914-fhqjbh`
- backend: `docker`
- runtime: `claude-code/local_process`

Evidence:

- detached sandbox container created successfully
- step executed via `docker exec`
- `step.completed` emitted with `execution_backend=docker`
- `sandbox.destroyed` emitted after `docker rm -f`
- artifact created: `sandbox-docker.txt`

### 3. Kubernetes pod backend live smoke

Command shape:

- `run --config /tmp/.../config-k8s --source prompt --agent developer`

Attempts:

1. `run-1773079682916-361r3v`
   - failed before pod readiness
   - root cause: pod security context used `runAsNonRoot` with an image whose user was non-numeric in the pod spec
   - resolution: set `runAsUser`, `runAsGroup`, and `fsGroup` to `1001` in the K8s pod manifest

2. `run-1773079798557-9os8u7`
   - pod started, but step failed and the process crashed afterward
   - root cause 1: client-node exec wrapper used write-only objects without `.end()`
   - resolution: switched stdout/stderr capture to `PassThrough` streams
   - root cause 2 remained: no `.agent-result.json` visible in the host workspace

3. `run-1773079895963-av57xk`
   - failed cleanly without the exec crash
   - remaining root cause: host workspace and pod PVC workspace are not synchronized

Direct evidence for the remaining K8s blocker:

- after the failed run, the preserved PVC `sf-pod-run-1773079895963-av57xk-workspace` was mounted into a debug pod
- `/workspace` inside that PVC was empty
- the host workspace path for the run was separate and contained the prepared task files

Conclusion:

- K8s provisioning now works in this cluster with the numeric UID/GID fix
- K8s exec transport no longer crashes
- end-to-end K8s step execution is still blocked because the sandbox pod does not receive the prepared workspace contents

## Failures Encountered And Resolution

Resolved:

1. Validation harness bootstrap failed because the temporary bare Git remote did not point `HEAD` to `main`.
   - fixed by setting `symbolic-ref HEAD refs/heads/main`

2. `typecheck:tests` failed because several tests did not include newly-required `runId` / `run_id` fields.
   - fixed by updating the affected test fixtures

3. K8s pod startup failed under `runAsNonRoot`.
   - fixed by setting numeric pod security context IDs (`1001`)

4. K8s exec transport crashed in `@kubernetes/client-node` because fake writable objects lacked `.end()`.
   - fixed by using `PassThrough` streams

Operational-only:

5. Docker developer image build initially failed because it raced the base image build.
   - resolved by building `sprintfoundry/agent-base:latest` first, then `sprintfoundry/agent-developer:latest`

Unresolved:

1. `k8s-pod` backend does not synchronize the prepared host workspace into the PVC-backed pod workspace.
   - impact: the pod can start, but the agent runtime does not produce a result in the host workspace, and K8s end-to-end step execution is not certified

2. `pnpm test` does not exit cleanly under this local Node/Vitest environment even after all emitted test files are green.
   - impact: full-suite execution is high-confidence but not a clean single-command certification signal

## Files Changed During Validation

Code/test fixes:

- [src/service/execution/k8s-pod-backend.ts](/Users/trivedi/Documents/Projects/agentsdlc/src/service/execution/k8s-pod-backend.ts)
- [tests/k8s-pod-execution-backend.test.ts](/Users/trivedi/Documents/Projects/agentsdlc/tests/k8s-pod-execution-backend.test.ts)
- [tests/claude-code-runtime.test.ts](/Users/trivedi/Documents/Projects/agentsdlc/tests/claude-code-runtime.test.ts)
- [tests/codex-local-sdk-code-review-skills.integration.test.ts](/Users/trivedi/Documents/Projects/agentsdlc/tests/codex-local-sdk-code-review-skills.integration.test.ts)
- [tests/codex-runtime-sdk.test.ts](/Users/trivedi/Documents/Projects/agentsdlc/tests/codex-runtime-sdk.test.ts)
- [tests/codex-runtime-security.test.ts](/Users/trivedi/Documents/Projects/agentsdlc/tests/codex-runtime-security.test.ts)
- [tests/event-sink-client.test.ts](/Users/trivedi/Documents/Projects/agentsdlc/tests/event-sink-client.test.ts)

Validation docs:

- [sandbox-validation-plan-2026-03-10.md](/Users/trivedi/Documents/Projects/agentsdlc/docs/validation/sandbox-validation-plan-2026-03-10.md)
- [sandbox-validation-report-2026-03-10.md](/Users/trivedi/Documents/Projects/agentsdlc/docs/validation/sandbox-validation-report-2026-03-10.md)

## Certification Verdict

Certified now:

- local sandbox lifecycle with Codex runtime
- docker sandbox lifecycle and step execution on the supported runtime path
- orchestration metadata persistence and event emission for sandbox identity
- K8s pod provisioning and teardown behavior after the numeric security-context fix

Blocked from full certification:

- K8s end-to-end step execution remains blocked by missing workspace synchronization between the host-prepared workspace and the PVC-backed pod workspace
- Codex-driven live execution is not currently supported for `docker` or `k8s-pod` execution backends

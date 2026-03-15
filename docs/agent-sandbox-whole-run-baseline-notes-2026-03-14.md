# Agent Sandbox Whole-Run Baseline Notes

Date: 2026-03-14

## Current Baseline

- Kubernetes whole-run hosting is still implemented as one dispatched `Job` plus one workspace PVC.
- In whole-run mode, the inner step execution backend is forced to `local` via `SPRINTFOUNDRY_RUN_SANDBOX_MODE=k8s-whole-run`.
- The current `agent-sandbox` execution backend is only a scaffold:
  - it creates a `SandboxClaim`
  - waits for claim binding
  - persists minimal claim metadata
  - does not execute steps
- Monitor and session metadata currently surface `execution_backend`, but not a distinct run-hosting mode.

## Architectural Risks

- `execution_backend` is overloaded today. It mixes per-step execution semantics with outer run-host semantics.
- The current whole-run Job path inherits readiness, completion, timeout, and teardown semantics from native Kubernetes Jobs. Agent Sandbox migration will need to rebuild those semantics explicitly.
- Local hand-off and restore depend on durable workspace and runtime state (`.sprintfoundry`, `.codex`, Claude/Codex runtime files, sessions metadata). Any sandbox migration that changes workspace layout or teardown timing can break restore.
- Codex whole-run validation exists today. Claude appears code-path compatible but lacks equivalent live validation coverage.

## Unknowns To Validate In Kind

- Which Agent Sandbox CRD API group/version is actually installed in the target kind environment.
- How workspace storage should attach to sandbox-hosted runs without losing current PVC durability guarantees.
- How sandbox terminal state should be detected when the runner process exits but the sandbox object remains.
- Whether Codex and Claude continuation metadata survives sandbox-hosted teardown and export in the same way as the current Job path.

## Environment Status At Baseline

- Repository branch baseline is aligned with `origin/main` before migration work starts.
- Local kind validation is currently blocked in this shell:
  - the active kubeconfig endpoint is unreachable
  - Docker daemon access is currently unavailable
- This blocker affects live cluster validation only. Code migration work can proceed until the environment is repaired.

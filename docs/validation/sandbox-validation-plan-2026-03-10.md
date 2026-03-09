# Sandbox Validation Plan

Date: 2026-03-10
Branch: `codex/sandbox-validation-20260310`
Base feature branch: `codex/non-issues-changes-20260310`

## Goal

Validate the sandbox execution changes comprehensively enough to separate:

- paths that are proven by automated and live evidence
- paths that are covered only by automated tests
- paths that remain unsupported by current product constraints

## Scope

The validation targets these change areas:

- execution backend selection and factory wiring
- orchestration-owned run environment lifecycle
- sandbox metadata persistence and monitor/event surfaces
- Docker sandbox lifecycle
- Kubernetes pod sandbox lifecycle, including resume/reattach behavior
- agent sandbox backend contract coverage

## Product Constraints

- Live Codex-driven execution is feasible for the `local` execution backend.
- `docker` and `k8s-pod` execution backends currently reject `codex` runtime providers and only support `claude-code` step runtimes.
- Because of that constraint, Codex live runs will certify the supported Codex path, while Docker/Kubernetes sandbox backends will be certified with:
  - automated backend/orchestration tests
  - environment/doctor checks
  - live backend smoke runs on their currently supported runtime path

## Environments

- Local macOS workspace
- Docker daemon on host
- `kind` Kubernetes cluster with reachable API server

## Test Matrix

1. Repository health and prerequisite checks
   - `doctor` checks for local, Docker, and Kubernetes-oriented configs
   - Docker daemon availability
   - Kubernetes cluster reachability

2. Automated validation
   - typecheck
   - test suite focused on execution backends
   - runtime suite
   - orchestration suite
   - full test suite if targeted suites are green

3. Live Codex-driven runs
   - local execution backend with Codex runtime
   - successful run evidence:
     - run completion
     - `sandbox.created` and `sandbox.destroyed` events
     - `execution_backend=local`
   - failure/resume evidence if reproducible without destabilizing the environment

4. Live sandbox backend smoke
   - Docker execution backend on supported runtime path
   - Kubernetes pod execution backend on supported runtime path
   - evidence targets:
     - run environment creation
     - step execution inside backend sandbox
     - teardown behavior
     - backend-specific metadata
   - Kubernetes-specific resume preservation check for failed/cancelled paths where feasible

5. Reporting
   - covered cases
   - unsupported combinations
   - failures encountered
   - fixes applied
   - residual risks and non-certified areas

## Success Criteria

- No unexplained failures in targeted automated suites
- At least one successful live Codex-driven run through SprintFoundry
- Evidence that orchestration emits and persists sandbox lifecycle metadata
- Evidence that Docker and Kubernetes sandbox backends behave correctly on supported runtime paths
- A written report committed to the repo with concrete evidence and unresolved gaps

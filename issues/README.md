# Area 1: Sandboxed Execution — Issue Breakdown

This directory contains one Markdown file per GitHub issue for implementing Area 1 (Sandboxed execution) from `docs/sprintfoundry-k8s-multitenant-plan.md`.

## Goal

Make every SprintFoundry run equivalent to an isolated, resumable sandbox. Introduce an `ExecutionBackend` abstraction so that the orchestration layer is decoupled from where and how agents physically execute.

## Dependency graph

```
#001 ExecutionBackend interface
  └─> #002 LocalExecutionBackend + AgentRunner refactor
        └─> #004 Event store sandbox identity
        └─> #005 DockerExecutionBackend
              └─> #012 Cleanup deprecated container mode
        └─> #006 KubernetesPodExecutionBackend skeleton
              └─> #007 PVC workspace persistence
              └─> #008 Per-run service account + RBAC
              └─> #009 Isolation levels (Standard/Hardened/Strong)
              └─> #010 Network policy + egress allowlist
              └─> #011 AgentSandboxExecutionBackend (feature-flagged)
#003 TaskRun sandbox fields
  └─> #004 Event store sandbox identity
```

## Milestone summary

| Milestone | Issues | Outcome |
|---|---|---|
| M1 — Execution abstraction | #001 – #005 | `ExecutionBackend` abstraction in place; local + Docker backends working; no behavior regression |
| M2 — Kubernetes run sandbox | #006 – #010 | One pod per run; PVC workspace; RBAC; isolation levels; network policies |
| M3 — Strategic / cleanup | #011 – #012 | `agent-sandbox` CRD integration (feature-flagged); deprecated container mode removed |

## Success metrics (from the plan)

- 100% of hosted runs execute in an isolated backend
- No cross-run filesystem access
- No static long-lived secrets inside the sandbox image
- Sandbox identity visible in every run trace

---
title: "Define `ExecutionBackend` interface and `RunEnvironmentHandle` type"
labels: [architecture, milestone-1]
milestone: "Milestone 1: Execution abstraction and identity"
---

## Summary

Add a new `ExecutionBackend` interface under `src/service/execution/backend.ts` that sits beneath `AgentRunner` and owns the full run lifecycle. This is the foundational abstraction that all future backends (local, Docker, Kubernetes) will implement. No implementation is included — interface and type definitions only.

## Background

`AgentRunner` currently calls `RuntimeFactory` directly, hardwiring local and container assumptions into the orchestration layer. The K8s multitenant plan requires an `ExecutionBackend` abstraction so that the orchestration logic is decoupled from where and how agents physically execute.

## Interface spec

```ts
// src/service/execution/backend.ts

interface ExecutionBackend {
  prepareRunEnvironment(run: TaskRun, plan: ExecutionPlan): Promise<RunEnvironmentHandle>
  executeStep(handle: RunEnvironmentHandle, step: PlanStep, config: AgentRunConfig): Promise<AgentRunResult>
  pauseRun(handle: RunEnvironmentHandle): Promise<void>
  resumeRun(handle: RunEnvironmentHandle): Promise<void>
  teardownRun(handle: RunEnvironmentHandle): Promise<void>
}

interface RunEnvironmentHandle {
  run_id: string
  sandbox_id: string
  execution_backend: string        // e.g. "local", "docker", "k8s-pod"
  workspace_path: string
  workspace_volume_ref?: string    // e.g. PVC name or Docker volume name
  network_profile?: string         // e.g. "github-only", "full-internet"
  secret_profile?: string
  tenant_id?: string
  project_id?: string
  resume_token?: string
  checkpoint_generation: number
  metadata: Record<string, unknown> // backend-specific extensions
}
```

## Files to create

- `src/service/execution/backend.ts` — interface + types
- `src/service/execution/index.ts` — re-exports for clean imports

## Acceptance Criteria

- [ ] `ExecutionBackend` interface is defined in `src/service/execution/backend.ts` and compiles cleanly with `tsc`
- [ ] `RunEnvironmentHandle` type is defined with all fields listed above
- [ ] `pauseRun` and `resumeRun` are present, documented as "may be a no-op depending on backend"
- [ ] No existing tests are broken (this is additive only)
- [ ] Interface exported from `src/service/execution/index.ts`

## How to test

1. `pnpm tsc --noEmit` — must pass with zero errors
2. Write a trivial in-test class `class TestBackend implements ExecutionBackend` and confirm TypeScript catches any missing methods
3. No runtime tests needed — this is types only

## Definition of Done

- Interface and types compile cleanly
- A follow-up implementor (issue #002) can import and implement without modifying this file
- Reviewed and merged to `claude/plan-sandboxed-execution-5Fia3`

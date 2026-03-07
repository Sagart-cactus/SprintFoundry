---
title: "Extend `TaskRun` and `StepExecution` with run_environment metadata fields"
labels: [types, milestone-1]
milestone: "Milestone 1: Execution abstraction and identity"
---

## Summary

Extend `TaskRun` and `StepExecution` in `src/shared/types.ts` with sandbox and tenant identity fields. All new fields are optional to preserve backwards compatibility with existing serialized runs.

## Background

The K8s multitenant plan requires every run to carry a sandbox identity (`sandbox_id`), backend identifier (`execution_backend`), and tenant metadata so that all events, logs, and artifacts can be attributed to the correct tenant and run. These fields are referenced by both the event store (issue #004) and the execution backends (issues #002, #005, #006).

## Fields to add

### `TaskRun`

```ts
tenant_id?: string              // e.g. "acme-corp"
sandbox_id?: string             // set by backend after prepareRunEnvironment
execution_backend?: string      // "local" | "docker" | "k8s-pod" | "agent-sandbox"
workspace_volume_ref?: string   // PVC name or Docker volume name
network_profile?: string        // "github-only" | "full-internet" | etc.
secret_profile?: string         // "standard" | "minimal"
resume_token?: string
checkpoint_generation?: number
```

Also confirm `project_id` exists on `TaskRun`; add it if missing.

### `StepExecution`

```ts
sandbox_id?: string             // sandbox that executed this step
execution_backend?: string
```

## Files to modify

- `src/shared/types.ts`

## Acceptance Criteria

- [ ] All fields listed above added to `TaskRun` as optional fields with JSDoc comments
- [ ] All fields listed above added to `StepExecution` as optional fields
- [ ] `project_id` is present on `TaskRun` (add if missing)
- [ ] `pnpm tsc --noEmit` passes with zero errors
- [ ] All existing code that constructs `TaskRun` objects compiles without changes (all new fields are optional)

## How to test

1. `pnpm tsc --noEmit` — must pass
2. Search for all `TaskRun` construction sites (`grep -r "TaskRun" src/`) — confirm none need changes
3. Write a unit test that constructs a `TaskRun` with and without the new fields and asserts both are valid TypeScript

## Definition of Done

- Types compile cleanly
- No existing code broken
- Reviewed and merged

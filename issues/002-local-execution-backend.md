---
title: "Implement `LocalExecutionBackend` — wrap existing AgentRunner behavior"
labels: [implementation, milestone-1]
milestone: "Milestone 1: Execution abstraction and identity"
depends-on: ["#001"]
---

## Summary

Create `src/service/execution/local-backend.ts` that implements `ExecutionBackend` using the current local execution path. Refactor `AgentRunner` to delegate to the backend instead of calling `RuntimeFactory` directly. This must be a **zero-behavior-change refactor** for local mode.

## Background

`AgentRunner.run()` currently calls `RuntimeFactory.create()` and `runtimeImpl.runStep()` directly. Wrapping this in `LocalExecutionBackend` gives us the abstraction layer needed for Docker and Kubernetes backends without changing current behavior.

## Implementation

### `src/service/execution/local-backend.ts`

| Method | Implementation |
|---|---|
| `prepareRunEnvironment` | Accept existing workspace path, return populated `RunEnvironmentHandle` |
| `executeStep` | Move current `RuntimeFactory.create()` + `runtimeImpl.runStep()` logic here |
| `pauseRun` | No-op with `logger.warn("LocalExecutionBackend does not support pause/resume")` |
| `resumeRun` | No-op with `logger.warn("LocalExecutionBackend does not support pause/resume")` |
| `teardownRun` | No-op — workspace cleanup stays in `OrchestrationService` |

### `src/service/agent-runner.ts` changes

- Accept optional `ExecutionBackend` parameter in constructor
- Default to `new LocalExecutionBackend()` when no backend provided
- Call `backend.executeStep(handle, step, config)` instead of `RuntimeFactory` directly
- `OrchestrationService` does not need changes — it constructs `AgentRunner` the same way

## Files to modify

- `src/service/agent-runner.ts`

## Files to create

- `src/service/execution/local-backend.ts`

## Acceptance Criteria

- [ ] `LocalExecutionBackend` implements all 5 methods of `ExecutionBackend`
- [ ] `AgentRunner` constructor accepts an optional `ExecutionBackend` parameter
- [ ] When no backend is provided, `AgentRunner` defaults to `LocalExecutionBackend`
- [ ] `AgentRunner.run()` no longer calls `RuntimeFactory` directly — it delegates to the backend
- [ ] `RuntimeFactory` still exists and is used by `LocalExecutionBackend` (not deleted)
- [ ] All existing `AgentRunner` unit tests pass unchanged
- [ ] `OrchestrationService` requires no changes

## How to test

1. `pnpm test` — full suite must pass with zero regressions
2. Run an end-to-end local task (`pnpm dev -- --prompt "..."`) and confirm the run completes
3. Add one new unit test: construct `AgentRunner` with a mock `ExecutionBackend`, call `run()`, and assert the mock's `executeStep` was called

## Definition of Done

- All existing tests pass
- New unit test for backend delegation passes
- `LocalExecutionBackend` exported from `src/service/execution/index.ts`
- Reviewed and merged

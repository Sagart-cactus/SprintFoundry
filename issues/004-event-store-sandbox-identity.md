---
title: "Persist sandbox identity in the event store"
labels: [implementation, milestone-1]
milestone: "Milestone 1: Execution abstraction and identity"
depends-on: ["#002", "#003"]
---

## Summary

Update the event system so that every run audit trail carries sandbox and tenant identity. Add `sandbox.created` and `sandbox.destroyed` event types. Enrich existing events (`task.started`, `task.completed`, `task.failed`, `step.started`, `step.completed`) with `sandbox_id` and `execution_backend` fields.

## Background

The K8s multitenant plan requires every event to carry tracing dimensions including `tenant_id`, `sandbox_id`, and `execution_backend` so that runs are fully attributable. The event store writes to JSONL files and an optional external sink — these changes flow through naturally.

## Changes

### New event types in `src/shared/types.ts`

```ts
// Emitted by OrchestrationService after backend.prepareRunEnvironment() succeeds
{
  type: "sandbox.created"
  sandbox_id: string
  execution_backend: string
  workspace_volume_ref?: string
  network_profile?: string
  tenant_id?: string
}

// Emitted by OrchestrationService after backend.teardownRun() completes
{
  type: "sandbox.destroyed"
  sandbox_id: string
  reason: "completed" | "failed" | "cancelled"
}
```

### Existing event payloads to enrich (add as optional fields)

| Event | New fields |
|---|---|
| `task.started` | `sandbox_id`, `execution_backend`, `tenant_id` |
| `task.completed` | `sandbox_id` |
| `task.failed` | `sandbox_id` |
| `step.started` | `sandbox_id` |
| `step.completed` | `sandbox_id` |

### `src/service/orchestration-service.ts`

- Emit `sandbox.created` after `backend.prepareRunEnvironment()` completes
- Emit `sandbox.destroyed` in the `finally` block (after `teardownRun`)

### `src/service/event-store.ts`

No structural changes needed. Events are written as-is; new fields appear in JSONL automatically.

## Files to modify

- `src/shared/types.ts`
- `src/service/orchestration-service.ts`

## Acceptance Criteria

- [ ] `sandbox.created` and `sandbox.destroyed` event types are in the `TaskEvent` union
- [ ] `OrchestrationService` emits `sandbox.created` after `prepareRunEnvironment` and `sandbox.destroyed` after `teardownRun`
- [ ] `task.started` payload includes `sandbox_id`, `execution_backend`, `tenant_id`
- [ ] All existing event-store tests pass
- [ ] JSONL output includes sandbox fields when running with `LocalExecutionBackend`

## How to test

1. `pnpm test --filter event-store` — all must pass
2. Run a local task and inspect JSONL: `cat /tmp/sprintfoundry/.../.events.jsonl | jq 'select(.type=="sandbox.created")'` — should appear
3. `task.started` event should carry `sandbox_id` matching the value from `RunEnvironmentHandle`
4. Add a unit test: mock `OrchestrationService`, assert `sandbox.created` is emitted after `prepareRunEnvironment` succeeds and `sandbox.destroyed` is emitted in the finally block

## Definition of Done

- New event types compile and appear in JSONL
- `sandbox.created` and `sandbox.destroyed` emitted at correct lifecycle positions
- Unit test passes
- Reviewed and merged

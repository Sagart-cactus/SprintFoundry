---
title: "Complete `AgentRunner` cleanup — remove deprecated container mode"
labels: [type:refactor, milestone-3]
milestone: "Milestone 3: Durable resume and session portability"
depends-on: ["#002", "#005", "#006"]
---

## Summary

Remove the deprecated `container` runtime mode that was marked for removal in v0.3.0. With `LocalExecutionBackend`, `DockerExecutionBackend`, and `KubernetesPodExecutionBackend` all in place, the deprecated mode is no longer needed. Update docs to reflect `DockerExecutionBackend` as the replacement.

## Background

The `container` mode in `RuntimeConfig` spawned a new Docker container per step (not per run). It was marked deprecated in v0.3.0 and is superseded by `DockerExecutionBackend` (issue #005), which correctly runs one container per run with steps dispatched via `docker exec`.

## Changes

- Remove `"container"` from `RuntimeConfig.mode` union type in `src/shared/types.ts`
- Remove `container` case from `RuntimeFactory` in `src/service/runtime/`
- Remove any `mode === "container"` branches in `AgentRunner`
- Remove `container_resources` fields from `platform.yaml` that were used only by the old mode
- Remove the old per-step container entrypoint logic from `containers/entrypoint.sh` (the new Docker backend's long-lived container pattern uses a different entrypoint)
- Update `CLAUDE.md` and relevant docs to reflect `DockerExecutionBackend` as the replacement
- `pnpm tsc --noEmit` and `pnpm test` must both pass after removal

## Files to modify

- `src/shared/types.ts`
- `src/service/runtime/` (RuntimeFactory)
- `src/service/agent-runner.ts`
- `config/platform.yaml`
- `containers/entrypoint.sh`
- `CLAUDE.md`
- Any relevant docs

## Acceptance Criteria

- [ ] `RuntimeConfig.mode` no longer includes `"container"` as a valid value
- [ ] `RuntimeFactory` has no `container` case
- [ ] `AgentRunner` has no direct references to the old container mode
- [ ] `platform.yaml` has no `container_resources` fields used by the old mode
- [ ] All tests pass: `pnpm test`
- [ ] Type check passes: `pnpm tsc --noEmit`
- [ ] `CLAUDE.md` updated to mention `DockerExecutionBackend` as the replacement

## How to test

1. `pnpm tsc --noEmit` — must pass
2. `pnpm test` — full test suite must pass
3. Search: `grep -r "mode.*container\|container.*mode" src/` — no matches in non-test files except `DockerExecutionBackend`
4. Run an end-to-end local task — confirm it still works with `LocalExecutionBackend`

## Definition of Done

- Deprecated container mode fully removed
- `DockerExecutionBackend` is the documented replacement
- All tests pass
- Reviewed and merged

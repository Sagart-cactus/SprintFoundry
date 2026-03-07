---
title: "Runtime isolation level selection (Standard / Hardened / Strong)"
labels: [security, milestone-2, kubernetes]
milestone: "Milestone 2: Kubernetes run sandbox"
depends-on: ["#006"]
---

## Summary

Support three isolation levels that map to Kubernetes `runtimeClassName`. Isolation level is configured per-platform and overridable per-project. Default is `standard_isolated`. Hosted multitenant workloads should use `hardened_isolated` (gVisor).

## Background

The K8s multitenant plan defines three isolation levels:
1. **Standard isolated** — regular container isolation, suitable for internal workloads
2. **Hardened isolated** — gVisor, default for hosted multitenant
3. **Strong isolated** — Kata Containers, for enterprise or high-risk workloads

## Changes

### `src/shared/types.ts`

```ts
export type IsolationLevel =
  | "standard_isolated"   // cluster default runtimeClass
  | "hardened_isolated"   // gVisor
  | "strong_isolated"     // Kata Containers
```

### `RunEnvironmentHandle` (issue #001)

Add `isolation_level?: IsolationLevel` field.

### `KubernetesPodExecutionBackend`

Map isolation level to `runtimeClassName` in pod spec:

```ts
const runtimeClassMap: Record<IsolationLevel, string | undefined> = {
  standard_isolated: undefined,          // use cluster default
  hardened_isolated: config.k8s.runtime_classes.hardened_isolated,
  strong_isolated: config.k8s.runtime_classes.strong_isolated,
}
const runtimeClassName = runtimeClassMap[handle.isolation_level ?? "standard_isolated"]
if (runtimeClassName) {
  podSpec.spec.runtimeClassName = runtimeClassName
}
```

### `config/platform.yaml` additions

```yaml
k8s:
  default_isolation_level: standard_isolated
  runtime_classes:
    hardened_isolated: gvisor
    strong_isolated: kata-containers
```

Allow per-project override in `project.yaml`.

### Event payload

`isolation_level` included in `sandbox.created` event payload.

## Files to modify

- `src/shared/types.ts`
- `src/service/execution/k8s-pod-backend.ts`
- `config/platform.yaml`

## Acceptance Criteria

- [ ] `IsolationLevel` type defined in `src/shared/types.ts`
- [ ] `isolation_level` field on `RunEnvironmentHandle`
- [ ] Pod spec includes `runtimeClassName` for `hardened_isolated` and `strong_isolated`
- [ ] `standard_isolated` omits `runtimeClassName` (uses cluster default)
- [ ] Default isolation level configurable in `platform.yaml`
- [ ] Runtime class names configurable (not hardcoded) in `platform.yaml`
- [ ] `isolation_level` in `sandbox.created` event
- [ ] `pnpm tsc --noEmit` passes

## How to test

**Unit tests**:
- Backend configured with `hardened_isolated` → pod manifest includes `runtimeClassName: gvisor`
- Backend configured with `standard_isolated` → pod manifest has no `runtimeClassName`

**Integration test** (optional, requires gVisor-enabled cluster):
- Confirm pod actually runs under gVisor by checking `/proc/version` inside the container

## Definition of Done

- `IsolationLevel` type and pod spec wiring in place
- All three levels produce correct pod spec
- Runtime class names not hardcoded
- Reviewed and merged

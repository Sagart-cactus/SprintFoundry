---
title: "Scaffold `AgentSandboxExecutionBackend` — Kubernetes agent-sandbox CRD integration (feature-flagged)"
labels: [enhancement, milestone-3, kubernetes]
milestone: "Milestone 3: Durable resume and session portability"
depends-on: ["#006", "#007", "#008"]
---

## Summary

Scaffold `AgentSandboxExecutionBackend` behind a feature flag (`SPRINTFOUNDRY_AGENT_SANDBOX=true`). This backend integrates with the Kubernetes `agent-sandbox` project (kubernetes-sigs/agent-sandbox), which provides purpose-built CRDs for isolated, stateful, resumable agent workloads. Full integration depends on upstream API stability — this issue is a scaffold only.

## Background

The kubernetes-sigs/agent-sandbox project introduces CRDs designed specifically for AI agent workloads:
- `Sandbox` — the running execution unit
- `SandboxTemplate` — profile (typescript, go, fullstack-node)
- `SandboxClaim` — request for a sandbox, may bind to a pre-warmed instance
- `SandboxWarmPool` — pool of pre-warmed sandbox capacity

This is the strategic long-term backend for hosted SprintFoundry execution because it provides stable identity, pause/resume lifecycle, and warm pool support natively.

## Changes

### `src/service/execution/agent-sandbox-backend.ts` (new)

| Method | CRD operation |
|---|---|
| `prepareRunEnvironment` | Create `SandboxClaim`; wait for it to bind to a `Sandbox` |
| `executeStep` | Dispatch via the Sandbox's exec interface |
| `pauseRun` | Call Sandbox lifecycle API (`pause` verb) |
| `resumeRun` | Call Sandbox lifecycle API (`resume` verb) |
| `teardownRun` | Delete the `SandboxClaim` |

### Feature flag

Only activated when `SPRINTFOUNDRY_AGENT_SANDBOX=true` (env var checked at startup). When flag is off, `KubernetesPodExecutionBackend` remains the default K8s backend.

### `config/platform.yaml` additions

```yaml
k8s:
  agent_sandbox:
    enabled: false   # controlled by SPRINTFOUNDRY_AGENT_SANDBOX env var
    sandbox_templates:
      typescript: sf-typescript-template
      go: sf-go-template
      fullstack-node: sf-fullstack-template
```

### `docs/decisions.md`

Add ADR note explaining:
- Why `AgentSandboxExecutionBackend` is the strategic target
- The dependency on kubernetes-sigs/agent-sandbox API stability
- How `SandboxWarmPool` will reduce cold-start latency

## Files to create

- `src/service/execution/agent-sandbox-backend.ts`

## Files to modify

- `config/platform.yaml`
- `docs/decisions.md`

## Acceptance Criteria

- [ ] `AgentSandboxExecutionBackend` exists and implements `ExecutionBackend`
- [ ] Only activated when `SPRINTFOUNDRY_AGENT_SANDBOX=true`
- [ ] When flag is off, `KubernetesPodExecutionBackend` is the K8s default (no regression)
- [ ] `prepareRunEnvironment` creates a `SandboxClaim` custom resource
- [ ] `pauseRun` and `resumeRun` call Sandbox lifecycle API
- [ ] `SandboxTemplate` names configurable in `platform.yaml`
- [ ] `pnpm tsc --noEmit` passes
- [ ] ADR note in `docs/decisions.md`

## How to test

**Unit tests** (mock K8s custom resource client):
- `prepareRunEnvironment` calls `createNamespacedCustomObject` with the `SandboxClaim` schema
- Feature flag `SPRINTFOUNDRY_AGENT_SANDBOX=false` → `DispatchController` does not instantiate this backend

**Type check**: `pnpm tsc --noEmit`

## Definition of Done

- `AgentSandboxExecutionBackend` compiles and is feature-flagged
- Feature flag off by default — no behavior change for existing users
- `SandboxTemplate` configuration documented in `platform.yaml`
- ADR note in `docs/decisions.md`
- Reviewed and merged

---
title: "Network policy and egress allowlist per run"
labels: [security, milestone-2, kubernetes]
milestone: "Milestone 2: Kubernetes run sandbox"
depends-on: ["#006", "#008"]
---

## Summary

Apply a `NetworkPolicy` to each run pod restricting egress to a named profile. This prevents agents from making unexpected network calls during a run. Profiles are defined in `platform.yaml` and are not hardcoded.

## Background

The K8s multitenant plan requires an "egress allowlist" per run. Agents should only be able to reach the hosts needed for their task (e.g., GitHub for code commits, package registries for builds). Without a network policy, a compromised or misbehaving agent could exfiltrate data or communicate with arbitrary hosts.

## Named egress profiles

| Profile | Allowed egress |
|---|---|
| `github-only` | `api.github.com`, `github.com`, `objects.githubusercontent.com` |
| `github-plus-registries` | above + `registry.npmjs.org`, `pypi.org`, `proxy.golang.org` |
| `full-internet` | No egress restriction (pass-through `NetworkPolicy`) |
| `internal-only` | Cluster-internal DNS only |

Default profile: `github-only`.

## Changes

### `k8s/base/network-policies/` (new directory)

Parameterized `NetworkPolicy` YAML templates for each profile. Profiles select the run's pod via label `run-id: {run_id}`.

### `KubernetesPodExecutionBackend.prepareRunEnvironment`

1. Resolve `network_profile` from `RunEnvironmentHandle` (default: `github-only`)
2. Apply the corresponding `NetworkPolicy` to the cluster

### `KubernetesPodExecutionBackend.teardownRun`

Delete the `NetworkPolicy` after pod deletion.

### `config/platform.yaml` additions

```yaml
k8s:
  default_network_profile: github-only
  network_profiles:
    github-only:
      egress_domains: [api.github.com, github.com, objects.githubusercontent.com]
    github-plus-registries:
      egress_domains: [api.github.com, github.com, objects.githubusercontent.com,
                       registry.npmjs.org, pypi.org, proxy.golang.org]
    full-internet:
      egress_cidr: ["0.0.0.0/0"]
    internal-only:
      egress_cidr: []
```

### Event payload

`network_profile` included in `sandbox.created` event payload.

## Files to create

- `k8s/base/network-policies/github-only.yaml`
- `k8s/base/network-policies/github-plus-registries.yaml`
- `k8s/base/network-policies/full-internet.yaml`
- `k8s/base/network-policies/internal-only.yaml`

## Files to modify

- `src/service/execution/k8s-pod-backend.ts`
- `config/platform.yaml`

## Acceptance Criteria

- [ ] `NetworkPolicy` applied to each run pod based on `network_profile`
- [ ] `github-only` profile prevents egress to non-allowlisted domains
- [ ] `full-internet` applies no egress restriction
- [ ] `NetworkPolicy` deleted in `teardownRun`
- [ ] Default profile is `github-only` (configurable in `platform.yaml`)
- [ ] Profile names and rules defined in `platform.yaml` — not hardcoded in the backend
- [ ] `network_profile` appears in `sandbox.created` event

## How to test

**Integration test** (`kind` with Calico or Cilium CNI for NetworkPolicy support):
1. Start run with `github-only` profile
2. Inside running pod: `curl -m 5 https://example.com` → should fail/timeout
3. Inside running pod: `curl -m 5 https://api.github.com/zen` → should succeed
4. After teardown: `kubectl get networkpolicy -n sprintfoundry` → none for this run

**Unit test** (mock K8s client):
- `prepareRunEnvironment` with `network_profile: "github-only"` → `createNamespacedNetworkPolicy` called with correct spec

## Definition of Done

- `NetworkPolicy` created and enforced for every K8s run
- Profiles configurable, not hardcoded
- `NetworkPolicy` cleaned up on teardown
- Reviewed and merged

# SprintFoundry Helm Chart

This chart installs the SprintFoundry control plane and supports two public
paths:

- a `quickstart` install that proves the platform works with one real prompt run
- fully configured GitHub/Linear projects using `.Values.projects`

If you do not provide system tokens, the chart generates and preserves:

- `SPRINTFOUNDRY_INTERNAL_API_TOKEN`
- `SPRINTFOUNDRY_MONITOR_API_TOKEN`
- `SPRINTFOUNDRY_MONITOR_WRITE_TOKEN`

## Prerequisites

- a Kubernetes cluster reachable from `kubectl`
- Helm 3
- a valid model API key
  - quickstart supports `OPENAI_API_KEY` directly
- a published SprintFoundry runner image

Quickstart does **not** require Agent Sandbox CRDs. It runs with
`dispatchController.k8sMode=false` and `agentSandbox.enabled=false`.

## Install Modes

### 1. Quickstart

This is the shortest supported path to a working install. It creates:

- the control plane
- Postgres and Redis
- a prompt-only sample project
- a per-project Secret and ConfigMap
- a built-in `helm test` smoke run that dispatches one real task

```bash
helm upgrade --install sprintfoundry ./helm/sprintfoundry \
  -n sprintfoundry-system \
  --create-namespace \
  -f helm/sprintfoundry/values.quickstart.yaml \
  --set-string quickstart.apiKeys.openaiKey="$OPENAI_API_KEY" \
  --wait --wait-for-jobs

helm test sprintfoundry -n sprintfoundry-system
```

Quickstart defaults:

- project id: `quickstart`
- project namespace: `<release-name>-quickstart`
- repo: `https://github.com/octocat/Hello-World.git`
- ticket source: `prompt`
- runtime: `codex` + `local_process`
- PR finalization skipped by default

This path is intended to prove the install works before onboarding GitHub,
Linear, or external secrets.

### 2. GitHub + Linear Projects

Use `.Values.projects` when you want repo-backed work with webhook-driven
execution. See:

- [values.github-linear.yaml](./values.github-linear.yaml)
- [values.external-secrets.yaml](./values.external-secrets.yaml)

Each configured project defaults to:

- namespace: `<project id>`
- secret: `sprintfoundry-project-<project id>-secrets`
- configmap: `sprintfoundry-project-<project id>-config`

The chart validates project entries at render time. If a project is missing
required config such as `repo.url` or `ticket_source.type`, Helm fails before
install.

## Project Contract

Each project should provide either:

- `config`
- `existingConfigMap`

If you use inline `config`, the minimum required fields are:

- `project_id`
- `repo.url`
- `repo.default_branch`
- `integrations.ticket_source.type`

The chart supports three project secret patterns:

1. Inline `apiKeys` for local/dev installs
2. `existingSecret` for pre-created secrets
3. `externalSecret` for External Secrets Operator

## What The Chart Creates

- dispatch controller
- event API
- monitor
- platform config ConfigMap
- system secret for monitor/internal API auth
- optional per-project namespaces, secrets, configmaps, and resource quotas
- optional quickstart project resources

## Health And Validation

Stable health endpoints:

- dispatch: `/health`
- event API: `/health`
- monitor: `/health`

`helm test` always validates those endpoints. When quickstart is enabled, it
also dispatches a real prompt run and waits for it to reach `completed`.

## Supported Today

- quickstart installs with a single Helm command plus one model API key
- local-dispatch mode without Agent Sandbox CRDs
- chart-managed project secrets/configmaps
- GitHub/Linear project configuration through Helm values

## Not Included In The Quickstart Path

- Agent Sandbox CRDs/controller
- custom multi-agent workflows
- project-specific skills mounted from external storage
- production secret management unless you configure `existingSecret` or
  `externalSecret`

## Render

```bash
helm template sprintfoundry ./helm/sprintfoundry
```

## Related Docs

- [docs/k8s-quickstart.md](../../docs/k8s-quickstart.md)

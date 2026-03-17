# SprintFoundry Helm Chart

This chart installs the SprintFoundry control plane and optionally pre-creates
per-project namespaces and runtime resources.

## What The Chart Creates

- dispatch controller
- event API
- monitor
- platform config ConfigMap
- system secret for monitor/internal API auth
- optional per-project namespaces, secrets, configmaps, and resource quotas

## Per-Project Contract

If you configure `.Values.projects`, each project defaults to:

- namespace: `<project id>`
- secret: `sprintfoundry-project-<project id>-secrets`
- configmap: `sprintfoundry-project-<project id>-config`

The dispatch controller expects that contract unless you override it with:

- `SPRINTFOUNDRY_K8S_NAMESPACE`
- `SPRINTFOUNDRY_K8S_PROJECT_SECRET_NAME`
- `SPRINTFOUNDRY_K8S_PROJECT_CONFIGMAP_NAME`

## Example

```yaml
projects:
  - id: my-project
    apiKeys:
      anthropicKey: sk-ant-...
      githubToken: ghp_...
    config:
      project_id: my-project
      name: My Project
      repo:
        url: git@github.com:org/repo.git
        default_branch: main
      api_keys:
        anthropic: ${ANTHROPIC_API_KEY}
      integrations:
        ticket_source:
          type: github
          config:
            token: ${GITHUB_TOKEN}
            owner: org
            repo: repo
      branch_strategy:
        prefix: feat/
        include_ticket_id: true
        naming: kebab-case
      rules: []
```

## Render

```bash
helm template sprintfoundry ./helm/sprintfoundry
```

## Install

```bash
helm upgrade --install sprintfoundry ./helm/sprintfoundry -n sprintfoundry-system --create-namespace
```

## First Checks

```bash
kubectl get pods -n sprintfoundry-system
kubectl get configmap -n sprintfoundry-system
kubectl get secret -n sprintfoundry-system
```

For end-to-end Kubernetes setup, use [docs/k8s-quickstart.md](../../docs/k8s-quickstart.md).

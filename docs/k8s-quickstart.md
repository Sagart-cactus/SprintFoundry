# Kubernetes Quickstart

This is the shortest reliable path to a first whole-run Kubernetes setup.

## 1. Install The Control Plane

Render first:

```bash
kubectl kustomize k8s/overlays/dev
helm template sprintfoundry ./helm/sprintfoundry
```

Then install with either Kustomize or Helm.

Kustomize:

```bash
kubectl apply -k k8s/overlays/dev
```

Helm:

```bash
helm upgrade --install sprintfoundry ./helm/sprintfoundry -n sprintfoundry-system --create-namespace
```

## 2. Create System Secrets

At minimum, create the internal API token:

```bash
kubectl -n sprintfoundry-system create secret generic sprintfoundry-system-secrets \
  --from-literal=SPRINTFOUNDRY_INTERNAL_API_TOKEN=replace-me
```

Add monitor tokens if you want monitor auth enabled.

## 3. Install Agent Sandbox Prerequisites

You need:

- Agent Sandbox controller and CRDs
- ExternalSecrets operator if you use the project onboarding template as-is
- the `ClusterSecretStore` referenced by the project template

Before running a task, verify:

```bash
sprintfoundry doctor --profile k8s --project my-project
```

## 4. Understand The Project Resource Contract

SprintFoundry now expects one default contract per project:

- namespace: `<project id>`
- secret: `sprintfoundry-project-<project id>-secrets`
- configmap: `sprintfoundry-project-<project id>-config`

If you change those names, also change:

- dispatch environment overrides
- onboarding scripts
- Helm values

## 5. Onboard A Project

```bash
scripts/onboard-project.sh \
  --project-id my-project \
  --config-file config/project.yaml \
  --dry-run
```

Then apply for real:

```bash
scripts/onboard-project.sh \
  --project-id my-project \
  --config-file config/project.yaml
```

## 6. Preflight Before The First Run

```bash
sprintfoundry doctor --profile k8s --project my-project
sprintfoundry validate --strict --project my-project
```

Those checks should confirm:

- kube context is valid
- Agent Sandbox CRDs are installed
- namespace exists
- secret exists
- configmap exists
- RBAC allows SandboxClaim creation

## 7. Run And Observe

Start the monitor:

```bash
sprintfoundry monitor
```

Run a prompt or ticket:

```bash
sprintfoundry run --project my-project --source prompt --prompt "Smoke test the k8s whole-run path"
```

Use:

- `sprintfoundry logs <run-id>`
- the monitor UI
- `kubectl get sandboxclaims,pods,pvc -n my-project`

## 8. If A Run Fails

Use:

```bash
sprintfoundry logs <run-id>
sprintfoundry resume --latest --project my-project
```

If the workspace PVC is retained, the monitor will show a handoff action and status.

## Related Docs

- [k8s/README.md](../k8s/README.md)
- [docs/troubleshooting.md](./troubleshooting.md)
- [helm/sprintfoundry/README.md](../helm/sprintfoundry/README.md)

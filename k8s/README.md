# SprintFoundry Kubernetes Manifests

This directory contains Kustomize manifests for running SprintFoundry in Kubernetes.

## Layout

- `base/`:
  - `dispatch-controller.yaml` — dispatch API + queue consumer
  - `monitor.yaml` — monitor API/UI
  - `event-api.yaml` — event ingestion API
  - `ingress.yaml` — path routing for monitor/dispatch/webhooks/internal ingestion
  - `rbac.yaml` — RBAC for dispatch to create run Jobs
  - `configmap-platform.yaml` — baked `config/platform.yaml` as ConfigMap
  - `job-template.yaml` — reference run-job template (not included in kustomization)
- `overlays/dev/`:
  - Adds in-cluster Postgres + Redis StatefulSets
  - Applies smaller resource limits for local/dev clusters

## Render

```bash
kubectl kustomize k8s/base
kubectl kustomize k8s/overlays/dev
```

## Apply (dev)

```bash
kubectl apply -k k8s/overlays/dev
```

## Required Secrets

Create `sprintfoundry-system-secrets` in namespace `sprintfoundry-system` with at least:

- `SPRINTFOUNDRY_INTERNAL_API_TOKEN`
- `SPRINTFOUNDRY_MONITOR_API_TOKEN` (optional)
- `SPRINTFOUNDRY_MONITOR_WRITE_TOKEN` (optional)

Example:

```bash
kubectl -n sprintfoundry-system create secret generic sprintfoundry-system-secrets \
  --from-literal=SPRINTFOUNDRY_INTERNAL_API_TOKEN=replace-me
```

## Notes

- Base manifests use `sprintfoundry-runner:latest`.
- The run pod template in `base/job-template.yaml` shows EmptyDir, Secret env mount, ConfigMap mount, resources, and Karpenter toleration.

## Provisioning Metrics

SprintFoundry exports sandbox provisioning latency through:

- `sprintfoundry_sandbox_provision_duration_seconds`

The histogram is labelled by `execution_backend` and `stage`. Current stages include:

- `service_account_create`
- `workspace_volume_create`
- `egress_policy_create`
- `pod_create`
- `pod_ready_wait`
- `claim_create`
- `claim_bind_wait`
- `total`

## ExternalSecrets Prerequisite

Project onboarding templates assume ExternalSecrets Operator is installed and a
`ClusterSecretStore` named `sprintfoundry-aws-secretsmanager` exists.

Install example (chart/version may vary by cluster policy):

```bash
helm repo add external-secrets https://charts.external-secrets.io
helm repo update
helm upgrade --install external-secrets external-secrets/external-secrets \
  --namespace external-secrets \
  --create-namespace
```

## Per-Project AWS Secrets Manager Entries

The onboarding template reads project secrets from:

`sprintfoundry/projects/<project_id>/`

Recommended keys:

- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GITHUB_TOKEN`
- `GIT_SSH_KEY`
- `SPRINTFOUNDRY_INTERNAL_API_TOKEN`

Optional monitor/dispatch keys:

- `SPRINTFOUNDRY_MONITOR_API_TOKEN`
- `SPRINTFOUNDRY_MONITOR_WRITE_TOKEN`
- `SPRINTFOUNDRY_DISPATCH_READ_TOKEN`
- `SPRINTFOUNDRY_DISPATCH_WRITE_TOKEN`

## Project Onboarding Script

Use `scripts/onboard-project.sh` to render and apply project-specific manifests:

```bash
scripts/onboard-project.sh \
  --project-id my-project \
  --config-file config/project-my-project.yaml
```

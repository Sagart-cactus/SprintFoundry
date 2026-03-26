# Kubernetes Quickstart

This is the shortest supported Helm path to a first working SprintFoundry
install.

## Prerequisites

- Kubernetes cluster reachable from `kubectl`
- Helm 3
- a model API key
  - quickstart supports `OPENAI_API_KEY` out of the box

Quickstart does not require Agent Sandbox CRDs. The provided
`values.quickstart.yaml` disables both Agent Sandbox and k8s-mode dispatch.

## One-Command Install

```bash
helm upgrade --install sprintfoundry ./helm/sprintfoundry \
  -n sprintfoundry-system \
  --create-namespace \
  -f helm/sprintfoundry/values.quickstart.yaml \
  --set-string quickstart.apiKeys.openaiKey="$OPENAI_API_KEY" \
  --wait --wait-for-jobs
```

That single install creates:

- SprintFoundry control plane
- Postgres and Redis
- a prompt-only `quickstart` project
- the project Secret and ConfigMap required for dispatch
- a release-scoped quickstart namespace so multiple releases can coexist

The quickstart project uses:

- a public repo clone
- prompt ticket source
- `codex` with `local_process`
- no GitHub PR finalization

## Validate The Install

Run the built-in Helm smoke tests:

```bash
helm test sprintfoundry -n sprintfoundry-system
```

This verifies:

1. dispatch, event-api, and monitor health endpoints respond
2. a real prompt run can be queued
3. the run reaches `completed`

If you want hook logs inline while debugging:

```bash
helm test sprintfoundry -n sprintfoundry-system --logs
```

## Observe The System

Port-forward the monitor:

```bash
kubectl port-forward svc/sprintfoundry-monitor 4310:4310 -n sprintfoundry-system
```

Then open:

```text
http://localhost:4310
```

## Queue Another Prompt Run

```bash
kubectl port-forward svc/sprintfoundry-dispatch-controller 4320:4320 -n sprintfoundry-system

curl -X POST http://127.0.0.1:4320/api/dispatch/run \
  -H 'content-type: application/json' \
  -d '{
    "project_id": "quickstart",
    "source": "prompt",
    "agent": "developer",
    "prompt": "Create quickstart-manual.txt describing this manual validation run."
  }'
```

## Real Projects

When you move beyond quickstart, switch to `.Values.projects` and provide the
real project config plus GitHub/Linear credentials in the same Helm release.

Use the shipped examples:

- [helm/sprintfoundry/values.github-linear.yaml](../helm/sprintfoundry/values.github-linear.yaml)
- [helm/sprintfoundry/values.external-secrets.yaml](../helm/sprintfoundry/values.external-secrets.yaml)

See [helm/sprintfoundry/README.md](../helm/sprintfoundry/README.md) for the full
project contract and install modes.

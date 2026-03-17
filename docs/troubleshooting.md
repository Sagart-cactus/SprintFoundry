# Troubleshooting

## Start Here

Run the profile-specific checks first:

```bash
sprintfoundry doctor --profile local
sprintfoundry doctor --profile distributed
sprintfoundry doctor --profile k8s
sprintfoundry validate --strict --project my-project
```

## Common Local Failures

### Missing Claude or Codex CLI

Symptom:
- `doctor` reports the runtime CLI is not in `PATH`
- runs fail before or during the first step

Fix:
- install the required CLI
- verify `claude --version` or `codex --version`
- rerun `sprintfoundry doctor --profile local`

### Missing API keys

Symptom:
- `Anthropic key missing`
- `OpenAI key missing`
- ticket provider auth errors

Fix:
- set the env var or put the value in `config/project.yaml`
- rerun `sprintfoundry validate --strict --project my-project`

### Registry preflight failure

Symptom:
- JavaScript workspace fails before package install/test steps

Fix:
- allow outbound HTTPS to your npm registry
- or set `NPM_CONFIG_REGISTRY` to a reachable mirror
- only bypass with `SPRINTFOUNDRY_SKIP_REGISTRY_PREFLIGHT=true` if you understand the tradeoff

## Run Debugging

### Find and inspect a failed run

```bash
sprintfoundry sessions
sprintfoundry logs <run-id>
sprintfoundry resume --latest --project my-project
```

### No visible progress during a run

Use the monitor and the new timeline/log output:

```bash
sprintfoundry monitor
sprintfoundry logs <run-id>
```

The CLI also emits step heartbeats every 60s for long-running steps.

### Rework loops are unclear

Look for:
- `step.rework_triggered`
- `task.rework_planned`

The logs command and monitor now show the rework reason, cycle count, and planned recovery sequence.

## Distributed Mode Failures

### Event API unreachable

Symptom:
- distributed doctor/preflight warns about event API health
- monitor has incomplete data

Fix:
- confirm `SPRINTFOUNDRY_EVENT_SINK_URL`
- verify `curl http://localhost:3001/health`
- verify Postgres and Redis are reachable

### Postgres or Redis misconfigured

Symptom:
- distributed mode doctor fails on DB/Redis URL checks

Fix:
- set `SPRINTFOUNDRY_DATABASE_URL`
- set `SPRINTFOUNDRY_REDIS_URL`
- restart the local distributed stack if needed

## Kubernetes Failures

### Missing Agent Sandbox CRDs

Symptom:
- `doctor --profile k8s` fails on Agent Sandbox CRDs
- sandbox claims never bind

Fix:
- install the Agent Sandbox controller and CRDs
- rerun `sprintfoundry doctor --profile k8s`

### SandboxClaim never binds

Symptom:
- run logs repeat `Waiting for SandboxClaim ... to bind`
- run fails after timeout

Fix:
- confirm the controller is running
- confirm RBAC allows creating SandboxClaims
- confirm the target namespace exists
- check the claim, sandbox, and pod events with `kubectl describe`

### Project resources not found

The default Kubernetes contract is:

- namespace: `<project id>`
- secret: `sprintfoundry-project-<project id>-secrets`
- configmap: `sprintfoundry-project-<project id>-config`

Fix:
- align your onboarding process with that contract
- or set explicit overrides:
  - `SPRINTFOUNDRY_K8S_NAMESPACE`
  - `SPRINTFOUNDRY_K8S_PROJECT_SECRET_NAME`
  - `SPRINTFOUNDRY_K8S_PROJECT_CONFIGMAP_NAME`

### Snapshot or cleanup failed

Symptom:
- monitor shows `Snapshot failed` or `PVC retained`

Fix:
- inspect run events for `workspace.snapshot.failed` or `workspace.cleanup.failed`
- if the PVC is still present, use the handoff command or clean it up manually after recovery

## Notifications

If Slack or webhook notifications do not arrive:

- verify the integration is configured in `project.yaml`
- verify credentials or webhook URL are present
- inspect startup warnings and run logs for notification skip messages

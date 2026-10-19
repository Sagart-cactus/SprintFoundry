# Incident and Rollback Runbooks

Alert rules live in `config/prometheus-alerts.yml` and load automatically when
you start the observability stack with `docker compose -f docker-compose.otel.yml up`.
Metric definitions are in `docs/metrics.md`. Day-to-day operations are in
`docs/operations.md`.

## Alerts

### Run failure rate high

`SprintFoundryRunFailureRateHigh`: more than 25% of runs failed over 30 minutes.

1. In the monitor (`pnpm monitor`), open recently failed runs and read the failing
   step's `.agent-result.json` and runtime logs.
2. Check whether failures share an agent, provider, or project:
   `sum by (project_id, source) (increase(sprintfoundry_runs_total{status="failed"}[1h]))`.
3. Provider-wide failures usually mean an expired or rate-limited API key. Verify
   the key in the project config or Kubernetes secret.
4. If a recent release caused it, roll back (see below), then resume affected runs
   with the steps in `docs/operations.md#resume-failed-run`.

### Agent timeouts

`SprintFoundryAgentTimeouts`: one agent timed out 3 or more times in an hour.

1. Compare `sprintfoundry_step_duration_seconds` for that agent against its
   configured timeout in `config/platform.yaml` or the project override.
2. Inspect the timed-out step's workspace for a hung command (dev server, watch
   mode, interactive prompt).
3. Raise the timeout only if steps finish legitimately close to the limit.

### Git errors

`SprintFoundryGitErrors`: a git operation failed repeatedly.

1. Group failures with `sum by (operation) (increase(sprintfoundry_git_errors_total[1h]))`.
2. `clone` or `push` failures usually mean an expired token or missing repository
   permission. `pr` failures often mean the branch already has an open PR.
3. Rotate the token in the project secret and retry one run before resuming others.

### Cost spike

`SprintFoundryDailyCostHigh`: model spend exceeded $200 in 24 hours.

1. Find the source: `topk(5, sum by (agent, provider) (increase(sprintfoundry_cost_usd_total[24h])))`.
2. Check `sprintfoundry_rework_cycles_total` for runs stuck in rework loops.
3. Lower per-agent budgets in the project config or pause autoexecute in the
   monitor until the cause is fixed.

### Metrics missing

`SprintFoundryMetricsMissing`: Prometheus cannot scrape the OTel Collector.

1. `docker compose -f docker-compose.otel.yml ps` and check the collector logs.
2. Confirm services export to the collector (`OTEL_EXPORTER_OTLP_ENDPOINT`).
3. Check service health endpoints: `/health` on the event API, dispatch
   controller, and monitor.

## Rollback

Every release publishes the npm package, container images tagged by version and
commit SHA, and a Helm chart, all from the same `v*` tag.

### Kubernetes (Helm)

```bash
helm history sprintfoundry -n <namespace>
helm rollback sprintfoundry <previous-revision> -n <namespace> --wait
kubectl -n <namespace> rollout status deploy -l app.kubernetes.io/instance=sprintfoundry
```

To pin a specific earlier release instead, upgrade to its chart version:
`helm upgrade sprintfoundry oci://ghcr.io/sagart-cactus/charts/sprintfoundry --version <x.y.z> --reuse-values`.

### Container images

Images are immutable per version (`ghcr.io/sagart-cactus/sprintfoundry-runner:<x.y.z>`,
`:sha-<commit>`). Point deployments or `values.yaml` image tags at the previous
version. Do not retag `latest` by hand.

### npm package

```bash
npm dist-tag add sprintfoundry@<previous-version> latest
npm deprecate sprintfoundry@<bad-version> "Rolled back; use <previous-version>"
```

### Website (GitHub Pages)

Run the **Deploy website to Pages** workflow manually and set `ref` to the last
good tag or commit SHA. The workflow builds, tests, deploys, and smoke-tests that
ref.

After any rollback, open an issue with the alert, the bad version, and the
rollback time, and link the fix PR to it.

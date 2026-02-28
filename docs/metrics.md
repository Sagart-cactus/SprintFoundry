# SprintFoundry Metrics

SprintFoundry emits two layers of metrics via OpenTelemetry (OTel):

1. **Pass-through agent metrics** — Claude Code CLI and Codex CLI both have native OTel support. When telemetry is enabled, SprintFoundry injects the necessary env vars so agents forward their own metrics (token usage, cost, API latency, tool calls) to the shared collector.

2. **Service-level metrics** — The orchestration service itself emits metrics covering run lifecycle, step execution, cost & budget, quality gates, rework loops, guardrails, git operations, and agent activity.

Both layers are off by default. All metrics flow through an OTLP-compatible collector and are scraped by Prometheus.

---

## Quick Start

```bash
# 1. Start OTel Collector + Prometheus + Grafana
docker compose -f docker-compose.otel.yml up -d

# 2. Enable telemetry
echo "SPRINTFOUNDRY_OTEL_ENABLED=1" >> .env

# 3. Run a task
pnpm dev -- --source prompt --prompt "Add a hello world endpoint"

# 4. Verify metrics are flowing
curl -s http://localhost:8889/metrics | grep sprintfoundry_

# 5. Open Grafana
open http://localhost:3000   # default: admin / sprintfoundry
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│  SprintFoundry process (index.ts)           │
│  ┌────────────────────────────────────────┐ │
│  │ MetricsService (@opentelemetry/api)    │ │
│  │ records: runs, steps, cost, rework,   │ │
│  │          gates, git, tool calls …     │ │
│  └──────────────────┬─────────────────────┘ │
│                     │ OTLP HTTP              │
│  Claude Code agents │ port 4318              │
│  (CLAUDE_CODE_ENABLE│_TELEMETRY=1)           │
│  Codex CLI agents   │                        │
└─────────────────────┼──────────────────────-┘
                      ▼
          ┌──────────────────────┐
          │  OTel Collector      │
          │  :4317 (gRPC)        │
          │  :4318 (HTTP)        │
          │  :8889 /metrics      │  ← Prometheus scrapes here
          └──────────┬───────────┘
                     │
          ┌──────────▼───────────┐
          │  Prometheus :9090    │
          └──────────┬───────────┘
                     │
          ┌──────────▼───────────┐
          │  Grafana  :3000      │
          └──────────────────────┘
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SPRINTFOUNDRY_OTEL_ENABLED` | `0` | Set to `1` to activate all telemetry |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | OTLP collector endpoint |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | `http/protobuf` | `http/protobuf` or `grpc` |

---

## SprintFoundry Custom Metrics

### Run Lifecycle

| Metric | Type | Labels | What it tells you |
|--------|------|--------|-------------------|
| `sprintfoundry_runs_total` | Counter | `project_id`, `source`, `status` | Throughput and failure rate by ticket source |
| `sprintfoundry_run_duration_seconds` | Histogram | `project_id`, `status` | End-to-end latency: ticket fetch → PR creation |
| `sprintfoundry_active_runs` | UpDownCounter | `project_id`, `source` | Concurrency — how many runs are in-flight |
| `sprintfoundry_plan_steps_count` | Histogram | `project_id` | Plan complexity: how many agent steps per ticket |

### Agent Step Execution

| Metric | Type | Labels | What it tells you |
|--------|------|--------|-------------------|
| `sprintfoundry_steps_total` | Counter | `agent`, `provider`, `mode`, `status` | Volume and success rate per agent type |
| `sprintfoundry_step_attempts_total` | Counter | `agent`, `provider`, `mode` | Retries and rework invocations |
| `sprintfoundry_agent_spawns_total` | Counter | `agent`, `provider`, `mode` | Total process/container invocations |
| `sprintfoundry_step_duration_seconds` | Histogram | `agent`, `provider`, `mode`, `status` | Per-agent latency — find slow agents |

### Cost & Token Budget

| Metric | Type | Labels | What it tells you |
|--------|------|--------|-------------------|
| `sprintfoundry_tokens_used_total` | Counter | `agent`, `provider`, `mode` | Token consumption per agent — find biggest spenders |
| `sprintfoundry_cost_usd_total` | Counter | `agent`, `provider`, `mode` | Dollar cost breakdown |
| `sprintfoundry_token_budget_utilization_ratio` | Histogram | `agent` | How close agents get to their token ceiling (0.0 – 1.0+) |
| `sprintfoundry_cache_tokens_saved_total` | Counter | `agent`, `provider` | Prompt cache efficiency |
| `sprintfoundry_token_limit_exceeded_total` | Counter | `agent`, `provider`, `reason` | How often agents hit the token or cost cap |

### Quality & Rework

| Metric | Type | Labels | What it tells you |
|--------|------|--------|-------------------|
| `sprintfoundry_rework_cycles_total` | Counter | `project_id`, `agent` | QA failure rate — how often developer output is rejected |
| `sprintfoundry_human_gate_decisions_total` | Counter | `project_id`, `decision` | Approval vs rejection frequency |
| `sprintfoundry_human_gate_wait_seconds` | Histogram | `project_id` | How long gates stay open before a human responds |

### Safety & Reliability

| Metric | Type | Labels | What it tells you |
|--------|------|--------|-------------------|
| `sprintfoundry_agent_timeouts_total` | Counter | `agent`, `provider` | Agents killed for exceeding the timeout |
| `sprintfoundry_guardrail_blocks_total` | Counter | `agent`, `provider` | Tool calls blocked by guardrail deny-list rules |
| `sprintfoundry_plan_validation_injections_total` | Counter | `rule_id` | Which mandatory rules fire most often |

### Infrastructure

| Metric | Type | Labels | What it tells you |
|--------|------|--------|-------------------|
| `sprintfoundry_git_operation_duration_seconds` | Histogram | `operation`, `status` | Latency for clone / commit / push / pr_create |
| `sprintfoundry_git_errors_total` | Counter | `operation` | Git failure count |
| `sprintfoundry_pr_created_total` | Counter | `project_id`, `status` | PR creation success/failure |
| `sprintfoundry_workspace_prep_duration_seconds` | Histogram | `agent` | Time to write context files and set up agent workspace |

### Agent Activity (from runtime event stream)

| Metric | Type | Labels | What it tells you |
|--------|------|--------|-------------------|
| `sprintfoundry_agent_tool_calls_total` | Counter | `agent`, `tool_name` | Which tools agents use most — informs plugin/skill design |
| `sprintfoundry_agent_file_edits_total` | Counter | `agent`, `extension` | Which file types are most modified |
| `sprintfoundry_agent_commands_total` | Counter | `agent` | Shell commands run by agents |

---

## Claude Code CLI Native Metrics (pass-through)

When `SPRINTFOUNDRY_OTEL_ENABLED=1`, Claude Code agents emit their own metrics:

- `claude_code_tokens_input_total`
- `claude_code_tokens_output_total`
- `claude_code_cost_usd_total`
- `claude_code_session_duration_seconds`
- `claude_code_cache_read_tokens_total`
- `claude_code_tool_calls_total`

Reference: [Claude Code Monitoring docs](https://docs.anthropic.com/en/docs/claude-code/monitoring-usage)

---

## Codex CLI Native Metrics (pass-through)

Codex CLI emits OTel traces and logs (not metrics directly). These are forwarded to the collector and visible in the debug exporter logs:

- `codex.api_requests_total` (traces)
- `codex.stream_events_total` (traces)
- `codex.tool_calls_total` (traces)
- Session attributes: `auth_mode`, `originator`, `model`, `app.version`

Reference: [SigNoz Codex monitoring](https://signoz.io/docs/codex-monitoring/)

---

## Useful Prometheus Queries

```promql
# Runs completed in the last hour
increase(sprintfoundry_runs_total{status="completed"}[1h])

# Run failure rate
rate(sprintfoundry_runs_total{status="failed"}[30m])
/ rate(sprintfoundry_runs_total[30m])

# P95 step duration per agent
histogram_quantile(0.95, rate(sprintfoundry_step_duration_seconds_bucket[30m]))

# Total cost in the last day
increase(sprintfoundry_cost_usd_total[24h])

# Rework loop rate (QA fail rate)
rate(sprintfoundry_rework_cycles_total[1h])
/ rate(sprintfoundry_steps_total[1h])

# Token budget utilization (P90 across all steps)
histogram_quantile(0.90, rate(sprintfoundry_token_budget_utilization_ratio_bucket[1h]))

# How often guardrails block tool calls
rate(sprintfoundry_guardrail_blocks_total[1h])
```

---

## Grafana Dashboard Setup

1. Open Grafana at `http://localhost:3000` (admin / sprintfoundry)
2. Add a Prometheus datasource pointing at `http://prometheus:9090`
3. Import a new dashboard and use the PromQL queries above as panel sources

A pre-built dashboard JSON will be added to `config/grafana-dashboard.json` in a future release.

---

## Production Deployment

For production, replace the bundled `docker-compose.otel.yml` with your own collector infrastructure:

- **Grafana Cloud** — configure `OTEL_EXPORTER_OTLP_ENDPOINT` to your Grafana Cloud OTLP endpoint
- **Datadog** — use `OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp.datadoghq.com` with `DD_API_KEY` header
- **Honeycomb** — set endpoint and `x-honeycomb-team` header via `OTEL_EXPORTER_OTLP_HEADERS`
- **AWS CloudWatch** — use the CloudWatch ADOT collector as the endpoint

The `OTEL_EXPORTER_OTLP_HEADERS` env var (standard OTel) can be used for auth tokens:

```bash
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <token>"
```

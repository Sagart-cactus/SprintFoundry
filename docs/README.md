# SprintFoundry Documentation

This folder contains the current, code-aligned documentation for SprintFoundry (AgentSDLC).

## Start Here

- `docs/architecture.md` — system design, execution flow, and runtime model
- `docs/configuration.md` — `platform.yaml` and `project.yaml` reference
- `docs/operations.md` — local development, running tasks, testing, troubleshooting
- `docs/monitor.md` — run monitor APIs and UI routes (`/`, `/v2`, `/v3`)
- `docs/decisions.md` — decision log and rationale

## Repo Map

Top-level implementation areas:

- `src/index.ts` — CLI entrypoint (`run`, `validate`, `review`)
- `src/service/` — orchestration, planning, runtime adapters, integrations
- `src/shared/types.ts` — core config and runtime type system
- `monitor/` — monitor server and static UIs
- `config/` — platform defaults + project config templates
- `containers/` — agent container images
- `plugins/` — optional skill/plugin catalogs
- `tests/` — unit tests for service/runtime/config behavior

## Documentation Status

This set focuses on runtime behavior that is implemented today. Legacy notes in root-level `CLAUDE.md` may include planned or historical items that differ from current code.

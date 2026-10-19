# Repository Guide for Coding Agents

## Project Layout

- `src/` contains the TypeScript CLI, orchestration service, and runtime integrations.
- `monitor/` contains the monitor server and versioned UI packages.
- `website/` is the independently deployed public landing page.
- `config/`, `helm/`, and `k8s/` contain platform and deployment configuration.
- `tests/` contains platform unit, API, and integration tests.

## Setup

Requirements: Node.js 20 or newer, pnpm 9, and Git. Docker is needed only for
the distributed local stack.

```bash
corepack enable
pnpm install --frozen-lockfile
```

Copy `config/project.example.yaml` to a project-specific config and provide
credentials through environment variables. Never commit project configs,
tokens, or `.env` files.

## CI-Verified Commands

Run these from the repository root:

```bash
pnpm lint
pnpm typecheck:tests
pnpm build
pnpm --filter @sprintfoundry/website typecheck
pnpm --filter @sprintfoundry/website build
pnpm --filter @sprintfoundry/website test
```

The CI workflow validates this command list and runs each command. For the
platform's complete local test suite, use `pnpm test`.

CI also runs these quality gates, which you can run locally:

- `pnpm format:check` checks Prettier formatting for newer files. Existing files
  are formatted by the pre-commit hook as they change.
- `pnpm check:changed-files` keeps changed source files at 1,200 lines or fewer and
  requires new `TODO`/`FIXME` markers to reference an issue, as in `TODO(#123)`.
- `pnpm dead-code:check` finds unused files and dependencies. `pnpm dead-code:report`
  also lists unused exports.
- `pnpm duplicates:check`, `pnpm boundaries:check`, and `pnpm versions:check` cover
  copy-paste, module layering, and version drift across workspaces.

Alert response and rollback steps are in `docs/runbooks.md`.

The website's local interactive QA steps are documented in `website/README.md`.
For the distributed platform QA flow, follow `docs/operations.md`, including
its documented local tokens and health/API requests.

## Conventions

- Keep TypeScript strict; do not introduce `any` without a specific reason.
- Use `camelCase` for variables and functions, `PascalCase` for types and classes,
  and preserve `snake_case` where it is part of an external API or persisted schema.
- Put shared contracts in `src/shared/`; keep service implementation in `src/service/`.
- Add focused tests for behavior changes. Keep tests deterministic and isolate
  filesystem or Git state in temporary directories.
- Do not log credentials, authorization headers, or ticket contents. Use the
  existing redaction paths for command arguments and secrets.
- Keep modules focused. Prefer extracting a cohesive unit over growing the
  already large orchestration and monitor files.

## Pull Requests

Describe user-visible behavior, list validation commands and results, and call
out configuration, migration, security, and deployment implications.

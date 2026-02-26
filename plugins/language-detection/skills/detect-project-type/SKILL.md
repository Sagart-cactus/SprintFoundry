# Skill: Detect Project Type

Run this detection block **before any build, install, test, or lint commands**.
If a file doesn't exist or a command fails, silently skip it — never abort.

## Step 1 — Detect language/stack

```bash
STACK=unknown
[ -f go.mod ]                                                      && STACK=go
[ -f Cargo.toml ]                                                  && STACK=rust
[ -f pyproject.toml ] || [ -f requirements.txt ] || [ -f setup.py ] && STACK=python
[ -f Gemfile ]                                                     && STACK=ruby
[ -f pom.xml ] || [ -f build.gradle ] || [ -f build.gradle.kts ]  && STACK=jvm
[ -f mix.exs ]                                                     && STACK=elixir
[ -f package.json ]                                                && STACK=node
```

If STACK is still `unknown` after these checks:
1. Read `README.md` for language/framework mentions
2. Read `Makefile` for common build targets (`build`, `test`, `run`)
3. Look for other manifest files (`.nvmrc`, `runtime.txt`, `.tool-versions`)
4. Make your best inference and proceed — but **flag the assumption** (see Step 6)

## Step 2 — Detect package manager (Node only)

```bash
PM=npm
[ -f pnpm-lock.yaml ]    && PM=pnpm
[ -f yarn.lock ]         && PM=yarn
[ -f bun.lockb ]         && PM=bun
```

For Python:
```bash
PY_PM=pip
[ -f poetry.lock ]  && PY_PM=poetry
[ -f uv.lock ]      && PY_PM=uv
[ -f Pipfile.lock ] && PY_PM=pipenv
```

## Step 3 — Derive commands

Set these variables based on STACK and PM. Use them everywhere — never hardcode tool names.

| Variable | Node (pnpm) | Go | Python (poetry) | Rust | Ruby |
|---|---|---|---|---|---|
| `INSTALL_CMD` | `pnpm install --frozen-lockfile` | `go mod download` | `poetry install` | `cargo fetch` | `bundle install` |
| `BUILD_CMD` | `pnpm build` | `go build ./...` | *(empty)* | `cargo build` | `bundle exec rake build` |
| `TEST_CMD` | `pnpm test` | `go test ./...` | `poetry run pytest` | `cargo test` | `bundle exec rspec` |
| `LINT_CMD` | `pnpm lint` | `go vet ./...` | `ruff check . \|\| flake8 .` | `cargo clippy` | `bundle exec rubocop` |
| `TYPECHECK_CMD` | `pnpm typecheck \|\| npx tsc --noEmit` | *(empty — go build covers this)* | `mypy .` | *(empty)* | *(empty)* |

For Node, check `package.json` scripts before running each command to avoid errors on missing scripts:
```bash
node -e "process.exit(require('./package.json').scripts?.lint?0:1)" 2>/dev/null \
  && $PM run lint || true
```

For other stacks, check if the tool exists first:
```bash
command -v pytest > /dev/null 2>&1 && pytest || true
```

## Step 4 — Detect monorepo

If multiple manifests exist in subdirectories, identify the relevant workspace:

```bash
# Node workspaces
[ -f pnpm-workspace.yaml ] && echo "MONOREPO=pnpm-workspace"
# Go workspace
[ -f go.work ] && echo "MONOREPO=go-workspace"
# Python: multiple pyproject.toml
find . -name pyproject.toml -maxdepth 3 | wc -l | grep -q "^[2-9]" && echo "MONOREPO=python"
```

In a monorepo, identify which sub-package is relevant to the current task (usually from the file paths mentioned in the dev handoff or changed files).

## Step 5 — Detect pre-commit hooks

```bash
PRE_COMMIT_HOOKS=none
[ -f .husky/pre-commit ]         && PRE_COMMIT_HOOKS=husky
[ -f .lefthook.yml ] || [ -f lefthook.yml ] && PRE_COMMIT_HOOKS=lefthook
[ -f .pre-commit-config.yaml ]   && PRE_COMMIT_HOOKS=pre-commit
```

If `PRE_COMMIT_HOOKS` is set (not `none`), be prepared for `git commit` to run checks. See pre-commit hook handling in the developer agent.

## Step 6 — Flag assumptions

Any time detection is ambiguous or you infer something not explicitly stated, add it to the `"assumptions"` field in `.agent-result.json`. These appear in the monitor so the user knows what was inferred.

```json
"assumptions": [
  "Stack inferred as Python/poetry from pyproject.toml (no explicit stack set in agent config)",
  "Monorepo detected — working in packages/api subdirectory based on task file paths",
  "No test script found in package.json — test step skipped"
]
```

An empty array `[]` means no assumptions were made (everything was explicit).

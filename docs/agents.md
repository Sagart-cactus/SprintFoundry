# Agents Reference

SprintFoundry orchestrates specialized AI agents, each with a focused role, purpose-built instructions (`CLAUDE.md` or `CODEX.md`), and a defined set of input artifacts and output artifacts.

## Agent ID Format

Agent IDs are **free-form strings** — not a fixed enum. The platform ships with the agents below, but you can define custom agents (e.g., `go-developer`, `rust-qa`) in `platform.yaml`.

## Agent Roles (Ordered)

Roles define ordering for plan validation and mandatory rule injection:

```
orchestrator → product → architect → ui-ux → developer → code-review → qa → security → devops
```

## Dual Runtime Instructions

Each agent has instructions for both runtimes:

| Runtime | Instruction File | Used When |
|---------|-----------------|-----------|
| `claude-code` | `src/agents/<type>/CLAUDE.md` | provider is `claude-code` |
| `codex` | `src/agents-codex/<type>/CODEX.md` | provider is `codex` |

---

## Built-in Agents

### `product`
**Role:** product  
**Purpose:** Analyzes tickets, writes product specs, defines user stories and acceptance criteria.

**Reads:**
- `.agent-task.md` (ticket details)

**Produces:**
- `artifacts/product-spec.md` — what to build, why, constraints
- `artifacts/user-stories.md` — structured user stories
- `artifacts/scope.md` — in-scope / out-of-scope

---

### `architect`
**Role:** architect  
**Purpose:** Makes technical design decisions, defines system boundaries, API contracts, and data models.

**Reads:**
- `artifacts/product-spec.md`
- Existing codebase (relevant directories)

**Produces:**
- `artifacts/architecture.md` — component design, data flow
- `artifacts/api-contracts.yaml` — API shapes and endpoints
- `artifacts/data-model.md` — schema definitions
- `artifacts/decisions/ADR-*.md` — architecture decision records

---

### `developer`
**Role:** developer  
**Stack:** JavaScript / TypeScript  
**Plugins:** `js-nextjs`, `code-review`

**Purpose:** Implements features and fixes bugs in JS/TS projects. Follows a plan → implement → self-test → self-review → handoff workflow.

**Self-Review Checklist:**
- TypeScript strict mode — no `any`
- Lint passes (`eslint`, `tsc --noEmit`)
- Tests pass (`npm test`)
- Build succeeds (`npm run build`)

**Reads:**
- `artifacts/product-spec.md`
- `artifacts/architecture.md`
- `artifacts/api-contracts.yaml`
- `artifacts/ui-specs/` (if UI work)
- `.agent-context/` (previous step results)

**Produces:**
- Modified source files (`src/`)
- `artifacts/handoff/dev-to-qa.md` — what was built, test instructions, known risks

**Available Plugin Skills (`js-nextjs`):**
- `nextjs-app-router` — File conventions, routing, layouts, metadata API
- `react-patterns` — Server vs Client Components, Suspense, data fetching
- `nextjs-config` — next.config.mjs, environment variables, middleware
- `nextjs-testing` — Vitest + React Testing Library + Playwright setup
- `nextjs-performance` — ISR, streaming, image optimization, caching
- `api-routes` — Route Handlers, validation, error handling, auth patterns

**Available Plugin Skills (`code-review`):**
- `code-quality` — Readability, naming, function length, DRY, SOLID
- `error-handling` — Error propagation, swallowed errors, user-facing messages
- `performance-review` — N+1 queries, re-renders, memory leaks, bundle size

---

### `go-developer`
**Role:** developer  
**Stack:** Go  
**Plugins:** `code-review`

**Purpose:** Implements features and fixes bugs in Go projects. Follows the same plan → implement → self-test → self-review → handoff workflow as `developer`.

**Self-Review Checklist:**
- `go vet ./...` passes
- `go test ./...` passes
- `golangci-lint run` passes
- Race detector clean: `go test -race ./...`

**Reads:**
- `artifacts/product-spec.md`
- `artifacts/architecture.md`
- `artifacts/api-contracts.yaml`

**Produces:**
- Modified Go source files (`*.go`)
- `artifacts/handoff/dev-to-qa.md`

---

### `code-review`
**Role:** code-review  
**Plugins:** `code-review`

**Purpose:** Senior staff engineer performing a fresh-eyes review of all changes in the PR. Evaluates code quality, correctness, error handling, performance, and architecture alignment.

**Reads:**
- All files modified or created in the current run
- `artifacts/architecture.md` (for alignment checks)
- `artifacts/api-contracts.yaml`
- Developer handoff notes

**Produces:**
- `artifacts/code-review-report.md` — structured findings with severity levels
- `artifacts/handoff/review-to-dev.md` — required fixes and suggestions

**Available Plugin Skills:**
- `code-quality` — Readability, naming, DRY, type safety, SOLID principles
- `error-handling` — Swallowed errors, propagation, HTTP status codes
- `performance-review` — Algorithmic complexity, query efficiency, memory
- `testing-standards` — Test behavior vs implementation, assertions, edge cases
- `architecture-alignment` — ADR compliance, API contract conformance, patterns

---

### `qa`
**Role:** qa  
**Stack:** JavaScript / TypeScript

**Purpose:** Writes and executes a comprehensive test suite. Reports bugs that fail acceptance criteria.

**Reads:**
- `artifacts/product-spec.md` (acceptance criteria)
- `artifacts/handoff/dev-to-qa.md`
- Source code

**Produces:**
- Test files (`tests/`, `__tests__/`, `*.test.ts`)
- `artifacts/test-report.json` — pass/fail summary
- `artifacts/bugs.md` — bugs found with reproduction steps

**Testing Stack:**
- Unit: Vitest
- Integration/API: Supertest or Vitest
- E2E: Playwright

---

### `go-qa`
**Role:** qa  
**Stack:** Go

**Purpose:** Writes and executes Go tests. Reports bugs that fail acceptance criteria.

**Reads:**
- `artifacts/product-spec.md`
- `artifacts/handoff/dev-to-qa.md`
- Go source files

**Produces:**
- Test files (`*_test.go`)
- `artifacts/test-report.json`
- `artifacts/bugs.md`

**Testing Stack:**
- Unit: `testing` package
- HTTP: `net/http/httptest`
- Integration: testcontainers-go (when needed)
- Race detection: `go test -race`

---

### `security`
**Role:** security

**Purpose:** Scans code and dependencies for vulnerabilities. Reviews authentication, authorization, and data handling. Flags secrets, insecure patterns, and CVEs.

**Reads:**
- All source files
- `artifacts/architecture.md`
- `package.json`, `go.mod` (dependency files)

**Produces:**
- `artifacts/security-report.json` — findings with CVSS severity
- `artifacts/security-fixes.md` — required remediations

**Focus Areas:**
- OWASP Top 10
- Dependency CVEs
- Hardcoded secrets / credential exposure
- Auth and authorization logic
- Data validation at API boundaries
- Cryptographic misuse

---

### `ui-ux`
**Role:** ui-ux  
**Plugins:** `frontend-design`

**Purpose:** Designs user interfaces, creates component specs, wireframes, and accessibility reviews.

**Reads:**
- `artifacts/product-spec.md`
- `artifacts/user-stories.md`
- Existing design system / component library

**Produces:**
- `artifacts/ui-specs/user-flows.md` — user journey diagrams
- `artifacts/ui-specs/components.md` — component inventory
- `artifacts/component-specs.md` — detailed component specs
- Wireframe previews (HTML/React)

**Available Plugin Skills (`frontend-design`):**
- `design-system` — Design tokens, spacing scale, naming conventions
- `component-spec` — Structured component specs (props, states, variants, a11y)
- `wireframe-preview` — Renderable React/HTML wireframe previews
- `accessibility-audit` — WCAG 2.1 AA structured audit
- `responsive-layout` — Responsive patterns, breakpoints, container strategies
- `color-typography` — Color palette, type scale, contrast compliance

---

### `devops`
**Role:** devops

**Purpose:** Creates and updates CI/CD pipelines, Dockerfiles, infrastructure-as-code, and deployment configurations.

**Reads:**
- `artifacts/architecture.md`
- Source code structure
- Existing CI/CD config

**Produces:**
- `.github/workflows/*.yml` — GitHub Actions CI/CD pipelines
- `Dockerfile`, `docker-compose.yml`
- Infrastructure-as-code files (`terraform/`, `k8s/`)
- `artifacts/deployment-guide.md` — deployment instructions and runbook

---

## Agent Result Format

Every agent must write `.agent-result.json` when it finishes:

```json
{
  "status": "complete",
  "summary": "Implemented CSV export with streaming for large datasets",
  "artifacts_created": ["src/api/export.ts", "src/components/ExportButton.tsx"],
  "artifacts_modified": ["src/api/reports.ts"],
  "issues": ["Rate limiting not yet implemented — noted in handoff"],
  "rework_reason": null,
  "rework_target": null,
  "metadata": {
    "lines_added": 142,
    "files_created": 2
  }
}
```

| Field | Values | Description |
|-------|--------|-------------|
| `status` | `complete \| needs_rework \| blocked \| failed` | Outcome of this step |
| `summary` | string | One-paragraph description of what was done |
| `artifacts_created` | string[] | Files created (relative to workspace) |
| `artifacts_modified` | string[] | Files modified (relative to workspace) |
| `issues` | string[] | Problems, risks, or outstanding concerns |
| `rework_reason` | string | Why rework is needed (if `needs_rework`) |
| `rework_target` | string | Agent ID that should receive the rework |
| `metadata` | object | Free-form key/value pairs for observability |

---

## Plugin System

Plugins extend agents with additional skills and tools. They are resolved from the `plugins/` directory and passed to Claude Code via `--plugin-dir`.

### Plugin Structure
```
plugins/
  <plugin-name>/
    plugin.json          # Manifest (name, version, description)
    skills/
      <skill-name>/
        SKILL.md         # Skill content injected into agent context
```

### Built-in Plugins

| Plugin | Used By | Skills |
|--------|---------|--------|
| `js-nextjs` | `developer` | nextjs-app-router, react-patterns, nextjs-config, nextjs-testing, nextjs-performance, api-routes |
| `code-review` | `developer`, `code-review`, `go-developer` | code-quality, error-handling, performance-review, testing-standards, architecture-alignment |
| `frontend-design` | `ui-ux` | design-system, component-spec, wireframe-preview, accessibility-audit, responsive-layout, color-typography |

### Assigning Plugins to Agents (platform.yaml)

```yaml
agent_definitions:
  - type: developer
    plugins:
      - js-nextjs
      - code-review
```

---

## Codex Skills

Codex skills are a parallel mechanism to plugins, specifically for the `codex` runtime. Skills are staged into `CODEX_HOME/skills/` and referenced in the agent prompt.

### Enable
```yaml
# project.yaml
codex_skills_enabled: true
```

### Add Custom Skills
```yaml
codex_skill_catalog_overrides:
  my-skill:
    path: path/to/skill-dir   # Must contain SKILL.md
```

### Assign to Agents
```yaml
codex_skills_overrides:
  developer:
    - code-quality
    - my-skill
```

### How It Works
1. Before the agent runs, skill directories are copied to `<workspace>/.codex-home/skills/<skill-name>/`
2. A `skills/.manifest.json` is written listing all staged skills
3. The agent AGENTS.md gets a `## Runtime Skills` section listing available skills
4. The Codex runtime passes `CODEX_HOME` as an environment variable so the agent CLI can find skills

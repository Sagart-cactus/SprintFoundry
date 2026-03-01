# Skills Hybrid Execution Plan (Codex + Claude)

Date: 2026-03-01
Owner: SprintFoundry Core
Status: done

## Objectives
- Support repo-level skills for both runtimes:
  - Codex: `.agents/skills/<name>/SKILL.md`
  - Claude: `.claude/skills/<name>/SKILL.md`
- Support org/project-provided skills from config.
- Use one runtime-agnostic assignment model while preserving legacy `codex_*` compatibility.
- Add guardrails to prevent overloading one agent with too many skills.

## Phase Breakdown

### Phase 1 — Schema + Compatibility Layer
Status: done

Tasks:
- [x] Add runtime-agnostic types in `src/shared/types.ts`:
  - `SkillDefinition`, `SkillSource`, `SkillGuardrails`
  - `skills_enabled`, `skill_catalog`, `skill_assignments_per_agent`, `skill_sources`, `skill_guardrails`
- [x] Keep legacy keys (`codex_*`) supported and merged as fallback.

Validation:
- [x] `pnpm lint`

### Phase 2 — Unified Skill Resolution + Staging
Status: done

Tasks:
- [x] Extend `src/service/runtime/codex-skill-manager.ts` to resolve skills for both `codex` and `claude-code` runtimes.
- [x] Add support for source-based loading:
  - folder source (`type: folder`)
  - files source (`type: files`)
- [x] Add runtime-native repo discovery:
  - codex discovers workspace `.agents/skills`
  - claude discovers workspace `.claude/skills`
- [x] Add guardrail warnings/errors for skill counts.

Validation:
- [x] `pnpm vitest tests/codex-skill-manager.test.ts`

### Phase 3 — Runner Wiring
Status: done

Tasks:
- [x] Update `prepareWorkspace()` in `src/service/agent-runner.ts`:
  - resolve/stage skills for both runtimes
  - codex: stage into `.codex-home/skills`
  - claude: stage into workspace `.claude/skills`
- [x] Append runtime skill section to instruction file for traceability.

Validation:
- [x] `pnpm vitest tests/agent-runner.test.ts`

### Phase 4 — Docs + Examples
Status: done

Tasks:
- [x] Update `config/project.example.yaml` with runtime-agnostic skill config.
- [x] Add guidance for repo-level skills and org-level overrides.

Validation:
- [x] `pnpm dev -- validate --config config --project project`

Guidance summary:
- Repo-level skills:
  - Codex: `.agents/skills/<name>/SKILL.md`
  - Claude: `.claude/skills/<name>/SKILL.md`
- Org/project-level skills:
  - configure `skill_catalog_overrides` and/or `skill_sources`
  - assign by agent via `skill_assignments`
  - enforce limits via `skill_guardrails`

### Phase 5 — Rollout Gate + Metadata
Status: done

Tasks:
- [x] Add `skills_v2_enabled` feature gate (project/platform defaults).
- [x] Preserve legacy codex-only behavior when `skills_v2_enabled` is off.
- [x] Add skill metadata to runtime metadata:
  - skill names
  - runtime provider
  - staged skills directory
  - guardrail warnings
  - per-skill content hash

Validation:
- [x] `pnpm vitest tests/codex-skill-manager.test.ts tests/agent-runner.test.ts`

### Phase 6 — Monitor UI Surfacing
Status: done

Tasks:
- [x] Expose per-step runtime skill summary in monitor API (`runtime_skills` from event `runtime_metadata`).
- [x] Surface runtime skill count on run detail step cards.
- [x] Surface runtime skill names, warnings, and hashes in step result drawer.
- [x] Add monitor route test coverage for runtime skill summary payload.

Validation:
- [x] `pnpm vitest tests/api/monitor-routes.test.ts tests/codex-skill-manager.test.ts tests/agent-runner.test.ts`
- [x] `pnpm lint`
- [x] `pnpm dev -- validate --config config --project project`

## Execution Log
- 2026-03-01: Plan file created.
- 2026-03-01: Started Phase 1-3 implementation.
- 2026-03-01: Added runtime-agnostic skill schema/types with legacy `codex_*` compatibility.
- 2026-03-01: Implemented unified skill staging for codex + claude runtime paths.
- 2026-03-01: Updated runner skill wiring and guardrail warning logs.
- 2026-03-01: Validation passed:
  - `pnpm vitest tests/codex-skill-manager.test.ts tests/agent-runner.test.ts`
  - `pnpm lint`
  - `pnpm dev -- validate --config config --project project`
- 2026-03-01: Added rollout gating (`skills_v2_enabled`) and runtime skill metadata hashes.
- 2026-03-01: Re-ran validations after Phase 5:
  - `pnpm vitest tests/codex-skill-manager.test.ts tests/agent-runner.test.ts`
  - `pnpm lint`
  - `pnpm dev -- validate --config config --project project`
- 2026-03-01: Added monitor API/UI runtime skills surfacing and route tests.

## Open Risks
- Claude runtime skill activation behavior differs by CLI/SDK mode; staging `.claude/skills` is the lowest-risk baseline.
- Overly permissive skill loading can bloat prompts; guardrails are enabled as warnings first.

## Completion Criteria
- [x] Existing Codex tests pass without regressions.
- [x] Claude and Codex both can consume configured skills.
- [x] Legacy `codex_*` configs still work.

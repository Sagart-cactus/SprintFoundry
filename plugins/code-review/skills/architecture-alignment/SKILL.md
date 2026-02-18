---
name: architecture-alignment
description: Architecture conformance review — verify implementation matches architecture docs, API contracts, ADRs, and codebase patterns. Use when checking that code follows the planned design.
---

# Architecture Alignment Review

## Architecture Document Conformance
- Implementation matches the design in `artifacts/architecture.md` (if present)
- Data models match the defined schema (field names, types, relationships)
- Service boundaries are respected — no cross-boundary direct access
- Communication patterns match the design (REST, gRPC, events, etc.)
- State management follows the documented approach

## API Contract Conformance
- Endpoints match `artifacts/api-contracts.yaml` or OpenAPI spec (if present)
- Request/response shapes match the contract exactly (field names, types, nesting)
- Required vs optional fields match the spec
- HTTP methods are correct (GET for reads, POST for creates, PUT/PATCH for updates)
- Error response format matches the documented standard
- Pagination, filtering, and sorting follow the contract

## ADR Compliance
- Check `artifacts/decisions/` or `docs/adr/` for relevant Architecture Decision Records
- Implementation follows the chosen approach in relevant ADRs
- If deviating from an ADR, the deviation is documented with rationale
- New architectural decisions are recorded as ADRs

## Pattern Consistency
- New code follows the same patterns as existing code in the same module
- If the project uses Repository pattern, new data access follows it
- If the project uses middleware chains, new cross-cutting concerns use middleware
- Error handling follows the project's established pattern
- Configuration follows the project's approach (env vars, config files, etc.)
- Naming conventions match (file names, directory structure, export patterns)

## Dependency Introduction
- New dependencies have a documented justification
- No duplicate functionality (check if existing deps already provide the feature)
- License compatibility verified
- Dependency is actively maintained (not abandoned/archived)
- Bundle size impact considered for frontend dependencies
- Security audit status checked (known vulnerabilities)

## Layer Violations
- Controllers/handlers don't contain business logic
- Business logic doesn't import HTTP/transport concerns
- Data access layer doesn't leak into business logic
- Frontend components don't make direct database calls
- Shared utilities don't import from feature-specific modules

## Review Checklist Summary
1. Does the implementation match the architecture document?
2. Do API endpoints conform to the contract specification?
3. Are relevant ADRs being followed?
4. Does new code follow existing patterns and conventions?
5. Are new dependencies justified and vetted?
6. Are architectural layers properly separated?

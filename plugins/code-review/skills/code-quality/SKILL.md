---
name: code-quality
description: Code quality review checklist — readability, naming, function length, DRY, type safety, SOLID principles, and debug artifact detection. Use when reviewing code for maintainability and correctness.
---

# Code Quality Review

## Readability

### Naming
- Variables, functions, and types have descriptive, intention-revealing names
- Boolean variables/functions use `is`/`has`/`can`/`should` prefixes
- Consistent naming conventions throughout (camelCase, snake_case, etc.)
- No single-letter names outside of short loops or lambda parameters
- No abbreviations that aren't universally understood

### Function Length & Complexity
- Functions are under 50 lines (prefer under 30)
- Cyclomatic complexity is low — few nested conditionals
- Each function has a single, clear responsibility
- Early returns for guard clauses instead of deep nesting
- Complex conditions extracted into well-named boolean variables or helper functions

### Code Organization
- Related code is grouped together
- Imports are organized (stdlib → external → internal)
- No circular dependencies between modules
- Public API surface is minimal — unexported by default

## DRY Violations
- No copy-pasted logic blocks (3+ similar lines = extract)
- Shared constants instead of magic numbers/strings
- Common patterns extracted into utility functions
- But: don't over-abstract — two similar blocks is not a DRY violation

## Dead Code & Debug Artifacts
- No `console.log`, `console.debug`, `fmt.Println` debug statements
- No `debugger` statements
- No commented-out code blocks
- No unused imports, variables, or functions
- No TODO/FIXME/HACK comments (address them or move to issue tracker)

## Type Safety
- No `any` types in TypeScript (use `unknown` + type guards when needed)
- No type assertions (`as`) without validation
- Function signatures have explicit parameter and return types
- Discriminated unions over loose string types
- Go: no `interface{}` without type assertion; use generics where appropriate

## Import Hygiene
- No unused imports
- No wildcard imports (`import *`) in production code
- No circular import chains
- Dependencies are imported from their canonical path

## SOLID Principles
- **Single Responsibility**: Each module/class does one thing
- **Open/Closed**: Extend behavior without modifying existing code
- **Liskov Substitution**: Subtypes are substitutable for base types
- **Interface Segregation**: Small, focused interfaces over large ones
- **Dependency Inversion**: Depend on abstractions, not concretions

## Review Checklist Summary
1. Can you understand what each function does from its name alone?
2. Are there any functions over 50 lines?
3. Is there duplicated logic that should be extracted?
4. Are there any debug artifacts or dead code?
5. Are types strict (no `any`, no unsafe assertions)?
6. Are imports clean and minimal?

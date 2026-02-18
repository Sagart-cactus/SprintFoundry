---
name: testing-standards
description: Testing quality review — test behavior vs implementation, assertion quality, edge case coverage, test isolation, and mock boundaries. Use when reviewing test code.
---

# Testing Standards Review

## Test Behavior, Not Implementation
- Tests describe what the code does, not how it does it internally
- Refactoring the implementation should not break tests (unless behavior changes)
- No testing of private methods directly — test through the public API
- Test names describe the expected behavior: `"returns 404 when user not found"`
- No testing of framework internals or library behavior

## Assertion Quality
- Assertions are specific: `expect(result).toBe(42)` not `expect(result).toBeTruthy()`
- Error paths assert the specific error type/message, not just "throws"
- Snapshot tests used sparingly — prefer explicit assertions for critical values
- Each test has at least one meaningful assertion (no test-without-assert)
- Assert on the relevant output, not on internal state

## Edge Case Coverage
- Empty inputs: empty strings, empty arrays, null/undefined
- Boundary values: 0, -1, MAX_INT, empty collections
- Invalid inputs: wrong types, malformed data, SQL injection strings
- Concurrency: race conditions, duplicate submissions
- Error paths: network failures, timeouts, permission denied
- Unicode and i18n: non-ASCII characters, RTL text, emoji

## Test Isolation
- Each test is independent — no shared mutable state between tests
- Tests can run in any order and still pass
- Database state is reset between tests (transactions, truncation, or fresh fixtures)
- External services are mocked (no real HTTP calls in unit tests)
- File system operations use temp directories, cleaned up in `afterEach`
- Environment variables are restored after tests that modify them

## Mock at Boundaries, Not Internals
- Mock external services (HTTP APIs, databases, file system, time)
- Don't mock the code under test or its direct collaborators
- Use dependency injection to make mocking clean
- Mocks return realistic data (not empty objects or bare minimum)
- Verify mock interactions only when the side effect is the behavior being tested
- Prefer test doubles (fakes, stubs) over mock assertion libraries when possible

## Test Organization
- Test files colocated with source or in a parallel `tests/` directory (follow project convention)
- Describe/context blocks group related scenarios
- Setup/teardown is minimal and in `beforeEach`/`afterEach`
- Helper functions for repeated test setup (factory functions, builders)
- Integration tests clearly separated from unit tests

## Review Checklist Summary
1. Do tests describe behavior or implementation details?
2. Are assertions specific and meaningful?
3. Are edge cases and error paths covered?
4. Can tests run independently in any order?
5. Are mocks at service boundaries, not internal functions?
6. Are tests organized consistently with the project's conventions?

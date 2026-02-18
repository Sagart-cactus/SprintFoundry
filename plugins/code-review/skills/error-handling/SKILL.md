---
name: error-handling
description: Error handling review — swallowed errors, propagation chains, user-facing vs internal messages, HTTP status codes, and Go error patterns. Use when reviewing error handling correctness.
---

# Error Handling Review

## No Swallowed Errors
- No empty `catch` blocks — at minimum, log the error
- No `catch (e) { return null }` without documenting why
- Promises must have `.catch()` or be `await`-ed inside try/catch
- Go: no `_ = someFunc()` that discards error returns
- Go: no bare `if err != nil { return }` that loses error context

## Error Propagation Chain
- Errors include context as they propagate up the stack
- Original error is preserved (wrapped, not replaced)
- TypeScript: use `cause` option in `new Error("msg", { cause: err })`
- Go: use `fmt.Errorf("context: %w", err)` to wrap errors
- Stack traces are available in development but not leaked to users

## User-Facing vs Internal Errors
- User-facing error messages are helpful and non-technical
- Internal error details (stack traces, SQL errors, file paths) are never exposed to users
- Sensitive data (API keys, passwords, internal URLs) never appears in error messages
- Error responses include actionable guidance when possible

## HTTP Status Code Correctness
- `400` for client input validation failures
- `401` for missing/invalid authentication
- `403` for authenticated but unauthorized access
- `404` for resources that don't exist
- `409` for conflict (duplicate creation, concurrent modification)
- `422` for well-formed but semantically invalid input
- `500` for unexpected server errors only
- Never `200` with an error body

## Go-Specific Error Patterns
- Use `errors.Is(err, target)` for sentinel error comparison (not `==`)
- Use `errors.As(err, &target)` for type-based error checking
- Define sentinel errors as package-level `var ErrXxx = errors.New("...")`
- Custom error types implement the `error` interface
- Context propagation: pass `context.Context` and check `ctx.Err()`

## Async & Concurrent Error Handling
- Goroutines and async tasks have error reporting channels
- `Promise.all` failures are handled (one rejection doesn't silently kill others)
- Background workers have retry logic with backoff for transient failures
- Timeouts are set on all external calls (HTTP, database, file I/O)

## Review Checklist Summary
1. Are there any empty catch blocks or discarded errors?
2. Do errors include sufficient context for debugging?
3. Are user-facing and internal errors properly separated?
4. Are HTTP status codes accurate for each error condition?
5. Are concurrent operations handling errors correctly?

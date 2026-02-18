---
name: performance-review
description: Performance anti-pattern detection — N+1 queries, React re-render issues, memory leaks, bundle size problems, and Go concurrency pitfalls. Use when reviewing code for performance.
---

# Performance Review

## N+1 Query Detection
- No database queries inside loops (fetch all IDs, then batch query)
- ORM eager-loading used for known relation traversals
- GraphQL resolvers use DataLoader pattern for batching
- SQL queries use `IN (...)` instead of per-item `WHERE id = ?`
- Pagination implemented for unbounded list queries

## React Performance
- Components that receive objects/arrays as props use `React.memo` when appropriate
- Callback props are wrapped in `useCallback` to prevent child re-renders
- Expensive computations use `useMemo`
- No object/array literals created in render (causes new reference each render)
- State updates are batched where possible
- Lists use stable `key` props (not array index for dynamic lists)
- Large lists use virtualization (react-window, tanstack-virtual)
- No state stored higher than necessary (colocation principle)

## Memory Leaks
- Event listeners are cleaned up in `useEffect` return / `componentWillUnmount`
- `setInterval` / `setTimeout` are cleared on component unmount or scope exit
- Subscriptions (WebSocket, EventSource, observable) are unsubscribed on cleanup
- AbortController used for fetch requests that may be cancelled
- Go: goroutines have explicit exit conditions (context cancellation, done channel)
- Go: `defer` used for resource cleanup (file handles, locks, connections)

## Bundle Size
- Large libraries imported selectively (`import { debounce } from 'lodash-es'` not `import _ from 'lodash'`)
- Dynamic imports (`import()`) for route-level code splitting
- Images and assets are optimized (next/image, SVG for icons)
- No duplicate dependencies (check with `npm ls <pkg>`)
- Tree-shaking friendly exports (named exports, no side effects in modules)

## Go Concurrency
- Goroutines always have a way to terminate (context, done channel, or WaitGroup)
- Channels are closed by the sender, never the receiver
- No unbuffered channel sends without a guaranteed receiver (deadlock risk)
- `sync.Mutex` used for shared mutable state (not channels for simple locking)
- `sync.Pool` for frequently allocated/deallocated objects
- `context.Context` propagated through the call chain for cancellation

## Database & I/O
- Connection pooling configured with appropriate limits
- Queries use prepared statements for repeated execution
- Indexes exist for frequently queried columns
- Large file operations use streaming (not loading entire file into memory)
- External API calls have timeouts and circuit breakers

## Review Checklist Summary
1. Are there database queries inside loops?
2. Are React components re-rendering unnecessarily?
3. Are all event listeners, timers, and subscriptions cleaned up?
4. Are large dependencies imported selectively?
5. Are goroutines properly managed with cancellation?
6. Are database queries using indexes and connection pooling?

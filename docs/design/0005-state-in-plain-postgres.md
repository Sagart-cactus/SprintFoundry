# 0005: State lives in plain Postgres tables, without a workflow library

Status: decided on 22 November 2026 after a spike.

## Decision

The controller keeps all state in Postgres tables it owns: runs, the effect journal, criteria, evidence. Progress is a row with a state and a wake-up time. Workers claim due rows with `FOR UPDATE SKIP LOCKED`, which also bounds concurrency. Every external effect goes through the `effect` package: intent, remote lookup, act, record.

## Rejected

**DBOS Transact for Go (v1.9.0).** We ran it against Postgres and killed the process inside a step, after the step's side effect and before it returned.

| What we saw | Consequence |
|---|---|
| On restart the workflow resumed by itself and the completed first step was skipped | The library does what it says |
| The interrupted step ran again, so the side effect happened twice | Every external effect still needs its own marker and remote lookup. That is the hard part, and the library does not remove it |
| A rebuilt binary left the workflow pending, because the default application version is a hash of the binary | Every upgrade would need care that our own tables do not need |
| A second process that started the library re-ran a step that was still in flight | Our binary has several commands (`demo`, `verify`, the server). Only one may start the engine, and nothing enforces that |

It also offers durable timers, queues with concurrency limits and waiting for an external event, and those worked. We need small versions of all three and will write them as rows and a poll loop.

**Temporal.** A separate server to install, and it has the same at-least-once step semantics.

## Consequences

- One dependency for storage: a Postgres driver.
- Local mode starts Postgres as a container. Docker is already required.
- The failure-injection suite in milestone 3 tests our own recovery, not a library's.

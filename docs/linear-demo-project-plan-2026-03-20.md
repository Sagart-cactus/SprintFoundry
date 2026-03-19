# Linear Demo Project Plan

## Goal

Define an ideal demo project for SprintFoundry where:

- a human creates issues in Linear
- SprintFoundry picks them up automatically
- the developer agent implements the work
- the QA agent validates it and opens a PR
- the merge bot resolves simple merge friction, runs smoke checks, and merges

This document is intentionally planning-only. It does not propose code changes in SprintFoundry itself.

## Recommended Demo Project

**Project name:** `LaunchDeck`

**Tagline:** a small product-launch dashboard for internal teams to plan, publish, and review launch checklists.

**Why this is the best demo candidate**

- It is easy to understand in under a minute.
- It supports UI work, API work, validation work, and small data-model changes.
- It creates visually obvious outcomes for a live demo.
- It can be built as a compact TypeScript app with straightforward tests.
- Tickets can be sliced into clean, single-agent units.
- QA value is easy to show because each feature naturally needs unit tests and a small end-to-end flow.
- Merge-bot value is easy to show because multiple tickets will touch shared files like routes, schemas, and navigation.

## Product Shape

Build `LaunchDeck` as a small full-stack app with:

- a dashboard page
- a launches list
- a launch detail page
- checklist items per launch
- comments/activity log
- status badges
- a simple REST or RPC API

Recommended stack:

- Next.js or Vite + React frontend
- Node/TypeScript backend
- SQLite or Postgres
- Vitest for unit/integration tests
- Playwright for one or two happy-path end-to-end tests

## Why This Works Well For SprintFoundry

### Developer agent fit

The developer agent can handle tickets like:

- add a new status filter
- add checklist due dates
- add a launch owner field
- show completion progress on cards
- add optimistic update for checklist toggles

These are concrete, code-producing, branch-worthy tasks.

### QA agent fit

The QA agent can demonstrate value by:

- adding or fixing unit tests
- running targeted integration tests
- running a small Playwright smoke test
- checking that the feature actually works from the UI

### Merge-bot fit

The merge bot can demonstrate value by:

- rebasing branches after concurrent changes
- resolving small conflicts in shared navigation, types, or test snapshots
- rerunning smoke tests
- merging only when the branch is clean

## Linear Project Structure

Create one Linear project named:

`SprintFoundry Demo - LaunchDeck`

Suggested workflow states:

- `Todo`
- `In Progress` or omit if you want SprintFoundry to own execution directly
- `Review`
- `Done`

Suggested labels:

- `demo`
- `frontend`
- `backend`
- `testing`
- `workflow`

Suggested milestone buckets:

- `M1 Core Launch List`
- `M2 Checklist and Activity`
- `M3 Polish and Reliability`

## Demo Ticket Design Principles

Tickets should be:

- small enough for a single developer-agent pass
- testable in isolation
- visible in the UI or API
- not blocked on unclear product decisions
- likely to touch shared files occasionally so merge-bot value is visible

Avoid tickets that require:

- complex auth flows
- third-party billing
- external APIs with unstable mocks
- large migrations
- vague product discovery

## Suggested Demo Backlog

### Wave 1: clear wins

1. Create launches list page with seeded sample launches.
2. Add launch detail page with title, owner, target date, and status.
3. Add checklist section with complete/incomplete toggles.
4. Show checklist completion progress on launch cards.
5. Add status filter on the launches dashboard.

### Wave 2: QA-friendly tickets

6. Add unit tests for checklist progress calculation.
7. Add API validation for launch create/update payloads.
8. Add Playwright smoke test for launch detail and checklist toggle flow.
9. Add activity log entry when checklist items change.

### Wave 3: merge-bot-friendly tickets

10. Add sidebar navigation badge with count of launches in review.
11. Add launch sorting by target date and status.
12. Add “recent activity” widget to the dashboard.

These last tickets are useful because they increase the chance of overlapping edits in:

- dashboard layout
- shared types
- navigation components
- test fixtures

## Best Demo Narrative

### Setup

- The app already exists with a small seeded dataset.
- SprintFoundry is connected to Linear, GitHub, and the demo cluster.
- Webhooks are active.

### Live demo flow

1. Create two or three issues in Linear in `Todo`.
2. Show SprintFoundry picking up the first issue automatically.
3. Show the developer branch appearing in GitHub and the Linear issue moving to `Review`.
4. Show the QA agent validating the branch and opening a PR.
5. Create or reveal a second ticket that causes a small overlapping change.
6. Show merge-bot handling the PR path and merging after checks.
7. Show the Linear issue move to `Done`.
8. Open the app and show the visible feature now live.

## Ideal Demo Tickets For The First Run

If only three tickets are used for the first polished demo, use these:

1. `Add checklist completion progress to launch cards`
2. `Add status filter to the launches dashboard`
3. `Add activity log entry when checklist items are completed`

Why these three:

- they are easy to explain
- they create UI and behavior changes
- they require tests
- they touch shared files
- they produce a satisfying before/after demo

## Acceptance Criteria For The Demo Project Itself

The demo repo should be ready when:

- it installs with one command
- tests run locally and in CI
- seeded demo data makes the UI immediately useful
- each ticket can be completed in a single focused branch
- PR diffs are human-readable
- one or two concurrent tickets can create believable merge overlap

## Risks And Mitigations

### Risk: tickets are too large

Mitigation:

- keep every Linear issue scoped to one visible change or one backend capability

### Risk: the app is too trivial

Mitigation:

- include both UI and backend logic so QA and merge steps look substantive

### Risk: the app is too complex

Mitigation:

- avoid auth, external APIs, billing, and background jobs in the demo repo

### Risk: merge-bot has nothing interesting to do

Mitigation:

- intentionally choose a few tickets that touch shared files like dashboard layout, navigation, and shared schema/types

## Recommendation

Use `LaunchDeck` as the canonical SprintFoundry demo repo.

It is the best balance of:

- understandable product surface
- visually obvious implementation output
- easy ticket slicing in Linear
- strong QA story
- believable merge-bot story

If needed later, a second demo can be created for a more backend-heavy workflow, but `LaunchDeck` should be the primary public demo because it shows the full SprintFoundry loop clearly and quickly.

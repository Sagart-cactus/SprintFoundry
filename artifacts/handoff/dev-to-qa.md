# Developer → QA Handoff

## What Changed
- `monitor/public/index.html`
- Updated Run Monitor IA shell to a timeline-first structure:
  - run header strip (project/run/status/elapsed + refresh controls)
  - phase progress region
  - primary timeline region
  - active context region
  - secondary tab region (`Artifacts`, `Logs`, `Result JSON`)
- Added timeline/refresh controls needed for incremental behavior validation:
  - `Load older events`
  - `Jump to latest`
  - `Pause updates` / `Resume updates`
  - `Sync now`

- `monitor/public/styles.css`
- Implemented responsive layout behavior consistent with IA intent:
  - `>=1100px`: split timeline/context
  - `768-1099px`: stacked timeline then context
  - `<768px`: timeline-first with secondary content below
- Added row and control states needed for QA state-preservation checks:
  - selected timeline row styling
  - payload expand/collapse presentation
  - follow-paused notice state
  - keyboard focus-visible states

- `monitor/public/app.js`
- Replaced full timeline rerendering with incremental DOM patching strategy (`patchChildrenInOrder`) to reduce visual jitter.
- Implemented deterministic event keys (`eventSignature` + occurrence suffix via `deriveEventKey`) for stable node reuse across polls.
- Added load-more prepend behavior that preserves viewport position.
- Preserved interaction state across refresh cycles (selection, payload expansion, timeline focus, follow/latest mode).
- Added explicit pause/resume live updates and one-shot manual sync behavior.
- Kept existing monitor API contracts unchanged (`/api/runs`, `/api/run`, `/api/events`, `/api/log`, `/api/files`).

## IA Decisions (For QA Validation)
- Timeline is primary navigation for understanding run progression; context is detail for selected timeline event.
- Summary-first timeline rows are intentional: users scan event type/time/preview before opening payload JSON.
- Active step + next action are derived from run status/step/event signals so users do not need to infer progress from raw events only.
- Secondary content remains available but de-emphasized behind tabs so timeline/context stays dominant.
- Follow-latest behavior is user-controlled: scrolling up pauses follow, and explicit `Jump to latest` restores tail-following.

## Incremental Update Strategy (For QA Validation)
- Polling updates fetch fresh run/event data, then patch timeline nodes in place instead of replacing full list HTML.
- Existing row nodes are reused when keys match; only inserted/removed/moved nodes change.
- `Load older events` increases event limit and prepends older rows while compensating `scrollTop` by height delta.
- Manual sync while paused performs one refresh but does not re-enable live polling.
- Selection/context rendering is refreshed from state, not reset blindly on every poll.

## Preserved UI State Rules
- Selected event:
  - Rule: if selected event key still exists after refresh, keep selection.
  - Fallback: if missing, select newest event and update context.
- Payload expansion:
  - Rule: expanded/collapsed state is tracked per event key and survives refreshes.
- Timeline scroll position:
  - Rule: prepend operation preserves reading position using scroll-height delta compensation.
  - Rule: when follow mode is active and user is near bottom, keep pinned to latest.
- Focus:
  - Rule: timeline focus remains on the same event summary control when possible after updates.
  - Rule: context heading focus only moves during explicit row selection action.
- Follow/latest mode:
  - Rule: user scroll away from tail sets follow paused.
  - Rule: `Jump to latest` restores follow mode and scrolls to tail.
- Live updates:
  - Rule: `Pause updates` stops interval-driven refresh.
  - Rule: `Sync now` works while paused as one-shot refresh.

## How to Test
1. Start monitor server in a local environment that allows loopback HTTP listen.
2. Open monitor UI, pick a run with active/ongoing events.
3. Verify IA layout order and hierarchy:
   - header and phase first, timeline primary, context adjacent/stacked based on breakpoint, secondary tabs available.
4. Verify summary-first rows and payload toggles:
   - row shows event type/time/preview;
   - `Show payload` expands JSON;
   - refresh does not collapse already expanded rows.
5. Verify incremental prepend behavior:
   - scroll to mid-list;
   - click `Load older events`;
   - confirm older rows appear above without visible jump away from current reading line.
6. Verify preserved selection/focus:
   - select a row;
   - trigger `Sync now`;
   - confirm same row remains selected and keyboard focus remains on same row control.
7. Verify follow pause/recovery:
   - scroll up from bottom;
   - confirm follow-paused notice + `Jump to latest` visibility;
   - click `Jump to latest` and confirm tail-follow resumes.
8. Verify pause/resume semantics:
   - click `Pause updates`, wait beyond poll interval, confirm no automatic content changes;
   - click `Sync now`, confirm one refresh;
   - click `Resume updates`, confirm periodic updates return.
9. Verify tabs (`Artifacts`, `Logs`, `Result JSON`) still load expected content.

## Explicit Verification Notes: Jitter Reduction
- Goal: reduce visual jump/flicker during periodic refresh and load-more actions.
- Pass indicators:
  - Timeline does not flash/repaint as a full blank-then-refill list on poll.
  - Expanded payload rows remain open through updates.
  - Selected row highlight does not drop/reset during updates.
  - Viewport anchor remains stable when prepending older events.
  - Keyboard focus does not unexpectedly move to top/header on refresh.
- Recommended QA checks:
  - Run `Sync now` repeatedly while a row is selected and payload is expanded; verify no state loss.
  - Keep timeline at tail, allow automatic refresh, verify only new rows append and no list-wide jump occurs.
  - During `Load older events`, place cursor over a known row and verify its on-screen position remains effectively stable after prepend.
- Known non-goal:
  - If event identity truly changes (different signature/order), row reuse may change for affected items; this is expected and not a regression.

## Environment Setup
- No new environment variables.
- No new dependencies.
- No database migrations.

## Notes
- Sandbox limitations in this developer run:
  - `npm test` could not run successfully in this environment because `vitest` is unavailable at runtime.
  - Browser/server smoke validation could not be executed here because local listen is blocked (`EPERM` on `127.0.0.1`).
- QA should run the above verification in a normal local/dev environment where monitor server startup is allowed.

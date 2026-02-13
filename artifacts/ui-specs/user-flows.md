# User Flows

## Flow 1: Monitor a running run (desktop)
1. User opens Run Monitor and selects project/run from the top global controls.
2. Run header strip loads with run ID, project, current status, start time, elapsed time, and primary actions (`Pause auto-refresh`, `Jump to active step`, `Open artifacts`).
3. Phase progress bar renders directly under header with ordered phases (`Plan`, `Execute`, `Validate`, `Finalize`) and current phase highlighted.
4. Main split shows timeline on the left and active step/decision context on the right.
5. Timeline auto-scrolls to the newest event unless user manually scrolls up (auto-follow pauses).
6. Selecting any timeline item updates active context panel with step details, decision reason, impacted files, and agent output summary.
7. Secondary panel (artifacts/logs) appears as a right rail tabset; user can switch between `Artifacts`, `Logs`, and `Result JSON` without losing main selection.

**Error path:** If run data fails to load, replace main split with inline error state: "Unable to load this run. Check monitor server connectivity and try again." Keep header strip visible with `Retry` button.

## Flow 2: Review a decision and related artifacts
1. User clicks a `Decision` event in timeline.
2. Active context panel anchors to `Decision context` section and shows decision prompt, selected option, confidence, and rationale.
3. User opens `Artifacts` tab in secondary panel.
4. Artifact list filters to files touched by selected decision, sorted newest-first.
5. User selects one artifact to preview metadata and quick actions (`Open`, `Copy path`).

**Error path:** If artifact content is unavailable, show "Artifact unavailable for this step." with `Refresh artifacts` action.

## Flow 3: Mobile monitoring with accordion + drawer
1. User opens Run Monitor on a phone (<768px).
2. Header strip collapses to two rows: run identity/status row and compact actions row.
3. Phase progress becomes horizontally scrollable chip-track with current phase pinned first.
4. Main content defaults to timeline list; tapping an event opens active context in a bottom drawer.
5. Secondary content is moved into an accordion below timeline (`Artifacts`, `Logs`, `Result JSON`), single-section-open behavior.
6. If user taps `Open full logs`, logs expand into full-height drawer with close control and preserved scroll position.
7. Closing drawer returns focus to trigger event row/accordion button.

**Error path:** If log fetch fails in drawer, show inline error: "Unable to fetch logs. Pull to retry or tap Refresh." Keep drawer open for retry.

## Flow 4: Keyboard/screen reader interaction
1. User tabs through header actions, then phase progress landmarks, then timeline.
2. Timeline rows are keyboard-selectable (`Enter`/`Space`) and announce type + timestamp + status.
3. Selecting a row moves virtual cursor target to active context heading (`aria-live="polite"` summary announcement only).
4. Opening mobile drawer traps focus within drawer until dismissed with `Escape` or close button.

**Error path:** If focus target is missing (stale selection), return focus to timeline list container and announce "Selection expired; choose another event."

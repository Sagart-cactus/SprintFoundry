# Bug Report — SPR-5: Default monitor to v3, remove v1/v2 routes

## CRITICAL Issues
(none found)

## MAJOR Issues
(none found)

## MINOR Issues

### BUG-1: docs/operations.md still lists /v2 as a valid UI route

- **File**: `docs/operations.md`, lines 62–64
- **Steps to reproduce**: Open `docs/operations.md`, find the "UI routes" section under "Monitor".
- **Expected**: The section should list `/` as the canonical v3 UI and note that `/v2` is removed.
- **Actual**: The section reads:
  ```
  - `http://127.0.0.1:4310/` (legacy)
  - `http://127.0.0.1:4310/v2`
  - `http://127.0.0.1:4310/v3`
  ```
  This is wrong on two counts: `/` is labeled `(legacy)` (it is now the primary URL), and `/v2` is listed as if it still works (it returns 404).
- **Suggested fix**: Update the section to:
  ```
  - `http://127.0.0.1:4310/` — v3 UI (default)
  - `http://127.0.0.1:4310/v3` — v3 UI (legacy alias)
  - `/v2` is removed; returns 404
  ```

### BUG-2: docs/README.md description of monitor.md still mentions /v2

- **File**: `docs/README.md`, line 10
- **Steps to reproduce**: Open `docs/README.md`, find the entry for `docs/monitor.md`.
- **Expected**: Description should not list `/v2` as a live route.
- **Actual**: Reads: `docs/monitor.md — run monitor APIs and UI routes (/, /v2, /v3)`
- **Suggested fix**: Update to: `docs/monitor.md — run monitor APIs and UI routes (/, /v3)`

# Developer → QA Handoff

## What Changed

- **`monitor/server.mjs`** — Removed `publicDir` and `publicV2Dir` constants. `GET /` and all unmatched routes now serve from `publicV3Dir` (`monitor/public-v3`). `/v2` and all sub-paths return HTTP 404 with a descriptive message. The `/v3` prefix route is unchanged (still resolves to v3 assets). Added a comment in server.mjs explaining the 404-not-redirect decision.
- **`monitor/public-v2/`** — Deleted entirely (was the v2 UI: `app.js`, `index.html`, `run.html`, `run.js`, `styles.css`).
- **`monitor/public/`** — Deleted entirely (was the legacy v1 UI: `app.js`, `index.html`, `styles.css`).
- **`README.md`** — Updated monitor quick-start URL from `/v3` to `/`. Updated repo structure description from "static UIs (`/`, `/v2`, `/v3`)" to "v3 UI (`/`)".
- **`docs/monitor.md`** — Updated UI Versions section to reflect v3 as default at `/`, `/v3` as a legacy alias, and `/v2` as removed (404).

## How to Test

1. Start the monitor: `npm run monitor`
2. Open `http://127.0.0.1:4310/` — should serve the v3 board UI (same as the old `/v3`).
3. Navigate to `http://127.0.0.1:4310/v2` — should return HTTP 404 with message "Not found — /v2 has been removed. Use / instead."
4. Navigate to `http://127.0.0.1:4310/v2/run?project=foo&run=bar` — should also return 404.
5. Navigate to `http://127.0.0.1:4310/v3` — should still serve the v3 UI (backward-compat alias).
6. Verify all API endpoints still work:
   - `GET /api/runs`
   - `GET /api/run?project=<id>&run=<id>`
   - `GET /api/events?project=<id>&run=<id>`
   - `GET /api/log?project=<id>&run=<id>&kind=agent_stdout`
   - `GET /api/files?project=<id>&run=<id>`

## Environment Setup

No new env vars or dependencies. No database migrations.

## Notes

- **Why 404 not redirect**: A redirect (301/302) would silently mask the fact that `/v2` is gone, allowing stale scripts or bookmarks to appear to work. A 404 makes the removal explicit and loud, which is preferable for internal tooling.
- The `monitor/public/` (v1) directory was removed because its files (`app.js`, `index.html`, `styles.css`) are not referenced by the v3 UI and are no longer served by any route.
- `/v3` prefix route is intentionally kept as a convenience alias — no functional impact.

# Monitor Local Run Check

Monitor v3 surfaces local run state from the run workspace plus optional DB-backed APIs.

## Step Results

- The run detail page fetches `GET /api/run` for step list and inline `result_summary` text.
- Clicking `Step Result` calls `GET /api/step-result?project=<id>&run=<id>&step=<n>`.
- Result payload is rendered as:
  - `status`, `summary`, `source`
  - `issues[]`
  - `metadata` as an expandable key/value tree
  - runtime skill metadata when present
- Filesystem mode resolves step results in this order:
  - `.sprintfoundry/step-results/step-<n>.attempt-<m>.*.json`
  - `.agent-context/step-<n>-*.json`
  - `.agent-result.json` only for the latest completed step

## Logs

- Initial load pulls:
  - `GET /api/log?...&kind=planner_stdout`
  - `GET /api/log?...&kind=planner_stderr`
  - `GET /api/log?...&kind=agent_stdout`
  - `GET /api/log?...&kind=agent_stderr`
- Per-step output drawers call `GET /api/log?...&step=<n>&kind=agent_stdout|agent_stderr`.
- In filesystem mode, v3 prefers step-specific files such as `.codex-runtime.step-<n>.attempt-<m>.stdout.log` and `.claude-runtime.step-<n>.attempt-<m>.stderr.log`; otherwise it falls back to shared runtime logs.
- SSE at `GET /api/events/stream` pushes new events and periodic `runs` summaries, but log text is still fetched via `/api/log`.

## Artifacts

- Step artifacts come from step result fields:
  - `artifacts_created[]`
  - `artifacts_modified[]`
- The UI exposes them in both `Step Result` and `Files Modified` drawers.
- File lists are path-based; the monitor does not infer artifacts from directory scans for this view.

## Diffs

- Each artifact path is rendered as a collapsed `<details>` row.
- Opening a row lazy-loads `GET /api/diff?project=<id>&run=<id>&file=<path>`.
- Diff resolution order:
  - `git diff HEAD~1..HEAD -- <file>`
  - synthetic "new file" diff from `git show HEAD:<file>`
  - synthetic untracked diff from raw file contents
  - GitHub PR file patch fallback when a PR URL is known
- Diff content is cached client-side per step/file and preserved across refreshes for already-open sections.

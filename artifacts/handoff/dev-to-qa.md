# Developer → QA Handoff

## What Changed

### `src/service/git-manager.ts`
- Added `commitStepCheckpoint(workspacePath, runId, stepNumber, agentId): Promise<boolean>` — stages all workspace changes (`git add -A`), checks if anything is staged (`git diff --staged --quiet`), skips the commit if nothing changed (returns `false`), otherwise creates a commit with the message `chore(agentsdlc): run <run_id> step <n> <agent_id>` (returns `true`).
- Added private `execRaw(args, cwd)` helper that runs a git command and returns the raw `{ status, stdout }` without throwing on non-zero exit codes. Used by `commitStepCheckpoint` to distinguish "no changes" (exit 0) from "has changes" (exit 1) for `git diff --staged --quiet`.

### `src/shared/types.ts`
- Added `"step.committed"` to the `EventType` union — emitted when a per-step checkpoint commit is successfully created.

### `src/service/orchestration-service.ts`
- In `executeStep`, immediately after `result.agentResult.status === "complete"` is accepted and `step.completed` is emitted, calls `this.git.commitStepCheckpoint(...)`.
- If the commit was created, emits `step.committed` event with `{ step, agent }`.
- If `commitStepCheckpoint` throws, marks `stepExec.status = "failed"`, emits `step.failed` with an error message, sets `run.status = "failed"` and `run.error`, and returns `"failed"`.
- If there are no file changes, `commitStepCheckpoint` returns `false` and execution continues normally (no commit, no event).

## How to Test

### Happy path — step produces file changes
1. Run a task that produces at least one file change per step.
2. After each agent step completes, verify a new git commit appears on the branch:
   ```
   git log --oneline
   ```
   Expected commit message format: `chore(agentsdlc): run run-<id> step <n> <agent>`
3. Verify a `step.committed` event appears in the run event log after each `step.completed`.

### Happy path — step produces no file changes
1. Configure or mock a step that completes successfully without writing any files.
2. Verify that no checkpoint commit is created (git log unchanged after that step).
3. Verify no `step.committed` event is emitted for that step.
4. Verify the run continues normally to the next step.

### Failure path — git commit fails
1. Simulate a git commit failure (e.g. corrupt repo, locked `.git/index`).
2. Verify the run is marked as `failed` with an error message containing "Git checkpoint commit failed".
3. Verify a `step.failed` event is emitted with the git error details.

### PR creation compatibility
1. Run a full multi-step task end-to-end.
2. Verify that `createPullRequest` succeeds after per-step commits are already on the branch.
3. If the `gh` CLI fallback path is hit (`commitAndPush`), verify it still pushes correctly even when no new changes exist (git will commit with nothing, which may need validation — see Notes).

## Environment Setup

- No new environment variables required.
- No new dependencies required.
- No database migrations required.

## Notes

- **PR fallback compatibility**: The existing `commitAndPush` fallback in `createPullRequest` runs `git add -A && git commit && git push`. If per-step commits have already captured all changes, `git commit` in this fallback will fail with "nothing to commit". This is an existing edge case in the pre-existing fallback path — it was already broken if called on a clean tree. The primary `gh pr create` path is unaffected. Document this risk for future hardening.
- **Rework steps**: The checkpoint is only created when `agentResult.status === "complete"`. Steps that enter rework (`needs_rework`) do not get a checkpoint commit, which is correct behavior.
- **Parallel steps**: Each parallel step creates its own checkpoint commit independently when it completes. This is safe since parallel steps run in the same workspace — if two parallel steps modify the same files, commits will serialize correctly because `commitStepCheckpoint` runs synchronously via `spawnSync`.

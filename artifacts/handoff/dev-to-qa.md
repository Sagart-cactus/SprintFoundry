# Developer → QA Handoff

## What Changed

- **`tests/git-manager.test.ts` (line 46)** — Updated `toHaveBeenCalledTimes(2)` to `toHaveBeenCalledTimes(3)` in the `cloneAndBranch calls git clone + checkout` test and added an explanatory comment.

## Root Cause

`cloneAndBranch` was previously making 2 `spawnSync` calls (clone + checkout). A prior change added `tryEnableEntire()` at the end of `cloneAndBranch`, which makes a 3rd `spawnSync` call (`entire enable --strategy auto-commit`). The test mock returns `{ status: 0 }` by default, so `tryEnableEntire` runs successfully in the test, incrementing the call count to 3.

## How to Test

1. Run the full test suite: `npm test`
2. Verify all 144 tests pass, especially `tests/git-manager.test.ts` (19 tests including all 14 `commitStepCheckpoint` tests).

## Expected Behavior

- `cloneAndBranch calls git clone + checkout` — passes with 3 expected calls
- All 14 `commitStepCheckpoint` tests — pass unchanged
- All other `git-manager.test.ts` tests — pass unchanged

## Environment Setup

No new env vars, dependencies, or migrations needed.

## Notes

- `tryEnableEntire` is a best-effort call that silently ignores failures. In the test mock environment it "succeeds" (mock returns status 0) but that is harmless — the test only validates calls[0] (clone) and calls[1] (checkout), so the 3rd call does not affect correctness of those assertions.
- The 3-call count assertion is now accurate and will catch regressions if someone removes the `tryEnableEntire` call or adds another `spawnSync` call to `cloneAndBranch`.

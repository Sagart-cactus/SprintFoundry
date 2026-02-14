# Bug Report

## CRITICAL Issues
(none found)

## MAJOR Issues
(none found)

## MINOR Issues

### BUG-1: Pre-existing test regression — `cloneAndBranch calls git clone + checkout` fails after tryEnableEntire addition
- **File**: `tests/git-manager.test.ts:46`
- **Steps to reproduce**: Run `npm test`
- **Expected**: `cloneAndBranch` test passes (historically expected 2 `spawnSync` calls: clone + checkout)
- **Actual**: Test fails — `spawnSync` called 3 times because the developer's commit added `tryEnableEntire()` inside `cloneAndBranch`, which unconditionally calls `spawnSync` with `entire enable --strategy auto-commit`. The test expected exactly 2 calls.
- **Severity**: MINOR — functional behavior is correct; only the test assertion is stale. The `tryEnableEntire` call is best-effort and catches its own errors, so it does not affect production correctness.
- **Suggested fix**: Update `tests/git-manager.test.ts` line 46 to allow 3 or more calls (or use targeted `toHaveBeenCalledWith` assertions instead of `toHaveBeenCalledTimes`). Alternatively, in `GitManager.tryEnableEntire`, accept a flag to skip in tests, or mock the `entire` binary via the `spawnSync` mock.

---

## Notes

### Documented Risk: commitAndPush fallback may fail with "nothing to commit"
As noted in the developer handoff (`artifacts/handoff/dev-to-qa.md`), the `createPullRequest` fallback path calls `commitAndPush` which runs `git add -A && git commit`. If all changes were already captured by per-step checkpoint commits, this `git commit` will fail with "nothing to commit". This risk was pre-existing before this ticket and is NOT introduced by the current change. The primary `gh pr create` path is unaffected.
- **Recommendation**: Harden the `commitAndPush` fallback in a future ticket to skip the commit step if the tree is clean.

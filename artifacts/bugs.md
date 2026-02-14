# Bug Report

## CRITICAL Issues
(none found)

## MAJOR Issues
(none found)

## MINOR Issues
(none found)

---

## Notes

### Previously Reported Issue — RESOLVED
**BUG-1** (from previous QA run): `cloneAndBranch calls git clone + checkout` was failing because the test asserted exactly 2 `spawnSync` calls while `tryEnableEntire()` introduced a 3rd call.

**Resolution**: Developer updated `tests/git-manager.test.ts` line 46 to `toHaveBeenCalledTimes(3)` with an explanatory comment. The test now correctly reflects the 3 `spawnSync` calls (clone + checkout + tryEnableEntire). Verified passing in this run.

### Documented Risk: commitAndPush fallback may fail with "nothing to commit"
As noted in the developer handoff (`artifacts/handoff/dev-to-qa.md`), the `createPullRequest` fallback path calls `commitAndPush` which runs `git add -A && git commit`. If all changes were already captured by per-step checkpoint commits, this `git commit` will fail with "nothing to commit". This risk is pre-existing and NOT introduced by the current change.
- **Recommendation**: Harden the `commitAndPush` fallback in a future ticket to skip the commit step if the tree is clean.

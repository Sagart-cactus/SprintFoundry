# Behaviour spec

This is what the tests implement. Each rule names the Go test that proves it. A rule without a passing test is not done.

## Run states

A run moves through these states. Any state can move to `stopped` (a cap was hit or the owner cancelled) or `needs_owner` (a decision is required).

```
requested -> criteria_frozen -> building -> candidate_built -> evaluating
evaluating -> passed | failed | inconclusive
failed -> building            (repair, at most two rounds per criteria digest)
passed -> evidence_signed -> released_decision_issued
```

| Rule | Test |
|---|---|
| A run cannot leave `requested` until the criteria, the check suite and the run spec each have a digest | `TestRunNeedsFrozenInputs` |
| A third repair round for the same criteria digest moves the run to `needs_owner` | `TestRepairCapIsPerCriteriaDigest` |
| An inconclusive evaluation never becomes a pass by retrying; it moves to `needs_owner` after its retry budget | `TestInconclusiveNeverPasses` |

## Mechanism 1: a change is imported as data

The builder's change reaches the controller as a patch plus the tree hash the builder tested. The controller never runs git, hooks or builds inside a working tree the builder wrote.

| Rule | Test |
|---|---|
| The patch is applied to the parent commit in a bare repository with hooks disabled, without a working tree | `TestImportAppliesPatchWithoutWorktree` |
| The import fails unless the resulting tree hash equals the tree hash the builder reported | `TestImportRejectsTreeMismatch` |
| The import fails if the patch changes nothing | `TestImportRejectsEmptyChange` |
| A hook planted in the patch or the store never runs | `TestImportNeverRunsHooks` |
| A patch that writes outside the repository is rejected | `TestImportRejectsPathEscape` |

## Mechanism 2: the thing tested is the thing served

| Rule | Test |
|---|---|
| Before evaluation starts, the preview must report the candidate's digest | `TestEvaluationWaitsForCandidateDigest` |
| After evaluation ends, the preview must still report the same digest, or the result is discarded | `TestEvaluationDiscardedIfPreviewChanged` |

## Mechanism 3: intent before effect

Every action with an effect outside the controller (create a branch, open a pull request, comment, dispatch a release) follows the same four steps.

1. Write an intent record with a stable key derived from the run and the action.
2. Look for the effect at the remote by that key (branch name, marker in the pull request body).
3. Perform the effect only if it is not found.
4. Record the result.

These rules are one shared suite (`internal/effect/effecttest`). It runs against the in-memory journal as `TestMemoryJournal/...` and against real Postgres as `TestPostgresJournal/...`.

| Rule | Test |
|---|---|
| A crash after the effect and before step 4 does not repeat the effect on restart | `EffectNotRepeatedAfterCrash` |
| A crash after step 1 and before the effect performs it exactly once on restart | `EffectPerformedOnceAfterEarlyCrash` |
| Three controllers racing on the same key produce one effect | `EffectSingleUnderRace` |
| An effect without a remote lookup cannot be registered | `EffectRequiresReconciler` |
| A lock held by a controller that dies is released by the database | `TestLockIsReleasedWhenTheHolderDies` |

## Trust rules with tests

| Rule | Test |
|---|---|
| A sandbox spec that mounts a credential or passes a secret in its environment is refused | `TestSandboxRefusesSecrets` |
| The check runner's output is raw results; the grade is computed by controller code | `TestGradeComputedFromRawResults` |
| A result that names a check not in the frozen suite is refused | `TestGradeRefusesUnknownCheck` |
| Feedback to the builder contains the criterion and a symptom, never the request or the expected value | `TestFeedbackHidesCheckDetails` |
| A holdout failure sends nothing to the builder | `TestHoldoutFailureIsSilentToBuilder` |
| A demo signer cannot produce a statement with purpose `production` | `TestDemoSignerCannotSignProduction` |
| `verify` rejects a decision older than `max_decision_age`, for another image, another policy digest or another repository | `TestVerifyRejectsStaleOrForeignDecision` |
| Evidence superseded by a newer run cannot back a new decision | `TestSupersededEvidenceCannotRelease` |

## Not carried over from the prototype

Ticket intake from one tracker, the local-model author and the AX task wrapper are specific to the prototype's environment. They are not part of this spec.
